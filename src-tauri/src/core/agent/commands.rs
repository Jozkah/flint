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
}

/// Every subagent saved for the desktop, from the single
/// `<jan_data>/agent-workspace/subagents/` directory.
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
    Ok(
        subagent::SubagentRegistry::load_one(&dir, subagent::SubagentScope::User)
            .list()
            .into_iter()
            .map(|d| SubagentDefinitionDto {
                name: d.name.clone(),
                description: d.description.clone(),
                system_prompt: d.system_prompt.clone(),
                allowed_tools: d.allowed_tools.clone(),
                model: d.model.clone(),
            })
            .collect(),
    )
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
    let roots = workspace::worktrees_dir(std::path::Path::new(&data_folder));
    worktree::ensure(std::path::Path::new(&project), &roots, &session_id)
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
    let roots = workspace::worktrees_dir(std::path::Path::new(&data_folder));
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
    let roots = workspace::worktrees_dir(std::path::Path::new(&data_folder));
    let repo = std::path::Path::new(&project);
    // Bookkeeping for directories that are gone is dropped first, so a crash
    // that left Git's record behind does not show a worktree that is not there.
    let _ = worktree::prune(repo);
    worktree::list(repo, &roots)
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
    tauri_plugin_agent_tools::activity::append(&data_folder, &event.redacted());
    Ok(())
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
    Ok(tauri_plugin_agent_tools::activity::items(
        &data_folder,
        session.as_deref(),
    ))
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
