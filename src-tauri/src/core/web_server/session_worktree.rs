//! Worktrees for server sessions (phase P2 of docs/MOBILE.md, "Server
//! runner"): a remote session that may write runs in an isolated checkout that
//! the server owns, and what it changed comes back as a proposal.
//!
//! Boundaries, in the order a request meets them:
//!
//! - the worktree lives under the server's own folder
//!   (`workspace::worktrees_dir(<data>)`); a client never names a path, only a
//!   session id, and the record is read from that session's stored thread;
//! - a stored record is trusted for nothing: it must still be listed by its
//!   repository's own git under the owned root on a Flint branch
//!   (`worktree::ensure_owned`), and its repository must resolve inside an
//!   `--agent-root`;
//! - every state-changing operation is audited in the session's event log with
//!   the digests of the client and its address.
//!
//! Nothing here runs a project command. `git` itself runs (worktree add,
//! commit-tree, `merge --ff-only`, `worktree remove`), which can fire the
//! repository's own hooks; see "Security notes" in docs/MOBILE.md.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri_plugin_agent_tools::proposal::{
    self, FileInput, ProposalRecord, ProposalScope, ProposalState,
};
use tauri_plugin_agent_tools::workspace;

use super::agent::Fail;
use super::agent_runs;
use crate::core::agent::proposals::{self, ChangesError};
use crate::core::agent::worktree::{
    self, EnsureOptions, RepoIdentity, WorktreeRecord, WorktreeState,
};

/// Thread metadata key (shared with the CLI, which reads `path` and `branch`).
pub const KEY: &str = "worktree";
const MAX_MESSAGE: usize = 200;
const MAX_REF: usize = 200;

fn fail(status: u16, message: impl Into<String>) -> Fail {
    Fail {
        status,
        body: Value::String(message.into()),
    }
}

/// Commands this module's operations answer (the runner routes them).
pub fn handles(command: &str) -> bool {
    matches!(
        command,
        "agent_worktree_state"
            | "agent_worktree_pending"
            | "agent_worktree_commit_pending"
            | "agent_worktree_merge"
            | "agent_worktree_unmerged"
            | "agent_worktree_discard"
            | "agent_worktree_rename"
            | "agent_worktree_list"
    )
}

/// The server's own worktree folder, absolute.
pub fn owned_root(data: &Path) -> Result<PathBuf, Fail> {
    worktree::absolute(&workspace::worktrees_dir(data)).map_err(|m| fail(500, m))
}

// ---------------------------------------------------------------------------
// The record in the thread
// ---------------------------------------------------------------------------

pub fn record_json(record: &WorktreeRecord) -> Value {
    serde_json::to_value(record).unwrap_or(Value::Null)
}

/// The record a runner session stored, or `None` for a thread without one
/// (including the CLI's `{path, branch}` pointer, which has no base commit).
pub fn record_of(meta: &Value) -> Option<WorktreeRecord> {
    let w = meta.get(KEY)?;
    let text = |key: &str| w.get(key).and_then(Value::as_str).map(str::to_owned);
    let list = |key: &str| -> Vec<String> {
        w.get(key)
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    };
    Some(WorktreeRecord {
        path: text("path")?,
        branch: text("branch")?,
        base_sha: text("baseSha")?,
        source_root: text("sourceRoot")?,
        identity: RepoIdentity {
            root: w.pointer("/identity/root")?.as_str()?.to_owned(),
            first_commit: w
                .pointer("/identity/firstCommit")
                .and_then(Value::as_str)
                .map(str::to_owned),
        },
        uncommitted_at_creation: list("uncommittedAtCreation"),
        base_branch: text("baseBranch"),
        notes: list("notes"),
    })
}

fn thread_metadata(data: &Path, id: &str) -> Option<Value> {
    let path = crate::core::threads::utils::get_thread_metadata_path(data, id);
    let thread: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    thread.get("metadata").cloned()
}

fn write_metadata(data: &Path, id: &str, change: impl FnOnce(&mut Value)) -> Result<(), Fail> {
    use crate::core::threads::{helpers, utils};
    let path = utils::get_thread_metadata_path(data, id);
    let mut thread: Value = serde_json::from_str(
        &std::fs::read_to_string(&path)
            .map_err(|_| fail(404, "that session does not exist on this server"))?,
    )
    .map_err(|_| fail(500, "that session cannot be read"))?;
    if !thread["metadata"].is_object() {
        thread["metadata"] = json!({});
    }
    change(&mut thread["metadata"]);
    helpers::update_thread_metadata(data, id, &thread).map_err(|m| fail(500, m))
}

/// The thread's metadata as the disk has it, for an actor that just ran an
/// operation here.
pub fn reload(data: &Path, id: &str) -> Option<(Value, Option<WorktreeRecord>)> {
    let meta = thread_metadata(data, id)?;
    let record = record_of(&meta);
    Some((meta, record))
}

// ---------------------------------------------------------------------------
// Creating one
// ---------------------------------------------------------------------------

/// Whether `folder` is inside a git working tree.
pub fn in_git(folder: &Path) -> bool {
    worktree::identity(folder).is_ok()
}

/// Make the session's worktree under the server's folder. The repository must
/// be inside a root: a folder under a root whose repository top level is
/// above it is refused rather than isolated from a place nobody allowed.
pub fn create(
    data: &Path,
    roots: &[PathBuf],
    folder: &Path,
    session_id: &str,
    title: &str,
    base: Option<&str>,
) -> Result<WorktreeRecord, Fail> {
    let identity = worktree::identity(folder).map_err(|_| {
        fail(
            422,
            "that folder is not inside a git repository, so it cannot be isolated",
        )
    })?;
    let top = Path::new(&identity.root)
        .canonicalize()
        .map_err(|_| fail(422, "the repository could not be resolved"))?;
    if !roots.iter().any(|r| top.starts_with(r)) {
        return Err(fail(
            403,
            "that folder's repository reaches outside the folders this server allows; start the session at the repository root",
        ));
    }
    let base = base.map(str::trim).filter(|b| !b.is_empty());
    if let Some(base) = base {
        if base.len() > MAX_REF
            || base.starts_with('-')
            || base.contains('\0')
            || base.chars().any(char::is_control)
        {
            return Err(fail(400, "base is not a branch or commit"));
        }
    }
    let root = owned_root(data)?;
    let title = title.trim();
    worktree::ensure_with(
        folder,
        &root,
        session_id,
        &EnsureOptions {
            title: (!title.is_empty()).then(|| title.to_owned()),
            base: base.map(str::to_owned),
        },
    )
    .map_err(|m| fail(422, m))
    .inspect(hide_session_state)
}

/// The session's own scaffolding (`.jan/`, written into the folder the tools
/// work in) must never be committed or merged as the session's work. The
/// repository's local, unversioned exclude file is the one place git reads for
/// a linked worktree; `.jan/` is added there once.
fn hide_session_state(record: &WorktreeRecord) {
    let Ok(path) = worktree::run(
        Path::new(&record.path),
        &["rev-parse", "--git-path", "info/exclude"],
    ) else {
        return;
    };
    let path = {
        let p = PathBuf::from(path);
        if p.is_absolute() {
            p
        } else {
            Path::new(&record.path).join(p)
        }
    };
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    if current.lines().any(|l| l.trim() == ".jan/") {
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let separator = if current.is_empty() || current.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    let _ = std::fs::write(&path, format!("{current}{separator}.jan/\n"));
}

/// Where the session's tools work: the same subfolder of the worktree as the
/// folder was of the repository.
pub fn tool_dir(record: &WorktreeRecord, folder: &Path) -> PathBuf {
    let wt = PathBuf::from(&record.path);
    let top = Path::new(&record.source_root).canonicalize().ok();
    let rel = top.and_then(|top| folder.strip_prefix(top).ok().map(Path::to_path_buf));
    match rel {
        Some(rel) if !rel.as_os_str().is_empty() && wt.join(&rel).is_dir() => wt.join(rel),
        _ => wt,
    }
}

/// A stored record, checked the way every use must: still the worktree its
/// repository lists, under the owned root, in a repository inside a root.
pub fn validated(data: &Path, roots: &[PathBuf], record: &WorktreeRecord) -> Result<(), Fail> {
    let top = Path::new(&record.source_root).canonicalize().map_err(|_| {
        fail(
            409,
            "that session's repository is not on this server any more",
        )
    })?;
    if !roots.iter().any(|r| top.starts_with(r)) {
        return Err(fail(
            403,
            "that session's repository is outside the folders this server allows",
        ));
    }
    let owned = owned_root(data)?;
    worktree::ensure_owned(record, &owned).map_err(|m| fail(403, m))
}

pub fn state_word(state: &WorktreeState) -> &'static str {
    match state {
        WorktreeState::Ready => "ready",
        WorktreeState::Missing => "missing",
        WorktreeState::Corrupt => "corrupt",
        WorktreeState::BranchMoved => "branch-moved",
        WorktreeState::IdentityChanged => "identity-changed",
    }
}

// ---------------------------------------------------------------------------
// Operations on a session's worktree
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum Op {
    State,
    Pending,
    Unmerged,
    CommitPending {
        message: String,
    },
    Merge {
        target: Option<String>,
        message: Option<String>,
    },
    Rename {
        title: String,
    },
    Discard {
        force: bool,
    },
}

impl Op {
    /// Whether it changes the worktree or its repository (refused while a
    /// turn is writing there).
    pub fn mutates(&self) -> bool {
        matches!(
            self,
            Op::CommitPending { .. } | Op::Merge { .. } | Op::Rename { .. } | Op::Discard { .. }
        )
    }

    fn name(&self) -> &'static str {
        match self {
            Op::State => "state",
            Op::Pending => "pending",
            Op::Unmerged => "unmerged",
            Op::CommitPending { .. } => "commit_pending",
            Op::Merge { .. } => "merge",
            Op::Rename { .. } => "rename",
            Op::Discard { .. } => "discard",
        }
    }
}

fn clean(raw: Option<&str>, max: usize) -> Option<String> {
    raw.map(|s| {
        s.chars()
            .filter(|c| !c.is_control() || *c == '\n')
            .take(max)
            .collect::<String>()
    })
    .map(|s| s.trim().to_owned())
    .filter(|s| !s.is_empty())
}

pub fn parse_op(command: &str, args: &Value) -> Result<Op, Fail> {
    let text = |key: &str| args.get(key).and_then(Value::as_str);
    Ok(match command {
        "agent_worktree_state" => Op::State,
        "agent_worktree_pending" => Op::Pending,
        "agent_worktree_unmerged" => Op::Unmerged,
        "agent_worktree_commit_pending" => Op::CommitPending {
            message: clean(text("message"), MAX_MESSAGE)
                .unwrap_or_else(|| "Work from a Flint session".to_owned()),
        },
        "agent_worktree_merge" => {
            let target = clean(text("target"), MAX_REF);
            if target.as_deref().is_some_and(|t| t.starts_with('-')) {
                return Err(fail(400, "target is not a branch"));
            }
            Op::Merge {
                target,
                message: clean(text("commitMessage"), MAX_MESSAGE),
            }
        }
        "agent_worktree_rename" => Op::Rename {
            title: clean(text("title"), 80).ok_or_else(|| fail(400, "title is required"))?,
        },
        "agent_worktree_discard" => Op::Discard {
            force: args.get("force").and_then(Value::as_bool).unwrap_or(false),
        },
        _ => return Err(fail(404, "Unknown agent command")),
    })
}

/// Run one operation against the session `id`'s worktree. Callable for a live
/// session (from its actor, so it cannot interleave with a turn) or a stored
/// one. `by` and `ip` are the digests the audit record carries.
pub fn execute(
    data: &Path,
    roots: &[PathBuf],
    id: &str,
    op: Op,
    by: &str,
    ip: &str,
) -> Result<Value, Fail> {
    let (_, thread) = agent_runs::open(data, roots, id)?;
    let meta = thread.get("metadata").cloned().unwrap_or(Value::Null);
    if meta.get("source").and_then(Value::as_str) != Some("runner") {
        return Err(fail(
            403,
            "only sessions started on this server have a worktree here",
        ));
    }
    if meta.get("worktreeDiscarded").and_then(Value::as_bool) == Some(true) {
        return Err(fail(410, "this session's worktree was discarded"));
    }
    let record = record_of(&meta).ok_or_else(|| fail(404, "that session has no worktree"))?;
    validated(data, roots, &record)?;
    let state = worktree::state(&record);
    let needs_ready = matches!(
        op,
        Op::CommitPending { .. } | Op::Merge { .. } | Op::Rename { .. }
    );
    if needs_ready && state != WorktreeState::Ready {
        return Err(fail(
            409,
            format!(
                "the worktree is {}; nothing was changed",
                state_word(&state)
            ),
        ));
    }
    let name = op.name();
    let answer = match op {
        Op::State => json!({
            "state": state_word(&state),
            "worktree": record_json(&record),
            "project": record.source_root,
        }),
        Op::Pending => json!({ "files": worktree::pending(&record) }),
        Op::Unmerged => json!({ "commits": worktree::unmerged_commits(&record, None) }),
        Op::CommitPending { message } => {
            let committed =
                worktree::commit_pending(&record, &message).map_err(|m| fail(422, m))?;
            json!({ "committed": committed })
        }
        Op::Merge { target, message } => {
            let outcome = worktree::merge(&record, target.as_deref(), message.as_deref())
                .map_err(|m| fail(422, m))?;
            serde_json::to_value(outcome).unwrap_or(Value::Null)
        }
        Op::Rename { title } => {
            let renamed = worktree::rename_branch(&record, id, &title).map_err(|m| fail(422, m))?;
            let stored = record_json(&renamed);
            write_metadata(data, id, |m| m[KEY] = stored)?;
            json!({ "worktree": record_json(&renamed) })
        }
        Op::Discard { force } => {
            worktree::discard_owned(&record, &owned_root(data)?, force)
                .map_err(|m| fail(422, m))?;
            write_metadata(data, id, |m| {
                if let Some(obj) = m.as_object_mut() {
                    obj.remove(KEY);
                }
                m["worktreeDiscarded"] = json!(true);
            })?;
            json!({ "discarded": true })
        }
    };
    if !matches!(name, "state" | "pending" | "unmerged") {
        audit(data, id, name, &record.branch, by, ip, &answer);
    }
    Ok(answer)
}

/// Deleting a session takes its worktree and branch with it, so they do not
/// pile up under the server's folder. A worktree with uncommitted changes, or
/// commits not yet merged, refuses (409) unless `force`: that work exists
/// nowhere else. A record that is not a worktree this server owns (git does
/// not list it under the owned root, or its repository is outside every
/// `--agent-root`) is never touched; the delete goes ahead without it.
pub fn release_for_delete(
    data: &Path,
    roots: &[PathBuf],
    id: &str,
    force: bool,
) -> Result<(), Fail> {
    let Some(record) = thread_metadata(data, id).as_ref().and_then(record_of) else {
        return Ok(());
    };
    if validated(data, roots, &record).is_err() {
        return Ok(());
    }
    worktree::discard_owned(&record, &owned_root(data)?, force).map_err(|m| {
        fail(
            409,
            format!("merge or discard this session's worktree first, or delete with force: {m}"),
        )
    })
}

/// Flint's worktrees of the repository at `project` (already confined).
pub fn list(data: &Path, project: &Path) -> Result<Value, Fail> {
    let root = owned_root(data)?;
    let _ = worktree::prune(project);
    let found: Vec<Value> = worktree::list(project, &root)
        .iter()
        .map(record_json)
        .collect();
    Ok(json!({ "worktrees": found }))
}

/// One state-changing operation, in the session's own event log.
pub fn audit(
    data: &Path,
    session: &str,
    op: &str,
    branch: &str,
    by: &str,
    ip: &str,
    outcome: &Value,
) {
    let summary = json!({
        "merged": outcome.get("merged"),
        "fastForward": outcome.get("fastForward"),
        "conflicts": outcome.get("conflicts").and_then(Value::as_array).map(Vec::len),
        "committed": outcome.get("committed"),
        "discarded": outcome.get("discarded"),
    });
    let _ = tauri_plugin_agent_tools::event_log::append(
        data,
        tauri_plugin_agent_tools::event_log::NewEvent {
            id: format!("worktree:{op}:{}", uuid::Uuid::new_v4()),
            session: session.to_owned(),
            run: String::new(),
            invocation: String::new(),
            kind: format!("worktree.{op}"),
            payload: json!({
                "branch": branch,
                "by": by,
                "ip": ip,
                "outcome": summary,
                "source": "server-runner",
            }),
        },
    );
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

pub struct Proposed {
    pub record: ProposalRecord,
    pub digest: String,
    pub superseded: usize,
}

fn digest_of(inputs: &[FileInput]) -> String {
    let mut h = Sha256::new();
    for input in inputs {
        h.update(input.path.as_bytes());
        h.update([0]);
        match &input.proposed {
            Some(bytes) => {
                h.update(b"+");
                h.update(bytes);
            }
            None => h.update(b"-"),
        }
        h.update([1]);
    }
    hex::encode(h.finalize())
}

/// Store what the session's worktree changed as a proposal, when it changed
/// something new since `last` (a digest of the previous proposal's content).
/// An earlier pending proposal of this session is rejected as superseded.
/// Nothing is applied: `agent_proposal_apply` needs a hash-approved approval.
pub fn propose(
    data: &Path,
    roots: &[PathBuf],
    session: &str,
    record: &WorktreeRecord,
    last: Option<&str>,
) -> Result<Option<Proposed>, String> {
    validated(data, roots, record)
        .map_err(|f| f.body.as_str().unwrap_or("worktree refused").to_owned())?;
    let state = worktree::state(record);
    if state != WorktreeState::Ready {
        return Err(format!(
            "the worktree is {}, so its changes are not proposed",
            state_word(&state)
        ));
    }
    let inputs = proposals::changes_in_worktree(record).map_err(|e| match e {
        ChangesError::LinkEscape(_) | ChangesError::Other(_) => e.to_string(),
    })?;
    if inputs.is_empty() {
        return Ok(None);
    }
    let digest = digest_of(&inputs);
    if last == Some(digest.as_str()) {
        return Ok(None);
    }
    let scope = ProposalScope {
        session: session.to_owned(),
        run: String::new(),
        agent: "main".to_owned(),
        project: record.source_root.clone(),
        worktree: record.path.clone(),
        ..Default::default()
    };
    let created =
        proposal::create(data, scope.clone(), &record.base_sha, inputs).map_err(|e| e.message())?;
    let mut superseded = 0;
    for earlier in proposal::list(data, &record.source_root) {
        if earlier.id != created.id
            && earlier.state == ProposalState::Pending
            && earlier.scope.session == session
            && proposal::reject(data, &earlier.id, &scope).is_ok()
        {
            superseded += 1;
        }
    }
    Ok(Some(Proposed {
        record: created,
        digest,
        superseded,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> WorktreeRecord {
        WorktreeRecord {
            path: "/data/worktrees/ab/cd".into(),
            branch: "flint/x-1".into(),
            base_sha: "a".repeat(40),
            source_root: "/work/app".into(),
            identity: RepoIdentity {
                root: "/work/app".into(),
                first_commit: Some("b".repeat(40)),
            },
            uncommitted_at_creation: vec!["f.txt".into()],
            base_branch: Some("main".into()),
            notes: vec!["n".into()],
        }
    }

    #[test]
    fn a_record_survives_the_thread_metadata() {
        let record = sample();
        let meta = json!({ KEY: record_json(&record) });
        assert_eq!(record_of(&meta), Some(record));
        // The CLI's own pointer has no base commit and is not a managed record.
        assert_eq!(
            record_of(&json!({ KEY: { "path": "/x", "branch": "jan/agent/1" } })),
            None
        );
        assert_eq!(record_of(&json!({})), None);
    }

    #[test]
    fn operations_parse_cleanly_and_say_which_mutate() {
        let merge = parse_op(
            "agent_worktree_merge",
            &json!({ "target": " main ", "commitMessage": "x\u{7}y" }),
        )
        .unwrap();
        match &merge {
            Op::Merge { target, message } => {
                assert_eq!(target.as_deref(), Some("main"));
                assert_eq!(message.as_deref(), Some("xy"));
            }
            other => panic!("{other:?}"),
        }
        assert!(merge.mutates());
        assert!(!parse_op("agent_worktree_state", &json!({}))
            .unwrap()
            .mutates());
        assert_eq!(
            parse_op("agent_worktree_merge", &json!({ "target": "--x" }))
                .unwrap_err()
                .status,
            400
        );
        assert_eq!(
            parse_op("agent_worktree_rename", &json!({}))
                .unwrap_err()
                .status,
            400
        );
        assert_eq!(
            parse_op("agent_worktree_bogus", &json!({}))
                .unwrap_err()
                .status,
            404
        );
        assert!(handles("agent_worktree_list") && !handles("agent_campaign_merge_task"));
    }

    /// A data folder with one runner thread whose worktree is real.
    fn delete_fixture(id: &str) -> (tempfile::TempDir, PathBuf, Vec<PathBuf>, WorktreeRecord) {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        worktree::run(&repo, &["init", "-q", "-b", "main"]).unwrap();
        std::fs::write(repo.join("a.txt"), "one").unwrap();
        worktree::run(&repo, &["add", "."]).unwrap();
        worktree::run(&repo, &["commit", "-q", "-m", "first"]).unwrap();
        let record = worktree::ensure(&repo, &owned_root(&data).unwrap(), id).unwrap();
        let thread = json!({ "id": id, "metadata": { "source": "runner", KEY: record_json(&record) } });
        let path = crate::core::threads::utils::get_thread_metadata_path(&data, id);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, thread.to_string()).unwrap();
        let roots = vec![repo.canonicalize().unwrap()];
        (dir, data, roots, record)
    }

    #[test]
    fn delete_session_discards_clean_worktree() {
        let (_dir, data, roots, record) = delete_fixture("del-clean");
        release_for_delete(&data, &roots, "del-clean", false).expect("clean worktree is released");
        assert!(!PathBuf::from(&record.path).exists());
    }

    #[test]
    fn delete_session_with_dirty_worktree_refused_without_force() {
        let (_dir, data, roots, record) = delete_fixture("del-dirty");
        std::fs::write(PathBuf::from(&record.path).join("notes.txt"), "mine").unwrap();
        let refused = release_for_delete(&data, &roots, "del-dirty", false).unwrap_err();
        assert_eq!(refused.status, 409);
        assert!(PathBuf::from(&record.path).join("notes.txt").is_file());
    }

    #[test]
    fn delete_session_force_discards() {
        let (_dir, data, roots, record) = delete_fixture("del-force");
        std::fs::write(PathBuf::from(&record.path).join("notes.txt"), "mine").unwrap();
        release_for_delete(&data, &roots, "del-force", true).expect("force discards");
        assert!(!PathBuf::from(&record.path).exists());
    }

    #[test]
    fn delete_never_removes_foreign_path() {
        let (dir, data, roots, record) = delete_fixture("del-foreign");
        let foreign = dir.path().join("foreign");
        std::fs::create_dir_all(&foreign).unwrap();
        std::fs::write(foreign.join("keep.txt"), "keep").unwrap();
        let mut forged = record.clone();
        forged.path = foreign.to_string_lossy().into_owned();
        write_metadata(&data, "del-foreign", |m| m[KEY] = record_json(&forged)).unwrap();
        release_for_delete(&data, &roots, "del-foreign", true).expect("nothing to release");
        assert!(foreign.join("keep.txt").is_file());
        assert!(PathBuf::from(&record.path).is_dir(), "the real worktree is not the forged record's");
    }

    #[test]
    fn the_tool_directory_keeps_the_subfolder() {
        let dir = tempfile::tempdir().unwrap();
        let (repo, wt) = (dir.path().join("repo"), dir.path().join("wt"));
        std::fs::create_dir_all(repo.join("pkg")).unwrap();
        std::fs::create_dir_all(wt.join("pkg")).unwrap();
        let mut record = sample();
        record.path = wt.to_string_lossy().into_owned();
        record.source_root = repo.to_string_lossy().into_owned();
        let repo = repo.canonicalize().unwrap();
        assert_eq!(tool_dir(&record, &repo.join("pkg")), wt.join("pkg"));
        assert_eq!(tool_dir(&record, &repo), wt);
    }
}
