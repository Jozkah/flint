//! Plugin lifecycle: install, list, details, enable/disable, removal, and
//! marketplace search. A plugin is a directory `.jan/agent/plugins/<name>/`
//! holding skills, slash-command prompt templates and agent profiles. There is
//! no lockfile or registry file: an installed plugin is a directory, removed by
//! deleting it. Installing never executes plugin code and never changes tool
//! permissions -- it only places files.
//!
//! A plugin's payload is discovered conventionally, so a source needs no
//! manifest to be installable:
//!   - `skills/` -- folder skills (`<name>/SKILL.md`) and flat `<name>.md`,
//!     the same layout as project skills
//!   - `commands/**/*.md` -- prompt templates offered as slash commands
//!   - `agents/**/*.md` -- agent profiles (subagent definitions)
//!   - `SKILL.md` at the plugin root -- a source that is itself one skill
//!   - `plugin.toml` or `.claude-plugin/plugin.json` -- optional metadata:
//!     `name`, `description`, `version`, `repo`
//!   - `.mcp.json` -- recognised so a source that ships only this is not
//!     rejected as empty, but NEVER loaded: plugins contribute no MCP servers.
//!
//! Sources, and what each one contacts:
//!   - a local folder -- copied (never cloned, never executed); no network.
//!   - a git URL -- `git clone --depth 1`, which contacts that URL's host.
//!   - a marketplace name -- only when `[plugins] marketplace` is configured:
//!     fetches that index URL, then clones the entry's repository.
//!
//! Per-project state lives in `agent.toml`: `[plugins] disabled = [...]` keeps
//! an installed plugin on disk while discovery skips it. Each install writes a
//! small `.jan-install.json` provenance record into the plugin directory, so
//! source and install time survive restarts without a registry.

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use serde::{Deserialize, Serialize};

use crate::core::agent::project::PluginsSection;
use crate::core::agent::skills;

/// Shell metacharacters rejected in install specs. A spec is a git URL or a
/// marketplace name; anything else (including command substitution) is a
/// typo or an injection attempt, so it errors instead of being passed to a
/// shell. `:` `/` `#` `@` `-` `_` `.` are all fine — they appear in URLs.
const SHELL_METACHARS: &[char] = &[
    ';', '&', '|', '`', '$', '(', ')', '{', '}', '<', '>', '\\', '\n', '\r', '\t',
];

const USER_AGENT: &str = "jan-agent-plugin-manager";

/// Provenance record written into every plugin Flint installs.
const INSTALL_RECORD_FILE: &str = ".jan-install.json";

/// Prefix of the staging directories an install copies or clones into before
/// the payload is renamed into place. Every discovery path skips these.
const STAGING_PREFIX: &str = ".installing-";

/// Cap on the executable file paths a details view lists (the count is exact).
const MAX_LISTED_EXECUTABLES: usize = 100;

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/// What went wrong, as a stable code the UI maps to actionable text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginErrorCode {
    /// The spec, URL or path is malformed or not the kind it claims to be.
    InvalidSource,
    /// A local folder does not exist or is not a directory.
    SourceNotFound,
    /// The source has no manifest, skills, commands, agents or SKILL.md.
    NoPluginContent,
    /// The source holds several plugins; one must be chosen.
    Collection,
    /// A plugin of this name is already installed.
    AlreadyInstalled,
    /// The plugin name is not a safe directory name.
    InvalidName,
    /// No installed plugin has this id.
    NotInstalled,
    /// `git` is not installed or not on PATH.
    GitUnavailable,
    /// `git clone` failed (network, authentication, unknown ref ...).
    GitFailed,
    /// A marketplace name was given but no marketplace is configured.
    MarketplaceNotConfigured,
    /// The configured marketplace index could not be fetched or parsed.
    MarketplaceUnavailable,
    /// The marketplace index has no entry of that name.
    MarketplaceEntryNotFound,
    /// The install was cancelled; nothing was installed.
    Cancelled,
    /// The project folder does not exist.
    ProjectUnavailable,
    /// `agent.toml` could not be read or written.
    Config,
    /// A filesystem operation failed.
    Io,
}

/// A refusal or failure from the plugin lifecycle: a code plus a message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PluginError {
    pub code: PluginErrorCode,
    pub message: String,
}

impl PluginError {
    pub(crate) fn new(code: PluginErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn io(e: impl std::fmt::Display) -> Self {
        Self::new(PluginErrorCode::Io, e.to_string())
    }
}

impl std::fmt::Display for PluginError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for PluginError {}

/// The CLI and TUI speak the `ERROR: ` string convention of agent tool output.
impl From<PluginError> for String {
    fn from(e: PluginError) -> Self {
        format!("ERROR: {}", e.message)
    }
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

/// What an install run needs besides its source: a cancellation flag, and
/// whether git may prompt on a terminal for credentials (the interactive CLI
/// can; the desktop has no terminal, so a prompt would hang forever).
#[derive(Clone)]
pub(crate) struct InstallCtx {
    pub cancel: Arc<AtomicBool>,
    pub terminal_prompts: bool,
}

impl InstallCtx {
    fn interactive() -> Self {
        Self {
            cancel: Arc::new(AtomicBool::new(false)),
            terminal_prompts: true,
        }
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    fn check(&self) -> Result<(), PluginError> {
        if self.cancelled() {
            Err(cancelled_error())
        } else {
            Ok(())
        }
    }
}

fn cancelled_error() -> PluginError {
    PluginError::new(
        PluginErrorCode::Cancelled,
        "install cancelled - nothing was installed",
    )
}

/// Installs in flight, by caller-chosen id, so a separate command can cancel.
static INSTALLS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Registration of one running install. Dropping it unregisters the id.
#[cfg_attr(feature = "cli", allow(dead_code))]
pub(crate) struct InstallGuard {
    id: String,
    cancel: Arc<AtomicBool>,
}

#[cfg_attr(feature = "cli", allow(dead_code))]
impl InstallGuard {
    pub(crate) fn ctx(&self) -> InstallCtx {
        InstallCtx {
            cancel: self.cancel.clone(),
            terminal_prompts: false,
        }
    }
}

impl Drop for InstallGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = INSTALLS.lock() {
            map.remove(&self.id);
        }
    }
}

/// Register an install under `id` so [`cancel_install`] can reach it.
#[cfg_attr(feature = "cli", allow(dead_code))]
pub(crate) fn begin_install(id: &str) -> Result<InstallGuard, PluginError> {
    let id = id.trim();
    if id.is_empty() {
        return Err(PluginError::new(
            PluginErrorCode::InvalidSource,
            "install id is required",
        ));
    }
    let mut map = INSTALLS
        .lock()
        .map_err(|_| PluginError::io("install registry is unavailable"))?;
    if map.contains_key(id) {
        return Err(PluginError::new(
            PluginErrorCode::InvalidSource,
            format!("an install with id '{id}' is already running"),
        ));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    map.insert(id.to_string(), cancel.clone());
    Ok(InstallGuard {
        id: id.to_string(),
        cancel,
    })
}

/// Request cancellation of a running install. `false` when no install of that
/// id is running (it already finished, or never started).
#[cfg_attr(feature = "cli", allow(dead_code))]
pub(crate) fn cancel_install(id: &str) -> bool {
    INSTALLS
        .lock()
        .ok()
        .and_then(|map| map.get(id.trim()).cloned())
        .map(|flag| flag.store(true, Ordering::SeqCst))
        .is_some()
}

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

// How a bare collection URL that holds several plugins is resolved after the
// clone. A collection has no payload at the root, so we enumerate the plugins
// inside it and either ask the user which one to install (interactive CLI) or
// fail with an actionable listing (TUI/desktop, where stdin is owned by the
// render loop and cannot be read mid-install).
#[derive(Clone, PartialEq, Eq)]
enum CollectionChoice {
    /// Fail on a multi-plugin collection, listing the choices in the error.
    // (desktop-only) `install` is the non-CLI entry point, so this arm is
    // dead under `--features cli` but still matched in the always-compiled
    // `finish_install`, so it is allowed rather than `cfg`'d out.
    #[cfg_attr(feature = "cli", allow(dead_code))]
    ListError,
    /// Ask on stdin which plugins to install (the interactive CLI).
    // (cli-only)
    #[cfg_attr(not(feature = "cli"), allow(dead_code))]
    Prompt,
    /// Return the choices instead of installing, so a caller that owns the
    /// terminal (the TUI) can present its own picker.
    // (cli-only)
    #[cfg_attr(not(feature = "cli"), allow(dead_code))]
    List,
    /// Install exactly these payload-root-relative paths (a picker selection).
    // (cli-only)
    #[cfg_attr(not(feature = "cli"), allow(dead_code))]
    Only(Vec<String>),
}

/// One plugin discovered inside a collection repo, for a caller to choose from.
pub(crate) struct CollectionPlugin {
    // (cli-only) fields are read only by the CLI list/install path but the
    // struct is constructed by the always-compiled `finish_install`, so they
    // are dead (allowed) under the desktop/test config.
    /// Path relative to the payload root, e.g. `plugins/code-review`.
    #[cfg_attr(not(feature = "cli"), allow(dead_code))]
    pub(crate) path: String,
    /// A plugin of this name is already installed.
    #[cfg_attr(not(feature = "cli"), allow(dead_code))]
    pub(crate) installed: bool,
}

/// The result of an install: either plugins landed, or the source turned out
/// to be a collection the caller must choose from.
pub(crate) enum GitInstall {
    Installed(Vec<InstalledPlugin>),
    // (cli-only) the collection listing is produced by the always-compiled
    // `finish_install` and consumed only by the CLI list/install path, so it
    // is dead (allowed) under the desktop/test config.
    #[cfg_attr(not(feature = "cli"), allow(dead_code))]
    Collection(Vec<CollectionPlugin>),
}

/// An installed plugin, from its directory plus optional manifest.
#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    /// The directory name under `.jan/agent/plugins/`: the stable identity
    /// every other operation (details, enable, remove) takes.
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub repo: String,
    /// Number of skills the plugin contributes.
    pub skills: usize,
    /// Number of command prompt templates (`commands/**/*.md`).
    pub commands: usize,
    /// Number of agent definitions (`agents/**/*.md`).
    pub agents: usize,
    /// False when listed in `[plugins].disabled`.
    pub enabled: bool,
    /// `local`, `git` or `marketplace`, from the install record; `None` for a
    /// directory Flint did not install (copied in by hand, or installed before
    /// records existed).
    pub source_kind: Option<String>,
    /// The folder path or URL the plugin was installed from.
    pub source: Option<String>,
}

/// Where a plugin was installed from, persisted as `.jan-install.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstallRecord {
    pub source_kind: String,
    pub source: String,
    #[serde(default)]
    pub git_ref: Option<String>,
    #[serde(default)]
    pub subdir: Option<String>,
    pub installed_at_ms: u64,
}

/// Everything the management UI shows about one installed plugin.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDetails {
    #[serde(flatten)]
    pub plugin: InstalledPlugin,
    pub installed_path: String,
    pub installed_at_ms: Option<u64>,
    pub git_ref: Option<String>,
    /// Qualified skill names (`<plugin>:<skill>`).
    pub skill_names: Vec<String>,
    pub command_names: Vec<String>,
    pub agent_names: Vec<String>,
    /// The plugin ships a `.mcp.json`. Flint does not load it.
    pub has_mcp_config: bool,
    /// Script and executable files (relative, `/`-separated), capped at
    /// [`MAX_LISTED_EXECUTABLES`]. They only ever run if the agent runs them
    /// through the shell tool, under the normal permission gate.
    pub executable_files: Vec<String>,
    pub executable_file_count: usize,
}

/// What `remove_plugin` removed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveReport {
    pub id: String,
    pub name: String,
    pub removed_path: String,
    /// The id was dropped from `[plugins].disabled`.
    pub removed_from_disabled: bool,
    /// `[skills].enabled` entries naming the plugin (`<id>` or `<id>:<skill>`)
    /// that were dropped.
    pub removed_skill_entries: Vec<String>,
}

/// Which install sources this project can use right now.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSources {
    /// The configured marketplace index URL, if any.
    pub marketplace: Option<String>,
    /// Whether `git` can be run (required for git and marketplace sources).
    pub git_available: bool,
}

/// An explicit install source from the desktop. Each kind states what it
/// contacts, so nothing is inferred from the shape of a string.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InstallSource {
    /// Copy a local folder. No network.
    Local { path: String },
    /// `git clone` a URL. Contacts that URL's host.
    Git { url: String },
    /// Resolve through the configured marketplace index, then clone.
    Marketplace { name: String },
}

/// A plugin available on the configured marketplace: JSON index entry.
#[derive(Serialize, Deserialize, Clone)]
pub struct MarketEntry {
    pub name: String,
    pub description: String,
    pub repo: String,
    #[serde(default)]
    pub r#ref: Option<String>,
}

/// Optional metadata manifest at the plugin root. Every field is optional so
/// a repo without a manifest is still installable and listable.
#[derive(Debug, Default, Deserialize)]
struct Manifest {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    repo: Option<String>,
}

fn client() -> Result<reqwest::Client, PluginError> {
    crate::core::net::tls::apply12(
        reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(std::time::Duration::from_secs(60)),
    )
        .build()
        .map_err(|e| PluginError::new(PluginErrorCode::MarketplaceUnavailable, e.to_string()))
}

/// Read the project's `[plugins]` config; missing/malformed falls back to
/// defaults (no marketplace, nothing disabled).
fn plugins_section(root: &Path) -> PluginsSection {
    crate::core::agent::project::load_agent_config(root)
        .ok()
        .map(|c| c.plugins)
        .unwrap_or_default()
}

/// [`plugins_section`], generalized to a [`PluginScope`]. `Global` reads
/// `<store>/agent.toml` -- the global agent config, sibling of the global
/// `plugins/`/`skills/` directories under the same store -- rather than any
/// project's `.jan/agent/agent.toml`. Missing/malformed still falls back to
/// defaults (no marketplace, nothing disabled), same as a project without one.
fn plugins_section_for_scope(scope: &PluginScope) -> PluginsSection {
    match scope {
        PluginScope::Project(root) => plugins_section(root),
        PluginScope::Global => {
            crate::core::agent::project::load_agent_config_at(&global_agent_toml_path())
                .ok()
                .map(|c| c.plugins)
                .unwrap_or_default()
        }
    }
}

/// Path to the global agent config: `<store>/agent.toml`, where `<store>` is
/// the same store `plugin_root_dir`'s `Global` arm and `user_plugins_dir`
/// resolve under (`<jan_data_folder>/agent-workspace` outside tests, or the
/// `set_test_user_plugins` override inside them).
fn global_agent_toml_path() -> PathBuf {
    match skills::user_plugin_store_root() {
        Some(store) => store.join("agent.toml"),
        None => {
            let data = crate::core::app::commands::resolve_jan_data_folder();
            tauri_plugin_agent_tools::workspace::permanent_store(&data).join("agent.toml")
        }
    }
}

/// Where a plugin manager operation targets its `plugins/` directory: a
/// single project's `.jan/agent/plugins/`, or the user's own global store
/// shared by every workspace (`<jan_data_folder>/agent-workspace/plugins/`,
/// same store `skills::user_plugins_dir` discovers from). `Project` is the
/// default everywhere for backward compatibility -- every existing caller
/// keeps installing, listing and removing per-project unless it opts into
/// `Global`.
#[derive(Debug, Clone)]
pub(crate) enum PluginScope {
    Project(PathBuf),
    #[cfg_attr(feature = "cli", allow(dead_code))]
    Global,
}

/// The `plugins/` directory a scope resolves to. `Global` honours the same
/// `skills::set_test_user_plugins` override the discovery tests use, so a
/// test can point it at a temp store without touching the real data folder;
/// outside tests it is `<jan_data_folder>/agent-workspace/plugins`.
pub(crate) fn plugin_root_dir(scope: &PluginScope) -> PathBuf {
    match scope {
        PluginScope::Project(root) => skills::plugins_dir(root),
        PluginScope::Global => skills::user_plugins_dir().unwrap_or_else(|| {
            let data = crate::core::app::commands::resolve_jan_data_folder();
            tauri_plugin_agent_tools::skills::plugins_dir(
                &tauri_plugin_agent_tools::workspace::permanent_store(&data),
            )
        }),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn read_install_record(plugin_dir: &Path) -> Option<InstallRecord> {
    std::fs::read_to_string(plugin_dir.join(INSTALL_RECORD_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

// ---------------------------------------------------------------------------
// Listing and details
// ---------------------------------------------------------------------------

/// Every installed plugin, sorted by display name. Staging directories from
/// interrupted installs are intentionally excluded. Disabled plugins are
/// listed (with `enabled: false`) and keep their component counts.
// (cli-only) the desktop path now goes through `installed_scoped`.
#[cfg_attr(not(feature = "cli"), allow(dead_code))]
pub(crate) fn installed(root: &Path) -> Vec<InstalledPlugin> {
    installed_entries(root)
        .into_iter()
        .map(|(_, plugin)| plugin)
        .collect()
}

/// Find an installed plugin by directory name or manifest name.
pub(crate) fn find_installed(root: &Path, query: &str) -> Option<(String, InstalledPlugin)> {
    let query = skills::safe_stem(query).ok()?;
    let entries = installed_entries(root);
    // Directory name first: it is the identity, a manifest name only a label.
    if let Some(hit) = entries.iter().find(|(directory, _)| directory == &query) {
        return Some(hit.clone());
    }
    entries.into_iter().find(|(_, plugin)| plugin.name == query)
}

fn installed_entries(root: &Path) -> Vec<(String, InstalledPlugin)> {
    let dir = skills::plugins_dir(root);
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    // Scan each artifact kind once; per-plugin counts filter the shared lists
    // rather than re-walking the whole plugin tree per plugin. The listing
    // shows what a plugin ships whether or not it is enabled.
    let all_skills = skills::discover_plugins_including_disabled(root);
    let all_commands = crate::core::agent::plugin_commands::discover_including_disabled(root);
    let disabled = crate::core::agent::project::disabled_plugins(root);
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let Some(directory) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if directory.starts_with(STAGING_PREFIX) {
            continue;
        }
        let manifest = read_manifest(&path);
        let record = read_install_record(&path);
        let plugin_skills = all_skills
            .iter()
            .filter(|e| e.plugin.as_deref() == Some(directory))
            .count();
        let plugin_commands = all_commands
            .iter()
            .filter(|e| e.plugin == directory)
            .count();
        let plugin_agents = crate::core::agent::subagent::count_plugin_agents(root, directory);
        out.push((
            directory.to_string(),
            InstalledPlugin {
                id: directory.to_string(),
                name: manifest.name.unwrap_or_else(|| directory.to_string()),
                description: manifest.description.unwrap_or_default(),
                version: manifest.version.unwrap_or_else(|| "0.0.0".to_string()),
                repo: manifest
                    .repo
                    .or_else(|| {
                        record
                            .as_ref()
                            .filter(|r| r.source_kind != "local")
                            .map(|r| r.source.clone())
                    })
                    .unwrap_or_default(),
                skills: plugin_skills,
                commands: plugin_commands,
                agents: plugin_agents,
                enabled: !disabled.iter().any(|d| d == directory),
                source_kind: record.as_ref().map(|r| r.source_kind.clone()),
                source: record.map(|r| r.source),
            },
        ));
    }
    out.sort_by(|a, b| a.1.name.cmp(&b.1.name));
    out
}

/// [`installed_entries`], generalized to a [`PluginScope`]. `Project` behaves
/// exactly as before. `Global` has no `agent.toml` of its own, so a global
/// plugin has no disabled list to consult (always `enabled: true`) and no
/// project-scoped skill/command/agent discovery to count against (those
/// counts are `0`; `agent_plugin_details` still lists names for a global
/// plugin by reading its directory directly).
fn installed_entries_scoped(scope: &PluginScope) -> Vec<(String, InstalledPlugin)> {
    if let PluginScope::Project(root) = scope {
        return installed_entries(root);
    }
    let dir = plugin_root_dir(scope);
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let Some(directory) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if directory.starts_with(STAGING_PREFIX) {
            continue;
        }
        let manifest = read_manifest(&path);
        let record = read_install_record(&path);
        out.push((
            directory.to_string(),
            InstalledPlugin {
                id: directory.to_string(),
                name: manifest.name.unwrap_or_else(|| directory.to_string()),
                description: manifest.description.unwrap_or_default(),
                version: manifest.version.unwrap_or_else(|| "0.0.0".to_string()),
                repo: manifest
                    .repo
                    .or_else(|| {
                        record
                            .as_ref()
                            .filter(|r| r.source_kind != "local")
                            .map(|r| r.source.clone())
                    })
                    .unwrap_or_default(),
                skills: 0,
                commands: 0,
                agents: 0,
                enabled: true,
                source_kind: record.as_ref().map(|r| r.source_kind.clone()),
                source: record.map(|r| r.source),
            },
        ));
    }
    out.sort_by(|a, b| a.1.name.cmp(&b.1.name));
    out
}

/// [`installed`], scoped to a project or the global store.
#[cfg_attr(feature = "cli", allow(dead_code))]
pub(crate) fn installed_scoped(scope: &PluginScope) -> Vec<InstalledPlugin> {
    installed_entries_scoped(scope)
        .into_iter()
        .map(|(_, plugin)| plugin)
        .collect()
}

/// [`find_installed`], scoped to a project or the global store.
fn find_installed_scoped(scope: &PluginScope, query: &str) -> Option<(String, InstalledPlugin)> {
    let query = skills::safe_stem(query).ok()?;
    let entries = installed_entries_scoped(scope);
    if let Some(hit) = entries.iter().find(|(directory, _)| directory == &query) {
        return Some(hit.clone());
    }
    entries.into_iter().find(|(_, plugin)| plugin.name == query)
}

/// Resolve an installed plugin by id (directory name), erroring when absent.
fn require_installed(root: &Path, id: &str) -> Result<(String, InstalledPlugin), PluginError> {
    skills::safe_stem(id).map_err(|_| {
        PluginError::new(
            PluginErrorCode::InvalidName,
            format!("invalid plugin name '{id}'"),
        )
    })?;
    find_installed(root, id).ok_or_else(|| {
        PluginError::new(
            PluginErrorCode::NotInstalled,
            format!("plugin '{id}' is not installed"),
        )
    })
}

/// Full details for one installed plugin. Reads files only.
#[cfg_attr(feature = "cli", allow(dead_code))]
pub(crate) fn details(root: &Path, id: &str) -> Result<PluginDetails, PluginError> {
    let (directory, plugin) = require_installed(root, id)?;
    let dir = skills::plugins_dir(root).join(&directory);
    let record = read_install_record(&dir);

    let skill_names = skills::discover_plugins_including_disabled(root)
        .iter()
        .filter(|e| e.plugin.as_deref() == Some(directory.as_str()))
        .map(skills::qualified_name)
        .collect();
    let command_names = crate::core::agent::plugin_commands::discover_including_disabled(root)
        .into_iter()
        .filter(|e| e.plugin == directory)
        .map(|e| e.name)
        .collect();
    let agent_names = crate::core::agent::subagent::plugin_agent_metas(root, &directory)
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    let executables = executable_files(&dir);

    Ok(PluginDetails {
        installed_path: dir.display().to_string(),
        installed_at_ms: record.as_ref().map(|r| r.installed_at_ms),
        git_ref: record.as_ref().and_then(|r| r.git_ref.clone()),
        skill_names,
        command_names,
        agent_names,
        has_mcp_config: dir.join(".mcp.json").is_file(),
        executable_file_count: executables.len(),
        executable_files: executables
            .into_iter()
            .take(MAX_LISTED_EXECUTABLES)
            .collect(),
        plugin,
    })
}

/// [`details`], scoped to a project or the global store. `Global` has no
/// per-project skill/command/agent discovery to name, so those lists are
/// empty; the identity, provenance and executable-file listing (all
/// directory reads) are unaffected.
#[cfg_attr(feature = "cli", allow(dead_code))]
pub(crate) fn details_scoped(scope: &PluginScope, id: &str) -> Result<PluginDetails, PluginError> {
    let root = match scope {
        PluginScope::Project(root) => return details(root, id),
        PluginScope::Global => plugin_root_dir(scope),
    };
    let (directory, plugin) = find_installed_scoped(scope, id).ok_or_else(|| {
        PluginError::new(
            PluginErrorCode::NotInstalled,
            format!("plugin '{id}' is not installed"),
        )
    })?;
    let dir = root.join(&directory);
    let record = read_install_record(&dir);
    let executables = executable_files(&dir);
    Ok(PluginDetails {
        installed_path: dir.display().to_string(),
        installed_at_ms: record.as_ref().map(|r| r.installed_at_ms),
        git_ref: record.as_ref().and_then(|r| r.git_ref.clone()),
        skill_names: Vec::new(),
        command_names: Vec::new(),
        agent_names: Vec::new(),
        has_mcp_config: dir.join(".mcp.json").is_file(),
        executable_file_count: executables.len(),
        executable_files: executables
            .into_iter()
            .take(MAX_LISTED_EXECUTABLES)
            .collect(),
        plugin,
    })
}

/// Extensions of files that can run as programs or scripts.
const EXECUTABLE_EXTENSIONS: &[&str] = &[
    "sh", "bash", "zsh", "fish", "ps1", "psm1", "bat", "cmd", "py", "js", "mjs", "cjs", "ts",
    "rb", "pl", "php", "exe", "com", "jar",
];

/// Every script/executable under `dir` (relative, `/`-separated, sorted).
/// Skips `.git` and never follows symlinks.
fn executable_files(dir: &Path) -> Vec<String> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<String>) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in rd.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            let path = entry.path();
            if ft.is_dir() {
                if entry.file_name() != ".git" {
                    walk(base, &path, out);
                }
                continue;
            }
            let is_exec = path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| EXECUTABLE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()));
            if is_exec {
                if let Ok(rel) = path.strip_prefix(base) {
                    out.push(
                        rel.components()
                            .map(|c| c.as_os_str().to_string_lossy())
                            .collect::<Vec<_>>()
                            .join("/"),
                    );
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out.sort();
    out
}

fn read_manifest(root: &Path) -> Manifest {
    std::fs::read_to_string(root.join("plugin.toml"))
        .ok()
        .and_then(|raw| toml::from_str::<Manifest>(&raw).ok())
        .or_else(|| {
            std::fs::read_to_string(root.join(".claude-plugin/plugin.json"))
                .ok()
                .and_then(|raw| serde_json::from_str::<Manifest>(&raw).ok())
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Enable / disable / remove
// ---------------------------------------------------------------------------

/// Enable or disable an installed plugin for this project, persisted to
/// `[plugins].disabled`. Changes only which installed files discovery reads:
/// no tool permission, no MCP server, no process.
#[cfg_attr(feature = "cli", allow(dead_code))]
pub(crate) fn set_enabled(
    root: &Path,
    id: &str,
    enabled: bool,
) -> Result<InstalledPlugin, PluginError> {
    let (directory, _) = require_installed(root, id)?;
    crate::core::agent::project::ensure_project(root)
        .map_err(|e| PluginError::new(PluginErrorCode::ProjectUnavailable, e))?;
    let path = crate::core::agent::project::agent_toml_path(root);
    // Read the current list from the file itself, not the lenient loader: a
    // malformed agent.toml must fail here rather than be overwritten with a
    // list that forgot the user's other disabled plugins.
    let cfg = crate::core::agent::project::load_agent_config(root)
        .map_err(|e| PluginError::new(PluginErrorCode::Config, e))?;
    let mut disabled = cfg.plugins.disabled;
    disabled.retain(|d| d != &directory);
    if !enabled {
        disabled.push(directory.clone());
    }
    crate::core::agent::project::set_string_array_in_agent_toml(
        &path, "plugins", "disabled", &disabled,
    )
    .map_err(|e| PluginError::new(PluginErrorCode::Config, e))?;
    find_installed(root, &directory)
        .map(|(_, plugin)| plugin)
        .ok_or_else(|| {
            PluginError::new(
                PluginErrorCode::NotInstalled,
                format!("plugin '{id}' is not installed"),
            )
        })
}

/// [`set_enabled`], scoped to a project or the global store. `Global` has no
/// `agent.toml` to persist a disabled list into -- a global plugin is always
/// enabled -- so this refuses rather than silently doing nothing.
#[cfg_attr(feature = "cli", allow(dead_code))]
pub(crate) fn set_enabled_scoped(
    scope: &PluginScope,
    id: &str,
    enabled: bool,
) -> Result<InstalledPlugin, PluginError> {
    match scope {
        PluginScope::Project(root) => set_enabled(root, id, enabled),
        PluginScope::Global => Err(PluginError::new(
            PluginErrorCode::ProjectUnavailable,
            "global plugins have no per-project enable/disable state",
        )),
    }
}

/// Remove an installed plugin: delete its directory, then drop its id from
/// `[plugins].disabled` and every `[skills].enabled` entry naming it.
///
/// The directory goes first. If config cleanup then fails, the plugin is gone
/// and a stale config entry can only ever disable or name something absent;
/// the reverse order could re-enable a plugin whose removal then failed.
///
/// A skills whitelist that named only this plugin would become empty, and an
/// empty whitelist means "every skill". That would silently turn on skills
/// the user had switched off, so it is written as `[""]` (matches nothing)
/// instead.
pub(crate) fn remove_plugin(root: &Path, query: &str) -> Result<RemoveReport, PluginError> {
    let (directory, plugin) = require_installed(root, query)?;
    let target = skills::plugins_dir(root).join(&directory);
    std::fs::remove_dir_all(&target).map_err(|e| {
        PluginError::io(format!("could not remove {}: {e}", target.display()))
    })?;
    let mut report = RemoveReport {
        id: directory.clone(),
        name: plugin.name,
        removed_path: target.display().to_string(),
        removed_from_disabled: false,
        removed_skill_entries: Vec::new(),
    };

    let path = crate::core::agent::project::agent_toml_path(root);
    if !path.is_file() {
        return Ok(report);
    }
    let config_failed = |e: String| {
        PluginError::new(
            PluginErrorCode::Config,
            format!(
                "removed {}, but could not update agent.toml: {e}",
                target.display()
            ),
        )
    };
    let cfg = crate::core::agent::project::load_agent_config(root).map_err(config_failed)?;

    let mut disabled = cfg.plugins.disabled;
    let before = disabled.len();
    disabled.retain(|d| d != &directory);
    if disabled.len() != before {
        crate::core::agent::project::set_string_array_in_agent_toml(
            &path, "plugins", "disabled", &disabled,
        )
        .map_err(config_failed)?;
        report.removed_from_disabled = true;
    }

    let mut enabled = cfg.skills.enabled;
    let prefix = format!("{directory}:");
    let (dropped, kept): (Vec<String>, Vec<String>) = enabled
        .drain(..)
        .partition(|n| n == &directory || n.starts_with(&prefix));
    if !dropped.is_empty() {
        let kept = if kept.is_empty() {
            vec![String::new()]
        } else {
            kept
        };
        crate::core::agent::project::set_string_array_in_agent_toml(
            &path, "skills", "enabled", &kept,
        )
        .map_err(config_failed)?;
        report.removed_skill_entries = dropped;
    }
    Ok(report)
}

/// Remove an installed plugin by directory or manifest name (CLI surface).
#[cfg_attr(not(feature = "cli"), allow(dead_code))]
pub(crate) fn remove(root: &Path, name: &str) -> Result<(), String> {
    remove_plugin(root, name).map(|_| ()).map_err(String::from)
}

/// [`remove_plugin`], scoped to a project or the global store. `Global` has
/// no `agent.toml`, so removal is just deleting the plugin directory -- there
/// is no `[plugins].disabled` or `[skills].enabled` entry naming a global
/// plugin to clean up.
#[cfg_attr(feature = "cli", allow(dead_code))]
pub(crate) fn remove_plugin_scoped(
    scope: &PluginScope,
    query: &str,
) -> Result<RemoveReport, PluginError> {
    if let PluginScope::Project(root) = scope {
        return remove_plugin(root, query);
    }
    let (directory, plugin) = find_installed_scoped(scope, query).ok_or_else(|| {
        PluginError::new(
            PluginErrorCode::NotInstalled,
            format!("plugin '{query}' is not installed"),
        )
    })?;
    let target = plugin_root_dir(scope).join(&directory);
    std::fs::remove_dir_all(&target)
        .map_err(|e| PluginError::io(format!("could not remove {}: {e}", target.display())))?;
    Ok(RemoveReport {
        id: directory,
        name: plugin.name,
        removed_path: target.display().to_string(),
        removed_from_disabled: false,
        removed_skill_entries: Vec::new(),
    })
}

/// Which sources the project can install from.
// (dead in both configs now: the desktop path goes through `sources_scoped`,
// and no CLI surface calls this directly either) kept for API stability.
#[allow(dead_code)]
pub(crate) fn sources(root: &Path) -> PluginSources {
    PluginSources {
        marketplace: plugins_section(root).marketplace,
        git_available: git_command()
            .arg("--version")
            .stdin(Stdio::null())
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false),
    }
}

/// [`sources`], scoped to a project or the global store (which has no
/// marketplace of its own; see [`plugins_section_for_scope`]).
#[cfg_attr(feature = "cli", allow(dead_code))]
pub(crate) fn sources_scoped(scope: &PluginScope) -> PluginSources {
    PluginSources {
        marketplace: plugins_section_for_scope(scope).marketplace,
        git_available: git_command()
            .arg("--version")
            .stdin(Stdio::null())
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false),
    }
}

// ---------------------------------------------------------------------------
// Spec parsing
// ---------------------------------------------------------------------------

/// Does the spec name a local filesystem path in Windows form?
///
/// Only `\` is at stake here, and only for a path. A drive-letter path
/// (`C:\src\plugin`), its `file://` URL, and a UNC share (`\\host\share`) all
/// contain backslashes as *separators*, which is not the same thing as a spec
/// trying to smuggle an escape into a command line.
fn is_windows_local_path(spec: &str) -> bool {
    let path = spec
        .strip_prefix("file:///")
        .or_else(|| spec.strip_prefix("file://"))
        .unwrap_or(spec);
    let bytes = path.as_bytes();
    // `\\host\share`
    if path.starts_with(r"\\") {
        return true;
    }
    // `C:\...` or `C:/...`
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

/// What a CLI install spec names.
#[derive(Debug, PartialEq, Eq)]
enum SpecKind {
    /// A local folder, copied.
    Local,
    /// A git source, cloned.
    Git,
    /// A marketplace entry name.
    Marketplace,
}

/// Classify a CLI spec. A bare path -- Windows drive or UNC, POSIX absolute,
/// or explicitly relative -- is a local folder. `file://` stays a git clone:
/// it is how a local *repository* is named, and cloning it is what the user
/// asked for. Before this existed, `C:\src\plugin` fell through to a
/// marketplace lookup because it matched no git shape.
fn classify_spec(spec: &str) -> SpecKind {
    let spec = spec.trim();
    if looks_like_git(spec) {
        return SpecKind::Git;
    }
    if is_windows_local_path(spec)
        || spec.starts_with('/')
        || spec == "."
        || spec == ".."
        || ["./", "../", ".\\", "..\\"]
            .iter()
            .any(|p| spec.starts_with(p))
    {
        return SpecKind::Local;
    }
    SpecKind::Marketplace
}

/// Reject specs that could inject shell commands. The spec is later passed as
/// literal argv to `git clone`, never to a shell, but a spec full of `$()`
/// is a typo at best — error early and clearly.
///
/// `\` is the one character whose meaning depends on the spec. It is a shell
/// escape in a URL and a path separator on Windows, and rejecting it outright
/// made every local-path install impossible there -- `jan plugin install
/// C:\src\my-plugin` and the `file://` form both failed as "shell
/// metacharacters are not allowed". So it is permitted for a spec that is
/// recognisably a Windows path, and rejected everywhere else. Every other
/// metacharacter is still refused, in a path or out of it.
fn validate_spec(spec: &str) -> Result<(), PluginError> {
    let spec = spec.trim();
    if spec.is_empty() {
        return Err(PluginError::new(
            PluginErrorCode::InvalidSource,
            "nothing to install",
        ));
    }
    let path_like =
        is_windows_local_path(spec) || spec.starts_with(".\\") || spec.starts_with("..\\");
    if spec
        .chars()
        .any(|c| SHELL_METACHARS.contains(&c) && !(path_like && c == '\\'))
    {
        return Err(PluginError::new(
            PluginErrorCode::InvalidSource,
            format!("invalid plugin spec '{spec}' (shell metacharacters are not allowed)"),
        ));
    }
    Ok(())
}

/// Does the spec name a git source directly (URL, scp-like, or host shorthand)
/// rather than a marketplace name?
fn looks_like_git(spec: &str) -> bool {
    spec.contains("://")
        || spec.starts_with("git@")
        || ["github:", "gitlab:", "bitbucket:", "codeberg:"]
            .iter()
            .any(|p| spec.starts_with(p))
}

#[derive(Debug, PartialEq, Eq)]
struct GitSource {
    url: String,
    r#ref: Option<String>,
    subdir: Option<String>,
}

/// Parse a git URL and the optional GitHub `/tree/<ref>/<subdir>` (or
/// `/blob/<ref>/<subdir>`) payload path. Both the GitHub "browse" (`tree`) and
/// "copy path" (`blob`) URL forms name a repo, a ref, and a subdirectory to
/// install as a single plugin.
fn parse_git_source(spec: &str) -> Result<GitSource, PluginError> {
    let (base, suffix_ref) = split_ref(spec.trim());
    if let Some(path) = base.strip_prefix("https://github.com/") {
        let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
        if parts.len() >= 4 && (parts[2] == "tree" || parts[2] == "blob") {
            let repo = format!("https://github.com/{}/{}.git", parts[0], parts[1]);
            let tree_ref = parts[3].to_string();
            let subdir = (parts.len() > 4).then(|| parts[4..].join("/"));
            if subdir
                .as_deref()
                .is_some_and(|path| path.split('/').any(|part| part == "." || part == ".."))
            {
                return Err(PluginError::new(
                    PluginErrorCode::InvalidSource,
                    "plugin subdirectory cannot contain '.' or '..'",
                ));
            }
            return Ok(GitSource {
                url: repo,
                r#ref: Some(suffix_ref.unwrap_or(&tree_ref).to_string()),
                subdir,
            });
        }
    }
    Ok(GitSource {
        url: base.to_string(),
        r#ref: suffix_ref.map(str::to_string),
        subdir: None,
    })
}

fn plugin_has_content(root: &Path) -> bool {
    root.join("plugin.toml").is_file()
        || root.join(".claude-plugin/plugin.json").is_file()
        || root.join("skills").is_dir()
        || root.join("commands").is_dir()
        || root.join("agents").is_dir()
        || root.join("SKILL.md").is_file()
        || root.join(".mcp.json").is_file()
}
/// Walk `root` (recursively, skipping hidden dirs) and collect every directory
/// that is itself a plugin payload. A collection repo can nest plugins at any
/// depth (e.g. `plugins/` and `external_plugins/` are only wrapper dirs),
/// so a bare collection URL can't rely on a one-level scan.
fn find_plugin_dirs(root: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let rd = match std::fs::read_dir(dir) {
            Ok(rd) => rd,
            Err(_) => return,
        };
        for entry in rd.flatten() {
            let path = entry.path();
            // Skip hidden entries and symlinks. `entry.file_type()` reports the
            // link itself (not the target, unlike `path.is_dir()` which follows
            // it), so symlinked dirs are never descended into -- a hostile or
            // malformed collection can't use a link back to an ancestor to
            // recurse forever.
            let is_dir = match entry.file_type() {
                Ok(ft) => ft.is_dir() && !ft.is_symlink(),
                Err(_) => false,
            };
            if !is_dir {
                continue;
            }
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            if plugin_has_content(&path) {
                out.push(path);
            } else {
                walk(&path, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, &mut out);
    out
}

/// Present the plugin choices of a collection on stdout and collect the
/// 0-based indices the user wants to install, reading from `input`. The caller
/// has already cloned the collection, so this only asks which to install.
///
/// Accepts a comma/space-separated list of numbers, the keyword `all` (every
/// plugin), or a blank line to cancel. Already-installed plugins are marked
/// `[installed]` and skipped, never errored.
fn prompt_multi_choice(
    url: &str,
    paths: &[String],
    already: &[bool],
    input: &mut dyn io::BufRead,
) -> Result<Vec<usize>, String> {
    let mut stdout = io::stdout().lock();
    writeln!(
        stdout,
        "'{url}' is a plugin collection ({n} plugins):",
        n = paths.len()
    )
    .map_err(|e| format!("ERROR: {e}"))?;
    let width = paths.len().to_string().len();
    for (i, (path, inst)) in paths.iter().zip(already).enumerate() {
        let mark = if *inst { "  [installed]" } else { "" };
        writeln!(stdout, "  {:>width$}. {path}{mark}", i + 1).map_err(|e| format!("ERROR: {e}"))?;
    }
    writeln!(
        stdout,
        "Install which? numbers (e.g. 1 3 5) or 'all' [enter to cancel]:"
    )
    .map_err(|e| format!("ERROR: {e}"))?;
    let _ = stdout.flush();

    let mut line = String::new();
    loop {
        line.clear();
        match input.read_line(&mut line) {
            Ok(0) => return Err("ERROR: no plugin selected - install aborted".into()),
            Ok(_) => {}
            Err(e) => return Err(format!("ERROR: reading plugin choice: {e}")),
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return Err("ERROR: no plugin selected - install aborted".into());
        }
        if trimmed.eq_ignore_ascii_case("all") {
            return Ok((0..paths.len()).collect());
        }
        let mut picked: Vec<usize> = Vec::new();
        let mut ok = true;
        for tok in trimmed.split(|c: char| c == ',' || c.is_whitespace()) {
            if tok.is_empty() {
                continue;
            }
            match tok.parse::<usize>() {
                Ok(n) if (1..=paths.len()).contains(&n) => {
                    let idx = n - 1;
                    if !picked.contains(&idx) {
                        picked.push(idx);
                    }
                }
                _ => {
                    ok = false;
                    break;
                }
            }
        }
        if ok && !picked.is_empty() {
            return Ok(picked);
        }
        writeln!(
            stdout,
            "'{trimmed}' is not a valid choice; enter numbers like '1 3 5' or 'all' [enter to cancel]:"
        )
        .map_err(|e| format!("ERROR: {e}"))?;
        let _ = stdout.flush();
    }
}
/// Split a `#ref` suffix off a git URL (`https://host/repo#main`).
fn split_ref(url: &str) -> (&str, Option<&str>) {
    match url.split_once('#') {
        Some((base, r#ref)) => (base, Some(r#ref)),
        None => (url, None),
    }
}

/// The default plugin name for a repo URL: the last path segment, `.git`
/// stripped. `https://github.com/acme/release-tools.git` -> `release-tools`.
///
/// Splits on `\` as well as `/`, because a spec can be a local Windows path.
/// Splitting on `/` alone left `C:\src\my-plugin` as a single "segment", so the
/// whole path became the proposed plugin name and installing from a local
/// directory failed as `invalid plugin name 'C:\src\my-plugin'`. A backslash
/// is never a legal character *within* a segment on either platform, so
/// treating it as a separator everywhere costs nothing.
fn repo_dir_name(url: &str) -> Option<&str> {
    let (base, _) = split_ref(url);
    let base = base.trim_end_matches(['/', '\\']);
    let name = base.rsplit(['/', '\\']).next()?;
    Some(name.strip_suffix(".git").unwrap_or(name))
}

// ---------------------------------------------------------------------------
// Process and filesystem helpers
// ---------------------------------------------------------------------------

/// `git` with no console window on Windows (the desktop is a GUI process).
fn git_command() -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new("git");
    {
        use jan_process::CommandConsole;
        cmd.background();
    }
    cmd
}

#[cfg(test)]
fn git(args: &[&str]) -> Result<String, String> {
    let out = git_command()
        .args(args)
        .output()
        .map_err(|e| format!("ERROR: git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(format!(
            "ERROR: git: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// How a cancellable child process ended badly.
#[derive(Debug)]
enum RunError {
    Spawn(io::Error),
    Cancelled,
    Failed(String),
}

/// Run `cmd` to completion unless `cancel` is raised, in which case the child
/// is killed. Output pipes are drained on threads so a chatty child cannot
/// block on a full pipe while we poll. On cancel the drain threads are not
/// joined: a grandchild (git's remote helper) may still hold the pipe, and
/// cancelling must not wait for it.
fn run_cancellable(mut cmd: Command, cancel: &AtomicBool) -> Result<String, RunError> {
    if cancel.load(Ordering::SeqCst) {
        return Err(RunError::Cancelled);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(RunError::Spawn)?;
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut buf);
            }
            buf
        })
    };
    let stdout = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let stderr = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let status = loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(RunError::Cancelled);
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(25)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(RunError::Failed(e.to_string()));
            }
        }
    };
    let out = stdout.join().unwrap_or_default();
    let err = stderr.join().unwrap_or_default();
    if status.success() {
        Ok(String::from_utf8_lossy(&out).trim().to_string())
    } else {
        Err(RunError::Failed(
            String::from_utf8_lossy(&err).trim().to_string(),
        ))
    }
}

/// A fresh, unique staging directory under `plugins`. Unique per install (not
/// just per process) so two installs in one app cannot share one.
fn new_staging(plugins: &Path) -> PathBuf {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let tmp = plugins.join(format!(
        "{STAGING_PREFIX}{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&tmp);
    tmp
}

/// Remove a staging directory, retrying briefly: on Windows a just-killed git
/// child can hold a handle inside the clone for a moment.
fn remove_staging(tmp: &Path) {
    for attempt in 0..20 {
        match std::fs::remove_dir_all(tmp) {
            Ok(()) => return,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return,
            Err(_) if attempt < 19 => std::thread::sleep(std::time::Duration::from_millis(100)),
            Err(e) => log::warn!("plugins: could not remove staging {}: {e}", tmp.display()),
        }
    }
}

/// Copy `src` into `dst` (created), file by file. Symlinks are skipped, never
/// followed, and `.git` directories are not copied. Nothing is executed.
/// `on_file` runs after each copied file; cancellation is checked before each
/// entry.
fn copy_tree(
    src: &Path,
    dst: &Path,
    ctx: &InstallCtx,
    on_file: &mut dyn FnMut(),
) -> Result<(), PluginError> {
    ctx.check()?;
    std::fs::create_dir_all(dst).map_err(PluginError::io)?;
    let rd = std::fs::read_dir(src)
        .map_err(|e| PluginError::io(format!("could not read {}: {e}", src.display())))?;
    for entry in rd {
        ctx.check()?;
        let entry = entry.map_err(PluginError::io)?;
        let ft = entry.file_type().map_err(PluginError::io)?;
        if ft.is_symlink() {
            continue;
        }
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ft.is_dir() {
            if entry.file_name() == ".git" {
                continue;
            }
            copy_tree(&from, &to, ctx, on_file)?;
        } else if ft.is_file() {
            std::fs::copy(&from, &to).map_err(|e| {
                PluginError::io(format!("could not copy {}: {e}", from.display()))
            })?;
            on_file();
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/// A source already fetched into a staging directory, ready to be installed.
struct Staged {
    /// The staging directory (removed at the end, whatever happens).
    tmp: PathBuf,
    /// Where the payload search starts (the staging dir or a subdirectory).
    payload_root: PathBuf,
    /// The explicit subdirectory the source named, if any.
    subdir: Option<String>,
    /// The URL or path as shown in messages.
    display: String,
    /// Name for a root-level payload that has no manifest name.
    fallback_name: Option<String>,
    /// How to name one plugin of a collection directly.
    collection_hint: String,
    /// Provenance, completed per installed payload.
    record: InstallRecord,
}

/// Clone a plugin source into a staging dir, then install from it. A failed
/// or cancelled clone, or an empty repo, leaves nothing behind.
///
/// Returns one installed plugin for a normal source or a single-plugin
/// collection, and several for a multi-plugin collection when the user asked
/// for more than one (interactive CLI). Already-installed plugins are skipped,
/// not reported as errors.
fn install_git(
    scope: &PluginScope,
    url: &str,
    r#ref: Option<&str>,
    collection: CollectionChoice,
    ctx: &InstallCtx,
    source_kind: &str,
) -> Result<GitInstall, PluginError> {
    let source = parse_git_source(url)?;
    let plugins = plugin_root_dir(scope);
    std::fs::create_dir_all(&plugins).map_err(PluginError::io)?;
    ctx.check()?;
    let tmp = new_staging(&plugins);

    let r#ref = r#ref.or(source.r#ref.as_deref());
    let mut cmd = git_command();
    // A repository's symbolic links are checked out as plain files holding
    // the link text, never as links. A link in a plugin would otherwise lead
    // out of it: a skill file pointing at the project's `.env` is read and
    // handed to the model by `skill_read`, and a directory link named in a
    // tree URL's subdirectory makes the installer move a real directory from
    // outside the clone into the plugin store. The local-folder install
    // already skips links for the same reason.
    cmd.args(["-c", "core.symlinks=false", "clone", "--depth", "1"]);
    if let Some(r#ref) = r#ref {
        cmd.args(["--branch", r#ref]);
    }
    cmd.arg(&source.url).arg(&tmp);
    if !ctx.terminal_prompts {
        // No terminal to answer a credential prompt: fail instead of hanging.
        cmd.env("GIT_TERMINAL_PROMPT", "0");
    }
    if let Err(e) = run_cancellable(cmd, &ctx.cancel) {
        remove_staging(&tmp);
        return Err(match e {
            RunError::Cancelled => cancelled_error(),
            RunError::Spawn(e) if e.kind() == io::ErrorKind::NotFound => PluginError::new(
                PluginErrorCode::GitUnavailable,
                "git is not installed or not on PATH",
            ),
            RunError::Spawn(e) => {
                PluginError::new(PluginErrorCode::GitFailed, format!("git: {e}"))
            }
            RunError::Failed(stderr) => {
                PluginError::new(PluginErrorCode::GitFailed, format!("git: {stderr}"))
            }
        });
    }

    let payload_root = source
        .subdir
        .as_deref()
        .map(|subdir| tmp.join(subdir))
        .unwrap_or_else(|| tmp.clone());
    // Whatever the checkout holds, the payload must resolve inside the clone.
    let inside = match (payload_root.canonicalize(), tmp.canonicalize()) {
        (Ok(p), Ok(t)) => p.starts_with(&t),
        // A subdirectory that does not exist is reported as such below.
        (Err(_), _) => true,
        (Ok(_), Err(_)) => false,
    };
    if !inside {
        remove_staging(&tmp);
        return Err(PluginError::new(
            PluginErrorCode::InvalidSource,
            format!(
                "plugin subdirectory leads outside the repository: '{}'",
                source.subdir.as_deref().unwrap_or("")
            ),
        ));
    }
    let staged = Staged {
        tmp,
        payload_root,
        subdir: source.subdir.clone(),
        display: url.to_string(),
        fallback_name: repo_dir_name(&source.url).map(str::to_string),
        collection_hint: format!("{url}/tree/<ref>/<relative/path>"),
        record: InstallRecord {
            source_kind: source_kind.to_string(),
            source: if source_kind == "git" {
                url.to_string()
            } else {
                source.url.clone()
            },
            git_ref: r#ref.map(str::to_string),
            subdir: source.subdir.clone(),
            installed_at_ms: 0,
        },
    };
    finish_install(scope, &plugins, staged, collection, ctx, &source.url)
}

/// Copy a local folder into a staging dir, then install from it. Nothing is
/// cloned, fetched or executed. `on_file` runs after each copied file.
fn install_local(
    scope: &PluginScope,
    src: &Path,
    collection: CollectionChoice,
    ctx: &InstallCtx,
    on_file: &mut dyn FnMut(),
) -> Result<GitInstall, PluginError> {
    if !src.is_dir() {
        return Err(PluginError::new(
            PluginErrorCode::SourceNotFound,
            format!("folder does not exist: {}", src.display()),
        ));
    }
    let plugins = plugin_root_dir(scope);
    std::fs::create_dir_all(&plugins).map_err(PluginError::io)?;
    // Copying a folder that contains the plugins directory (the project root,
    // say) would copy the staging directory into itself.
    let src_real = std::fs::canonicalize(src).map_err(PluginError::io)?;
    let plugins_real = std::fs::canonicalize(&plugins).map_err(PluginError::io)?;
    if plugins_real.starts_with(&src_real) || src_real.starts_with(&plugins_real) {
        return Err(PluginError::new(
            PluginErrorCode::InvalidSource,
            format!(
                "cannot install from {}: it contains or is inside this project's plugin directory",
                src.display()
            ),
        ));
    }
    let tmp = new_staging(&plugins);
    if let Err(e) = copy_tree(&src_real, &tmp, ctx, on_file) {
        remove_staging(&tmp);
        return Err(e);
    }
    let display = src.display().to_string();
    let staged = Staged {
        payload_root: tmp.clone(),
        tmp,
        subdir: None,
        fallback_name: repo_dir_name(&display).map(str::to_string),
        collection_hint: format!("{display}/<relative/path>"),
        record: InstallRecord {
            source_kind: "local".to_string(),
            source: display.clone(),
            git_ref: None,
            subdir: None,
            installed_at_ms: 0,
        },
        display,
    };
    finish_install(scope, &plugins, staged, collection, ctx, &src.display().to_string())
}

/// Discover which plugin(s) in a staged source to install and move each one
/// into place under its final name. The staging directory is always removed.
fn finish_install(
    scope: &PluginScope,
    plugins: &Path,
    staged: Staged,
    collection: CollectionChoice,
    ctx: &InstallCtx,
    source_url: &str,
) -> Result<GitInstall, PluginError> {
    let tmp = staged.tmp.clone();
    let result = select_and_install(scope, plugins, &staged, collection, ctx, source_url);
    remove_staging(&tmp);
    result
}

fn select_and_install(
    scope: &PluginScope,
    plugins: &Path,
    staged: &Staged,
    collection: CollectionChoice,
    ctx: &InstallCtx,
    source_url: &str,
) -> Result<GitInstall, PluginError> {
    let url = staged.display.as_str();
    let payload_root = &staged.payload_root;
    if !payload_root.is_dir() {
        return Err(PluginError::new(
            PluginErrorCode::InvalidSource,
            format!(
                "plugin subdirectory does not exist: '{}'",
                staged.subdir.as_deref().unwrap_or("")
            ),
        ));
    }

    // Decide which payload directory(ies) to install, as
    // (dir, fallback name, is a subdir of the staging dir, relative path).
    let mut targets: Vec<(PathBuf, Option<String>, bool, Option<String>)> = Vec::new();
    if plugin_has_content(payload_root) {
        // A single plugin: either the source root or an explicit subdir.
        let fallback = staged
            .subdir
            .as_deref()
            .and_then(|subdir| subdir.rsplit('/').next())
            .map(str::to_string)
            .or_else(|| staged.fallback_name.clone());
        targets.push((
            payload_root.clone(),
            fallback,
            staged.subdir.is_some(),
            staged.subdir.clone(),
        ));
    } else {
        // A collection has no payload at its root; plugins can be nested any
        // number of dirs deep (`plugins/` and `external_plugins/` are only
        // wrapper dirs). Relative paths are always `/`-separated: they are
        // offered back to the user as the tail of a spec, so a Windows `\`
        // would print a suggestion that does not work when pasted back in.
        let rel_of = |p: &Path| {
            p.strip_prefix(payload_root)
                .map(|rel| {
                    rel.components()
                        .map(|c| c.as_os_str().to_string_lossy())
                        .collect::<Vec<_>>()
                        .join("/")
                })
                .unwrap_or_default()
        };
        let mut candidates = find_plugin_dirs(payload_root);
        candidates.sort_by_key(|p| rel_of(p));
        let rels: Vec<String> = candidates.iter().map(|p| rel_of(p)).collect();
        let already = || -> Vec<bool> {
            candidates
                .iter()
                .map(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .map(|n| plugins.join(n).exists())
                        .unwrap_or(false)
                })
                .collect()
        };
        let picked: Vec<usize> = match candidates.len() {
            0 => {
                return Err(PluginError::new(
                    PluginErrorCode::NoPluginContent,
                    format!(
                        "'{url}' has no plugin manifest, skills/, commands/, agents/, or SKILL.md - nothing to install"
                    ),
                ));
            }
            // Exactly one plugin in the collection: no ambiguity, install it.
            1 => vec![0],
            n => match &collection {
                CollectionChoice::ListError => {
                    return Err(PluginError::new(
                        PluginErrorCode::Collection,
                        format!(
                            "'{url}' is a plugin collection ({n} plugins: {}) - install one directly, e.g. {}",
                            rels.join(", "),
                            staged.collection_hint
                        ),
                    ));
                }
                CollectionChoice::Prompt => {
                    // Mark plugins already installed so the user can see why a
                    // pick will be skipped.
                    prompt_multi_choice(url, &rels, &already(), &mut io::stdin().lock()).map_err(
                        |e| {
                            PluginError::new(
                                PluginErrorCode::Cancelled,
                                e.strip_prefix("ERROR: ").unwrap_or(&e).to_string(),
                            )
                        },
                    )?
                }
                // The TUI owns stdin, so it cannot prompt inline: return the
                // candidate list untouched and let the caller present its own
                // picker, then re-invoke with `Only` for the chosen paths.
                CollectionChoice::List => {
                    return Ok(GitInstall::Collection(
                        rels.into_iter()
                            .zip(already())
                            .map(|(path, installed)| CollectionPlugin { path, installed })
                            .collect(),
                    ));
                }
                // A picker selection: install exactly the payload-root-relative
                // paths the caller chose. A caller that never supplied any (or
                // supplied paths matching no candidate) is a user error -- the
                // collection was re-scanned since the picker's listing, so that
                // is surfaced immediately instead of falling through to the
                // confusing "already installed: (nothing)" message below.
                CollectionChoice::Only(paths) => {
                    if paths.is_empty() {
                        return Err(PluginError::new(
                            PluginErrorCode::InvalidSource,
                            format!("no matching plugins in '{url}' to install: (none selected)"),
                        ));
                    }
                    let unmatched: Vec<&String> =
                        paths.iter().filter(|p| !rels.contains(p)).collect();
                    if !unmatched.is_empty() {
                        return Err(PluginError::new(
                            PluginErrorCode::InvalidSource,
                            format!(
                                "no matching plugins in '{url}' to install: {}",
                                unmatched
                                    .into_iter()
                                    .map(|s| s.as_str())
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            ),
                        ));
                    }
                    rels.iter()
                        .enumerate()
                        .filter(|(_, rel)| paths.contains(rel))
                        .map(|(idx, _)| idx)
                        .collect()
                }
            },
        };
        for idx in picked {
            let dir = candidates[idx].clone();
            let fallback = dir.file_name().and_then(|n| n.to_str()).map(str::to_string);
            let rel = Some(match staged.subdir.as_deref() {
                Some(sub) => format!("{sub}/{}", rels[idx]),
                None => rels[idx].clone(),
            });
            targets.push((dir, fallback, true, rel));
        }
    }

    // Installing one plugin reports an already-installed collision as an error
    // (the caller asked for that exact plugin); a batch skips it and installs
    // the rest.
    let single = targets.len() == 1;
    let mut installs: Vec<InstalledPlugin> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    for (dir, fallback, narrowed, rel) in targets {
        let record = InstallRecord {
            subdir: rel,
            installed_at_ms: now_ms(),
            ..staged.record.clone()
        };
        let outcome = install_payload_dir_with(
            scope,
            plugins,
            &staged.tmp,
            &dir,
            narrowed,
            fallback.as_deref(),
            source_url,
            Some(&record),
            Some(ctx),
        )?;
        match outcome {
            PayloadOutcome::Installed(plugin) => installs.push(plugin),
            PayloadOutcome::AlreadyInstalled(stem) => {
                if single {
                    return Err(PluginError::new(
                        PluginErrorCode::AlreadyInstalled,
                        format!("plugin '{stem}' is already installed"),
                    ));
                }
                skipped.push(stem);
            }
        }
    }
    if installs.is_empty() {
        return Err(PluginError::new(
            PluginErrorCode::AlreadyInstalled,
            format!("nothing installed - already installed: {}", skipped.join(", ")),
        ));
    }
    Ok(GitInstall::Installed(installs))
}

/// What happened to one candidate payload during an install.
enum PayloadOutcome {
    Installed(InstalledPlugin),
    /// A plugin of this name is already installed. A single-plugin install
    /// reports this as an error; a batch install skips it.
    AlreadyInstalled(String),
}

#[cfg(all(test, feature = "cli"))]
fn install_payload_dir(
    scope: &PluginScope,
    plugins: &Path,
    tmp: &Path,
    payload: &Path,
    payload_narrowed: bool,
    fallback_name: Option<&str>,
    source_url: &str,
) -> Result<PayloadOutcome, PluginError> {
    install_payload_dir_with(
        scope,
        plugins,
        tmp,
        payload,
        payload_narrowed,
        fallback_name,
        source_url,
        None,
        None,
    )
}

/// Move one plugin payload directory into `plugins/<stem>` and report it.
///
/// `payload_narrowed` says whether `payload` is a subdirectory of the staging
/// dir (rename the subdirectory) or the staging dir itself (rename `tmp`).
/// `fallback_name` names the plugin when the manifest does not. The install
/// record, when given, is written into the payload before the rename, so a
/// plugin is never in place without its provenance. Cancellation is honoured
/// up to the rename; after it the plugin is installed.
///
/// The shared staging dir `tmp` is NOT removed here so a batch can install
/// several payloads out of one clone; the caller removes it once at the end.
#[allow(clippy::too_many_arguments)]
fn install_payload_dir_with(
    scope: &PluginScope,
    plugins: &Path,
    tmp: &Path,
    payload: &Path,
    payload_narrowed: bool,
    fallback_name: Option<&str>,
    source_url: &str,
    record: Option<&InstallRecord>,
    ctx: Option<&InstallCtx>,
) -> Result<PayloadOutcome, PluginError> {
    let manifest = read_manifest(payload);
    let name = match (manifest.name.as_deref(), fallback_name) {
        (Some(name), _) if !name.is_empty() => name.to_string(),
        (_, Some(dir)) => dir.to_string(),
        _ => {
            return Err(PluginError::new(
                PluginErrorCode::InvalidName,
                format!("cannot determine plugin name from '{source_url}'"),
            ))
        }
    };
    let stem = match skills::safe_stem(&name) {
        Ok(stem) if stem == name && !stem.starts_with('.') => stem,
        _ => {
            return Err(PluginError::new(
                PluginErrorCode::InvalidName,
                format!("invalid plugin name '{name}'"),
            ))
        }
    };
    let target = plugins.join(&stem);
    // The name is one plain component, but the rename below must never move the
    // clone anywhere but directly under the store, whatever `join` made of it.
    if target.parent() != Some(std::path::Path::new(&plugins)) {
        return Err(PluginError::new(
            PluginErrorCode::InvalidName,
            format!("invalid plugin name '{name}'"),
        ));
    }
    if target.exists() {
        return Ok(PayloadOutcome::AlreadyInstalled(stem));
    }
    if let Some(record) = record {
        let body = serde_json::to_string_pretty(record).map_err(PluginError::io)?;
        std::fs::write(payload.join(INSTALL_RECORD_FILE), body).map_err(PluginError::io)?;
    }
    if let Some(ctx) = ctx {
        ctx.check()?;
    }
    let move_from = if payload_narrowed { payload } else { tmp };
    std::fs::rename(move_from, &target).map_err(PluginError::io)?;

    let entry = installed_entries_scoped(scope)
        .into_iter()
        .find(|(directory, _)| directory == &stem)
        .map(|(_, plugin)| plugin);
    let mut plugin = entry.unwrap_or_else(|| InstalledPlugin {
        id: stem.clone(),
        name: stem.clone(),
        version: "0.0.0".to_string(),
        enabled: true,
        ..Default::default()
    });
    // A fresh install reports the name it was installed under, and the source
    // URL as its repo when the manifest names none.
    plugin.name = stem;
    if plugin.repo.is_empty() {
        plugin.repo = manifest.repo.unwrap_or_else(|| source_url.to_string());
    }
    Ok(PayloadOutcome::Installed(plugin))
}

/// Fetch and parse the marketplace index. The marketplace URL lives in
/// `[plugins] marketplace`; without it, name-based installs cannot resolve.
async fn fetch_index(url: &str) -> Result<Vec<MarketEntry>, PluginError> {
    let unavailable = |m: String| PluginError::new(PluginErrorCode::MarketplaceUnavailable, m);
    let resp = client()?
        .get(url)
        .send()
        .await
        .map_err(|e| unavailable(format!("fetching marketplace index: {e}")))?;
    if !resp.status().is_success() {
        return Err(unavailable(format!(
            "marketplace index returned {}",
            resp.status()
        )));
    }
    resp.json::<Vec<MarketEntry>>()
        .await
        .map_err(|e| unavailable(format!("parsing marketplace index: {e}")))
}

/// Fetch the index unless the install is cancelled first.
async fn fetch_index_cancellable(
    url: &str,
    ctx: &InstallCtx,
) -> Result<Vec<MarketEntry>, PluginError> {
    ctx.check()?;
    let cancel = ctx.cancel.clone();
    tokio::select! {
        result = fetch_index(url) => result,
        _ = async move {
            while !cancel.load(Ordering::SeqCst) {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        } => Err(cancelled_error()),
    }
}

/// Install a plugin. `spec` is a local folder path, a git source (URL,
/// `git@host:path`, `github:owner/repo`, with an optional `#ref`) or a
/// marketplace name.
///
/// Non-interactive: a multi-plugin collection fails with a listing error, so
/// this always resolves to exactly one plugin. (The "exactly one" invariant
/// is enforced structurally by `CollectionChoice`: `install` passes
/// `ListError`, whose arm always returns an `Err` and never a
/// `GitInstall::Collection`.)
// (desktop-only) `install` is the non-CLI string entry point, so it is dead
// under `--features cli` (only the CLI TUI unit test uses it) and allowed
// rather than `cfg`'d out so it stays available in both configs.
#[allow(dead_code)]
pub(crate) async fn install(root: &Path, spec: &str) -> Result<InstalledPlugin, String> {
    let scope = PluginScope::Project(root.to_path_buf());
    match install_with(&scope, spec, CollectionChoice::ListError, InstallCtx::interactive())
        .await?
    {
        GitInstall::Installed(plugins) => plugins
            .into_iter()
            .next()
            .ok_or_else(|| "ERROR: no plugins installed".to_string()),
        GitInstall::Collection(_) => unreachable!("ListError never returns a collection listing"),
    }
}

/// Install like [`install`], but a multi-plugin collection prompts the user to
/// pick which plugins to install (the interactive CLI path), so this can return
/// several. Already-installed picks are skipped.
// (cli-only)
#[cfg(feature = "cli")]
pub(crate) async fn install_interactive(
    root: &Path,
    spec: &str,
) -> Result<Vec<InstalledPlugin>, String> {
    let scope = PluginScope::Project(root.to_path_buf());
    match install_with(&scope, spec, CollectionChoice::Prompt, InstallCtx::interactive()).await? {
        GitInstall::Installed(plugins) => Ok(plugins),
        GitInstall::Collection(_) => unreachable!("Prompt never returns a collection listing"),
    }
}

/// List the plugins inside a collection without installing anything, for a
/// caller that owns its own terminal (the TUI) to present a picker.
/// `GitInstall::Installed` means `spec` was not an ambiguous collection - a
/// single plugin (bare source, `#tree` subdir, or a collection with exactly
/// one nested plugin) installs directly, so it's already done.
// (cli-only)
#[cfg(feature = "cli")]
pub(crate) async fn list_collection(root: &Path, spec: &str) -> Result<GitInstall, String> {
    let scope = PluginScope::Project(root.to_path_buf());
    install_with(&scope, spec, CollectionChoice::List, InstallCtx::interactive())
        .await
        .map_err(String::from)
}

/// Install exactly the given payload-root-relative paths from a collection
/// (a picker selection following [`list_collection`]). Already-installed
/// picks are skipped rather than erroring.
// (cli-only)
#[cfg(feature = "cli")]
pub(crate) async fn install_selected(
    root: &Path,
    spec: &str,
    paths: Vec<String>,
) -> Result<Vec<InstalledPlugin>, String> {
    let scope = PluginScope::Project(root.to_path_buf());
    match install_with(&scope, spec, CollectionChoice::Only(paths), InstallCtx::interactive())
        .await?
    {
        GitInstall::Installed(plugins) => Ok(plugins),
        GitInstall::Collection(_) => unreachable!("Only never returns a collection listing"),
    }
}

/// Core CLI install. Local paths are copied and git URLs cloned on a blocking
/// thread; marketplace names resolve through the index first. The blocking
/// work runs off the async runtime (the TUI render loop must keep repainting
/// during a large clone).
async fn install_with(
    scope: &PluginScope,
    spec: &str,
    collection: CollectionChoice,
    ctx: InstallCtx,
) -> Result<GitInstall, PluginError> {
    let spec = spec.trim();
    validate_spec(spec)?;
    match classify_spec(spec) {
        SpecKind::Local => {
            let scope = scope.clone();
            let path = PathBuf::from(spec);
            spawn_blocking(move || install_local(&scope, &path, collection, &ctx, &mut || {}))
                .await
        }
        SpecKind::Git => {
            let scope = scope.clone();
            let spec = spec.to_string();
            spawn_blocking(move || install_git(&scope, &spec, None, collection, &ctx, "git")).await
        }
        SpecKind::Marketplace => {
            install_marketplace(scope, spec, collection, ctx, false).await
        }
    }
}

async fn spawn_blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, PluginError> + Send + 'static,
) -> Result<T, PluginError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| PluginError::io(format!("install task failed: {e}")))?
}

async fn install_marketplace(
    scope: &PluginScope,
    name: &str,
    collection: CollectionChoice,
    ctx: InstallCtx,
    desktop: bool,
) -> Result<GitInstall, PluginError> {
    let marketplace = plugins_section_for_scope(scope).marketplace.ok_or_else(|| {
        PluginError::new(
            PluginErrorCode::MarketplaceNotConfigured,
            if desktop {
                "no marketplace configured - set [plugins] marketplace in agent.toml"
            } else {
                "no marketplace configured - set [plugins] marketplace in agent.toml, or install a git URL directly"
            },
        )
    })?;
    let index = fetch_index_cancellable(&marketplace, &ctx).await?;
    let entry = index.into_iter().find(|e| e.name == name).ok_or_else(|| {
        PluginError::new(
            PluginErrorCode::MarketplaceEntryNotFound,
            format!("plugin '{name}' not found on the marketplace"),
        )
    })?;
    // Marketplace installs clone a git repo too: same blocking-work treatment.
    let scope = scope.clone();
    spawn_blocking(move || {
        install_git(
            &scope,
            &entry.repo,
            entry.r#ref.as_deref(),
            collection,
            &ctx,
            "marketplace",
        )
    })
    .await
}

/// Install from an explicit desktop source. Exactly one plugin: a collection
/// is refused with the list of plugins inside it.
// Kept for API stability; the desktop command now calls
// `install_from_source_scoped` directly.
#[allow(dead_code)]
pub(crate) async fn install_from_source(
    root: &Path,
    source: InstallSource,
    ctx: InstallCtx,
) -> Result<InstalledPlugin, PluginError> {
    install_from_source_scoped(&PluginScope::Project(root.to_path_buf()), source, ctx).await
}

/// [`install_from_source`], generalized to a [`PluginScope`]. `Global` skips
/// the project-folder existence check (there is no project folder) and reads
/// its own marketplace from the global agent config (see
/// [`plugins_section_for_scope`]).
pub(crate) async fn install_from_source_scoped(
    scope: &PluginScope,
    source: InstallSource,
    ctx: InstallCtx,
) -> Result<InstalledPlugin, PluginError> {
    if let PluginScope::Project(root) = scope {
        if !root.is_dir() {
            return Err(PluginError::new(
                PluginErrorCode::ProjectUnavailable,
                format!("project folder does not exist: {}", root.display()),
            ));
        }
    }
    let result = match source {
        InstallSource::Local { path } => {
            let path = path.trim().to_string();
            if path.is_empty() {
                return Err(PluginError::new(
                    PluginErrorCode::InvalidSource,
                    "choose a folder to install from",
                ));
            }
            let path = PathBuf::from(path);
            if !path.is_absolute() {
                return Err(PluginError::new(
                    PluginErrorCode::InvalidSource,
                    format!("folder path must be absolute: {}", path.display()),
                ));
            }
            let scope = scope.clone();
            spawn_blocking(move || {
                install_local(&scope, &path, CollectionChoice::ListError, &ctx, &mut || {})
            })
            .await?
        }
        InstallSource::Git { url } => {
            let url = url.trim().to_string();
            validate_spec(&url)?;
            if !looks_like_git(&url) {
                return Err(PluginError::new(
                    PluginErrorCode::InvalidSource,
                    format!("'{url}' is not a git URL (expected https://, ssh:// or git@host:path)"),
                ));
            }
            let scope = scope.clone();
            spawn_blocking(move || {
                install_git(&scope, &url, None, CollectionChoice::ListError, &ctx, "git")
            })
            .await?
        }
        InstallSource::Marketplace { name } => {
            let name = name.trim().to_string();
            validate_spec(&name)?;
            install_marketplace(scope, &name, CollectionChoice::ListError, ctx, true).await?
        }
    };
    match result {
        GitInstall::Installed(plugins) => plugins
            .into_iter()
            .next()
            .ok_or_else(|| PluginError::io("no plugins installed")),
        GitInstall::Collection(_) => unreachable!("ListError never returns a collection listing"),
    }
}

/// List marketplace plugins matching `query` (name or description, case
/// insensitive; empty query lists everything).
pub(crate) async fn search_typed(
    root: &Path,
    query: &str,
) -> Result<Vec<MarketEntry>, PluginError> {
    search_typed_scoped(&PluginScope::Project(root.to_path_buf()), query).await
}

/// [`search_typed`], generalized to a [`PluginScope`]: `Global` searches the
/// marketplace configured in the global agent config, not any project's.
pub(crate) async fn search_typed_scoped(
    scope: &PluginScope,
    query: &str,
) -> Result<Vec<MarketEntry>, PluginError> {
    let url = plugins_section_for_scope(scope).marketplace.ok_or_else(|| {
        PluginError::new(
            PluginErrorCode::MarketplaceNotConfigured,
            "no marketplace configured - set [plugins] marketplace in agent.toml",
        )
    })?;
    let mut entries = fetch_index(&url).await?;
    let query = query.trim().to_lowercase();
    if !query.is_empty() {
        entries.retain(|e| {
            e.name.to_lowercase().contains(&query) || e.description.to_lowercase().contains(&query)
        });
    }
    Ok(entries)
}

/// [`search_typed`] for the CLI's string errors.
#[cfg_attr(not(feature = "cli"), allow(dead_code))]
pub(crate) async fn search(root: &Path, query: &str) -> Result<Vec<MarketEntry>, String> {
    search_typed(root, query).await.map_err(String::from)
}

#[cfg(all(test, feature = "cli"))]
mod tests {
    use std::path::PathBuf;

    use super::*;

    /// A local git repo fixture containing a plugin payload.
    fn make_repo(tag: &str, with_manifest: bool) -> PathBuf {
        let repo =
            std::env::temp_dir().join(format!("jan_plugin_repo_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&repo);
        std::fs::create_dir_all(repo.join("skills").join("prepare")).unwrap();
        std::fs::write(
            repo.join("skills").join("prepare").join("SKILL.md"),
            "---\ndescription: Prepare the thing\n---\n\n# prepare\n\nBody.\n",
        )
        .unwrap();
        if with_manifest {
            std::fs::write(
                repo.join("plugin.toml"),
                "name = \"release-tools\"\ndescription = \"Release automation\"\nversion = \"1.2.0\"\n",
            )
            .unwrap();
        }
        git(&["init", repo.to_str().unwrap()]).unwrap();
        git(&["-C", repo.to_str().unwrap(), "add", "-A"]).unwrap();
        git(&[
            "-C",
            repo.to_str().unwrap(),
            "commit",
            "-m",
            "init",
            "--author=Jan Test <test@jan.ai>",
        ])
        .unwrap();
        repo
    }

    fn unique_root(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("jan_plugin_test_{tag}_{}", std::process::id()))
    }

    #[test]
    fn validate_spec_rejects_shell_metachars() {
        assert!(validate_spec("https://github.com/a/b").is_ok());
        assert!(validate_spec("github:a/b").is_ok());
        assert!(validate_spec("release-tools").is_ok());
        for bad in [
            "https://x/y;rm -rf ~",
            "https://x/y$(id)",
            "a`b",
            "x && y",
            "x | y",
            "x < y",
        ] {
            assert!(validate_spec(bad).is_err(), "accepted {bad:?}");
        }
        assert!(validate_spec("").is_err());
        assert!(validate_spec("  ").is_err());
    }

    /// A backslash is a path separator on Windows, not an escape. Rejecting it
    /// outright made every local-path install fail there.
    #[test]
    fn validate_spec_accepts_windows_paths() {
        for good in [
            r"C:\src\my-plugin",
            r"c:/src/my-plugin",
            r"file://C:\src\my-plugin",
            r"file:///C:\src\my-plugin",
            r"\\fileserver\share\my-plugin",
        ] {
            assert!(validate_spec(good).is_ok(), "rejected {good:?}");
        }
    }

    /// The exemption is for the separator only. A path-shaped spec gets no
    /// licence to carry a command substitution, and a non-path spec gets no
    /// backslash.
    #[test]
    fn validate_spec_still_refuses_injection_inside_a_path() {
        for bad in [
            r"C:\src\$(id)",
            r"C:\src\a;rm -rf /",
            r"C:\src\a`id`",
            r"file://C:\src\a|b",
            // Not path-shaped: the backslash has no business here.
            r"https://x/y\z",
            r"marketplace\name",
        ] {
            assert!(validate_spec(bad).is_err(), "accepted {bad:?}");
        }
    }

    #[test]
    fn split_ref_and_repo_name() {
        assert_eq!(split_ref("https://h/r"), ("https://h/r", None));
        assert_eq!(split_ref("https://h/r#main"), ("https://h/r", Some("main")));
        assert_eq!(
            repo_dir_name("https://github.com/acme/release-tools.git"),
            Some("release-tools")
        );
        assert_eq!(
            repo_dir_name("https://github.com/acme/release-tools#v2"),
            Some("release-tools")
        );
        assert_eq!(
            repo_dir_name("git@github.com:acme/tools.git"),
            Some("tools")
        );
    }

    /// A local Windows path names the plugin after its last segment, not after
    /// the whole path. Splitting on `/` alone made the entire `C:\...` string
    /// the proposed name, which then failed name validation.
    #[test]
    fn repo_dir_name_reads_the_last_segment_of_a_windows_path() {
        assert_eq!(repo_dir_name(r"C:\src\my-plugin"), Some("my-plugin"));
        assert_eq!(repo_dir_name(r"C:\src\my-plugin\"), Some("my-plugin"));
        assert_eq!(
            repo_dir_name(r"file://C:\src\release-tools.git"),
            Some("release-tools")
        );
        assert_eq!(
            repo_dir_name(r"\\fileserver\share\my-plugin"),
            Some("my-plugin")
        );
        // A mixed-separator path still ends at the last segment.
        assert_eq!(repo_dir_name(r"C:/src\my-plugin"), Some("my-plugin"));
    }
    #[test]
    fn parses_github_tree_specs_as_repo_ref_and_subdirectory() {
        let source = parse_git_source(
            "https://github.com/anthropics/claude-plugins-official/tree/main/plugins/claude-code-setup",
        )
        .unwrap();
        assert_eq!(
            source.url,
            "https://github.com/anthropics/claude-plugins-official.git"
        );
        assert_eq!(source.r#ref.as_deref(), Some("main"));
        assert_eq!(source.subdir.as_deref(), Some("plugins/claude-code-setup"));
    }

    #[test]
    fn parses_github_blob_copy_path_urls_as_repo_ref_and_subdirectory() {
        // GitHub's "Copy path" button produces /blob/<ref>/<path>; a user
        // pasting that should still resolve to a single installable repo dir.
        let source = parse_git_source(
            "https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-simplifier",
        )
        .unwrap();
        assert_eq!(
            source.url,
            "https://github.com/anthropics/claude-plugins-official.git"
        );
        assert_eq!(source.r#ref.as_deref(), Some("main"));
        assert_eq!(source.subdir.as_deref(), Some("plugins/code-simplifier"));
    }

    #[test]
    fn installed_skips_staging_dirs_and_finds_manifest_names() {
        let root = unique_root("installed-filter");
        let plugins = skills::plugins_dir(&root);
        let release = plugins.join("release-tools");
        let staging = plugins.join(".installing-123");
        std::fs::create_dir_all(&release).unwrap();
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(
            release.join("plugin.toml"),
            "name = \"release-automation\"\nversion = \"1.2.0\"\n",
        )
        .unwrap();
        std::fs::write(staging.join("plugin.toml"), "name = \"incomplete\"\n").unwrap();

        let listed = installed(&root);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "release-automation");
        assert_eq!(
            find_installed(&root, "release-tools").map(|(directory, _)| directory),
            Some("release-tools".to_string())
        );
        assert_eq!(
            find_installed(&root, "release-automation").map(|(directory, _)| directory),
            Some("release-tools".to_string())
        );
        assert!(find_installed(&root, ".installing-123").is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_traversal_in_github_tree_subdirectory() {
        assert!(parse_git_source("https://github.com/acme/tools/tree/main/../../outside").is_err());
    }
    #[test]
    fn reads_claude_plugin_json_manifest() {
        let root = unique_root("json-manifest");
        std::fs::create_dir_all(root.join(".claude-plugin")).unwrap();
        std::fs::write(
            root.join(".claude-plugin/plugin.json"),
            r#"{"name":"claude-code-setup","description":"Claude Code setup","version":"1.0.0"}"#,
        )
        .unwrap();
        let manifest = read_manifest(&root);
        assert_eq!(manifest.name.as_deref(), Some("claude-code-setup"));
        assert_eq!(manifest.description.as_deref(), Some("Claude Code setup"));
        assert_eq!(manifest.version.as_deref(), Some("1.0.0"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn install_clones_and_validates() {
        let repo = make_repo("install1", true);
        let root = unique_root("install1");
        let p = install(&root, &format!("file://{}", repo.display()))
            .await
            .unwrap();
        assert_eq!(p.name, "release-tools");
        assert_eq!(p.skills, 1);
        let dir = skills::plugins_dir(&root).join("release-tools");
        assert!(dir.join("plugin.toml").is_file());
        assert!(dir.join("skills/prepare/SKILL.md").is_file());
        // Re-install collides.
        let err = install(&root, &format!("file://{}", repo.display()))
            .await
            .unwrap_err();
        assert!(err.contains("already installed"), "{err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A symbolic link committed to a plugin repository is never checked out
    /// as a link, so a skill cannot be a window onto a file outside the
    /// plugin (here, a `.env` two levels up).
    #[tokio::test]
    async fn install_never_checks_out_a_symlink() {
        let repo = make_repo("symlink", true);
        let r = repo.to_str().unwrap();
        std::fs::write(repo.join("link.txt"), "../../../.env").unwrap();
        let blob = git(&["-C", r, "hash-object", "-w", "link.txt"]).unwrap();
        std::fs::remove_file(repo.join("link.txt")).unwrap();
        let info = format!("120000,{},skills/notes.md", blob.trim());
        git(&["-C", r, "update-index", "--add", "--cacheinfo", &info]).unwrap();
        git(&["-C", r, "commit", "-m", "link", "--author=Jan Test <test@jan.ai>"]).unwrap();

        let root = unique_root("symlink");
        let p = install(&root, &format!("file://{}", repo.display())).await.unwrap();
        let notes = skills::plugins_dir(&root).join(&p.name).join("skills/notes.md");
        let meta = std::fs::symlink_metadata(&notes).expect("the link's path is still there");
        assert!(!meta.file_type().is_symlink(), "a repository symlink was checked out as a link");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn install_names_from_repo_dir_without_manifest() {
        let repo = make_repo("install2", false);
        let root = unique_root("install2");
        let p = install(&root, &format!("file://{}", repo.display()))
            .await
            .unwrap();
        // Repo dir name is the fallback name; skills still discovered.
        let dir_name = repo.file_name().unwrap().to_str().unwrap();
        assert_eq!(p.name, dir_name);
        assert_eq!(p.skills, 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn install_rejects_empty_repo_and_cleans_up() {
        let repo = std::env::temp_dir().join(format!("jan_plugin_empty_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&repo);
        std::fs::create_dir_all(&repo).unwrap();
        git(&["init", repo.to_str().unwrap()]).unwrap();
        git(&[
            "-C",
            repo.to_str().unwrap(),
            "commit",
            "--allow-empty",
            "-m",
            "empty",
        ])
        .unwrap();
        let root = unique_root("empty");
        let err = install(&root, &format!("file://{}", repo.display()))
            .await
            .unwrap_err();
        assert!(err.contains("nothing to install"), "{err}");
        // No leftover temp or installed dir.
        assert_eq!(
            std::fs::read_dir(skills::plugins_dir(&root))
                .unwrap()
                .count(),
            0
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn remove_deletes_installed_plugin() {
        let repo = make_repo("remove1", false);
        let root = unique_root("remove1");
        let p = install(&root, &format!("file://{}", repo.display()))
            .await
            .unwrap();
        assert!(skills::plugins_dir(&root).join(&p.name).is_dir());
        remove(&root, &p.name).unwrap();
        assert!(!skills::plugins_dir(&root).join(&p.name).exists());
        assert!(remove(&root, &p.name).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn marketplace_name_install_and_search() {
        let repo = make_repo("mkt", true);
        let root = unique_root("mkt");
        let index = serde_json::json!([{
            "name": "release-tools",
            "description": "Release automation",
            "repo": format!("file://{}", repo.display()),
        }]);
        let body = index.to_string();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(3) {
                let Ok(mut stream) = stream else { continue };
                let mut buf = [0u8; 4096];
                let _ = std::io::Read::read(&mut stream, &mut buf);
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = std::io::Write::write_all(&mut stream, resp.as_bytes());
            }
        });
        std::fs::create_dir_all(&root).unwrap();
        crate::core::agent::project::ensure_project(&root).unwrap();
        std::fs::write(
            crate::core::agent::project::agent_toml_path(&root),
            format!("[plugins]\nmarketplace = \"http://{addr}/index.json\"\n"),
        )
        .unwrap();

        let hits = search(&root, "release").await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "release-tools");

        let p = install(&root, "release-tools").await.unwrap();
        assert_eq!(p.name, "release-tools");
        assert!(skills::plugins_dir(&root).join("release-tools").is_dir());

        // Unknown name errors.
        let err = install(&root, "nope").await.unwrap_err();
        assert!(err.contains("not found on the marketplace"), "{err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A plugin *collection* repo: no payload at the root, each direct child
    /// is its own plugin. Multiple children -> an actionable error naming them.
    #[tokio::test]
    async fn install_collection_lists_plugin_choices() {
        let repo =
            std::env::temp_dir().join(format!("jan_plugin_collection_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&repo);
        for name in ["alpha", "beta"] {
            let d = repo.join(name).join("skills").join("prepare");
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(
                d.join("SKILL.md"),
                format!("---\ndescription: {name}\n---\n\n# {name}\n\nBody.\n"),
            )
            .unwrap();
            std::fs::write(
                repo.join(name).join("plugin.toml"),
                format!("name = \"{name}\"\ndescription = \"{name}\"\n"),
            )
            .unwrap();
        }
        git(&["init", repo.to_str().unwrap()]).unwrap();
        git(&["-C", repo.to_str().unwrap(), "add", "-A"]).unwrap();
        git(&["-C", repo.to_str().unwrap(), "commit", "-m", "collection"]).unwrap();

        let root = unique_root("collection1");
        let err = install(&root, &format!("file://{}", repo.display()))
            .await
            .unwrap_err();
        assert!(err.contains("alpha") && err.contains("beta"), "{err}");
        assert!(err.contains("plugin collection"), "{err}");
        assert_eq!(
            std::fs::read_dir(skills::plugins_dir(&root))
                .unwrap()
                .count(),
            0,
            "nothing should be installed for an ambiguous collection"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(repo);
    }

    /// A collection with a single plugin child auto-installs that one.
    #[tokio::test]
    async fn install_collection_with_single_plugin_installs_it() {
        let repo =
            std::env::temp_dir().join(format!("jan_plugin_singleton_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&repo);
        let d = repo.join("only").join("skills").join("prepare");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(
            d.join("SKILL.md"),
            "---\ndescription: only\n---\n\n# only\n\nBody.\n",
        )
        .unwrap();
        std::fs::write(
            repo.join("only").join("plugin.toml"),
            "name = \"only\"\ndescription = \"only\"\n",
        )
        .unwrap();
        git(&["init", repo.to_str().unwrap()]).unwrap();
        git(&["-C", repo.to_str().unwrap(), "add", "-A"]).unwrap();
        git(&["-C", repo.to_str().unwrap(), "commit", "-m", "singleton"]).unwrap();

        let root = unique_root("singleton1");
        let p = install(&root, &format!("file://{}", repo.display()))
            .await
            .unwrap();
        assert_eq!(p.name, "only");
        assert_eq!(p.skills, 1);
        assert!(skills::plugins_dir(&root).join("only").is_dir());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(repo);
    }

    /// A collection with plugins nested under wrapper dirs (like claude-plugins-
    /// official's `plugins/` + `external_plugins/`) still reports an actionable
    /// list of relative paths and installs nothing by default.
    #[tokio::test]
    async fn install_nested_collection_lists_plugin_choices() {
        let repo =
            std::env::temp_dir().join(format!("jan_nested_collection_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&repo);
        for name in ["alpha", "beta"] {
            let d = repo
                .join("plugins")
                .join(name)
                .join("skills")
                .join("prepare");
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(
                d.join("SKILL.md"),
                format!("---\ndescription: {name}\n---\n\n# {name}\n\nBody.\n"),
            )
            .unwrap();
            std::fs::write(
                repo.join("plugins").join(name).join("plugin.toml"),
                format!("name = \"{name}\"\ndescription = \"{name}\"\n"),
            )
            .unwrap();
        }
        let d = repo
            .join("external_plugins")
            .join("gamma")
            .join(".claude-plugin");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("plugin.json"), "{\"name\":\"gamma\"}").unwrap();
        git(&["init", repo.to_str().unwrap()]).unwrap();
        git(&["-C", repo.to_str().unwrap(), "add", "-A"]).unwrap();
        git(&[
            "-C",
            repo.to_str().unwrap(),
            "commit",
            "-m",
            "nested collection",
        ])
        .unwrap();

        let root = unique_root("nestedcollection1");
        let err = install(&root, &format!("file://{}", repo.display()))
            .await
            .unwrap_err();
        assert!(
            err.contains("plugins/alpha") && err.contains("plugins/beta"),
            "{err}"
        );
        assert!(err.contains("external_plugins/gamma"), "{err}");
        assert!(err.contains("plugin collection"), "{err}");
        assert!(
            err.contains("/tree/<ref>/<relative/path>"),
            "error should show the path-form tree syntax: {err}"
        );
        assert_eq!(
            std::fs::read_dir(skills::plugins_dir(&root))
                .unwrap()
                .count(),
            0,
            "nothing should be installed for an ambiguous nested collection"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(repo);
    }

    /// A nested collection with a single plugin auto-installs it.
    #[tokio::test]
    async fn install_nested_collection_with_single_plugin_installs_it() {
        let repo =
            std::env::temp_dir().join(format!("jan_nested_singleton_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&repo);
        let d = repo
            .join("plugins")
            .join("only")
            .join("skills")
            .join("prepare");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(
            d.join("SKILL.md"),
            "---\ndescription: only\n---\n\n# only\n\nBody.\n",
        )
        .unwrap();
        std::fs::write(
            repo.join("plugins").join("only").join("plugin.toml"),
            "name = \"only\"\ndescription = \"only\"\n",
        )
        .unwrap();
        git(&["init", repo.to_str().unwrap()]).unwrap();
        git(&["-C", repo.to_str().unwrap(), "add", "-A"]).unwrap();
        git(&[
            "-C",
            repo.to_str().unwrap(),
            "commit",
            "-m",
            "nested singleton",
        ])
        .unwrap();

        let root = unique_root("nestedsingleton1");
        let p = install(&root, &format!("file://{}", repo.display()))
            .await
            .unwrap();
        assert_eq!(p.name, "only");
        assert_eq!(p.skills, 1);
        assert!(skills::plugins_dir(&root).join("only").is_dir());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn prompt_multi_choice_parses_selections_and_cancels() {
        let paths: [String; 3] = [
            "plugins/alpha".into(),
            "plugins/beta".into(),
            "external_plugins/gamma".into(),
        ];
        let none = [false, false, false];
        // Single pick -> one 0-based index.
        let mut input = std::io::BufReader::new(&b"2\n"[..]);
        assert_eq!(
            prompt_multi_choice("http://x", &paths, &none, &mut input).unwrap(),
            vec![1]
        );
        // Surrounding whitespace is trimmed.
        let mut input = std::io::BufReader::new(&b"  3  \n"[..]);
        assert_eq!(
            prompt_multi_choice("http://x", &paths, &none, &mut input).unwrap(),
            vec![2]
        );
        // Comma and space separated lists, in the order given, deduped.
        let mut input = std::io::BufReader::new(&b"3,1 1\n"[..]);
        assert_eq!(
            prompt_multi_choice("http://x", &paths, &none, &mut input).unwrap(),
            vec![2, 0]
        );
        // `all` selects everything, case insensitively.
        let mut input = std::io::BufReader::new(&b"ALL\n"[..]);
        assert_eq!(
            prompt_multi_choice("http://x", &paths, &none, &mut input).unwrap(),
            vec![0, 1, 2]
        );
        // Out-of-range, then a valid answer: re-prompts rather than failing.
        let mut input = std::io::BufReader::new(&b"9\n1\n"[..]);
        assert_eq!(
            prompt_multi_choice("http://x", &paths, &none, &mut input).unwrap(),
            vec![0]
        );
        // A non-numeric token invalidates the whole line, then retries.
        let mut input = std::io::BufReader::new(&b"1,nope\n2\n"[..]);
        assert_eq!(
            prompt_multi_choice("http://x", &paths, &none, &mut input).unwrap(),
            vec![1]
        );
        // Already-installed entries stay selectable; the caller skips them.
        let mut input = std::io::BufReader::new(&b"1\n"[..]);
        assert_eq!(
            prompt_multi_choice("http://x", &paths, &[true, false, false], &mut input).unwrap(),
            vec![0]
        );
        // Blank line cancels.
        let mut input = std::io::BufReader::new(&b"\n"[..]);
        let err = prompt_multi_choice("http://x", &paths, &none, &mut input).unwrap_err();
        assert!(err.contains("aborted"), "{err}");
        // EOF cancels.
        let mut input = std::io::BufReader::new(&b""[..]);
        let err = prompt_multi_choice("http://x", &paths, &none, &mut input).unwrap_err();
        assert!(err.contains("aborted"), "{err}");
    }

    /// Installing several payloads out of one clone: each lands under its own
    /// name, and a payload whose name is already taken reports
    /// `AlreadyInstalled` instead of failing, so a batch can skip it.
    #[test]
    fn batch_install_lands_each_payload_and_reports_already_installed() {
        let root = unique_root("batchskip");
        let _ = std::fs::remove_dir_all(&root);
        let scope = PluginScope::Project(root.clone());
        let plugins = skills::plugins_dir(&root);
        std::fs::create_dir_all(&plugins).unwrap();
        let tmp = plugins.join(".installing-batchskip");

        // Stage two plugin payloads inside one shared clone dir.
        let stage = |name: &str| {
            let dir = tmp.join(name);
            std::fs::create_dir_all(dir.join("skills").join("prepare")).unwrap();
            std::fs::write(
                dir.join("skills").join("prepare").join("SKILL.md"),
                format!("---\ndescription: {name}\n---\n\n# {name}\n\nBody.\n"),
            )
            .unwrap();
            std::fs::write(
                dir.join("plugin.toml"),
                format!("name = \"{name}\"\ndescription = \"{name}\"\n"),
            )
            .unwrap();
            dir
        };
        let alpha = stage("alpha");
        let beta = stage("beta");

        // Both install out of the same clone: the shared tmp must survive the
        // first move for the second to succeed.
        for (dir, name) in [(&alpha, "alpha"), (&beta, "beta")] {
            let outcome =
                install_payload_dir(&scope, &plugins, &tmp, dir, true, Some(name), "http://x")
                    .unwrap();
            match outcome {
                PayloadOutcome::Installed(p) => {
                    assert_eq!(p.name, name);
                    assert_eq!(p.skills, 1, "{name} skills");
                }
                PayloadOutcome::AlreadyInstalled(s) => panic!("unexpected skip of {s}"),
            }
            assert!(plugins.join(name).join("plugin.toml").is_file());
        }

        // A second payload claiming an installed name is skipped, not an error.
        let again = stage("alpha");
        match install_payload_dir(
            &scope,
            &plugins,
            &tmp,
            &again,
            true,
            Some("alpha"),
            "http://x",
        )
        .unwrap()
        {
            PayloadOutcome::AlreadyInstalled(stem) => assert_eq!(stem, "alpha"),
            PayloadOutcome::Installed(p) => panic!("reinstalled {}", p.name),
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A local git repo fixture that is a collection of two plugins, `alpha`
    /// and `beta`, at its root.
    fn make_collection(tag: &str) -> PathBuf {
        let repo =
            std::env::temp_dir().join(format!("jan_plugin_coll_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&repo);
        for name in ["alpha", "beta"] {
            let d = repo.join(name).join("skills").join("prepare");
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(
                d.join("SKILL.md"),
                format!("---\ndescription: {name}\n---\n\n# {name}\n\nBody.\n"),
            )
            .unwrap();
            std::fs::write(
                repo.join(name).join("plugin.toml"),
                format!("name = \"{name}\"\ndescription = \"{name}\"\n"),
            )
            .unwrap();
        }
        git(&["init", repo.to_str().unwrap()]).unwrap();
        git(&["-C", repo.to_str().unwrap(), "add", "-A"]).unwrap();
        git(&["-C", repo.to_str().unwrap(), "commit", "-m", "collection"]).unwrap();
        repo
    }

    /// `list_collection` (the TUI path) returns the candidates without
    /// installing anything, marking ones already installed.
    #[tokio::test]
    async fn list_collection_returns_candidates_without_installing() {
        let repo = make_collection("list1");
        let root = unique_root("list1");
        let spec = format!("file://{}", repo.display());

        // Pre-install alpha directly so the listing marks it.
        install_selected(&root, &spec, vec!["alpha".to_string()])
            .await
            .unwrap();

        match list_collection(&root, &spec).await.unwrap() {
            GitInstall::Collection(mut candidates) => {
                candidates.sort_by(|a, b| a.path.cmp(&b.path));
                assert_eq!(candidates.len(), 2);
                assert_eq!(candidates[0].path, "alpha");
                assert!(candidates[0].installed);
                assert_eq!(candidates[1].path, "beta");
                assert!(!candidates[1].installed);
            }
            GitInstall::Installed(_) => panic!("expected a collection listing"),
        }
        // Listing must not have installed or left anything behind.
        assert_eq!(
            std::fs::read_dir(skills::plugins_dir(&root))
                .unwrap()
                .count(),
            1,
            "only the pre-install should be present"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(repo);
    }

    /// `install_selected` installs exactly the requested paths and skips ones
    /// already installed rather than erroring.
    #[tokio::test]
    async fn install_selected_installs_only_the_chosen_paths() {
        let repo = make_collection("select1");
        let root = unique_root("select1");
        let spec = format!("file://{}", repo.display());

        let installed = install_selected(&root, &spec, vec!["beta".to_string()])
            .await
            .unwrap();
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].name, "beta");
        assert!(skills::plugins_dir(&root).join("beta").is_dir());
        assert!(!skills::plugins_dir(&root).join("alpha").exists());

        // Re-selecting beta alongside alpha skips beta, installs alpha.
        let installed =
            install_selected(&root, &spec, vec!["alpha".to_string(), "beta".to_string()])
                .await
                .unwrap();
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].name, "alpha");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(repo);
    }

    /// `find_plugin_dirs` must skip symlinked entries rather than follow them.
    /// If it naively followed symlinks, a malicious/malformed non-plugin dir
    /// that symlinks back to an ancestor would recurse forever and overflow the
    /// stack. Here that link points into a cycle and must terminate, returning
    /// only the real plugin dirs.
    #[test]
    fn find_plugin_dirs_skips_symlinks_and_survives_a_link_cycle() {
        let root = unique_root("symlink");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("plugins").join("a")).unwrap();
        std::fs::create_dir_all(root.join("plugins").join("b")).unwrap();
        // Real plugin payloads at two levels.
        std::fs::write(
            root.join("plugins").join("a").join("plugin.toml"),
            "name=\"a\"",
        )
        .unwrap();
        std::fs::create_dir_all(root.join("plugins").join("b").join("skills").join("s")).unwrap();
        std::fs::write(
            root.join("plugins")
                .join("b")
                .join("skills")
                .join("s")
                .join("SKILL.md"),
            "# s\n",
        )
        .unwrap();

        // A real plugin dir that lives OUTSIDE the scanned tree, reachable only
        // through a symlink inside it: the symlinked entry must be skipped,
        // never followed, so this real-but-symlinked plugin is not returned.
        let outdir = unique_root("symlink-out");
        let _ = std::fs::remove_dir_all(&outdir);
        std::fs::create_dir_all(&outdir).unwrap();
        std::fs::write(outdir.join("plugin.toml"), "name=\"out\"").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outdir, root.join("linked-out")).unwrap();

        // A symlink cycle: a dir inside the tree pointing back at an ancestor.
        std::fs::create_dir_all(root.join("plugins").join("loop")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&root, root.join("plugins").join("loop").join("up")).unwrap();

        let found = find_plugin_dirs(&root);
        // Terminate, and return only the two real plugin dirs.
        let names: Vec<String> = found
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&"a".to_string()));
        assert!(names.contains(&"b".to_string()));
        assert!(
            !names.contains(&"out".to_string()),
            "symlinked dir was followed: {names:?}"
        );
        assert_eq!(names.len(), 2, "unexpected dirs: {names:?}");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outdir);
    }

    /// A picker selection that names no candidate (or names nothing at all)
    /// must fail loudly instead of falling through to the confusing
    /// "already installed: (nothing)" message, and must not leave a temp clone
    /// behind.
    #[tokio::test]
    async fn install_selected_rejects_unmatchable_or_empty_paths() {
        let repo = make_collection("selecterr1");
        let root = unique_root("selecterr1");
        let spec = format!("file://{}", repo.display());

        // A path that matches no candidate.
        let err = install_selected(&root, &spec, vec!["nope".to_string()])
            .await
            .unwrap_err();
        assert!(err.contains("no matching plugins"), "{err}");
        assert!(err.contains("nope"), "{err}");

        // An empty selection.
        let err = install_selected(&root, &spec, vec![]).await.unwrap_err();
        assert!(err.contains("no matching plugins"), "{err}");

        // Nothing installed and no temp clone left behind on either error.
        let installed = std::fs::read_dir(skills::plugins_dir(&root)).unwrap();
        let leftovers: Vec<_> = installed
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(leftovers, Vec::<String>::new(), "{leftovers:?}");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(repo);
    }
}

/// Lifecycle tests for the desktop plugin manager surface: typed errors, local
/// folder installs, cancellation, enable/disable honoured by discovery, removal
/// cleanup, and the AH-131 negative escalation check. Compiled in every test
/// configuration (not only `cli`), because the desktop commands wrap exactly
/// these functions.
#[cfg(test)]
mod lifecycle_tests {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::Arc;

    use super::*;
    use crate::core::agent::project;

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "jan_plugin_life_{tag}_{}_{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn put(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn ctx() -> InstallCtx {
        InstallCtx {
            cancel: Arc::new(AtomicBool::new(false)),
            terminal_prompts: false,
        }
    }

    /// A project folder with a scaffolded `.jan/agent/agent.toml`.
    fn project_root(tag: &str) -> PathBuf {
        let root = temp(tag);
        project::ensure_project(&root).unwrap();
        root
    }

    /// A plugin source folder with one skill, one command and one agent.
    fn plugin_source(tag: &str, name: &str) -> PathBuf {
        let src = temp(tag).join(name);
        put(
            &src.join("plugin.toml"),
            &format!("name = \"{name}\"\ndescription = \"Test plugin\"\nversion = \"2.0.0\"\n"),
        );
        put(
            &src.join("skills/prepare/SKILL.md"),
            "---\ndescription: Prepare the release\n---\n\nPrepare it.\n",
        );
        put(
            &src.join("commands/ship.md"),
            "---\ndescription: Ship it\n---\n\nShip $ARGUMENTS\n",
        );
        put(
            &src.join(format!("agents/{name}-reviewer.md")),
            &format!("---\nname: {name}-reviewer\ndescription: Reviews\n---\n\nYou review.\n"),
        );
        src
    }

    fn entries(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .map(|rd| {
                rd.flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn classifies_windows_and_posix_paths_as_local_folders() {
        for local in [
            r"C:\src\my-plugin",
            r"c:/src/my-plugin",
            r"D:\",
            r"\\fileserver\share\my-plugin",
            "/home/me/my-plugin",
            "./my-plugin",
            "../my-plugin",
            r".\my-plugin",
            ".",
        ] {
            assert_eq!(classify_spec(local), SpecKind::Local, "{local}");
        }
        for git in [
            "https://github.com/acme/tools",
            "file:///C:/src/repo",
            r"file://C:\src\repo",
            "git@github.com:acme/tools.git",
            "github:acme/tools",
        ] {
            assert_eq!(classify_spec(git), SpecKind::Git, "{git}");
        }
        assert_eq!(classify_spec("release-tools"), SpecKind::Marketplace);
    }

    #[tokio::test]
    async fn local_folder_install_copies_without_git_and_records_provenance() {
        let root = project_root("local");
        let src = plugin_source("local-src", "lifeplug");
        // A `.git` directory in the source is not part of the plugin.
        put(&src.join(".git/HEAD"), "ref: refs/heads/main\n");

        let plugin = install_from_source(
            &root,
            InstallSource::Local {
                path: src.display().to_string(),
            },
            ctx(),
        )
        .await
        .unwrap();
        assert_eq!(plugin.id, "lifeplug");
        assert_eq!(plugin.version, "2.0.0");
        assert_eq!((plugin.skills, plugin.commands, plugin.agents), (1, 1, 1));
        assert!(plugin.enabled);

        let dir = skills::plugins_dir(&root).join("lifeplug");
        assert!(dir.join("skills/prepare/SKILL.md").is_file());
        assert!(!dir.join(".git").exists(), ".git must not be copied");
        // Copied, not moved: the source folder is untouched.
        assert!(src.join("plugin.toml").is_file());
        // No staging directory left behind.
        assert_eq!(entries(&skills::plugins_dir(&root)), vec!["lifeplug"]);

        // Provenance is on disk, so a fresh listing (a restart) still has it.
        let listed = installed(&root);
        assert_eq!(listed[0].source_kind.as_deref(), Some("local"));
        assert_eq!(listed[0].source.as_deref(), Some(src.display().to_string().as_str()));

        let d = details(&root, "lifeplug").unwrap();
        assert_eq!(d.skill_names, vec!["lifeplug:prepare"]);
        assert_eq!(d.command_names, vec!["ship"]);
        assert_eq!(d.agent_names, vec!["lifeplug-reviewer"]);
        assert!(d.installed_at_ms.unwrap() > 0);
        assert!(!d.has_mcp_config);
        assert_eq!(d.executable_file_count, 0);
    }

    /// A bare path given to the CLI spec parser installs the folder. Before,
    /// `C:\path` matched no git shape and fell through to a marketplace lookup.
    #[tokio::test]
    async fn cli_spec_with_a_native_path_installs_the_folder() {
        let root = project_root("clipath");
        let src = plugin_source("clipath-src", "pathplug");
        let spec = src.display().to_string();
        assert_eq!(classify_spec(&spec), SpecKind::Local, "{spec}");
        let plugin = install(&root, &spec).await.unwrap();
        assert_eq!(plugin.id, "pathplug");
        assert!(skills::plugins_dir(&root).join("pathplug/plugin.toml").is_file());
    }

    #[test]
    fn cancelling_mid_copy_removes_the_staging_directory() {
        let root = project_root("cancelcopy");
        let src = plugin_source("cancelcopy-src", "cancelplug");
        for i in 0..20 {
            put(&src.join(format!("skills/prepare/extra-{i}.txt")), "x");
        }
        let ctx = ctx();
        let flag = ctx.cancel.clone();
        let mut copied = 0;
        let scope = PluginScope::Project(root.clone());
        let err = install_local(&scope, &src, CollectionChoice::ListError, &ctx, &mut || {
            copied += 1;
            // Cancel after the first file has landed in staging.
            flag.store(true, Ordering::SeqCst);
        })
        .err()
        .expect("cancelled");
        assert_eq!(err.code, PluginErrorCode::Cancelled);
        assert_eq!(copied, 1);
        assert!(
            entries(&skills::plugins_dir(&root)).is_empty(),
            "orphans: {:?}",
            entries(&skills::plugins_dir(&root))
        );
        assert!(installed(&root).is_empty());
    }

    #[test]
    fn cancelled_git_install_leaves_nothing_behind() {
        let root = project_root("cancelgit");
        let repo = plugin_source("cancelgit-src", "gitplug");
        git(&["init", repo.to_str().unwrap()]).unwrap();
        git(&["-C", repo.to_str().unwrap(), "add", "-A"]).unwrap();
        git(&[
            "-C",
            repo.to_str().unwrap(),
            "-c",
            "user.name=Jan Test",
            "-c",
            "user.email=test@jan.ai",
            "commit",
            "-m",
            "init",
        ])
        .unwrap();
        let ctx = ctx();
        ctx.cancel.store(true, Ordering::SeqCst);
        let scope = PluginScope::Project(root.clone());
        let err = install_git(
            &scope,
            &format!("file://{}", repo.display()),
            None,
            CollectionChoice::ListError,
            &ctx,
            "git",
        )
        .err()
        .expect("cancelled");
        assert_eq!(err.code, PluginErrorCode::Cancelled);
        assert!(entries(&skills::plugins_dir(&root)).is_empty());
    }

    /// The kill path itself: a long-running child is stopped promptly.
    #[test]
    fn cancelling_kills_a_running_child_process() {
        #[cfg(windows)]
        let cmd = {
            let mut c = Command::new("ping");
            c.args(["-n", "30", "127.0.0.1"]);
            c
        };
        #[cfg(not(windows))]
        let cmd = {
            let mut c = Command::new("sleep");
            c.arg("30");
            c
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let setter = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            setter.store(true, Ordering::SeqCst);
        });
        let started = std::time::Instant::now();
        let result = run_cancellable(cmd, &cancel);
        assert!(matches!(result, Err(RunError::Cancelled)), "{result:?}");
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
    }

    #[test]
    fn install_registry_cancels_by_id_and_forgets_finished_installs() {
        let guard = begin_install("life-registry-1").unwrap();
        assert_eq!(
            begin_install("life-registry-1").err().unwrap().code,
            PluginErrorCode::InvalidSource
        );
        assert!(cancel_install("life-registry-1"));
        assert!(guard.ctx().cancelled());
        drop(guard);
        assert!(!cancel_install("life-registry-1"));
        assert!(begin_install(" ").is_err());
    }

    /// A disabled plugin stays installed but offers nothing: no skills in the
    /// catalog or by qualified name, no commands, no agents. Re-enabling
    /// restores all three, and the state survives a fresh read of agent.toml.
    #[test]
    fn disabled_plugin_contributes_no_skills_commands_or_agents() {
        let root = project_root("disable");
        let src = plugin_source("disable-src", "toggleplug");
        std::fs::create_dir_all(skills::plugins_dir(&root)).unwrap();
        copy_tree(
            &src,
            &skills::plugins_dir(&root).join("toggleplug"),
            &ctx(),
            &mut || {},
        )
        .unwrap();

        let offered = |root: &Path| {
            let enabled = project::enabled_skills(root);
            let skills_offered = skills::catalog(root, &enabled)
                .into_iter()
                .any(|m| m.name == "toggleplug:prepare");
            let user_skill = skills::user_catalog(root, &enabled)
                .into_iter()
                .any(|m| m.name == "toggleplug:prepare");
            let readable = skills::resolve_readable(root, "toggleplug:prepare").is_ok();
            let invocable =
                skills::build_invocation_message(root, "toggleplug:prepare", "").is_ok();
            let command = crate::core::agent::plugin_commands::catalog(root, &enabled)
                .into_iter()
                .any(|c| c.plugin == "toggleplug" && c.name == "ship");
            let command_msg =
                crate::core::agent::plugin_commands::build_message(root, "toggleplug:ship", "")
                    .is_ok();
            let agent = crate::core::agent::subagent::SubagentRegistry::load(root)
                .get("toggleplug-reviewer")
                .is_some();
            [
                skills_offered,
                user_skill,
                readable,
                invocable,
                command,
                command_msg,
                agent,
            ]
        };

        assert_eq!(offered(&root), [true; 7], "enabled plugin must be offered");

        let state = set_enabled(&root, "toggleplug", false).unwrap();
        assert!(!state.enabled);
        assert_eq!(project::disabled_plugins(&root), vec!["toggleplug"]);
        assert_eq!(offered(&root), [false; 7], "disabled plugin must offer nothing");
        // Still installed, still describing what it ships.
        let listed = installed(&root);
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].enabled);
        assert_eq!((listed[0].skills, listed[0].commands, listed[0].agents), (1, 1, 1));
        assert!(!details(&root, "toggleplug").unwrap().plugin.enabled);

        // Idempotent: disabling twice keeps one entry.
        set_enabled(&root, "toggleplug", false).unwrap();
        assert_eq!(project::disabled_plugins(&root), vec!["toggleplug"]);

        let state = set_enabled(&root, "toggleplug", true).unwrap();
        assert!(state.enabled);
        assert!(project::disabled_plugins(&root).is_empty());
        assert_eq!(offered(&root), [true; 7]);
    }

    #[test]
    fn remove_deletes_the_directory_and_cleans_config_entries() {
        let root = project_root("removeclean");
        let plugins = skills::plugins_dir(&root);
        for name in ["gone", "stays"] {
            let src = plugin_source(&format!("removeclean-{name}"), name);
            copy_tree(&src, &plugins.join(name), &ctx(), &mut || {}).unwrap();
        }
        set_enabled(&root, "gone", false).unwrap();
        set_enabled(&root, "stays", false).unwrap();
        let toml = project::agent_toml_path(&root);
        project::set_string_array_in_agent_toml(
            &toml,
            "skills",
            "enabled",
            &["gone".into(), "gone:prepare".into(), "stays:prepare".into()],
        )
        .unwrap();

        let report = remove_plugin(&root, "gone").unwrap();
        assert_eq!(report.id, "gone");
        assert!(report.removed_from_disabled);
        assert_eq!(report.removed_skill_entries, vec!["gone", "gone:prepare"]);
        assert!(!plugins.join("gone").exists());
        let cfg = project::load_agent_config(&root).unwrap();
        assert_eq!(cfg.plugins.disabled, vec!["stays"]);
        assert_eq!(cfg.skills.enabled, vec!["stays:prepare"]);

        // A whitelist that named only the removed plugin must not collapse to
        // `[]`, which would switch every skill on.
        let report = remove_plugin(&root, "stays").unwrap();
        assert_eq!(report.removed_skill_entries, vec!["stays:prepare"]);
        let cfg = project::load_agent_config(&root).unwrap();
        assert!(cfg.plugins.disabled.is_empty());
        assert_eq!(cfg.skills.enabled, vec![String::new()]);
        assert!(installed(&root).is_empty());
    }

    #[tokio::test]
    async fn refusals_carry_stable_error_codes() {
        let root = project_root("codes");
        let code = |r: Result<InstalledPlugin, PluginError>| r.expect_err("must fail").code;

        assert_eq!(
            remove_plugin(&root, "missing").err().unwrap().code,
            PluginErrorCode::NotInstalled
        );
        assert_eq!(
            details(&root, "../escape").err().unwrap().code,
            PluginErrorCode::InvalidName
        );
        assert_eq!(
            set_enabled(&root, "missing", false).err().unwrap().code,
            PluginErrorCode::NotInstalled
        );

        let missing = temp("codes-missing").join("nope");
        assert_eq!(
            code(
                install_from_source(
                    &root,
                    InstallSource::Local {
                        path: missing.display().to_string()
                    },
                    ctx()
                )
                .await
            ),
            PluginErrorCode::SourceNotFound
        );
        assert_eq!(
            code(
                install_from_source(
                    &root,
                    InstallSource::Local {
                        path: "relative/folder".into()
                    },
                    ctx()
                )
                .await
            ),
            PluginErrorCode::InvalidSource
        );
        assert_eq!(
            code(
                install_from_source(
                    &root,
                    InstallSource::Git {
                        url: "not a url".into()
                    },
                    ctx()
                )
                .await
            ),
            PluginErrorCode::InvalidSource
        );
        assert_eq!(
            code(
                install_from_source(
                    &root,
                    InstallSource::Git {
                        url: "https://example.invalid/a;rm -rf".into()
                    },
                    ctx()
                )
                .await
            ),
            PluginErrorCode::InvalidSource
        );
        assert_eq!(
            code(
                install_from_source(
                    &root,
                    InstallSource::Marketplace {
                        name: "anything".into()
                    },
                    ctx()
                )
                .await
            ),
            PluginErrorCode::MarketplaceNotConfigured
        );

        let empty = temp("codes-empty");
        assert_eq!(
            code(
                install_from_source(
                    &root,
                    InstallSource::Local {
                        path: empty.display().to_string()
                    },
                    ctx()
                )
                .await
            ),
            PluginErrorCode::NoPluginContent
        );

        // Installing the project root itself would copy staging into itself.
        assert_eq!(
            code(
                install_from_source(
                    &root,
                    InstallSource::Local {
                        path: root.display().to_string()
                    },
                    ctx()
                )
                .await
            ),
            PluginErrorCode::InvalidSource
        );

        let collection = temp("codes-collection");
        for name in ["alpha", "beta"] {
            put(
                &collection.join(name).join("skills/s/SKILL.md"),
                "---\ndescription: s\n---\n\nBody.\n",
            );
        }
        let err = install_from_source(
            &root,
            InstallSource::Local {
                path: collection.display().to_string(),
            },
            ctx(),
        )
        .await
        .err()
        .unwrap();
        assert_eq!(err.code, PluginErrorCode::Collection);
        assert!(err.message.contains("alpha") && err.message.contains("beta"));

        let src = plugin_source("codes-dup", "dupplug");
        let source = InstallSource::Local {
            path: src.display().to_string(),
        };
        install_from_source(&root, source.clone(), ctx()).await.unwrap();
        assert_eq!(
            code(install_from_source(&root, source, ctx()).await),
            PluginErrorCode::AlreadyInstalled
        );
        // Nothing but the one plugin, whatever failed above.
        assert_eq!(entries(&skills::plugins_dir(&root)), vec!["dupplug"]);

        let gone = temp("codes-noproject").join("absent");
        assert_eq!(
            code(
                install_from_source(
                    &gone,
                    InstallSource::Local {
                        path: src.display().to_string()
                    },
                    ctx()
                )
                .await
            ),
            PluginErrorCode::ProjectUnavailable
        );

        // A malformed agent.toml is reported, not silently overwritten.
        std::fs::write(project::agent_toml_path(&root), "[plugins\nbroken").unwrap();
        assert_eq!(
            set_enabled(&root, "dupplug", false).err().unwrap().code,
            PluginErrorCode::Config
        );

        // The wire shape the UI maps.
        let json = serde_json::to_value(PluginError::new(
            PluginErrorCode::NotInstalled,
            "plugin 'x' is not installed",
        ))
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({"code": "not_installed", "message": "plugin 'x' is not installed"})
        );
        // And the source shape the UI sends.
        let parsed: InstallSource =
            serde_json::from_value(serde_json::json!({"kind": "git", "url": "https://h/r"}))
                .unwrap();
        assert!(matches!(parsed, InstallSource::Git { url } if url == "https://h/r"));
    }

    /// AH-131: installing and enabling a plugin executes none of its code and
    /// grants no tool permission. The plugin ships every kind of file that
    /// could run -- install scripts, a package.json lifecycle hook, hook
    /// config, a skill script, and an `.mcp.json` server command -- each of
    /// which would create a marker file if it ever ran.
    #[tokio::test]
    async fn install_and_enable_execute_nothing_and_grant_no_permissions() {
        let root = project_root("escalation");
        let before_toml = std::fs::read_to_string(project::agent_toml_path(&root)).unwrap();
        let before = project::load_agent_config(&root).unwrap();

        let marker = temp("escalation-marker").join("ran");
        let m = marker.display().to_string().replace('\\', "/");
        let src = plugin_source("escalation-src", "hostile");
        put(&src.join("install.sh"), &format!("#!/bin/sh\ntouch '{m}'\n"));
        put(&src.join("setup.py"), &format!("open(r'{m}', 'w').write('x')\n"));
        put(
            &src.join("package.json"),
            &format!("{{\"scripts\":{{\"postinstall\":\"node -e \\\"require('fs').writeFileSync('{m}','x')\\\"\"}}}}"),
        );
        put(
            &src.join("hooks/hooks.json"),
            &format!("{{\"PostInstall\":[{{\"command\":\"touch '{m}'\"}}]}}"),
        );
        put(
            &src.join(".mcp.json"),
            &format!("{{\"mcpServers\":{{\"evil\":{{\"command\":\"sh\",\"args\":[\"-c\",\"touch '{m}'\"]}}}}}}"),
        );
        put(
            &src.join("skills/prepare/scripts/run.sh"),
            &format!("#!/bin/sh\ntouch '{m}'\n"),
        );
        // Frontmatter that asks for tools must not become a permission.
        put(
            &src.join("agents/hostile-reviewer.md"),
            "---\nname: hostile-reviewer\ndescription: Reviews\ntools: [Bash, Write]\n---\n\nYou review.\n",
        );

        install_from_source(
            &root,
            InstallSource::Local {
                path: src.display().to_string(),
            },
            ctx(),
        )
        .await
        .unwrap();
        set_enabled(&root, "hostile", false).unwrap();
        set_enabled(&root, "hostile", true).unwrap();
        let d = details(&root, "hostile").unwrap();

        // Give any stray process a moment to have written the marker.
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(!marker.exists(), "plugin code ran during install/enable");

        // The details view reports what could run, and that .mcp.json exists.
        assert!(d.has_mcp_config);
        for script in ["install.sh", "setup.py", "skills/prepare/scripts/run.sh"] {
            assert!(
                d.executable_files.iter().any(|f| f == script),
                "{script} missing from {:?}",
                d.executable_files
            );
        }

        // Tool policy is byte-for-byte what it was: only `[plugins]` changed.
        let after = project::load_agent_config(&root).unwrap();
        assert_eq!(format!("{:?}", before.tools), format!("{:?}", after.tools));
        assert_eq!(before.skills.enabled, after.skills.enabled);
        assert_eq!(before.plugins.marketplace, after.plugins.marketplace);
        assert!(after.tools.allow.is_empty());
        assert!(after.tools.allow_write.is_empty());
        assert_eq!(after.tools.allow_network, None);
        assert_eq!(after.tools.sandbox, None);
        let after_toml = std::fs::read_to_string(project::agent_toml_path(&root)).unwrap();
        let strip_plugins = |s: &str| {
            s.lines()
                .filter(|l| !l.trim().is_empty() && !l.starts_with("[plugins]") && !l.starts_with("disabled"))
                .collect::<Vec<_>>()
                .join("\n")
        };
        assert_eq!(strip_plugins(&before_toml), strip_plugins(&after_toml));
        assert_eq!(
            format!("{:?}", project::permissions_from(&before)),
            format!("{:?}", project::permissions_from(&after))
        );
    }
}

/// `PluginScope` / `plugin_root_dir` tests: plain `#[cfg(test)]`, not gated
/// behind `feature = "cli"` like the module above, so they run under the
/// desktop's own test build (`--features test-tauri`) too.
#[cfg(test)]
mod scope_tests {
    use super::*;

    /// `Project(root)` resolves to that project's own `.jan/agent/plugins/`,
    /// exactly like the unscoped `skills::plugins_dir`.
    #[test]
    fn project_scope_resolves_to_the_project_plugins_dir() {
        let root = std::env::temp_dir().join(format!(
            "jan_plugin_scope_project_{}",
            std::process::id()
        ));
        let scope = PluginScope::Project(root.clone());
        assert_eq!(plugin_root_dir(&scope), skills::plugins_dir(&root));
    }

    /// `Global` resolves under the permanent store, not any project -- and
    /// honours the same `set_test_user_plugins` override the discovery tests
    /// use, so this is deterministic and hermetic (no real data folder).
    #[test]
    fn global_scope_resolves_under_the_permanent_store() {
        let data = std::env::temp_dir().join(format!(
            "jan_plugin_scope_global_{}",
            std::process::id()
        ));
        let store = tauri_plugin_agent_tools::workspace::permanent_store(&data);
        skills::set_test_user_plugins(Some(store.clone()));

        let expected = tauri_plugin_agent_tools::skills::plugins_dir(&store);
        assert_eq!(plugin_root_dir(&PluginScope::Global), expected);

        // A project scope in the same process is unaffected by the global
        // override: the two stores never collapse into one.
        let project_root = std::env::temp_dir().join(format!(
            "jan_plugin_scope_project_for_global_{}",
            std::process::id()
        ));
        let project_scope = PluginScope::Project(project_root.clone());
        assert_eq!(plugin_root_dir(&project_scope), skills::plugins_dir(&project_root));
        assert_ne!(plugin_root_dir(&project_scope), expected);

        skills::set_test_user_plugins(None);
    }

    /// `sources_scoped(Global)` reads its marketplace from `<store>/agent.toml`
    /// -- the global agent config -- not from any project, and not always the
    /// default `PluginsSection` the old stub returned.
    #[test]
    fn global_sources_reads_marketplace_from_the_permanent_store_agent_toml() {
        let store = std::env::temp_dir().join(format!(
            "jan_plugin_global_agent_toml_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&store);
        std::fs::create_dir_all(&store).unwrap();
        skills::set_test_user_plugins(Some(store.clone()));

        // No agent.toml yet: falls back to defaults, same as an unconfigured
        // project -- not an error, and not a hidden/blocked state.
        let empty = sources_scoped(&PluginScope::Global);
        assert_eq!(empty.marketplace, None);

        std::fs::write(
            store.join("agent.toml"),
            "[plugins]\nmarketplace = \"https://example.com/plugins.json\"\n",
        )
        .unwrap();

        let configured = sources_scoped(&PluginScope::Global);
        assert_eq!(
            configured.marketplace.as_deref(),
            Some("https://example.com/plugins.json")
        );

        skills::set_test_user_plugins(None);
        let _ = std::fs::remove_dir_all(&store);
    }
}
