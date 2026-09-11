//! Tauri command surface for the agent's project-scoped state: skills, the
//! skill hub, plugins, and the git branch shown in the workspace pill.
//!
//! The agent *loop* is no longer driven from here. The desktop runs it in the
//! renderer on the Vercel AI SDK (`web-app/src/lib/coworkRunner.ts`), calling
//! the tool plugin directly; `core::agent::r#loop` stays for the headless CLI
//! and the OpenAI-compatible API server, which still orchestrate in Rust.

use crate::core::agent::checkpoint;
use crate::core::agent::git;
use crate::core::agent::plugins;
use crate::core::agent::project::{
    agent_toml_path, ensure_project, load_agent_config, set_skills_enabled_in_agent_toml,
};
use crate::core::agent::skill_hub;
use crate::core::agent::skills as agent_skills;
use crate::core::agent::subagent;
use crate::core::agent::worktree;
use crate::core::app::commands::get_jan_data_folder_path;
use tauri_plugin_agent_tools::skills::{self, SkillMeta};
use tauri_plugin_agent_tools::workspace;

/// Strip the internal `ERROR: ` prefix (an agent-tool-output convention) so the
/// message reads cleanly in a UI toast.
fn ui_error(e: String) -> String {
    e.strip_prefix("ERROR: ").map(str::to_string).unwrap_or(e)
}

/// List the skills under `<project>/.jan/agent/skills/` (folder `<name>/SKILL.md`
/// and legacy flat `<name>.md`). These are the same skills `load_skills` injects
/// into the agent's system prompt; managing them here is CRUD over that
/// directory. Read-only: returns empty when the project isn't scaffolded yet.
#[tauri::command]
pub async fn agent_skill_list(project: String) -> Result<Vec<SkillMeta>, String> {
    let root = std::path::PathBuf::from(&project);
    Ok(skills::list_meta(&workspace::project_store(&root)))
}

/// Read one skill's raw SKILL.md (frontmatter included) for the editor.
#[tauri::command]
pub async fn agent_skill_read(project: String, name: String) -> Result<String, String> {
    let root = std::path::PathBuf::from(&project);
    skills::read_raw(&workspace::project_store(&root), &name).map_err(ui_error)
}

/// Create or overwrite a skill. New skills are written as `<name>/SKILL.md`;
/// existing ones keep their on-disk form. `name` is sanitized (no path escape).
#[tauri::command]
pub async fn agent_skill_write(
    project: String,
    name: String,
    content: String,
) -> Result<(), String> {
    let root = std::path::PathBuf::from(&project);
    ensure_project(&root)?;
    skills::write(&workspace::project_store(&root), &name, &content).map_err(ui_error)
}

/// Delete a skill by name. Idempotent: a missing skill is treated as success.
#[tauri::command]
pub async fn agent_skill_delete(project: String, name: String) -> Result<(), String> {
    let root = std::path::PathBuf::from(&project);
    skills::delete(&workspace::project_store(&root), &name).map_err(ui_error)
}

/// List the skills available on Anthropic's public skill hub (name + purpose).
#[tauri::command]
pub async fn agent_skill_hub_list() -> Result<Vec<skill_hub::HubSkill>, String> {
    skill_hub::list().await.map_err(ui_error)
}

/// Download a hub skill (SKILL.md + bundled files) into the project as
/// `<name>/SKILL.md`. Scaffolds the project on first use.
#[tauri::command]
pub async fn agent_skill_hub_import(project: String, name: String) -> Result<(), String> {
    let root = std::path::PathBuf::from(&project);
    ensure_project(&root)?;
    skill_hub::import(&root, &name).await.map_err(ui_error)
}

/// Read the project's enabled-skill whitelist (`[skills].enabled`). An empty
/// list means all skills are enabled.
#[tauri::command]
pub async fn agent_skill_enabled_get(project: String) -> Result<Vec<String>, String> {
    let root = std::path::PathBuf::from(&project);
    Ok(load_agent_config(&root)
        .map(|c| c.skills.enabled)
        .unwrap_or_default())
}

/// Set the project's enabled-skill whitelist. Empty = all skills enabled.
/// Persisted to `[skills].enabled` in agent.toml (format-preserving).
#[tauri::command]
pub async fn agent_skill_enabled_set(project: String, enabled: Vec<String>) -> Result<(), String> {
    let root = std::path::PathBuf::from(&project);
    ensure_project(&root)?;
    set_skills_enabled_in_agent_toml(&agent_toml_path(&root), &enabled).map_err(ui_error)
}

/// Build the user message for invoking an enabled skill (`/skill:<name>` /
/// `<skill>` semantics shared with the console): the full skill body wrapped
/// in an invocation header, skill directory announcement for bundled files,
/// and the user's `args` threaded in. Err when the skill is unknown or
/// disabled. UIs submit the returned message through their own session flow.
#[tauri::command]
pub async fn agent_skill_invoke(
    project: String,
    name: String,
    args: String,
) -> Result<String, String> {
    let root = std::path::PathBuf::from(&project);
    agent_skills::build_invocation_message(&root, &name, &args)
        .map(|(message, _)| message)
        .map_err(ui_error)
}

/// List installed plugins under `<project>/.jan/agent/plugins/` with metadata
/// and skill counts.
#[tauri::command]
pub async fn agent_plugin_list(project: String) -> Result<Vec<plugins::InstalledPlugin>, String> {
    let root = std::path::PathBuf::from(&project);
    Ok(plugins::installed(&root))
}

/// Install a plugin from a git URL or configured marketplace name.
#[tauri::command]
pub async fn agent_plugin_install(
    project: String,
    spec: String,
) -> Result<plugins::InstalledPlugin, String> {
    let root = std::path::PathBuf::from(&project);
    plugins::install(&root, &spec).await.map_err(ui_error)
}

/// Remove an installed plugin by directory name.
#[tauri::command]
pub async fn agent_plugin_remove(project: String, name: String) -> Result<(), String> {
    let root = std::path::PathBuf::from(&project);
    plugins::remove(&root, &name).map_err(ui_error)
}

/// Search the configured plugin marketplace.
#[tauri::command]
pub async fn agent_plugin_search(
    project: String,
    query: String,
) -> Result<Vec<plugins::MarketEntry>, String> {
    let root = std::path::PathBuf::from(&project);
    plugins::search(&root, &query).await.map_err(ui_error)
}

/// Return the git branch name for the project at `project`, or `None` when the
/// folder is not inside a git repo (or git is not installed). Used by the Code
/// UI to display the current branch alongside the working directory.
#[tauri::command]
pub fn agent_git_branch(project: String) -> Option<String> {
    git::current_branch(std::path::Path::new(&project))
}

/// The cap, in bytes, for a single lazily-loaded file diff. Larger diffs come
/// back truncated with a friendly marker rather than flooding the webview.
const MAX_FILE_DIFF_BYTES: usize = 512 * 1024;

/// Read-only working-tree status for the attached project under `scope`
/// (`working` | `staged` | `all`). Returns branch, repo root, and the changed
/// files with their status, staged/unstaged flags and addition/deletion counts.
///
/// Strictly read-only: it never stages, unstages, commits, or otherwise mutates
/// the repository. `Ok(None)` means the folder is not inside a git work tree
/// (or git is unavailable), which the UI shows as "no repository" rather than an
/// error.
#[tauri::command]
pub async fn agent_git_status(
    project: String,
    scope: String,
) -> Result<Option<git::GitStatus>, String> {
    let path = std::path::Path::new(&project);
    // A non-repo folder is a normal state, not a failure to surface.
    if git::repo_root(path).is_none() {
        return Ok(None);
    }
    git::status(path, git::DiffScope::parse(&scope))
        .map(Some)
        .map_err(ui_error)
}

/// Read-only unified diff for a single file under `scope`, loaded lazily when a
/// review row is expanded. Untracked files are synthesized as new-file diffs;
/// binary files and oversized diffs come back flagged. Never mutates the repo.
#[tauri::command]
pub async fn agent_git_file_diff(
    project: String,
    path: String,
    scope: String,
) -> Result<git::GitFileDiff, String> {
    git::file_diff(
        std::path::Path::new(&project),
        &path,
        git::DiffScope::parse(&scope),
        MAX_FILE_DIFF_BYTES,
    )
    .map_err(ui_error)
}

/// A saved subagent definition, for the `task` tool's advertised name list and
/// the Cowork subagents panel.
#[derive(serde::Serialize)]
pub struct SubagentDefinitionDto {
    pub name: String,
    pub description: String,
    pub system_prompt: String,
    /// When set, the child's toolset is this list intersected with the parent's;
    /// it never widens. `None` inherits the parent's set.
    pub allowed_tools: Option<Vec<String>>,
    pub model: Option<String>,
    /// `builtin` for a role Jan ships, `user` for one saved on this machine.
    pub scope: subagent::SubagentScope,
}

/// The roles Jan ships (AH-094..099), then every subagent saved for the
/// desktop, from the single `<jan_data>/agent-workspace/subagents/` directory.
/// A saved definition replaces a built-in role of the same name, and only the
/// winner is listed, because the renderer resolves a name to its first match.
///
/// Deliberately not the CLI's plugin/user/project merge: Cowork has no project
/// root in a default session, and an attached folder is mounted read-only, so
/// scanning it would let a cloned repo inject a system prompt and a tool
/// allowlist into the agent. Malformed files are skipped, so a bad TOML costs one
/// definition rather than the whole list.
#[tauri::command]
pub async fn agent_subagent_list<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<Vec<SubagentDefinitionDto>, String> {
    let dir = subagent::desktop_subagents_dir(&get_jan_data_folder_path(app_handle));
    let saved: Vec<subagent::SubagentDefinition> =
        subagent::SubagentRegistry::load_one(&dir, subagent::SubagentScope::User)
            .list()
            .into_iter()
            .cloned()
            .collect();
    let builtins: Vec<subagent::SubagentDefinition> = crate::core::agent::roles::definitions()
        .into_iter()
        .filter(|b| !saved.iter().any(|s| s.name == b.name))
        .collect();
    Ok(builtins
        .into_iter()
        .chain(saved)
        .map(|d| SubagentDefinitionDto {
            name: d.name,
            description: d.description,
            system_prompt: d.system_prompt,
            allowed_tools: d.allowed_tools,
            model: d.model,
            scope: d.scope,
        })
        .collect())
}

/// Create, or reuse, the managed worktree for a Cowork session.
///
/// Idempotent by design: a session that already has one gets the same record
/// back rather than a second branch beside its work. Every refusal — a branch
/// that is already someone else's, a directory in our place that is not a
/// worktree, a repository with no commits — comes back as a message the UI can
/// show, because each of them means something happened outside Jan that a
/// silently chosen alternative would hide.
#[tauri::command]
pub fn agent_worktree_ensure(
    data_folder: String,
    session_id: String,
    project: String,
) -> Result<worktree::WorktreeRecord, String> {
    let roots = owned_worktrees_root(&data_folder)?;
    worktree::ensure(std::path::Path::new(&project), &roots, &session_id)
}

/// Jan's worktree folder, absolute. See [`worktree::absolute`]: a relative
/// data folder -- the configured default is `./data` -- would otherwise be
/// resolved one way by git and another by everything else.
fn owned_worktrees_root(data_folder: &str) -> Result<std::path::PathBuf, String> {
    worktree::absolute(&workspace::worktrees_dir(std::path::Path::new(data_folder)))
}

/// What state a recorded worktree is actually in.
///
/// Asked before a run uses one, so a worktree deleted, moved or moved-off-branch
/// between sessions is reported rather than written into.
#[tauri::command]
pub fn agent_worktree_state(record: WorktreeRecordInput) -> worktree::WorktreeState {
    worktree::state(&record.into())
}

/// Remove a worktree and its branch.
///
/// Only ever called because someone asked: this is the one operation here that
/// destroys work, so it is never cleanup on a path doing something else.
///
/// The record arrives over IPC, so the path is checked against the folder Jan
/// owns before anything is removed. Without that, a wrong record — a bug, a
/// stale value, anything — would be a request to delete an arbitrary directory
/// and its branch.
#[tauri::command]
pub fn agent_worktree_discard(
    data_folder: String,
    record: WorktreeRecordInput,
    force: bool,
) -> Result<(), String> {
    let roots = owned_worktrees_root(&data_folder)?;
    let record: worktree::WorktreeRecord = record.into();
    if !std::path::Path::new(&record.path).starts_with(&roots) {
        return Err(format!(
            "{} is not a worktree Jan manages, so Jan will not remove it",
            record.path
        ));
    }
    worktree::discard(&record, force)
}

/// What a worktree holds that removing it would destroy.
///
/// Asked before offering to remove one, so the confirmation names the work
/// rather than asking about a path.
#[tauri::command]
pub fn agent_worktree_pending(record: WorktreeRecordInput) -> Vec<String> {
    worktree::pending(&record.into())
}

/// Every Jan-owned worktree of this repository that is on disk.
///
/// The recovery surface. A session's own record dies with the process, so
/// after a crash this is the only truthful answer to "where is the work that
/// run was doing" — and it is only that. Nothing here authorizes anything: a
/// listed worktree is a place, and writing to one still requires the user to
/// authorize it again.
#[tauri::command]
pub fn agent_worktree_list(data_folder: String, project: String) -> Vec<worktree::WorktreeRecord> {
    let Ok(roots) = owned_worktrees_root(&data_folder) else {
        return Vec::new();
    };
    let repo = std::path::Path::new(&project);
    // Bookkeeping for directories that are gone is dropped first, so a crash
    // that left Git's record behind does not show a worktree that is not there.
    let _ = worktree::prune(repo);
    worktree::list(repo, &roots)
}

/// Why a proposal command refused, with the conflicts when that is the reason,
/// so the review can mark the exact hunks rather than show a sentence.
#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProposalFailure {
    pub message: String,
    pub conflicts: Vec<tauri_plugin_agent_tools::proposal::Conflict>,
    /// What kind of refusal this is, when the review needs to tell them apart:
    /// a deleted worktree, a link out of one, a child that did not finish.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<crate::core::agent::team_children::ChildErrorKind>,
    /// Selected files whose dependency, lock file or migration flag was not
    /// acknowledged (AH-154/155/156). Nothing was written.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub unacknowledged: Vec<String>,
}

impl From<tauri_plugin_agent_tools::proposal::ProposalError> for ProposalFailure {
    fn from(e: tauri_plugin_agent_tools::proposal::ProposalError) -> Self {
        use tauri_plugin_agent_tools::proposal::ProposalError;
        let conflicts = match &e {
            ProposalError::Conflicts(c) => c.clone(),
            _ => Vec::new(),
        };
        let unacknowledged = match &e {
            ProposalError::Unacknowledged(paths) => paths.clone(),
            _ => Vec::new(),
        };
        ProposalFailure {
            message: e.message(),
            conflicts,
            kind: None,
            unacknowledged,
        }
    }
}

impl From<crate::core::agent::team_children::ChildError> for ProposalFailure {
    fn from(e: crate::core::agent::team_children::ChildError) -> Self {
        ProposalFailure {
            message: e.message,
            conflicts: Vec::new(),
            kind: Some(e.kind),
            unacknowledged: Vec::new(),
        }
    }
}

fn proposal_failure(message: impl Into<String>) -> ProposalFailure {
    ProposalFailure {
        message: message.into(),
        conflicts: Vec::new(),
        kind: None,
        unacknowledged: Vec::new(),
    }
}

/// Run a proposal operation on a blocking thread.
///
/// These commands spawn git once per changed file and read and write every
/// file a proposal names. A synchronous Tauri command runs on the main thread,
/// so while one of them worked the whole window stopped responding -- in the
/// Windows smoke run, for longer than a minute.
async fn off_the_main_thread<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, ProposalFailure> + Send + 'static,
) -> Result<T, ProposalFailure> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| proposal_failure(format!("the proposal operation did not finish: {e}")))?
}

/// Store what a run changed in its worktree as a proposal. AH-146/AH-109.
///
/// Nothing is applied. The record arrives over IPC, so it is checked the way
/// discard checks it -- inside the folder Jan owns, and still the worktree it
/// says it is -- before anything in it is read.
#[tauri::command]
pub async fn agent_proposal_from_worktree(
    app: tauri::AppHandle,
    record: WorktreeRecordInput,
    session: String,
    run: Option<String>,
    agent: Option<String>,
) -> Result<tauri_plugin_agent_tools::proposal::ProposalRecord, ProposalFailure> {
    let data_folder = get_jan_data_folder_path(app);
    off_the_main_thread(move || {
        let started = std::time::Instant::now();
        let out = proposal_from_worktree(data_folder, record, session, run, agent);
        log::debug!("proposal from worktree took {:?}", started.elapsed());
        out
    })
    .await
}

fn proposal_from_worktree(
    data_folder: std::path::PathBuf,
    record: WorktreeRecordInput,
    session: String,
    run: Option<String>,
    agent: Option<String>,
) -> Result<tauri_plugin_agent_tools::proposal::ProposalRecord, ProposalFailure> {
    use tauri_plugin_agent_tools::proposal;
    let roots = worktree::absolute(&workspace::worktrees_dir(&data_folder))
        .map_err(proposal_failure)?;
    let record: worktree::WorktreeRecord = record.into();
    // Compared canonically: the data folder Jan resolves and the one the
    // renderer was handed can differ in form (a verbatim `\\?\` prefix, case)
    // while naming the same directory, and a lexical comparison refused a
    // worktree Jan had just made.
    let inside = match (
        std::fs::canonicalize(&record.path),
        std::fs::canonicalize(&roots),
    ) {
        (Ok(path), Ok(roots)) => path.starts_with(roots),
        _ => false,
    };
    if !inside {
        return Err(proposal_failure(format!(
            "{} is not a worktree Jan manages",
            record.path
        )));
    }
    if worktree::state(&record) != worktree::WorktreeState::Ready {
        return Err(proposal_failure(
            "the worktree is not in the state it was recorded in, so its changes are not proposed",
        ));
    }
    let inputs = crate::core::agent::proposals::changes_in_worktree(&record).map_err(|e| {
        let kind = match e {
            crate::core::agent::proposals::ChangesError::LinkEscape(_) => {
                Some(crate::core::agent::team_children::ChildErrorKind::LinkEscape)
            }
            crate::core::agent::proposals::ChangesError::Other(_) => None,
        };
        ProposalFailure {
            kind,
            ..proposal_failure(e.to_string())
        }
    })?;
    if inputs.is_empty() {
        return Err(proposal_failure("the worktree has no changes to propose"));
    }
    let scope = proposal::ProposalScope {
        session,
        run: run.unwrap_or_default(),
        agent: agent.unwrap_or_else(|| "main".to_string()),
        project: record.source_root.clone(),
        worktree: record.path.clone(),
        ..Default::default()
    };
    proposal::create(&data_folder, scope, &record.base_sha, inputs).map_err(Into::into)
}

/// The proposals for a project, newest first.
#[tauri::command]
pub async fn agent_proposal_list(
    app: tauri::AppHandle,
    project: String,
) -> Vec<tauri_plugin_agent_tools::proposal::ProposalRecord> {
    let data_folder = get_jan_data_folder_path(app);
    off_the_main_thread(move || {
        Ok(tauri_plugin_agent_tools::proposal::list(
            &data_folder,
            &project,
        ))
    })
    .await
    .unwrap_or_default()
}

/// Apply an approval. The destination is the stored proposal's project, never
/// a path sent with the approval.
#[tauri::command]
pub async fn agent_proposal_apply(
    app: tauri::AppHandle,
    approval: tauri_plugin_agent_tools::proposal::Approval,
) -> Result<tauri_plugin_agent_tools::proposal::ApplyReport, ProposalFailure> {
    use tauri_plugin_agent_tools::proposal;
    let data_folder = get_jan_data_folder_path(app);
    off_the_main_thread(move || {
        let stored = proposal::load(&data_folder, &approval.proposal_id)?;
        let destination = std::path::PathBuf::from(&stored.scope.project);
        proposal::apply(&data_folder, &destination, &approval).map_err(Into::into)
    })
    .await
}

/// Reject a proposal outright. Nothing at the destination changes.
#[tauri::command]
pub async fn agent_proposal_reject(
    app: tauri::AppHandle,
    id: String,
    scope: tauri_plugin_agent_tools::proposal::ProposalScope,
) -> Result<tauri_plugin_agent_tools::proposal::ProposalRecord, ProposalFailure> {
    let data_folder = get_jan_data_folder_path(app);
    off_the_main_thread(move || {
        tauri_plugin_agent_tools::proposal::reject(&data_folder, &id, &scope).map_err(Into::into)
    })
    .await
}

/// Jan's worktree folder under the data folder the backend itself resolves.
fn team_roots(data_folder: &std::path::Path) -> Result<std::path::PathBuf, ProposalFailure> {
    worktree::absolute(&workspace::worktrees_dir(data_folder)).map_err(proposal_failure)
}

/// Record that a team's isolated child is starting. AH-109.
///
/// The renderer names the child -- parent session and task id -- and nothing
/// else about where it works: the worktree, branch and base are found here.
#[tauri::command]
pub async fn agent_team_child_begin(
    app: tauri::AppHandle,
    input: crate::core::agent::team_children::BeginInput,
) -> Result<crate::core::agent::team_children::ChildRecord, ProposalFailure> {
    let data_folder = get_jan_data_folder_path(app);
    off_the_main_thread(move || {
        let roots = team_roots(&data_folder)?;
        crate::core::agent::team_children::begin(&data_folder, &roots, input).map_err(Into::into)
    })
    .await
}

/// Record how a team's isolated child ended, and fingerprint what it left.
#[tauri::command]
pub async fn agent_team_child_settle(
    app: tauri::AppHandle,
    parent_session: String,
    task_id: String,
    status: crate::core::agent::team_children::ChildStatus,
    detail: Option<String>,
) -> Result<crate::core::agent::team_children::ChildRecord, ProposalFailure> {
    let data_folder = get_jan_data_folder_path(app);
    off_the_main_thread(move || {
        let roots = team_roots(&data_folder)?;
        crate::core::agent::team_children::settle(
            &data_folder,
            &roots,
            &parent_session,
            &task_id,
            status,
            detail.as_deref().unwrap_or_default(),
        )
        .map_err(Into::into)
    })
    .await
}

/// Every recorded team child of `project`, looked at again on disk.
#[tauri::command]
pub async fn agent_team_children_list(
    app: tauri::AppHandle,
    project: String,
    session: Option<String>,
) -> Vec<crate::core::agent::team_children::ChildView> {
    let data_folder = get_jan_data_folder_path(app);
    off_the_main_thread(move || {
        let roots = team_roots(&data_folder)?;
        Ok(crate::core::agent::team_children::list(
            &data_folder,
            &roots,
            &project,
            session.as_deref(),
        ))
    })
    .await
    .unwrap_or_default()
}

/// Store a team child's changes as a proposal, refusing with a typed reason
/// when they are not what the child left or the child did not finish.
#[tauri::command]
pub async fn agent_team_child_propose(
    app: tauri::AppHandle,
    parent_session: String,
    task_id: String,
    acknowledge: bool,
) -> Result<tauri_plugin_agent_tools::proposal::ProposalRecord, ProposalFailure> {
    let data_folder = get_jan_data_folder_path(app);
    off_the_main_thread(move || {
        let roots = team_roots(&data_folder)?;
        crate::core::agent::team_children::propose(
            &data_folder,
            &roots,
            &parent_session,
            &task_id,
            acknowledge,
        )
        .map_err(Into::into)
    })
    .await
}

/// Take a checkpoint of the tree a run is about to change.
///
/// The snapshot is a commit object off to one side: the user's branch, HEAD,
/// index and working tree are untouched, and only the paths named in `changed`
/// are staged, so the cost is proportional to the turn rather than to the
/// repository.
///
/// `destination` is not a hint. It is what decides, later, whether a rewind may
/// discard anything — so it is recorded with the checkpoint rather than
/// supplied at rewind time by whoever happens to be asking.
#[tauri::command]
pub fn agent_checkpoint_capture(
    root: String,
    thread_id: String,
    parent: Option<String>,
    label: String,
    changed: Vec<String>,
    destination: checkpoint::Destination,
) -> Result<checkpoint::Checkpoint, String> {
    let changed: Vec<std::path::PathBuf> =
        changed.into_iter().map(std::path::PathBuf::from).collect();
    checkpoint::capture(
        std::path::Path::new(&root),
        &thread_id,
        parent.as_deref(),
        &label,
        &changed,
        destination,
    )
}

/// What rewinding to a checkpoint would do, without doing it.
///
/// In a managed tree, a restore. In the user's own checkout, a patch and never
/// anything else — there is no argument to this that turns it into one.
#[tauri::command]
pub fn agent_checkpoint_plan(
    checkpoint: checkpoint::Checkpoint,
    latest: String,
) -> Result<checkpoint::RewindPlan, String> {
    checkpoint::plan(&checkpoint, &latest)
}

/// Roll a Jan-owned tree back to a checkpoint.
///
/// Refuses a checkpoint taken in the user's checkout, whatever the caller
/// says: that path leads to deleting work whose only sin was being in the same
/// directory as the run.
#[tauri::command]
pub fn agent_checkpoint_restore(
    checkpoint: checkpoint::Checkpoint,
    latest: String,
) -> Result<(), String> {
    checkpoint::restore(&checkpoint, &latest)
}

/// Forget a session's snapshot chain.
#[tauri::command]
pub fn agent_checkpoint_forget(root: String, thread_id: String) {
    checkpoint::forget(std::path::Path::new(&root), &thread_id)
}

/// A record as it comes back from the renderer.
///
/// Deserialized into its own type rather than reusing the serialize-only record:
/// what the frontend stores is state Jan wrote, but it arrives over IPC and is
/// treated as input like anything else that does.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRecordInput {
    pub path: String,
    pub branch: String,
    pub base_sha: String,
    pub source_root: String,
    pub identity: RepoIdentityInput,
    #[serde(default)]
    pub uncommitted_at_creation: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoIdentityInput {
    pub root: String,
    pub first_commit: Option<String>,
}

impl From<WorktreeRecordInput> for worktree::WorktreeRecord {
    fn from(input: WorktreeRecordInput) -> Self {
        worktree::WorktreeRecord {
            path: input.path,
            branch: input.branch,
            base_sha: input.base_sha,
            source_root: input.source_root,
            identity: worktree::RepoIdentity {
                root: input.identity.root,
                first_commit: input.identity.first_commit,
            },
            uncommitted_at_creation: input.uncommitted_at_creation,
        }
    }
}

#[cfg(test)]
mod worktree_command_tests {
    use super::*;

    fn record(path: &str) -> WorktreeRecordInput {
        WorktreeRecordInput {
            path: path.to_string(),
            branch: "jan/cowork/x".to_string(),
            base_sha: "a".repeat(40),
            source_root: "/repo".to_string(),
            identity: RepoIdentityInput {
                root: "/repo".to_string(),
                first_commit: None,
            },
            uncommitted_at_creation: Vec::new(),
        }
    }

    /// The record arrives over IPC, so it is input. A wrong one — a bug, a
    /// stale value, anything — must not be a request to delete an arbitrary
    /// directory and its branch.
    #[test]
    fn refuses_to_remove_anything_outside_the_folder_jan_owns() {
        let data = std::env::temp_dir().join(format!("jan_wt_cmd_{}", std::process::id()));
        for path in ["/etc", "/home/someone/important-project", "../../elsewhere"] {
            let err =
                agent_worktree_discard(data.to_string_lossy().to_string(), record(path), true)
                    .expect_err("must refuse");
            assert!(err.contains("not a worktree Jan manages"), "{err}");
        }
    }

    /// And a listing for a folder that is not a repository is empty rather
    /// than an error the UI would have to interpret.
    #[test]
    fn lists_nothing_for_a_folder_that_is_not_a_repository() {
        let data = std::env::temp_dir().join(format!("jan_wt_list_{}", std::process::id()));
        let listed = agent_worktree_list(
            data.to_string_lossy().to_string(),
            std::env::temp_dir().to_string_lossy().to_string(),
        );
        assert!(listed.is_empty());
    }
}

/// Stop work now, at the scope the caller names. AH-051.
///
/// Built on the one cancellation system rather than a second one: this is
/// `lifecycle::emergency_stop`, which is `stop_scope` applied to a wider scope.
/// It grants no authority — stopping work never needs permission that starting
/// it did not — and it never reaches outside the scope it was given, so an
/// application-wide stop is an explicit choice rather than a side effect.
///
/// The report is deliberately honest: if a child process survived the kill it
/// says so and `complete` is false, because telling someone their emergency
/// stop worked when a process is still running is worse than telling them it
/// did not.
#[tauri::command]
pub async fn agent_emergency_stop(
    app: tauri::AppHandle,
    session: Option<String>,
    run: Option<String>,
    call: Option<String>,
) -> Result<tauri_plugin_agent_tools::lifecycle::StopReport, String> {
    use tauri_plugin_agent_tools::lifecycle::{emergency_stop, record_killed, Scope};

    // An empty field means "everything at this level", which is what makes
    // session, run and call scopes fall out of one shape.
    let scope = Scope::new(
        session.unwrap_or_default(),
        run.unwrap_or_default(),
        call.unwrap_or_default(),
    );
    let report = emergency_stop(&scope);

    // Persisted so a restart cannot resume what was killed. Best effort: a
    // failure to record must not un-stop the work.
    let data_folder = crate::core::app::commands::get_jan_data_folder_path(app);
    record_killed(&data_folder, &report);

    Ok(report)
}

/// Retrieve prompt snapshots. AH-078.
///
/// Scoped on purpose. A caller asks for one snapshot by id, or for the
/// snapshots of a run or session it names, and gets nothing outside that: the
/// viewer must not become a way to read another session's prompts, which is
/// where the project context and any file content the agent was given would be.
///
/// The stored payload is already redacted -- redaction happens before
/// persistence, in `snapshot::capture` -- so there is no unredacted form for
/// this command to leak. It returns what is on disk and nothing more.
#[tauri::command]
pub async fn agent_prompt_snapshots(
    app: tauri::AppHandle,
    snapshot_id: Option<String>,
    run: Option<String>,
    session: Option<String>,
) -> Result<Vec<tauri_plugin_agent_tools::snapshot::PromptSnapshot>, String> {
    let data_folder = crate::core::app::commands::get_jan_data_folder_path(app);
    tauri_plugin_agent_tools::snapshot::scoped_lookup(
        &data_folder,
        snapshot_id.as_deref(),
        run.as_deref(),
        session.as_deref(),
    )
}

/// Export a managed worktree as a patch bundle under `<data>/exports`. AH-168.
///
/// The record arrives over IPC and is checked the way a proposal checks it:
/// inside the folder Jan owns, and still the worktree it says it is. Nothing
/// in the worktree or the user's checkout is written.
#[tauri::command]
pub async fn agent_worktree_export(
    app: tauri::AppHandle,
    record: WorktreeRecordInput,
) -> Result<
    crate::core::agent::worktree_export::ExportReport,
    crate::core::agent::worktree_export::ExportError,
> {
    use crate::core::agent::worktree_export::{export, ExportError};
    let data_folder = get_jan_data_folder_path(app);
    let record: worktree::WorktreeRecord = record.into();
    tokio::task::spawn_blocking(move || {
        let roots = worktree::absolute(&workspace::worktrees_dir(&data_folder))
            .map_err(ExportError::io_error)?;
        export(&data_folder, &roots, &record, &mut |_| Ok(()))
    })
    .await
    .map_err(|e| ExportError::io_error(format!("the export did not finish: {e}")))?
}

// ---------------------------------------------------------------------------
// AH-169: importing a worktree bundle
// ---------------------------------------------------------------------------

async fn import_blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, crate::core::agent::bundle_import::ImportError> + Send + 'static,
) -> Result<T, crate::core::agent::bundle_import::ImportError> {
    use crate::core::agent::bundle_import::{ImportError, ImportErrorKind};
    tokio::task::spawn_blocking(work).await.map_err(|e| {
        ImportError::new(ImportErrorKind::Io, format!("the import did not finish: {e}"))
    })?
}

/// Read a bundle folder into a private copy, check it, and store it as a
/// proposal against `destination`. `token` names the import so it can be
/// stopped before it has an id.
#[tauri::command]
pub async fn agent_bundle_import(
    app: tauri::AppHandle,
    token: String,
    bundle: String,
    destination: String,
) -> Result<crate::core::agent::bundle_import::ImportView, crate::core::agent::bundle_import::ImportError> {
    use crate::core::agent::bundle_import::{self as bi, ImportError, ImportErrorKind};
    if !bi::valid_token(&token) {
        return Err(ImportError::new(ImportErrorKind::Io, "an import needs a valid token"));
    }
    let data_folder = get_jan_data_folder_path(app);
    import_blocking(move || {
        let flag = bi::register(&token);
        // A test seam, compiled only into the smoke harness: slow each piece
        // down so a scenario can stop an import part-way.
        #[cfg(feature = "cowork-smoke")]
        let pause = std::env::var("JAN_SMOKE_IMPORT_DELAY_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok());
        let out = bi::import(
            &data_folder,
            std::path::Path::new(&bundle),
            std::path::Path::new(&destination),
            &flag,
            bi::LIMITS,
            &mut |_| {
                #[cfg(feature = "cowork-smoke")]
                if let Some(ms) = pause {
                    std::thread::sleep(std::time::Duration::from_millis(ms));
                }
                Ok(())
            },
        );
        bi::unregister(&token);
        out
    })
    .await
}

/// Stop a running import. Its private copy is removed and nothing is kept.
#[tauri::command]
pub fn agent_bundle_import_cancel(token: String) -> bool {
    crate::core::agent::bundle_import::cancel(&token)
}

/// Every import into a repository, with its proposal, newest first.
#[tauri::command]
pub async fn agent_bundle_imports_list(
    app: tauri::AppHandle,
    destination: String,
) -> Result<Vec<crate::core::agent::bundle_import::ImportView>, crate::core::agent::bundle_import::ImportError> {
    let data_folder = get_jan_data_folder_path(app);
    import_blocking(move || Ok(crate::core::agent::bundle_import::list(&data_folder, &destination))).await
}

/// Apply an approved import, re-checking everything it was bound to.
#[tauri::command]
pub async fn agent_bundle_apply(
    app: tauri::AppHandle,
    approval: crate::core::agent::bundle_import::BundleApproval,
) -> Result<tauri_plugin_agent_tools::proposal::ApplyReport, crate::core::agent::bundle_import::ImportError> {
    let data_folder = get_jan_data_folder_path(app);
    import_blocking(move || crate::core::agent::bundle_import::apply(&data_folder, &approval)).await
}

/// Give up on a pending import; its proposal is rejected.
#[tauri::command]
pub async fn agent_bundle_abandon(
    app: tauri::AppHandle,
    id: String,
) -> Result<crate::core::agent::bundle_import::ImportRecord, crate::core::agent::bundle_import::ImportError> {
    let data_folder = get_jan_data_folder_path(app);
    import_blocking(move || crate::core::agent::bundle_import::abandon(&data_folder, &id)).await
}

async fn replay_blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, crate::core::agent::replay::ReplayError> + Send + 'static,
) -> Result<T, crate::core::agent::replay::ReplayError> {
    use crate::core::agent::replay::{ReplayError, ReplayErrorKind};
    tokio::task::spawn_blocking(work).await.map_err(|e| {
        ReplayError::new(ReplayErrorKind::Io, format!("the replay operation did not finish: {e}"))
    })?
}

/// Start replaying a prompt snapshot. AH-079.
///
/// The renderer names the snapshot and the session it belongs to; the payload
/// to send is read from disk here and handed back. A snapshot stored without
/// its payload, or with fields redacted, is refused with a typed error.
#[tauri::command]
pub async fn agent_replay_begin(
    app: tauri::AppHandle,
    session: String,
    snapshot_id: String,
) -> Result<crate::core::agent::replay::ReplayStart, crate::core::agent::replay::ReplayError> {
    let data_folder = get_jan_data_folder_path(app);
    replay_blocking(move || crate::core::agent::replay::begin(&data_folder, &session, &snapshot_id))
        .await
}

/// Record how a replay ended. The first ending is the one kept.
#[tauri::command]
pub async fn agent_replay_settle(
    app: tauri::AppHandle,
    session: String,
    replay_id: String,
    outcome: crate::core::agent::replay::SettleInput,
) -> Result<crate::core::agent::replay::ReplayRecord, crate::core::agent::replay::ReplayError> {
    let data_folder = get_jan_data_folder_path(app);
    replay_blocking(move || {
        crate::core::agent::replay::settle(&data_folder, &session, &replay_id, outcome)
    })
    .await
}

/// A session's replays, newest first, optionally of one snapshot.
#[tauri::command]
pub async fn agent_replays_list(
    app: tauri::AppHandle,
    session: String,
    snapshot_id: Option<String>,
) -> Result<Vec<crate::core::agent::replay::ReplayView>, crate::core::agent::replay::ReplayError> {
    let data_folder = get_jan_data_folder_path(app);
    replay_blocking(move || {
        Ok(crate::core::agent::replay::list(&data_folder, &session, snapshot_id.as_deref()))
    })
    .await
}

/// Record one tool lifecycle event. AH-050.
///
/// Every tool execution reaches this, whatever ran it -- a built-in, a file
/// tool, Bash, an MCP server, a skill, a subagent or a background task -- so
/// the record is the whole story of a run and not the part the UI happened to
/// keep. The renderer owns dispatch, so it is the renderer that reports; this
/// command is the only way in, which is what keeps the path canonical.
#[tauri::command]
pub async fn tool_activity_record(
    app: tauri::AppHandle,
    event: tauri_plugin_agent_tools::activity::ToolActivityEvent,
) -> Result<(), String> {
    let data_folder = get_jan_data_folder_path(app);
    // Redacted here rather than trusting the caller: the caller is renderer
    // code, and the file outlives the window.
    let event = event.redacted();
    tauri_plugin_agent_tools::activity::append(&data_folder, &event);
    // AH-005: the same transition in the session's canonical event log. One
    // id per call and phase, so a retried record is not a second event.
    if !event.session.is_empty() {
        let phase = serde_json::to_value(event.phase)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default();
        let _ = tauri_plugin_agent_tools::event_log::append(
            &data_folder,
            tauri_plugin_agent_tools::event_log::NewEvent {
                id: format!("tool:{}:{phase}", event.call),
                session: event.session.clone(),
                run: event.run.clone(),
                invocation: event.invocation.clone(),
                kind: format!("tool.{phase}"),
                payload: serde_json::json!({
                    "tool": event.tool,
                    "phase": phase,
                    "capability": event.capability,
                    "resourceKind": event.kind,
                    "agent": event.agent,
                    "elapsedMs": event.elapsed_ms,
                    "exitCode": event.exit_code,
                    "call": event.call,
                    "resource": event.resource,
                    "summary": event.summary,
                    "detail": event.detail,
                }),
            },
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// AH-005 / AH-177: the canonical event log, and exporting it
// ---------------------------------------------------------------------------

/// Record run-level events the renderer owns: a run starting and ending, an
/// agent dispatched, a background job. Tool phases arrive through
/// `tool_activity_record`. Payloads are redacted and bounded in the backend.
#[tauri::command]
pub async fn agent_events_record(
    app: tauri::AppHandle,
    events: Vec<tauri_plugin_agent_tools::event_log::NewEvent>,
) -> Result<usize, String> {
    let data_folder = get_jan_data_folder_path(app);
    tokio::task::spawn_blocking(move || {
        let mut written = 0;
        for event in events.into_iter().take(256) {
            tauri_plugin_agent_tools::event_log::append(&data_folder, event).map_err(|e| e.message())?;
            written += 1;
        }
        Ok(written)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn event_export_cancels(
) -> &'static std::sync::Mutex<std::collections::BTreeMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>> {
    static MAP: std::sync::OnceLock<
        std::sync::Mutex<std::collections::BTreeMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>>,
    > = std::sync::OnceLock::new();
    MAP.get_or_init(Default::default)
}

/// Export a session's (or one run's) events under `<data>/exports`. Metadata
/// only unless `include_content` is set. Nothing is sent anywhere.
#[tauri::command]
pub async fn agent_events_export(
    app: tauri::AppHandle,
    token: String,
    session: String,
    run: Option<String>,
    include_content: bool,
) -> Result<tauri_plugin_agent_tools::event_export::ExportReport, tauri_plugin_agent_tools::event_export::ExportError> {
    use tauri_plugin_agent_tools::event_export::{export, ExportError, ExportErrorKind};
    let data_folder = get_jan_data_folder_path(app);
    let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    event_export_cancels().lock().unwrap_or_else(|p| p.into_inner()).insert(token.clone(), flag.clone());
    let out = tokio::task::spawn_blocking(move || export(&data_folder, &session, run.as_deref(), include_content, &flag))
        .await
        .map_err(|e| ExportError::new(ExportErrorKind::Io, e.to_string()));
    event_export_cancels().lock().unwrap_or_else(|p| p.into_inner()).remove(&token);
    out?
}

#[tauri::command]
pub fn agent_events_export_cancel(token: String) -> bool {
    match event_export_cancels().lock().unwrap_or_else(|p| p.into_inner()).get(&token) {
        Some(flag) => {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
            true
        }
        None => false,
    }
}

/// Read an export back as untrusted input and summarize it. Nothing in it is
/// run or replayed.
#[tauri::command]
pub async fn agent_events_inspect(
    path: String,
) -> Result<tauri_plugin_agent_tools::event_export::InspectReport, tauri_plugin_agent_tools::event_export::ExportError> {
    use tauri_plugin_agent_tools::event_export::{inspect, ExportError, ExportErrorKind};
    tokio::task::spawn_blocking(move || inspect(std::path::Path::new(&path)))
        .await
        .map_err(|e| ExportError::new(ExportErrorKind::Io, e.to_string()))?
}

/// The activity timeline: one durable item per tool call, in the order the
/// calls were requested. AH-172.
///
/// Reads from the same events `tool_activity_record` wrote, so a timeline
/// rebuilt after a restart is the same timeline, not a summary of one.
#[tauri::command]
pub async fn tool_activity_items(
    app: tauri::AppHandle,
    session: Option<String>,
) -> Result<Vec<tauri_plugin_agent_tools::activity::ToolActivityItem>, String> {
    let data_folder = get_jan_data_folder_path(app);
    // Off the async workers: a long session's log is real parsing work.
    tokio::task::spawn_blocking(move || {
        tauri_plugin_agent_tools::activity::items(&data_folder, session.as_deref())
    })
    .await
    .map_err(|e| e.to_string())
}

/// The unified diff one call produced, as it was stored when the call ended.
///
/// Scoped by session and call, which is also how it was stored: an edit's diff
/// is that edit's, never the repository's current aggregate. `None` when the
/// call stored none -- it changed no file, the diff was oversized, or it ran
/// before diffs were recorded -- and the timeline says which from the item.
#[tauri::command]
pub async fn tool_activity_diff(
    app: tauri::AppHandle,
    session: String,
    call: String,
) -> Result<Option<String>, String> {
    let data_folder = get_jan_data_folder_path(app);
    tokio::task::spawn_blocking(move || {
        tauri_plugin_agent_tools::activity::read_diff(&data_folder, &session, &call)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Everything the audit holds for one session -- permission decisions and the
/// execution record -- as one reviewable JSON document. AH-200.
///
/// A session is required: an export of every conversation at once is not
/// something a caller should get by omitting an argument.
#[tauri::command]
pub async fn audit_export(app: tauri::AppHandle, session: String) -> Result<String, String> {
    if session.trim().is_empty() {
        return Err("an audit export needs the session it is for".to_string());
    }
    let data_folder = get_jan_data_folder_path(app);
    tokio::task::spawn_blocking(move || {
        serde_json::to_string_pretty(&tauri_plugin_agent_tools::activity::export(
            &data_folder,
            Some(&session),
        ))
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Record what one dispatched payload cost. AH-073.
///
/// The count comes from the provider that tokenized the payload, so it is the
/// only exact number available; Jan's own measurement is an estimate and is
/// recorded as one. Both are bound to the invocation and to the snapshot of
/// the payload they describe, because a run makes many model calls and a count
/// shown beside the wrong one looks authoritative while being wrong.
#[tauri::command]
pub async fn payload_usage_record(
    app: tauri::AppHandle,
    usage: tauri_plugin_agent_tools::usage::PayloadUsage,
) -> Result<(), String> {
    let data_folder = get_jan_data_folder_path(app);
    tauri_plugin_agent_tools::usage::append(&data_folder, &usage);
    Ok(())
}

/// What an export wrote, and how many credentials it left out.
#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionExportReport {
    pub path: String,
    pub redactions: usize,
}

/// The file an export goes to, chosen in a dialog this command opens itself.
///
/// The renderer never supplies the path: a command that wrote wherever the
/// renderer said would be a write-anywhere primitive. The only way a path gets
/// here is a person choosing it.
async fn pick_bundle_path(save: bool) -> Option<std::path::PathBuf> {
    // Test-only: the smoke harness scripts the picker, as it does for folders.
    #[cfg(feature = "cowork-smoke")]
    if let Some(scripted) = crate::core::filesystem::smoke_dialog::scripted_response() {
        return scripted.and_then(|v| v.as_str().map(std::path::PathBuf::from));
    }
    let dialog = rfd::AsyncFileDialog::new().add_filter("Jan session", &["json"]);
    if save {
        dialog
            .set_file_name("session.jan-session.json")
            .save_file()
            .await
            .map(|f| f.path().to_path_buf())
    } else {
        dialog.pick_file().await.map(|f| f.path().to_path_buf())
    }
}

/// Export a session to a file the user picks. AH-203.
///
/// Authority and machine paths are dropped and credentials redacted before
/// the dialog even opens, so a cancelled export has written nothing and a
/// completed one never held a secret. `None` means the user cancelled.
#[tauri::command]
pub async fn session_export_save(
    bundle: serde_json::Value,
) -> Result<Option<SessionExportReport>, String> {
    let (bundle, redactions) = crate::core::agent::session_bundle::prepare_export(bundle)?;
    let Some(path) = pick_bundle_path(true).await else {
        return Ok(None);
    };
    let body = serde_json::to_vec_pretty(&bundle).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, &body).map_err(|e| format!("could not write the export: {e}"))?;
    std::fs::rename(&temp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("could not write the export: {e}")
    })?;
    Ok(Some(SessionExportReport {
        path: path.to_string_lossy().to_string(),
        redactions,
    }))
}

/// Save a session for another computer to continue. AH-210.
///
/// The same export as [`session_export_save`], plus the folder's identity and
/// the model, with every path that only means something here replaced. The
/// folder's path is used to work those out and is never written. `None`
/// means the user cancelled.
#[tauri::command]
pub async fn session_handoff_save(
    app: tauri::AppHandle,
    bundle: serde_json::Value,
    folder: Option<String>,
) -> Result<Option<SessionExportReport>, String> {
    let data_folder = get_jan_data_folder_path(app);
    let folder = folder
        .map(std::path::PathBuf::from)
        .filter(|path| path.is_dir());
    let home = dirs::home_dir();
    let (bundle, redactions) = tauri::async_runtime::spawn_blocking(move || {
        crate::core::agent::session_bundle::prepare_handoff(
            bundle,
            folder.as_deref(),
            &data_folder,
            home.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    let Some(path) = pick_bundle_path(true).await else {
        return Ok(None);
    };
    let body = serde_json::to_vec_pretty(&bundle).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, &body).map_err(|e| format!("could not write the handoff: {e}"))?;
    std::fs::rename(&temp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("could not write the handoff: {e}")
    })?;
    Ok(Some(SessionExportReport {
        path: path.to_string_lossy().to_string(),
        redactions,
    }))
}

/// The identity of a folder attached on this machine, to compare with the one
/// a handed-off session worked in. AH-210.
#[tauri::command]
pub async fn session_folder_identity(
    folder: String,
) -> Result<crate::core::agent::session_bundle::FolderIdentity, String> {
    let path = std::path::PathBuf::from(folder);
    if !path.is_dir() {
        return Err("that folder is not there".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        crate::core::agent::session_bundle::folder_identity(&path)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Read a session export the user picks. AH-203. `None` means cancelled.
///
/// Only reads and validates: the renderer creates the session, under a new id,
/// and refuses an export it has already imported.
#[tauri::command]
pub async fn session_import_open() -> Result<Option<serde_json::Value>, String> {
    let Some(path) = pick_bundle_path(false).await else {
        return Ok(None);
    };
    let size = std::fs::metadata(&path)
        .map_err(|e| format!("could not read the file: {e}"))?
        .len();
    if size > crate::core::agent::session_bundle::MAX_BYTES {
        return Err("this file is too large to be a Jan session export".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("could not read the file: {e}"))?;
    crate::core::agent::session_bundle::parse_import(&bytes).map(Some)
}

/// Record one hidden utility-agent invocation. AH-208.
///
/// Titling and summarising are model calls Jan makes for itself; they are not
/// shown as agents, so this record is how they stay accountable. The plugin
/// sanitizes every field, because the record arrives over IPC and a free-text
/// field is where conversation content would otherwise leak in.
#[tauri::command]
pub async fn utility_agent_record(
    app: tauri::AppHandle,
    record: tauri_plugin_agent_tools::utility::UtilityInvocation,
) -> Result<(), String> {
    let data_folder = get_jan_data_folder_path(app);
    tauri_plugin_agent_tools::utility::append(&data_folder, &record);
    Ok(())
}

/// One session's utility-agent invocations. A session must be named.
#[tauri::command]
pub async fn utility_agent_lookup(
    app: tauri::AppHandle,
    session: String,
) -> Result<Vec<tauri_plugin_agent_tools::utility::UtilityInvocation>, String> {
    let data_folder = get_jan_data_folder_path(app);
    tauri_plugin_agent_tools::utility::for_session(&data_folder, &session)
}

/// Retrieve payload accounting, scoped the way snapshots are.
#[tauri::command]
pub async fn payload_usage_lookup(
    app: tauri::AppHandle,
    invocation: Option<String>,
    run: Option<String>,
    session: Option<String>,
) -> Result<Vec<tauri_plugin_agent_tools::usage::PayloadUsage>, String> {
    let data_folder = get_jan_data_folder_path(app);
    tauri_plugin_agent_tools::usage::scoped_lookup(
        &data_folder,
        invocation.as_deref(),
        run.as_deref(),
        session.as_deref(),
    )
}
