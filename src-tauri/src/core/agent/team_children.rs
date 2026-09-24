//! What each isolated child of a team did, kept until someone has reviewed it.
//! AH-109.
//!
//! A team task that asks for isolation writes a Flint-owned worktree of its own.
//! Its work reaches the user's checkout only through a proposal, like any
//! isolated run -- but a team has several children, they finish at different
//! times, some of them fail, and the app may be restarted before anyone looks.
//! This is the record that survives all of that:
//!
//! * **Derived from disk, not from the renderer.** A child is identified by
//!   its parent session and task id; its owner id, worktree, branch and base
//!   commit are all worked out here from Git. Nothing the model said about
//!   paths, hashes or scopes is taken on trust.
//! * **Every ending is explicit.** Running, completed, failed and cancelled are
//!   recorded as they happen. A child still `running` in a record written by a
//!   different process is `interrupted`: the app stopped while it worked.
//! * **A proposal is made from what the child left.** When a child settles, a
//!   fingerprint of its changes is stored. A later review of a worktree that no
//!   longer matches it -- edited, reset or replaced since -- is a typed error,
//!   not a review of whatever happens to be there now.
//! * **An unfinished child never reads as a clean one.** Proposing the changes
//!   of a failed, cancelled or interrupted child needs an explicit
//!   acknowledgement, and the proposal it makes says so in its subject.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri_plugin_agent_tools::proposal::{self, FileInput, FileSummary, ProposalRecord};

use crate::core::agent::proposals::{changes_in_worktree, ChangesError};
use crate::core::agent::worktree::{self, RepoIdentity, WorktreeRecord, WorktreeState};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ChildStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

/// The user's decision to let overlapping tasks run side by side anyway.
///
/// Recorded, never inferred, and never a waiver of anything later: each
/// child's changes still go through a proposal, and the apply-time conflict
/// check runs exactly as it would have.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParallelOverride {
    pub tasks: Vec<String>,
    pub paths: Vec<String>,
    pub decided_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChildRecord {
    pub schema_version: u32,
    pub owner_id: String,
    pub parent_session: String,
    #[serde(default)]
    pub run: String,
    #[serde(default)]
    pub call: String,
    pub task_id: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub agent: String,
    pub worktree_path: String,
    pub branch: String,
    pub base_sha: String,
    pub source_root: String,
    #[serde(default)]
    pub first_commit: Option<String>,
    pub status: ChildStatus,
    #[serde(default)]
    pub detail: String,
    pub started_at: String,
    #[serde(default)]
    pub ended_at: Option<String>,
    /// Which app process recorded the start. A different one reading a
    /// `running` record knows the child was interrupted, not still going.
    pub instance: String,
    /// The child's changes when it settled. `None` until then.
    #[serde(default)]
    pub fingerprint: Option<String>,
    #[serde(default)]
    pub declared_writes: Vec<String>,
    #[serde(default)]
    pub overrides: Vec<ParallelOverride>,
}

/// A child's state as the review list shows it.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ChildState {
    Running,
    Interrupted,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ChildErrorKind {
    UnknownChild,
    NotManaged,
    Deleted,
    Corrupt,
    BranchMoved,
    IdentityChanged,
    LinkEscape,
    ModifiedAfterFinish,
    Incomplete,
    NoChanges,
    Io,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChildError {
    pub kind: ChildErrorKind,
    pub message: String,
}

/// What this failure is, in the harness's own vocabulary (AH-009).
///
/// Written out case by case rather than defaulted: this enum says what went
/// wrong *here*, and the mapping is the place to decide what that means
/// everywhere else -- whether it may be retried, who it is for, what the
/// process exits with. A blanket "everything is internal" would be the same
/// as having no taxonomy at all.
impl From<&ChildError> for tauri_plugin_agent_tools::harness_error::HarnessError {
    fn from(error: &ChildError) -> Self {
        use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};
        let kind = match error.kind {
            ChildErrorKind::UnknownChild | ChildErrorKind::Deleted => ErrorKind::NotFound,
            ChildErrorKind::NotManaged | ChildErrorKind::NoChanges => ErrorKind::InvalidInput,
            // The checkout is not what the record says it is any more.
            ChildErrorKind::Corrupt
            | ChildErrorKind::BranchMoved
            | ChildErrorKind::IdentityChanged
            | ChildErrorKind::ModifiedAfterFinish => ErrorKind::MalformedState,
            // A checkout reaching outside itself is a refusal.
            ChildErrorKind::LinkEscape => ErrorKind::PolicyViolation,
            ChildErrorKind::Incomplete => ErrorKind::ChildFailed,
            ChildErrorKind::Io => ErrorKind::Io,
        };
        HarnessError::new(kind, &error.message).at(Stage::Child)
    }
}

impl ChildError {
    fn new(kind: ChildErrorKind, message: impl Into<String>) -> Self {
        ChildError {
            kind,
            message: message.into(),
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChildView {
    #[serde(flatten)]
    pub record: ChildRecord,
    pub state: ChildState,
    pub files: Vec<FileSummary>,
    /// Why this child's work cannot be reviewed as a clean success, if it
    /// cannot.
    pub problem: Option<ChildError>,
}

/// What the renderer may say about a child when it starts.
///
/// Identity only. The worktree, branch and base are looked up here.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BeginInput {
    pub parent_session: String,
    pub task_id: String,
    #[serde(default)]
    pub run: String,
    #[serde(default)]
    pub call: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub agent: String,
    pub project: String,
    #[serde(default)]
    pub declared_writes: Vec<String>,
    #[serde(default)]
    pub overrides: Vec<ParallelOverride>,
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

fn store_dir(data_folder: &Path) -> PathBuf {
    data_folder.join("team-children")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

fn record_path(data_folder: &Path, owner_id: &str) -> PathBuf {
    store_dir(data_folder).join(format!("{}.json", &sha256_hex(owner_id.as_bytes())[..24]))
}

fn save(data_folder: &Path, record: &ChildRecord) -> Result<(), ChildError> {
    let io = |e: std::io::Error| ChildError::new(ChildErrorKind::Io, e.to_string());
    let path = record_path(data_folder, &record.owner_id);
    std::fs::create_dir_all(store_dir(data_folder)).map_err(io)?;
    let body = serde_json::to_vec_pretty(record)
        .map_err(|e| ChildError::new(ChildErrorKind::Io, e.to_string()))?;
    let temp = path.with_extension(format!("tmp-{}-{}", std::process::id(), unique()));
    std::fs::write(&temp, body).map_err(io)?;
    std::fs::rename(&temp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        io(e)
    })
}

pub fn load(data_folder: &Path, owner_id: &str) -> Result<ChildRecord, ChildError> {
    let text = std::fs::read_to_string(record_path(data_folder, owner_id)).map_err(|_| {
        ChildError::new(ChildErrorKind::UnknownChild, "no team child by that name was recorded")
    })?;
    let record: ChildRecord = serde_json::from_str(&text).map_err(|_| {
        ChildError::new(ChildErrorKind::UnknownChild, "the team child's record is unreadable")
    })?;
    // The file is named by the hash of the owner id; one that holds another
    // owner's record was put there by something other than this module.
    if record.owner_id != owner_id {
        return Err(ChildError::new(
            ChildErrorKind::UnknownChild,
            "the team child's record does not match its name",
        ));
    }
    Ok(record)
}

fn unique() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// Starting and settling read a child's record, decide, and write it back.
/// A run's teardown settles children as cancelled on a thread of its own
/// while a child may be settling itself; without this the later write won,
/// and a completed child could be relabelled cancelled.
static RECORDS: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// This process, as distinct from the one that ran before a restart.
fn instance() -> &'static str {
    static ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    ID.get_or_init(|| {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("{}-{nanos:x}", std::process::id())
    })
}

fn now() -> String {
    tauri_plugin_agent_tools::audit::now()
}

fn same_dir(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Worktree checks
// ---------------------------------------------------------------------------

fn as_worktree(record: &ChildRecord) -> WorktreeRecord {
    WorktreeRecord {
        path: record.worktree_path.clone(),
        branch: record.branch.clone(),
        base_sha: record.base_sha.clone(),
        source_root: record.source_root.clone(),
        identity: RepoIdentity {
            root: record.source_root.clone(),
            first_commit: record.first_commit.clone(),
        },
        uncommitted_at_creation: Vec::new(),
    }
}

/// The child's worktree, if it is still the one that was recorded.
fn verify(record: &ChildRecord, roots: &Path) -> Result<WorktreeRecord, ChildError> {
    let path = Path::new(&record.worktree_path);
    if !path.exists() {
        return Err(ChildError::new(
            ChildErrorKind::Deleted,
            format!("{} no longer exists, so there is nothing to review", record.worktree_path),
        ));
    }
    let inside = match (path.canonicalize(), roots.canonicalize()) {
        (Ok(p), Ok(r)) => p.starts_with(&r) && p != r,
        _ => false,
    };
    if !inside {
        return Err(ChildError::new(
            ChildErrorKind::NotManaged,
            format!("{} is not a worktree Jan manages", record.worktree_path),
        ));
    }
    let wt = as_worktree(record);
    match worktree::state(&wt) {
        WorktreeState::Ready => Ok(wt),
        WorktreeState::Missing => Err(ChildError::new(
            ChildErrorKind::Deleted,
            format!("{} no longer exists, so there is nothing to review", record.worktree_path),
        )),
        WorktreeState::Corrupt => Err(ChildError::new(
            ChildErrorKind::Corrupt,
            format!("{} is no longer a Git worktree of this project", record.worktree_path),
        )),
        WorktreeState::BranchMoved => Err(ChildError::new(
            ChildErrorKind::BranchMoved,
            format!(
                "{} is no longer on {}, so it is not what the task left",
                record.worktree_path, record.branch
            ),
        )),
        WorktreeState::IdentityChanged => Err(ChildError::new(
            ChildErrorKind::IdentityChanged,
            format!("{} is not the repository the task ran against", record.source_root),
        )),
    }
}

fn read_changes(wt: &WorktreeRecord) -> Result<Vec<FileInput>, ChildError> {
    changes_in_worktree(wt).map_err(|e| match e {
        ChangesError::LinkEscape(_) => ChildError::new(ChildErrorKind::LinkEscape, e.to_string()),
        ChangesError::Other(m) => ChildError::new(ChildErrorKind::Io, m),
    })
}

fn head_of(path: &Path) -> String {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(path).args(["rev-parse", "HEAD"]);
    jan_utils::system::hide_console_window(&mut cmd);
    cmd.output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// A digest of exactly what the child changed: every path and its content,
/// plus the commit its branch is on.
fn fingerprint(inputs: &[FileInput], head: &str) -> String {
    let mut basis = format!("head\t{head}\n");
    let mut sorted: Vec<&FileInput> = inputs.iter().collect();
    sorted.sort_by(|a, b| a.path.cmp(&b.path));
    for input in sorted {
        let content = input
            .proposed
            .as_deref()
            .map(sha256_hex)
            .unwrap_or_else(|| "absent".into());
        basis.push_str(&format!("{}\t{content}\n", input.path));
    }
    sha256_hex(basis.as_bytes())
}

fn current_fingerprint(wt: &WorktreeRecord) -> Result<String, ChildError> {
    let inputs = read_changes(wt)?;
    Ok(fingerprint(&inputs, &head_of(Path::new(&wt.path))))
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/// Record that a child is about to run in its own worktree.
///
/// The worktree must already exist -- the team provisions every isolated
/// task's checkout before any child starts -- and is found from the parent
/// session and task id, the same way it was made.
pub fn begin(data_folder: &Path, roots: &Path, input: BeginInput) -> Result<ChildRecord, ChildError> {
    if input.parent_session.trim().is_empty() || input.task_id.trim().is_empty() {
        return Err(ChildError::new(
            ChildErrorKind::UnknownChild,
            "a team child needs its parent session and task id",
        ));
    }
    let owner_id =
        tauri_plugin_agent_tools::child_session_id(&input.parent_session, &input.task_id);
    let source = Path::new(&input.project);
    let Some(found) = worktree::existing(source, roots, &owner_id) else {
        return Err(ChildError::new(
            ChildErrorKind::NotManaged,
            format!("task {} has no worktree of its own to run in", input.task_id),
        ));
    };
    let record = ChildRecord {
        schema_version: SCHEMA_VERSION,
        owner_id,
        parent_session: input.parent_session,
        run: input.run,
        call: input.call,
        task_id: input.task_id,
        description: input.description.chars().take(2000).collect(),
        agent: input.agent,
        worktree_path: found.path,
        branch: found.branch,
        base_sha: found.base_sha,
        source_root: found.source_root,
        first_commit: found.identity.first_commit,
        status: ChildStatus::Running,
        detail: String::new(),
        started_at: now(),
        ended_at: None,
        instance: instance().to_string(),
        fingerprint: None,
        declared_writes: input.declared_writes,
        overrides: input.overrides,
    };
    let _held = RECORDS.lock().unwrap_or_else(|p| p.into_inner());
    save(data_folder, &record)?;
    Ok(record)
}

/// Record how a child ended, and fingerprint what it left.
pub fn settle(
    data_folder: &Path,
    roots: &Path,
    parent_session: &str,
    task_id: &str,
    status: ChildStatus,
    detail: &str,
) -> Result<ChildRecord, ChildError> {
    if status == ChildStatus::Running {
        return Err(ChildError::new(
            ChildErrorKind::Incomplete,
            "a child cannot settle as running",
        ));
    }
    let owner_id = tauri_plugin_agent_tools::child_session_id(parent_session, task_id);
    // Held from the read to the write, so the check below sees any ending
    // written by a settle racing this one.
    let _held = RECORDS.lock().unwrap_or_else(|p| p.into_inner());
    let mut record = load(data_folder, &owner_id)?;
    // The first ending wins. A late "cancelled" from tearing down a run whose
    // child had already finished must not relabel a completed child, and a
    // settle that races another is not a second ending.
    if record.status != ChildStatus::Running {
        return Ok(record);
    }
    record.status = status;
    record.detail = detail.chars().take(2000).collect();
    record.ended_at = Some(now());
    // A worktree that cannot be read now has no fingerprint, and a later
    // review of it is refused for that reason rather than trusted.
    record.fingerprint = verify(&record, roots)
        .and_then(|wt| current_fingerprint(&wt))
        .ok();
    save(data_folder, &record)?;
    Ok(record)
}

fn state_of(record: &ChildRecord) -> ChildState {
    match record.status {
        ChildStatus::Running if record.instance == instance() => ChildState::Running,
        ChildStatus::Running => ChildState::Interrupted,
        ChildStatus::Completed => ChildState::Completed,
        ChildStatus::Failed => ChildState::Failed,
        ChildStatus::Cancelled => ChildState::Cancelled,
    }
}

fn incomplete(record: &ChildRecord, state: ChildState) -> Option<ChildError> {
    let what = match state {
        ChildState::Completed | ChildState::Running => return None,
        ChildState::Failed => "failed",
        ChildState::Cancelled => "was cancelled",
        ChildState::Interrupted => "was interrupted when Jan stopped",
    };
    Some(ChildError::new(
        ChildErrorKind::Incomplete,
        format!(
            "task {} {what}; what it changed is not a finished result",
            record.task_id
        ),
    ))
}

/// Everything recorded for `project`, and for `session` when one is named,
/// oldest first, each looked at again on disk.
pub fn list(
    data_folder: &Path,
    roots: &Path,
    project: &str,
    session: Option<&str>,
) -> Vec<ChildView> {
    let Ok(entries) = std::fs::read_dir(store_dir(data_folder)) else {
        return Vec::new();
    };
    let project = Path::new(project);
    let mut records: Vec<ChildRecord> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|t| serde_json::from_str::<ChildRecord>(&t).ok())
        .filter(|r| session.is_none_or(|s| r.parent_session == s))
        .filter(|r| same_dir(Path::new(&r.source_root), project))
        .collect();
    records.sort_by(|a, b| a.started_at.cmp(&b.started_at).then(a.task_id.cmp(&b.task_id)));
    records.into_iter().map(|r| view(r, roots)).collect()
}

fn view(record: ChildRecord, roots: &Path) -> ChildView {
    let state = state_of(&record);
    let mut files = Vec::new();
    let problem = match verify(&record, roots).and_then(|wt| {
        let inputs = read_changes(&wt)?;
        files = proposal::summarize(&inputs)
            .map_err(|e| ChildError::new(ChildErrorKind::Io, e.message()))?;
        Ok(fingerprint(&inputs, &head_of(Path::new(&wt.path))))
    }) {
        Err(e) => Some(e),
        Ok(now) => match (&record.fingerprint, state) {
            (_, ChildState::Running) => None,
            (Some(then), _) if *then != now => Some(ChildError::new(
                ChildErrorKind::ModifiedAfterFinish,
                format!(
                    "{} changed after task {} finished, so it is not what the task left",
                    record.worktree_path, record.task_id
                ),
            )),
            (None, _) if record.status != ChildStatus::Running => Some(ChildError::new(
                ChildErrorKind::ModifiedAfterFinish,
                format!(
                    "what task {} left could not be recorded when it finished",
                    record.task_id
                ),
            )),
            _ => incomplete(&record, state),
        },
    };
    ChildView {
        record,
        state,
        files,
        problem,
    }
}

/// Store a child's changes as a proposal, for the ordinary review and apply.
///
/// Refused with a typed error when the worktree is gone, not the one the task
/// ran in, holds a link out of itself, changed since the task finished, or has
/// nothing in it. A child that did not complete is refused too, unless
/// `acknowledge` says the person has seen that and wants to review it anyway.
pub fn propose(
    data_folder: &Path,
    roots: &Path,
    parent_session: &str,
    task_id: &str,
    acknowledge: bool,
) -> Result<ProposalRecord, ChildError> {
    let owner_id = tauri_plugin_agent_tools::child_session_id(parent_session, task_id);
    let record = load(data_folder, &owner_id)?;
    let state = state_of(&record);
    if state == ChildState::Running {
        return Err(ChildError::new(
            ChildErrorKind::Incomplete,
            format!("task {} is still running", record.task_id),
        ));
    }
    let wt = verify(&record, roots)?;
    let inputs = read_changes(&wt)?;
    if inputs.is_empty() {
        return Err(ChildError::new(
            ChildErrorKind::NoChanges,
            format!("task {} changed nothing in its worktree", record.task_id),
        ));
    }
    let now_print = fingerprint(&inputs, &head_of(Path::new(&wt.path)));
    let unchanged = record.fingerprint.as_deref() == Some(now_print.as_str());
    if !unchanged && !acknowledge {
        return Err(ChildError::new(
            ChildErrorKind::ModifiedAfterFinish,
            format!(
                "{} changed after task {} finished, so it is not what the task left",
                record.worktree_path, record.task_id
            ),
        ));
    }
    if let Some(problem) = incomplete(&record, state) {
        if !acknowledge {
            return Err(problem);
        }
    }
    let status = match state {
        ChildState::Completed => "completed",
        ChildState::Failed => "failed",
        ChildState::Cancelled => "cancelled",
        ChildState::Interrupted => "interrupted",
        ChildState::Running => "running",
    };
    let scope = proposal::ProposalScope {
        session: record.parent_session.clone(),
        run: record.run.clone(),
        call: record.call.clone(),
        invocation: record.owner_id.clone(),
        agent: format!("team:{}", record.task_id),
        // Carried into the proposal so a review of an unfinished child's work
        // says so wherever the proposal is shown.
        subject: format!(
            "task {} ({status}{})",
            record.task_id,
            if acknowledge && (!unchanged || status != "completed") {
                ", reviewed despite the warning"
            } else {
                ""
            }
        ),
        project: record.source_root.clone(),
        worktree: record.worktree_path.clone(),
    };
    proposal::create(data_folder, scope, &record.base_sha, inputs)
        .map_err(|e| ChildError::new(ChildErrorKind::Io, e.message()))
}

#[cfg(test)]
mod harness_error_bridge {
    use super::*;
    use tauri_plugin_agent_tools::harness_error::{ErrorKind, Stage};

    /// AH-009: a child checkout's failures cross into the taxonomy with the
    /// distinction that matters -- a checkout reaching outside itself is a
    /// refusal, not an I/O problem.
    #[test]
    fn a_child_failure_keeps_its_meaning() {
        let of = |kind: ChildErrorKind| -> tauri_plugin_agent_tools::harness_error::HarnessError {
            (&ChildError { kind, message: "why".into() }).into()
        };
        assert_eq!(of(ChildErrorKind::LinkEscape).kind(), ErrorKind::PolicyViolation);
        assert_eq!(of(ChildErrorKind::UnknownChild).kind(), ErrorKind::NotFound);
        assert_eq!(of(ChildErrorKind::IdentityChanged).kind(), ErrorKind::MalformedState);
        assert_eq!(of(ChildErrorKind::Incomplete).kind(), ErrorKind::ChildFailed);
        for kind in [
            ChildErrorKind::UnknownChild,
            ChildErrorKind::NotManaged,
            ChildErrorKind::Deleted,
            ChildErrorKind::Corrupt,
            ChildErrorKind::BranchMoved,
            ChildErrorKind::IdentityChanged,
            ChildErrorKind::LinkEscape,
            ChildErrorKind::ModifiedAfterFinish,
            ChildErrorKind::Incomplete,
            ChildErrorKind::NoChanges,
            ChildErrorKind::Io,
        ] {
            assert_eq!(of(kind).stage(), Stage::Child, "{kind:?}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(repo: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.invalid")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.invalid")
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
    }

    struct Fixture {
        data: PathBuf,
        roots: PathBuf,
        src: PathBuf,
    }

    fn fixture(name: &str) -> Fixture {
        let root = std::env::temp_dir().join(format!(
            "jan-team-children-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let src = root.join("src");
        std::fs::create_dir_all(&src).unwrap();
        git(&src, &["init", "-q", "-b", "main"]);
        std::fs::write(src.join("shared.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n").unwrap();
        git(&src, &["add", "."]);
        git(&src, &["commit", "-q", "-m", "base"]);
        let data = root.join("data");
        std::fs::create_dir_all(&data).unwrap();
        Fixture {
            roots: root.join("worktrees"),
            data,
            src: src.canonicalize().unwrap(),
        }
    }

    fn start(f: &Fixture, task: &str) -> ChildRecord {
        let owner = tauri_plugin_agent_tools::child_session_id("sess", task);
        worktree::ensure(&f.src, &f.roots, &owner).unwrap();
        begin(
            &f.data,
            &f.roots,
            BeginInput {
                parent_session: "sess".into(),
                task_id: task.into(),
                run: "run-1".into(),
                call: "call-1".into(),
                description: format!("do {task}"),
                agent: "worker".into(),
                project: f.src.to_string_lossy().to_string(),
                declared_writes: vec!["shared.txt".into()],
                overrides: Vec::new(),
            },
        )
        .unwrap()
    }

    fn one(f: &Fixture, task: &str) -> ChildView {
        list(&f.data, &f.roots, &f.src.to_string_lossy(), Some("sess"))
            .into_iter()
            .find(|v| v.record.task_id == task)
            .unwrap()
    }

    /// Identity is worked out from Git, the review list says what the child
    /// changed, and its proposal lands in the ordinary proposal store.
    #[test]
    fn a_completed_child_is_listed_with_its_changes_and_proposed() {
        let f = fixture("done");
        let rec = start(&f, "alpha");
        assert!(rec.branch.starts_with(worktree::BRANCH_PREFIX));
        assert_eq!(rec.base_sha.len(), 40);
        std::fs::write(
            Path::new(&rec.worktree_path).join("shared.txt"),
            "ONE\n2\n3\n4\n5\n6\n7\n8\n9\nTEN\n",
        )
        .unwrap();
        settle(&f.data, &f.roots, "sess", "alpha", ChildStatus::Completed, "").unwrap();

        let v = one(&f, "alpha");
        assert_eq!(v.state, ChildState::Completed);
        assert_eq!(v.problem, None);
        assert_eq!(v.files.len(), 1);
        assert_eq!((v.files[0].additions, v.files[0].deletions), (2, 2));

        let p = propose(&f.data, &f.roots, "sess", "alpha", false).unwrap();
        assert_eq!(p.scope.agent, "team:alpha");
        assert_eq!(p.scope.worktree, rec.worktree_path);
        assert_eq!(p.files[0].hunks.len(), 2);
        // Nothing was written to the checkout by listing or proposing.
        assert!(std::fs::read_to_string(f.src.join("shared.txt")).unwrap().starts_with("1\n"));
    }

    /// A run's teardown settles its children as cancelled while a child may be
    /// settling itself. Whichever lands first is the ending every caller sees
    /// and the one on disk; the other is not a second ending.
    #[test]
    fn racing_settles_agree_on_one_ending() {
        let f = fixture("race");
        start(&f, "alpha");
        let gate = std::sync::Arc::new(std::sync::Barrier::new(6));
        let handles: Vec<_> = (0..6)
            .map(|i| {
                let (data, roots, gate) = (f.data.clone(), f.roots.clone(), gate.clone());
                std::thread::spawn(move || {
                    let status = if i % 2 == 0 { ChildStatus::Completed } else { ChildStatus::Cancelled };
                    gate.wait();
                    settle(&data, &roots, "sess", "alpha", status, "").unwrap().status
                })
            })
            .collect();
        let seen: Vec<ChildStatus> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        let owner = tauri_plugin_agent_tools::child_session_id("sess", "alpha");
        let kept = load(&f.data, &owner).unwrap().status;
        assert!(seen.iter().all(|s| *s == kept), "callers saw {seen:?}, disk holds {kept:?}");
    }

    /// Failed and cancelled children are refused as clean proposals; the
    /// person has to acknowledge the ending, and the proposal says so.
    #[test]
    fn failed_and_cancelled_children_cannot_pass_as_clean_proposals() {
        let f = fixture("unfinished");
        for (task, status) in [("bad", ChildStatus::Failed), ("stopped", ChildStatus::Cancelled)] {
            let rec = start(&f, task);
            std::fs::write(Path::new(&rec.worktree_path).join("half.txt"), "half\n").unwrap();
            settle(&f.data, &f.roots, "sess", task, status, "boom").unwrap();
            let v = one(&f, task);
            assert_eq!(v.problem.as_ref().map(|p| p.kind), Some(ChildErrorKind::Incomplete));
            let err = propose(&f.data, &f.roots, "sess", task, false).unwrap_err();
            assert_eq!(err.kind, ChildErrorKind::Incomplete);
            let p = propose(&f.data, &f.roots, "sess", task, true).unwrap();
            assert!(p.scope.subject.contains("reviewed despite the warning"), "{}", p.scope.subject);
        }
    }

    /// A worktree edited after its child finished is a typed error, never a
    /// review of whatever is there now; a missing one says it is gone.
    #[test]
    fn a_modified_or_deleted_worktree_is_a_typed_error() {
        let f = fixture("stale");
        let rec = start(&f, "alpha");
        let wt = Path::new(&rec.worktree_path);
        std::fs::write(wt.join("shared.txt"), "changed by the task\n").unwrap();
        settle(&f.data, &f.roots, "sess", "alpha", ChildStatus::Completed, "").unwrap();
        std::fs::write(wt.join("shared.txt"), "changed by someone else\n").unwrap();
        assert_eq!(
            one(&f, "alpha").problem.map(|p| p.kind),
            Some(ChildErrorKind::ModifiedAfterFinish)
        );
        assert_eq!(
            propose(&f.data, &f.roots, "sess", "alpha", false).unwrap_err().kind,
            ChildErrorKind::ModifiedAfterFinish
        );

        worktree::discard(&as_worktree(&rec), true).unwrap();
        let v = one(&f, "alpha");
        assert_eq!(v.problem.map(|p| p.kind), Some(ChildErrorKind::Deleted));
        assert!(v.files.is_empty());
        assert_eq!(
            propose(&f.data, &f.roots, "sess", "alpha", true).unwrap_err().kind,
            ChildErrorKind::Deleted
        );
    }

    /// A child still `running` in a record another process wrote was stopped
    /// by a restart, and says so.
    #[test]
    fn a_child_running_when_jan_stopped_is_interrupted() {
        let f = fixture("interrupted");
        let rec = start(&f, "alpha");
        let mut stale = load(&f.data, &rec.owner_id).unwrap();
        stale.instance = "someone-else".into();
        save(&f.data, &stale).unwrap();
        let v = one(&f, "alpha");
        assert_eq!(v.state, ChildState::Interrupted);
        assert_eq!(v.problem.map(|p| p.kind), Some(ChildErrorKind::Incomplete));
        assert_eq!(
            propose(&f.data, &f.roots, "sess", "alpha", false).unwrap_err().kind,
            ChildErrorKind::NoChanges
        );
    }

    /// The renderer names a child; it cannot name a worktree. A task with no
    /// worktree of its own is refused, and so is a record swapped on disk.
    #[test]
    fn a_child_is_found_from_git_and_never_from_what_it_was_told() {
        let f = fixture("identity");
        let err = begin(
            &f.data,
            &f.roots,
            BeginInput {
                parent_session: "sess".into(),
                task_id: "never-provisioned".into(),
                run: String::new(),
                call: String::new(),
                description: String::new(),
                agent: String::new(),
                project: f.src.to_string_lossy().to_string(),
                declared_writes: Vec::new(),
                overrides: Vec::new(),
            },
        )
        .unwrap_err();
        assert_eq!(err.kind, ChildErrorKind::NotManaged);

        let a = start(&f, "alpha");
        let b = start(&f, "beta");
        // Copy beta's record over alpha's file: the name no longer matches.
        std::fs::copy(record_path(&f.data, &b.owner_id), record_path(&f.data, &a.owner_id)).unwrap();
        assert_eq!(load(&f.data, &a.owner_id).unwrap_err().kind, ChildErrorKind::UnknownChild);
    }

    /// A link out of a child's worktree is refused before anything it points
    /// at is read.
    #[test]
    fn a_link_out_of_a_child_worktree_is_refused() {
        let f = fixture("link");
        let rec = start(&f, "alpha");
        let outside = f.src.parent().unwrap().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "not yours\n").unwrap();
        crate::core::agent::proposals::tests::link_dir(
            &Path::new(&rec.worktree_path).join("escape"),
            &outside,
        );
        settle(&f.data, &f.roots, "sess", "alpha", ChildStatus::Completed, "").unwrap();
        assert_eq!(
            one(&f, "alpha").problem.map(|p| p.kind),
            Some(ChildErrorKind::LinkEscape)
        );
        assert_eq!(
            propose(&f.data, &f.roots, "sess", "alpha", true).unwrap_err().kind,
            ChildErrorKind::LinkEscape
        );
    }
}
