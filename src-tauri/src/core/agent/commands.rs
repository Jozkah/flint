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

/// What `project_tooling` hands the webview: the structured facts for the
/// readiness card, and the exact prompt block the CLI would give the model.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectToolingReport {
    #[serde(flatten)]
    tooling: crate::core::agent::tooling::ProjectTooling,
    prompt: Option<String>,
}

/// A detection that could not run, typed for the surface to branch on.
#[derive(serde::Serialize)]
pub struct ProjectToolingError {
    kind: &'static str,
    message: String,
}

/// Detect the attached project's frameworks, build systems and test runners.
/// AH-068 / AH-069 / AH-070.
///
/// Read-only and bounded (see `core::agent::tooling`); runs off the UI thread.
/// Nothing here can block attaching or using a folder: a failure comes back
/// typed and the caller carries on without the facts.
#[tauri::command]
pub async fn project_tooling(folder: String) -> Result<ProjectToolingReport, ProjectToolingError> {
    tauri::async_runtime::spawn_blocking(move || {
        let never = std::sync::atomic::AtomicBool::new(false);
        crate::core::agent::tooling::detect(std::path::Path::new(&folder), &never)
    })
    .await
    .map_err(|e| ProjectToolingError {
        kind: "internal",
        message: e.to_string(),
    })?
    .map(|tooling| ProjectToolingReport {
        prompt: tooling.render(),
        tooling,
    })
    .map_err(|e| ProjectToolingError {
        kind: e.kind(),
        message: e.to_string(),
    })
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

/// The effective compaction policy (AH-076): defaults, the user's file, then
/// the project's when one is given.
#[tauri::command]
pub async fn get_compaction_policy(
    app: tauri::AppHandle,
    project: Option<String>,
) -> Result<tauri_plugin_agent_tools::compaction_policy::Policy, String> {
    let data = get_jan_data_folder_path(app);
    tauri_plugin_agent_tools::compaction_policy::Policy::resolve(
        Some(&data),
        project.as_deref().map(std::path::Path::new),
        None,
    )
    .map_err(|e| e.message().to_string())
}

/// Whether Flint adds its attribution to the agent's commits and pull
/// requests (`<data folder>/attribution.json`, read by the CLI too).
#[tauri::command]
pub async fn get_attribution_settings(
    app: tauri::AppHandle,
) -> tauri_plugin_agent_tools::tools::git_attribution::Settings {
    tauri_plugin_agent_tools::tools::git_attribution::load(Some(&get_jan_data_folder_path(app)))
}

#[tauri::command]
pub async fn set_attribution_settings(
    app: tauri::AppHandle,
    settings: tauri_plugin_agent_tools::tools::git_attribution::Settings,
) -> Result<tauri_plugin_agent_tools::tools::git_attribution::Settings, String> {
    tauri_plugin_agent_tools::tools::git_attribution::save(&get_jan_data_folder_path(app), &settings)
        .map_err(|e| e.to_string())?;
    Ok(settings)
}

/// A `git` tool call's input with Flint's attribution added, as the renderer's
/// dispatchers run it: rewritten before the approval prompt, so the prompt
/// shows the exact message or body. `base` resolves a relative `-F` file.
#[tauri::command]
pub async fn attribute_git_call(
    app: tauri::AppHandle,
    input: serde_json::Value,
    model: String,
    base: Option<String>,
) -> serde_json::Value {
    let settings =
        tauri_plugin_agent_tools::tools::git_attribution::load(Some(&get_jan_data_folder_path(app)));
    let mut input = input;
    let base = std::path::PathBuf::from(base.unwrap_or_default());
    tauri_plugin_agent_tools::tools::git_attribution::attribute_call(&mut input, &model, settings, &base);
    input
}

/// Change the user's compaction policy (AH-076). Only the fields given are
/// changed; the rest of the user's file is kept. Validated before writing.
#[tauri::command]
pub async fn set_compaction_policy(
    app: tauri::AppHandle,
    layer: tauri_plugin_agent_tools::compaction_policy::Layer,
) -> Result<tauri_plugin_agent_tools::compaction_policy::Policy, String> {
    use tauri_plugin_agent_tools::compaction_policy::{save_user, user_path, Layer, Policy};
    let data = get_jan_data_folder_path(app);
    let mut current = Layer::read(&user_path(&data)).map_err(|e| e.message().to_string())?;
    if layer.auto.is_some() {
        current.auto = layer.auto;
    }
    if layer.reserve_tokens.is_some() {
        current.reserve_tokens = layer.reserve_tokens;
    }
    if layer.keep_recent.is_some() {
        current.keep_recent = layer.keep_recent;
    }
    if layer.strategy.is_some() {
        current.strategy = layer.strategy;
    }
    if layer.summary_max_tokens.is_some() {
        current.summary_max_tokens = layer.summary_max_tokens;
    }
    save_user(&data, &current).map_err(|e| e.message().to_string())?;
    Policy::resolve(Some(&data), None, None).map_err(|e| e.message().to_string())
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

// Plugin lifecycle. Every command returns a typed `PluginError`
// (`{ code, message }`) so the UI can map a refusal to actionable text rather
// than parse a sentence. Plugins are per project: `project` is the folder whose
// `.jan/agent/plugins/` is managed. `id` is the plugin's directory name.

/// Run blocking plugin filesystem work off the async runtime.
async fn plugin_blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, plugins::PluginError> + Send + 'static,
) -> Result<T, plugins::PluginError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| plugins::PluginError::new(plugins::PluginErrorCode::Io, e.to_string()))?
}

/// Resolve the `scope`/`project` pair every `agent_plugin_*` command takes:
/// `scope == "global"` targets the user's own plugin store, shared by every
/// workspace; anything else (including the parameter being absent) targets
/// `project`'s `.jan/agent/plugins/`, exactly as before this parameter
/// existed. Kept out of the typed command signatures (an added `Option<String>`
/// rather than a new required arg) so no existing caller breaks.
fn resolve_plugin_scope(project: &str, scope: Option<&str>) -> plugins::PluginScope {
    match scope {
        Some(s) if s.eq_ignore_ascii_case("global") => plugins::PluginScope::Global,
        _ => plugins::PluginScope::Project(std::path::PathBuf::from(project)),
    }
}

/// List installed plugins with metadata, enabled state and component counts.
#[tauri::command]
pub async fn agent_plugin_list(
    project: String,
    scope: Option<String>,
) -> Result<Vec<plugins::InstalledPlugin>, plugins::PluginError> {
    plugin_blocking(move || {
        Ok(plugins::installed_scoped(&resolve_plugin_scope(
            &project,
            scope.as_deref(),
        )))
    })
    .await
}

/// Full details of one installed plugin: identity, provenance, component
/// names, whether it ships an (unloaded) `.mcp.json`, and its script files.
#[tauri::command]
pub async fn agent_plugin_details(
    project: String,
    id: String,
    scope: Option<String>,
) -> Result<plugins::PluginDetails, plugins::PluginError> {
    plugin_blocking(move || {
        plugins::details_scoped(&resolve_plugin_scope(&project, scope.as_deref()), &id)
    })
    .await
}

/// Which install sources are usable: the configured marketplace (if any) and
/// whether git can run. Reads config and runs `git --version`; no network.
#[tauri::command]
pub async fn agent_plugin_sources(
    project: String,
    scope: Option<String>,
) -> Result<plugins::PluginSources, plugins::PluginError> {
    plugin_blocking(move || {
        Ok(plugins::sources_scoped(&resolve_plugin_scope(
            &project,
            scope.as_deref(),
        )))
    })
    .await
}

/// Install a plugin from an explicit source (`local` folder copy, `git` clone,
/// or configured `marketplace` name). `operation_id` is chosen by the caller so
/// `agent_plugin_install_cancel` can stop this install; a cancelled install
/// leaves no files behind.
#[tauri::command]
pub async fn agent_plugin_install(
    project: String,
    source: plugins::InstallSource,
    operation_id: String,
    scope: Option<String>,
) -> Result<plugins::InstalledPlugin, plugins::PluginError> {
    let guard = plugins::begin_install(&operation_id)?;
    let scope = resolve_plugin_scope(&project, scope.as_deref());
    plugins::install_from_source_scoped(&scope, source, guard.ctx()).await
}

/// Cancel a running install. `false` when no install of that id is running.
#[tauri::command]
pub fn agent_plugin_install_cancel(operation_id: String) -> bool {
    plugins::cancel_install(&operation_id)
}

/// Enable or disable an installed plugin for this project
/// (`[plugins].disabled` in agent.toml). Returns the plugin's new state.
#[tauri::command]
pub async fn agent_plugin_set_enabled(
    project: String,
    id: String,
    enabled: bool,
    scope: Option<String>,
) -> Result<plugins::InstalledPlugin, plugins::PluginError> {
    plugin_blocking(move || {
        plugins::set_enabled_scoped(
            &resolve_plugin_scope(&project, scope.as_deref()),
            &id,
            enabled,
        )
    })
    .await
}

/// Remove an installed plugin and the config entries that name it.
#[tauri::command]
pub async fn agent_plugin_remove(
    project: String,
    id: String,
    scope: Option<String>,
) -> Result<plugins::RemoveReport, plugins::PluginError> {
    plugin_blocking(move || {
        plugins::remove_plugin_scoped(&resolve_plugin_scope(&project, scope.as_deref()), &id)
    })
    .await
}

/// Search the configured plugin marketplace (contacts the index URL).
/// `scope == "global"` searches the marketplace set in the user's own global
/// agent config rather than `project`'s.
#[tauri::command]
pub async fn agent_plugin_search(
    project: String,
    query: String,
    scope: Option<String>,
) -> Result<Vec<plugins::MarketEntry>, plugins::PluginError> {
    plugins::search_typed_scoped(&resolve_plugin_scope(&project, scope.as_deref()), &query).await
}

/// Map a surface string from the frontend ("home" | "rooms" | "cowork") to
/// `extensions::Surface`. A `cowork` surface with no `project_id` uses the
/// empty string as its key, matching no registered project.
fn resolve_surface(
    surface: &str,
    project_id: Option<&str>,
) -> crate::core::agent::extensions::Surface {
    use crate::core::agent::extensions::Surface;
    match surface {
        "rooms" => Surface::Rooms,
        "cowork" => Surface::Cowork(project_id.unwrap_or_default().to_string()),
        _ => Surface::Home,
    }
}

/// Resolve the extensions (skills + plugin-backed skills) visible on `surface`,
/// filtered by the global enablement matrix. `project_id`, when the id is a
/// known registered project, resolves to that project's folder so its own
/// (project-scoped) skills are included too; Home/Rooms are always folderless.
#[tauri::command]
pub async fn agent_resolve_extensions(
    surface: String,
    project_id: Option<String>,
) -> Result<Vec<agent_skills::SkillMeta>, String> {
    use crate::core::agent::extensions::{resolve_extensions, Surface};
    let resolved_surface = resolve_surface(&surface, project_id.as_deref());
    let project_root = match &resolved_surface {
        Surface::Cowork(id) if !id.is_empty() => {
            crate::core::agent::projects_registry::list_projects()
                .into_iter()
                .find(|p| &p.id == id)
                .map(|p| std::path::PathBuf::from(p.folder))
        }
        _ => None,
    };
    Ok(resolve_extensions(
        &resolved_surface,
        project_root.as_deref(),
    ))
}

/// The surface a slash request comes from, plus the project folder it may
/// read. Cowork passes its folder; the matrix keys Cowork by the folder's
/// registered project id, so the folder is looked up in the registry.
fn slash_surface(
    surface: &str,
    project: Option<&str>,
) -> (
    crate::core::agent::extensions::Surface,
    Option<std::path::PathBuf>,
) {
    let folder = project
        .filter(|p| !p.trim().is_empty() && surface == "cowork")
        .map(std::path::PathBuf::from);
    let id = folder.as_ref().and_then(|f| {
        crate::core::agent::projects_registry::list_projects()
            .into_iter()
            .find(|p| std::path::Path::new(&p.folder) == f.as_path())
            .map(|p| p.id)
    });
    (resolve_surface(surface, id.as_deref()), folder)
}

/// What the composer's `/` menu offers on `surface` ("home" | "rooms" |
/// "cowork"): plugin commands (with their template bodies) and user-invocable
/// skills, filtered by the per-surface enablement matrix.
#[tauri::command]
pub async fn agent_slash_catalog(
    surface: String,
    project: Option<String>,
) -> Result<Vec<crate::core::agent::slash::SlashEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (surface, folder) = slash_surface(&surface, project.as_deref());
        crate::core::agent::slash::catalog(&surface, folder.as_deref())
    })
    .await
    .map_err(|e| e.to_string())
}

/// The message that invokes skill `name` from the `/` menu with `args` as
/// the task. Err when the surface does not offer that skill.
#[tauri::command]
pub async fn agent_slash_invoke_skill(
    surface: String,
    project: Option<String>,
    name: String,
    args: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (surface, folder) = slash_surface(&surface, project.as_deref());
        crate::core::agent::slash::invoke_skill(&surface, folder.as_deref(), &name, &args)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(ui_error)
}

/// The raw global skills/plugins enablement matrix (`extensions.json`).
#[tauri::command]
pub async fn agent_extensions_matrix_get() -> Result<serde_json::Value, String> {
    let matrix = crate::core::agent::extensions::Matrix::load();
    serde_json::to_value(&matrix).map_err(|e| e.to_string())
}

/// Set one item's enabled state on one surface in the global matrix, then
/// persist and return the resulting matrix.
#[tauri::command]
pub async fn agent_extensions_matrix_set(
    kind: String,
    id: String,
    surface: String,
    project_id: Option<String>,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    use crate::core::agent::extensions::{ItemKind, Matrix};
    let item_kind = match kind.as_str() {
        "plugin" => ItemKind::Plugin,
        _ => ItemKind::Skill,
    };
    let resolved_surface = resolve_surface(&surface, project_id.as_deref());
    let mut matrix = Matrix::load();
    matrix.set(item_kind, &id, &resolved_surface, enabled);
    matrix.save();
    serde_json::to_value(&matrix).map_err(|e| e.to_string())
}

/// Set (or clear) one item's ENTIRE surface list in the global matrix in one
/// shot -- the full-vector counterpart to `agent_extensions_matrix_set`'s
/// single-cell toggle, used by the enablement grid where one checkbox click
/// recomputes the whole boolean vector across all known surfaces.
/// `surfaces: None` clears the item back to its default (enabled everywhere);
/// `Some(list)` replaces its surface list with exactly `list`. Surface keys
/// are pre-encoded by the caller ("home" | "rooms" | "cowork:<id>").
#[tauri::command]
pub async fn agent_extensions_matrix_set_item(
    kind: String,
    id: String,
    surfaces: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    use crate::core::agent::extensions::{ItemKind, Matrix};
    let item_kind = match kind.as_str() {
        "plugin" => ItemKind::Plugin,
        _ => ItemKind::Skill,
    };
    let mut matrix = Matrix::load();
    match surfaces {
        Some(list) => matrix.set_item(item_kind, &id, list),
        None => matrix.clear_item(item_kind, &id),
    }
    matrix.save();
    serde_json::to_value(&matrix).map_err(|e| e.to_string())
}

/// Every registered project (stable id, folder, display name).
#[tauri::command]
pub async fn agent_projects_list(
) -> Result<Vec<crate::core::agent::projects_registry::ProjectEntry>, String> {
    Ok(crate::core::agent::projects_registry::list_projects())
}

/// Register (or re-register) `folder` as a project, returning its stable entry.
#[tauri::command]
pub async fn agent_projects_register(
    folder: String,
) -> Result<crate::core::agent::projects_registry::ProjectEntry, String> {
    Ok(crate::core::agent::projects_registry::register_folder(
        std::path::Path::new(&folder),
    ))
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
    /// `builtin` for a role Flint ships, `user` for one saved on this machine.
    pub scope: subagent::SubagentScope,
}

/// The roles Flint ships (AH-094..099), then every subagent saved for the
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
/// show, because each of them means something happened outside Flint that a
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

/// Flint's worktree folder, absolute. See [`worktree::absolute`]: a relative
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
/// The record arrives over IPC, so the path is checked against the folder Flint
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
            "{} is not a worktree Flint manages, so Flint will not remove it",
            record.path
        ));
    }
    worktree::discard_owned(&record, &roots, force)
}

/// Why a shell command would be asked about before it runs, or `None`.
///
/// The renderer's own port (`destructiveCommand.ts`) compares paths as text;
/// this resolves every root and target through the filesystem first, so an
/// absolute path inside an approved root is inside even when spelled through
/// a symlink, a junction, mixed separators or `..`, and a link inside a root
/// that leads out of it is outside. Roots that are not absolute are ignored;
/// with none left the scope is unknown and every absolute path is outside.
#[tauri::command]
pub fn agent_destructive_reason(command: String, roots: Vec<String>) -> Option<String> {
    let scope = crate::core::agent::destructive::Scope::new(roots.iter());
    crate::core::agent::destructive::destructive_reason_in(&command, &scope)
}

/// What a worktree holds that removing it would destroy.
///
/// Asked before offering to remove one, so the confirmation names the work
/// rather than asking about a path.
#[tauri::command]
pub fn agent_worktree_pending(record: WorktreeRecordInput) -> Vec<String> {
    worktree::pending(&record.into())
}

/// Route one `jan-desktop` bridge tool call. The runtime entry point for the
/// in-process desktop UI tools (open_file, get_terminal_contents, show_diff,
/// diff_accepted, apply_settings): it binds the call to its window, workspace,
/// conversation and session via a [`RequestContext`], and dispatches through the
/// bridge's authorization layer.
///
/// The backend context supplies a settings-file-backed UI, so `apply_settings`
/// works end to end; the editor/terminal/diff tools require a live window and
/// are served by the desktop window layer's own UI implementation.
#[tauri::command]
pub fn agent_desktop_bridge(
    data_folder: String,
    session_id: String,
    conversation_id: String,
    workspace: String,
    tool: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use crate::core::agent::desktop_bridge::{DesktopBridge, FileSettingsUi, RequestContext};
    let settings_path = std::path::Path::new(&data_folder)
        .join(crate::core::app::constants::CONFIGURATION_FILE_NAME);
    // The app's own settings file belongs to settings_store, which rewrites
    // it whole from memory; writing it directly lost one writer's keys
    // (#240). Any other folder has no in-process owner and is written as a
    // file.
    let app_settings = crate::core::app::commands::resolve_jan_data_folder()
        .join(crate::core::app::constants::CONFIGURATION_FILE_NAME);
    let ui = if settings_path == app_settings {
        FileSettingsUi::app_store()
    } else {
        FileSettingsUi::new(settings_path)
    };
    let mut bridge = DesktopBridge::new(ui);
    let ctx = RequestContext {
        window_id: String::new(),
        workspace_root: std::path::PathBuf::from(&workspace),
        conversation_id,
        session_id,
    };
    bridge.dispatch(&ctx, &tool, &args)
}

/// Every Flint-owned worktree of this repository that is on disk.
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

/// Apply opt-in optimizations to a worktree after it was created.
///
/// A separate, post-creation step on purpose: `ensure` stays the plain "make me
/// an isolated checkout" operation, and narrowing it with a sparse checkout or
/// sharing heavy directories into it is a choice made explicitly here. Both the
/// sparse paths and the symlinked directories are repository-relative and
/// validated as such, so neither can climb out of the worktree or reach into
/// `.git`.
///
/// The record arrives over IPC, so the path is checked against the folder Flint
/// owns before anything is done to it — the same boundary [`agent_worktree_discard`]
/// uses, not a new one.
#[tauri::command]
pub fn agent_worktree_optimize(
    data_folder: String,
    record: WorktreeRecordInput,
    symlink_directories: Vec<String>,
    sparse_paths: Vec<String>,
) -> Result<(), String> {
    let roots = owned_worktrees_root(&data_folder)?;
    let record: worktree::WorktreeRecord = record.into();
    if !std::path::Path::new(&record.path).starts_with(&roots) {
        return Err(format!(
            "{} is not a worktree Flint manages, so Flint will not optimize it",
            record.path
        ));
    }
    worktree::apply_optimizations(
        std::path::Path::new(&record.path),
        std::path::Path::new(&record.source_root),
        &symlink_directories,
        &sparse_paths,
    )
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
/// discard checks it -- inside the folder Flint owns, and still the worktree it
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
    let roots =
        worktree::absolute(&workspace::worktrees_dir(&data_folder)).map_err(proposal_failure)?;
    let record: worktree::WorktreeRecord = record.into();
    // Compared canonically: the data folder Flint resolves and the one the
    // renderer was handed can differ in form (a verbatim `\\?\` prefix, case)
    // while naming the same directory, and a lexical comparison refused a
    // worktree Flint had just made.
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

/// Flint's worktree folder under the data folder the backend itself resolves.
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

/// The diff a restore to `checkpoint` would apply to the tree as it stands.
/// Changes nothing; refuses a checkpoint in the user's own checkout.
#[tauri::command]
pub fn agent_checkpoint_preview_diff(checkpoint: checkpoint::Checkpoint) -> Result<String, String> {
    checkpoint::preview_restore_diff(&checkpoint)
}

/// Roll a Flint-owned tree back to a checkpoint.
///
/// Refuses a checkpoint taken in the user's checkout, whatever the caller
/// says: that path leads to deleting work whose only sin was being in the same
/// directory as the run.
///
/// In a managed tree, refuses before writing anything unless the tree on disk
/// is exactly what a checkpoint holds: `safety` when given (the point taken
/// immediately before this restore), otherwise `latest`. `allow_overwrite`
/// names paths the caller has explicitly agreed to lose. Both are optional, so
/// a caller that predates them gets the strict check rather than none.
#[tauri::command]
pub fn agent_checkpoint_restore(
    checkpoint: checkpoint::Checkpoint,
    latest: String,
    safety: Option<String>,
    allow_overwrite: Option<Vec<String>>,
) -> Result<(), String> {
    checkpoint::restore(
        &checkpoint,
        &latest,
        &checkpoint::RestoreGuard {
            safety,
            allow_overwrite: allow_overwrite.unwrap_or_default(),
        },
    )
}

/// Forget a session's snapshot chain.
#[tauri::command]
pub fn agent_checkpoint_forget(root: String, thread_id: String) {
    checkpoint::forget(std::path::Path::new(&root), &thread_id)
}

/// A record as it comes back from the renderer.
///
/// Deserialized into its own type rather than reusing the serialize-only record:
/// what the frontend stores is state Flint wrote, but it arrives over IPC and is
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
            assert!(err.contains("not a worktree Flint manages"), "{err}");
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

/// Delete every prompt snapshot of one session. AH-078.
///
/// What the model was sent is kept only as long as the conversation it
/// belongs to: deleting a Chat thread or a Cowork session calls this, and it
/// is how a user removes that record on purpose. Scoped to the one session it
/// names; an empty name is refused rather than read as "all".
#[tauri::command]
pub async fn agent_prompt_snapshots_delete(
    app: tauri::AppHandle,
    session: String,
) -> Result<usize, String> {
    let data_folder = crate::core::app::commands::get_jan_data_folder_path(app);
    if session.trim().is_empty() {
        // Refused, as before, rather than read as "all".
        return tauri_plugin_agent_tools::snapshot::delete_session(&data_folder, &session);
    }
    // Everything recorded for the session, not only its snapshots: its usage,
    // stored diffs, permission decisions and undo journal (Jozkah/jan#294).
    // A Cowork session is deleted through here alone.
    tauri_plugin_agent_tools::retention::delete_session(&data_folder, &session)
        .map(|removed| removed.snapshots)
}

/// Export a managed worktree as a patch bundle under `<data>/exports`. AH-168.
///
/// The record arrives over IPC and is checked the way a proposal checks it:
/// inside the folder Flint owns, and still the worktree it says it is. Nothing
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
        ImportError::new(
            ImportErrorKind::Io,
            format!("the import did not finish: {e}"),
        )
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
) -> Result<
    crate::core::agent::bundle_import::ImportView,
    crate::core::agent::bundle_import::ImportError,
> {
    use crate::core::agent::bundle_import::{self as bi, ImportError, ImportErrorKind};
    if !bi::valid_token(&token) {
        return Err(ImportError::new(
            ImportErrorKind::Io,
            "an import needs a valid token",
        ));
    }
    let data_folder = get_jan_data_folder_path(app);
    import_blocking(move || {
        let flag = bi::register(&token);
        // A test seam, compiled only into the smoke harness: slow each piece
        // down so a scenario can stop an import part-way.
        #[cfg(feature = "cowork-smoke")]
        let pause = crate::core::compat_env::var("SMOKE_IMPORT_DELAY_MS")
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
) -> Result<
    Vec<crate::core::agent::bundle_import::ImportView>,
    crate::core::agent::bundle_import::ImportError,
> {
    let data_folder = get_jan_data_folder_path(app);
    import_blocking(move || {
        Ok(crate::core::agent::bundle_import::list(
            &data_folder,
            &destination,
        ))
    })
    .await
}

/// Apply an approved import, re-checking everything it was bound to.
#[tauri::command]
pub async fn agent_bundle_apply(
    app: tauri::AppHandle,
    approval: crate::core::agent::bundle_import::BundleApproval,
) -> Result<
    tauri_plugin_agent_tools::proposal::ApplyReport,
    crate::core::agent::bundle_import::ImportError,
> {
    let data_folder = get_jan_data_folder_path(app);
    import_blocking(move || crate::core::agent::bundle_import::apply(&data_folder, &approval)).await
}

/// Copy one file a Review only session wrote into its sandbox into the
/// attached folder. The sandbox is resolved here from the session id, never
/// taken from the renderer; an existing file is only replaced when `overwrite`
/// says the user confirmed it.
#[tauri::command]
pub async fn agent_sandbox_apply_file(
    app: tauri::AppHandle,
    session: String,
    path: String,
    project: String,
    // Where in `project` the file goes, when the user confirmed a place other
    // than its sandbox path.
    destination: Option<String>,
    overwrite: bool,
) -> Result<tauri_plugin_agent_tools::sandbox_apply::SandboxApplyOutcome, String> {
    let data_folder = get_jan_data_folder_path(app);
    tokio::task::spawn_blocking(move || {
        let sandbox = workspace::session_workspace(&data_folder, &session)?;
        tauri_plugin_agent_tools::sandbox_apply::apply_sandbox_file_to(
            &sandbox,
            std::path::Path::new(&project),
            &path,
            destination.as_deref().unwrap_or(&path),
            overwrite,
        )
    })
    .await
    .map_err(|e| format!("the copy did not finish: {e}"))?
}

/// Give up on a pending import; its proposal is rejected.
#[tauri::command]
pub async fn agent_bundle_abandon(
    app: tauri::AppHandle,
    id: String,
) -> Result<
    crate::core::agent::bundle_import::ImportRecord,
    crate::core::agent::bundle_import::ImportError,
> {
    let data_folder = get_jan_data_folder_path(app);
    import_blocking(move || crate::core::agent::bundle_import::abandon(&data_folder, &id)).await
}

async fn replay_blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, crate::core::agent::replay::ReplayError> + Send + 'static,
) -> Result<T, crate::core::agent::replay::ReplayError> {
    use crate::core::agent::replay::{ReplayError, ReplayErrorKind};
    tokio::task::spawn_blocking(work).await.map_err(|e| {
        ReplayError::new(
            ReplayErrorKind::Io,
            format!("the replay operation did not finish: {e}"),
        )
    })?
}

/// What a session's runs started, as a tree. AH-173.
///
/// Built from what was recorded -- runs, their tool calls, the children they
/// dispatched and the background jobs they left -- never from the machine's
/// process list, which cannot say which run asked for anything.
#[tauri::command]
pub async fn agent_run_tree(
    app: tauri::AppHandle,
    session: String,
) -> Result<
    Vec<tauri_plugin_agent_tools::run_tree::Node>,
    tauri_plugin_agent_tools::harness_error::HarnessError,
> {
    let data_folder = get_jan_data_folder_path(app);
    tokio::task::spawn_blocking(move || {
        tauri_plugin_agent_tools::run_tree::of_session(&data_folder, &session)
    })
    .await
    .map_err(|e| {
        tauri_plugin_agent_tools::harness_error::HarnessError::internal(format!(
            "the run tree did not finish: {e}"
        ))
    })?
}

/// Start background work that outlives the app. AH-101/AH-102.
///
/// The job is run by a supervisor process of its own, so closing the window
/// leaves it running and a later app process can find it, read it and stop it.
#[tauri::command]
pub async fn agent_job_start(
    app: tauri::AppHandle,
    session: String,
    command: String,
    run: Option<String>,
    invocation: Option<String>,
    agent: Option<String>,
) -> Result<
    tauri_plugin_agent_tools::job_record::JobRecord,
    tauri_plugin_agent_tools::harness_error::HarnessError,
> {
    let data_folder = get_jan_data_folder_path(app);
    tokio::task::spawn_blocking(move || {
        let supervisor = tauri_plugin_agent_tools::worker::supervisor_binary()?;
        tauri_plugin_agent_tools::worker::start(
            &data_folder,
            &supervisor,
            &session,
            &command,
            (
                run.as_deref().unwrap_or_default(),
                invocation.as_deref().unwrap_or_default(),
                agent.as_deref().unwrap_or_default(),
            ),
        )
    })
    .await
    .map_err(|e| {
        tauri_plugin_agent_tools::harness_error::HarnessError::internal(format!(
            "the job could not be started: {e}"
        ))
    })?
}

/// What one background job has produced so far. AH-102.
#[tauri::command]
pub async fn agent_job_output(
    app: tauri::AppHandle,
    session: String,
    id: String,
    bytes: Option<usize>,
) -> Result<String, tauri_plugin_agent_tools::harness_error::HarnessError> {
    let data_folder = get_jan_data_folder_path(app);
    tokio::task::spawn_blocking(move || {
        tauri_plugin_agent_tools::worker::output(
            &data_folder,
            &session,
            &id,
            bytes.unwrap_or(64 * 1024),
        )
    })
    .await
    .map_err(|e| {
        tauri_plugin_agent_tools::harness_error::HarnessError::internal(format!(
            "the job's output could not be read: {e}"
        ))
    })?
}

/// Stop one background job, and only that one. AH-102.
#[tauri::command]
pub async fn agent_job_cancel(
    app: tauri::AppHandle,
    session: String,
    id: String,
) -> Result<String, tauri_plugin_agent_tools::harness_error::HarnessError> {
    let data_folder = get_jan_data_folder_path(app);
    tokio::task::spawn_blocking(move || {
        tauri_plugin_agent_tools::worker::cancel(&data_folder, &session, &id)
            .map(|state| state.tag().to_string())
    })
    .await
    .map_err(|e| {
        tauri_plugin_agent_tools::harness_error::HarnessError::internal(format!(
            "the job could not be stopped: {e}"
        ))
    })?
}

/// One conversation's background jobs, including those an earlier process
/// started. AH-101/AH-102.
///
/// Read from the durable record, so a job that outlived the app -- or that the
/// app outlived -- is still listed, with what became of it. Another
/// conversation's jobs are not listed at all.
#[tauri::command]
pub async fn agent_background_jobs(
    app: tauri::AppHandle,
    session: String,
) -> Result<Vec<tauri_plugin_agent_tools::job_record::JobRecord>, String> {
    let data_folder = get_jan_data_folder_path(app);
    tokio::task::spawn_blocking(move || {
        // What an earlier process left is settled before it is listed, so a
        // job nobody is running is never shown as running.
        tauri_plugin_agent_tools::worker::reconcile(&data_folder, &session);
        let mut records = tauri_plugin_agent_tools::job_record::read_owner(&data_folder, &session);
        // Newest first, the order a panel shows them in.
        records.reverse();
        records
    })
    .await
    .map_err(|e| format!("the background jobs could not be read: {e}"))
}

/// What one dispatched request was made of, by category. AH-087.
///
/// Read from the stored request itself -- the exact bytes the provider
/// received -- so every surface answers "what is filling the window?" from the
/// same place instead of each re-deriving it. `snapshotId` names the request;
/// omitted, it is the session's most recent one. A request of another session
/// names nothing here.
#[tauri::command]
pub async fn agent_context_breakdown(
    app: tauri::AppHandle,
    session: String,
    snapshot_id: Option<String>,
    window_tokens: Option<u64>,
    deferred_tools: Option<u64>,
) -> Result<
    tauri_plugin_agent_tools::context_report::Breakdown,
    tauri_plugin_agent_tools::harness_error::HarnessError,
> {
    let data_folder = get_jan_data_folder_path(app);
    tokio::task::spawn_blocking(move || {
        tauri_plugin_agent_tools::context_report::of_snapshot(
            &data_folder,
            &session,
            snapshot_id.as_deref(),
            window_tokens,
            deferred_tools.unwrap_or(0),
        )
    })
    .await
    .map_err(|e| {
        tauri_plugin_agent_tools::harness_error::HarnessError::internal(format!(
            "the context breakdown did not finish: {e}"
        ))
    })?
}

/// What replaying a recorded run would do, before anything is sent. AH-032.
///
/// Read from the session's canonical record: the run's provider requests, the
/// snapshot behind each, whether each can be sent again and why not when it
/// cannot, and the tools the original asked for -- which a replay shows and
/// never runs.
#[tauri::command]
pub async fn agent_replay_plan(
    app: tauri::AppHandle,
    session: String,
    run: String,
) -> Result<crate::core::agent::replay::ReplayPlan, crate::core::agent::replay::ReplayError> {
    let data_folder = get_jan_data_folder_path(app);
    replay_blocking(move || crate::core::agent::replay::plan(&data_folder, &session, &run)).await
}

/// A recorded run's own events, in order. AH-032.
///
/// The deterministic half of replay: what happened, re-read from the record.
/// Nothing is sent and nothing is run, so it is the same every time.
#[tauri::command]
pub async fn agent_replay_recorded(
    app: tauri::AppHandle,
    session: String,
    run: String,
) -> Result<
    Vec<tauri_plugin_agent_tools::event_log::Envelope>,
    crate::core::agent::replay::ReplayError,
> {
    let data_folder = get_jan_data_folder_path(app);
    replay_blocking(move || crate::core::agent::replay::recorded(&data_folder, &session, &run))
        .await
}

/// Start a fresh replay of one request of a recorded run. AH-032.
///
/// The replay is its own run in the record and says which run and request it
/// came from, so neither is mistaken for the other.
#[tauri::command]
pub async fn agent_replay_run_begin(
    app: tauri::AppHandle,
    session: String,
    run: String,
    invocation: Option<String>,
) -> Result<crate::core::agent::replay::ReplayStart, crate::core::agent::replay::ReplayError> {
    let data_folder = get_jan_data_folder_path(app);
    replay_blocking(move || {
        crate::core::agent::replay::begin_for_run(
            &data_folder,
            &session,
            &run,
            invocation.as_deref(),
        )
    })
    .await
}

/// Record how a run replay ended, in the canonical record as well. AH-032.
#[tauri::command]
pub async fn agent_replay_run_settle(
    app: tauri::AppHandle,
    session: String,
    replay_id: String,
    outcome: crate::core::agent::replay::SettleInput,
) -> Result<crate::core::agent::replay::ReplayRecord, crate::core::agent::replay::ReplayError> {
    let data_folder = get_jan_data_folder_path(app);
    replay_blocking(move || {
        crate::core::agent::replay::settle_for_run(&data_folder, &session, &replay_id, outcome)
    })
    .await
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
        Ok(crate::core::agent::replay::list(
            &data_folder,
            &session,
            snapshot_id.as_deref(),
        ))
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
    // code, and the file outlives the window. Written once, to the session's
    // canonical event log (AH-005); the activity timeline is folded from it.
    let event = event.redacted();
    tokio::task::spawn_blocking(move || {
        tauri_plugin_agent_tools::activity::append(&data_folder, &event)
    })
    .await
    .map_err(|e| e.to_string())
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
            tauri_plugin_agent_tools::event_log::append(&data_folder, event)
                .map_err(|e| e.message())?;
            written += 1;
        }
        Ok(written)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn event_export_cancels() -> &'static std::sync::Mutex<
    std::collections::BTreeMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>,
> {
    static MAP: std::sync::OnceLock<
        std::sync::Mutex<
            std::collections::BTreeMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>,
        >,
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
) -> Result<
    tauri_plugin_agent_tools::event_export::ExportReport,
    tauri_plugin_agent_tools::event_export::ExportError,
> {
    use tauri_plugin_agent_tools::event_export::{export, ExportError, ExportErrorKind};
    let data_folder = get_jan_data_folder_path(app);
    let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    event_export_cancels()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(token.clone(), flag.clone());
    let out = tokio::task::spawn_blocking(move || {
        export(
            &data_folder,
            &session,
            run.as_deref(),
            include_content,
            &flag,
        )
    })
    .await
    .map_err(|e| ExportError::new(ExportErrorKind::Io, e.to_string()));
    event_export_cancels()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(&token);
    out?
}

#[tauri::command]
pub fn agent_events_export_cancel(token: String) -> bool {
    match event_export_cancels()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&token)
    {
        Some(flag) => {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
            true
        }
        None => false,
    }
}

/// One page of a session's canonical events, oldest first, for the desktop
/// execution timeline. AH-172.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsPage {
    pub events: Vec<tauri_plugin_agent_tools::event_log::Envelope>,
    /// The highest `seq` in the session's log, so a caller polling with
    /// `after_seq` knows whether it has caught up.
    pub last_seq: u64,
    /// More events after `after_seq` than `limit` allowed.
    pub truncated: bool,
}

/// A session's events after `after_seq`, at most `limit` (default and cap
/// 5000). Scoped to the one session named; payloads were redacted and bounded
/// when they were written. A log that cannot be read is a typed error, not an
/// empty page.
#[tauri::command]
pub async fn agent_events_list(
    app: tauri::AppHandle,
    session: String,
    after_seq: Option<u64>,
    limit: Option<usize>,
) -> Result<EventsPage, String> {
    if session.trim().is_empty() {
        return Err("listing events needs the session they belong to".to_string());
    }
    let data_folder = get_jan_data_folder_path(app);
    tokio::task::spawn_blocking(move || {
        let all = tauri_plugin_agent_tools::event_log::read_session(&data_folder, &session)
            .map_err(|e| e.message())?;
        let last_seq = all.last().map_or(0, |e| e.seq);
        let after = after_seq.unwrap_or(0);
        let cap = limit.unwrap_or(5000).clamp(1, 5000);
        let newer: Vec<_> = all.into_iter().filter(|e| e.seq > after).collect();
        let truncated = newer.len() > cap;
        Ok(EventsPage {
            events: newer.into_iter().take(cap).collect(),
            last_seq,
            truncated,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The session's finished runs, each one steppable in the timeline. AH-176.
#[tauri::command]
pub async fn agent_events_runs(
    app: tauri::AppHandle,
    session: String,
) -> Result<
    Vec<tauri_plugin_agent_tools::run_replay::FinishedRun>,
    tauri_plugin_agent_tools::harness_error::HarnessError,
> {
    let data_folder = get_jan_data_folder_path(app);
    tokio::task::spawn_blocking(move || {
        tauri_plugin_agent_tools::run_replay::finished_runs(&data_folder, &session)
    })
    .await
    .map_err(|e| tauri_plugin_agent_tools::harness_error::HarnessError::internal(e.to_string()))?
}

/// One finished run's recorded events, to step through. A run that has not
/// ended, or is not in the log, is refused by kind. AH-176.
#[tauri::command]
pub async fn agent_events_run(
    app: tauri::AppHandle,
    session: String,
    run: String,
) -> Result<
    tauri_plugin_agent_tools::run_replay::RunRecording,
    tauri_plugin_agent_tools::harness_error::HarnessError,
> {
    let data_folder = get_jan_data_folder_path(app);
    tokio::task::spawn_blocking(move || {
        tauri_plugin_agent_tools::run_replay::recording(&data_folder, &session, &run)
    })
    .await
    .map_err(|e| tauri_plugin_agent_tools::harness_error::HarnessError::internal(e.to_string()))?
}

/// Read an export back as untrusted input and summarize it. Nothing in it is
/// run or replayed.
#[tauri::command]
pub async fn agent_events_inspect(
    path: String,
) -> Result<
    tauri_plugin_agent_tools::event_export::InspectReport,
    tauri_plugin_agent_tools::event_export::ExportError,
> {
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
    // The call's invocation, when the caller knows it: a provider can reuse a
    // call id across requests, and only this picks the right one (Jozkah/jan#244).
    invocation: Option<String>,
) -> Result<Option<String>, String> {
    let data_folder = get_jan_data_folder_path(app);
    tokio::task::spawn_blocking(move || {
        tauri_plugin_agent_tools::activity::read_diff(
            &data_folder,
            &session,
            invocation.as_deref(),
            &call,
        )
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
/// only exact number available; Flint's own measurement is an estimate and is
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
/// Titling and summarising are model calls Flint makes for itself; they are not
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

/// Idle-time memory consolidation ("autoDream").
///
/// Folds the permanent store's memory notes into a single deduplicated,
/// contradiction-resolved note. Off by default: the auto path (`manual = false`,
/// driven by the frontend idle poller) only runs when the store's
/// `consolidation.json` has enabled it and the machine is idle. A manual run
/// (`manual = true`, the user pressing "run now") bypasses the enabled/idle
/// gates, but every other guard still applies — the cross-process lock, the
/// path-safety check, and the atomic write. The backend is the real gate; the
/// hook merely schedules.
///
/// Uses the deterministic [`memory_consolidation::HeuristicMerger`] (passing
/// `None` for the model): consolidation reuses no second server, and wiring a
/// live model is a matter of handing `run_consolidation` an invoker instead.
#[tauri::command]
pub async fn consolidate_memory(
    idle_secs: u64,
    manual: bool,
) -> Result<memory_consolidation::ConsolidationOutcome, String> {
    use crate::core::agent::memory_consolidation as mc;

    let data_folder = crate::core::app::commands::resolve_jan_data_folder();
    let store = workspace::permanent_store(&data_folder);
    let dir = tauri_plugin_agent_tools::memory::memory_dir(&store);

    // The persisted config carries the enabled flag (default: off); the caller's
    // `idle_secs` overrides the idle threshold for this evaluation.
    let mut config = mc::ConsolidationConfig::load(&dir);
    config.idle_threshold_secs = idle_secs;

    // The renderer is the only idle sensor (it sees pointer/keyboard); the hook
    // calls the auto path only after `idle_secs` of inactivity. The snapshot
    // encodes that contract — last activity was at least `idle_secs` ago — so
    // the backend's `is_idle` gate exercises the same threshold and passes
    // exactly when the caller's claim holds. `enabled` (default off), the lock,
    // path safety, atomic write and the new-since checkpoint remain the real
    // backend gates. A `manual` call bypasses the enabled/idle gates only.
    let now = mc::now_ms();
    let snapshot = mc::ActivitySnapshot {
        last_activity_ms: now.saturating_sub(idle_secs.saturating_mul(1000)),
    };
    mc::run_consolidation(&dir, &config, snapshot, now, manual, None).await
}

#[cfg(test)]
mod extensions_command_tests {
    use super::*;
    use crate::core::agent::extensions::set_test_extensions_root;
    use crate::core::agent::projects_registry::set_test_registry_root;

    fn write_global_skill(dir: &std::path::Path, name: &str, body: &str) {
        let skills_dir = tauri_plugin_agent_tools::skills::skills_dir(dir).join(name);
        std::fs::create_dir_all(&skills_dir).unwrap();
        std::fs::write(skills_dir.join("SKILL.md"), body).unwrap();
    }

    /// `agent_resolve_extensions("home", None)` returns a global skill set up
    /// through the same test thread-locals `extensions::tests` uses, proving the
    /// command wrapper actually calls `resolve_extensions` rather than stubbing
    /// something else out.
    #[tokio::test]
    async fn resolve_extensions_home_returns_global_skill() {
        let user_store = tempfile::tempdir().unwrap();
        write_global_skill(
            user_store.path(),
            "caveman",
            "---\ndescription: caveman talk\n---\nbody\n",
        );
        agent_skills::set_test_user_skills(Some(user_store.path().to_path_buf()));
        agent_skills::set_test_user_plugins(None);
        let ext_store = tempfile::tempdir().unwrap();
        set_test_extensions_root(Some(ext_store.path().to_path_buf()));

        let result = agent_resolve_extensions("home".to_string(), None)
            .await
            .expect("resolve_extensions must not fail");
        assert!(
            result.iter().any(|m| m.name == "caveman"),
            "expected the global skill on the home surface: {:?}",
            result.iter().map(|m| &m.name).collect::<Vec<_>>()
        );

        set_test_extensions_root(None);
        agent_skills::set_test_user_skills(None);
    }

    /// `agent_extensions_matrix_set` then `agent_extensions_matrix_get` round
    /// trips through the persisted matrix: the surface key set by `_set` is
    /// visible in the JSON `_get` returns.
    #[tokio::test]
    async fn matrix_set_then_get_round_trips_surface_key() {
        let ext_store = tempfile::tempdir().unwrap();
        set_test_extensions_root(Some(ext_store.path().to_path_buf()));

        let after_set = agent_extensions_matrix_set(
            "skill".to_string(),
            "caveman".to_string(),
            "rooms".to_string(),
            None,
            true,
        )
        .await
        .expect("matrix_set must not fail");
        assert_eq!(
            after_set["skills"]["caveman"]["surfaces"][0], "rooms",
            "matrix_set's own return value must carry the surface: {after_set}"
        );

        let fetched = agent_extensions_matrix_get()
            .await
            .expect("matrix_get must not fail");
        assert_eq!(
            fetched["skills"]["caveman"]["surfaces"][0], "rooms",
            "matrix_get must reload what matrix_set persisted: {fetched}"
        );

        set_test_extensions_root(None);
    }

    /// `agent_extensions_matrix_set_item` replaces the whole surface vector,
    /// and `surfaces: None` clears the entry back to default-enabled.
    #[tokio::test]
    async fn matrix_set_item_full_vector_then_clear_round_trips() {
        let ext_store = tempfile::tempdir().unwrap();
        set_test_extensions_root(Some(ext_store.path().to_path_buf()));

        let after_set = agent_extensions_matrix_set_item(
            "skill".to_string(),
            "caveman".to_string(),
            Some(vec!["rooms".to_string(), "cowork:p1".to_string()]),
        )
        .await
        .expect("matrix_set_item must not fail");
        let surfaces = after_set["skills"]["caveman"]["surfaces"]
            .as_array()
            .expect("surfaces must be an array");
        assert_eq!(surfaces.len(), 2, "unexpected surfaces: {after_set}");

        let fetched = agent_extensions_matrix_get()
            .await
            .expect("matrix_get must not fail");
        assert_eq!(
            fetched["skills"]["caveman"]["surfaces"], after_set["skills"]["caveman"]["surfaces"],
            "matrix_get must reload what matrix_set_item persisted: {fetched}"
        );

        let after_clear =
            agent_extensions_matrix_set_item("skill".to_string(), "caveman".to_string(), None)
                .await
                .expect("matrix_set_item clear must not fail");
        assert!(
            after_clear["skills"].get("caveman").is_none(),
            "clear_item must remove the entry entirely: {after_clear}"
        );

        set_test_extensions_root(None);
    }

    /// Registering a folder then listing projects returns it, and
    /// `agent_resolve_extensions("cowork", Some(id))` resolves that id back to
    /// the folder (rather than treating an unknown/empty id as folderless).
    #[tokio::test]
    async fn projects_register_then_list_round_trips() {
        let registry_store = tempfile::tempdir().unwrap();
        set_test_registry_root(Some(registry_store.path().to_path_buf()));
        let project_dir = tempfile::tempdir().unwrap();

        let entry = agent_projects_register(project_dir.path().to_string_lossy().to_string())
            .await
            .expect("register must not fail");

        let listed = agent_projects_list().await.expect("list must not fail");
        assert!(
            listed.iter().any(|p| p.id == entry.id),
            "registered project must appear in the list"
        );

        set_test_registry_root(None);
    }
}

use crate::core::agent::memory_consolidation;
