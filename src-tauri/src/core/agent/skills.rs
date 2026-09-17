//! Per-project skill storage. A skill is either a folder `<name>/SKILL.md`
//! (SKILL.md-ecosystem compatible; may bundle scripts/resources alongside) or a
//! legacy flat `<name>.md`. Both may carry leading YAML frontmatter (`name`,
//! `description`); the folder form is what new/imported skills are written as.
//!
//! Skills have two invocation sides, matching the SKILL.md ecosystem:
//! `user-invocable: false` hides a skill from the human (slash popup, `/skill:`
//! dispatch) while keeping it model-invocable; `disable-model-invocation: true`
//! hides it from the model (system-prompt catalog, `skill_list`/`skill_read`)
//! while keeping it user-invocable. Default is both sides; setting both keys
//! makes a skill private. `[skills].enabled` stays the orthogonal availability
//! whitelist applied to both sides.
//!
//! Sync (std::fs) so the sync `context::load_skills` and the async `agent_skill_*`
//! commands share one code path; the ops are tiny single-file reads/writes.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use tauri_plugin_agent_tools::skills as tool_skills;
use tauri_plugin_agent_tools::skills::{
    DEFAULT_JAN_SKILL, DEFAULT_JAN_SKILL_NAME, LEGACY_DEFAULT_SKILL_NAME,
};
use tauri_plugin_agent_tools::workspace::{project_store, workspace_filename};

/// `<project_root>/.jan/agent/skills`.
#[cfg(test)]
pub(crate) fn skills_dir(root: &Path) -> PathBuf {
    tool_skills::skills_dir(&project_store(root))
}

/// The user's own skills, shared by every project (AH-121):
/// `<jan_data_folder>/agent-workspace/skills`, the same store the desktop
/// writes native skills to, so a skill saved in the app is available to the
/// CLI in any project. `None` when no data folder resolves.
pub(crate) fn user_skills_dir() -> Option<PathBuf> {
    user_skill_store().map(|store| tauri_plugin_agent_tools::skills::skills_dir(&store))
}

/// The store root holding the user's skills (`<jan_data_folder>/agent-workspace`),
/// in the form the plugin's skill functions and `ToolContext` take: they add
/// `skills/` themselves.
#[cfg(not(test))]
pub(crate) fn user_skill_store() -> Option<PathBuf> {
    let data = crate::core::app::commands::resolve_jan_data_folder();
    (!data.as_os_str().is_empty())
        .then(|| tauri_plugin_agent_tools::workspace::permanent_store(&data))
}

// Tests point the user scope at a temp store rather than the real data
// folder, whose skills would otherwise leak into every discovery test.
#[cfg(test)]
thread_local! {
    static TEST_USER_SKILLS: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn user_skill_store() -> Option<PathBuf> {
    TEST_USER_SKILLS.with(|d| d.borrow().clone())
}

/// The user's own plugins, shared by every workspace:
/// `<jan_data_folder>/agent-workspace/plugins`. Sibling of `user_skills_dir`.
#[cfg(not(test))]
pub(crate) fn user_plugins_dir() -> Option<PathBuf> {
    user_skill_store().map(|store| tauri_plugin_agent_tools::skills::plugins_dir(&store))
}

// Tests point the user plugins scope at a temp store directly, mirroring
// TEST_USER_SKILLS, so a global plugins store can be set up independently of
// the skills store in a given test.
#[cfg(test)]
thread_local! {
    static TEST_USER_PLUGINS: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn set_test_user_plugins(store: Option<PathBuf>) {
    TEST_USER_PLUGINS.with(|d| *d.borrow_mut() = store);
}

#[cfg(test)]
pub(crate) fn user_plugins_dir() -> Option<PathBuf> {
    TEST_USER_PLUGINS
        .with(|d| d.borrow().clone())
        .map(|store| tauri_plugin_agent_tools::skills::plugins_dir(&store))
}

/// Global plugins' skills, tagged like project plugin skills. A project (or
/// project-scoped) plugin of the same directory name shadows a global one.
pub(crate) fn discover_user_plugins(project: &[SkillEntry]) -> Vec<SkillEntry> {
    let Some(dir) = user_plugins_dir() else {
        return Vec::new();
    };
    tauri_plugin_agent_tools::skills::scan_plugins_at(&dir)
        .into_iter()
        .filter(|u| {
            !project
                .iter()
                .any(|p| p.plugin == u.plugin && p.name == u.name)
        })
        .collect()
}

/// User skills, minus any a project skill of the same name shadows.
fn discover_user(project: &[SkillEntry]) -> Vec<SkillEntry> {
    let Some(dir) = user_skills_dir() else {
        return Vec::new();
    };
    tool_skills::scan_skill_dir(&dir)
        .into_iter()
        .filter(|u| !project.iter().any(|p| p.name == u.name))
        .collect()
}

/// One skill on disk, located by its identity name (folder name or flat stem),
/// tagged with the plugin it ships in. The type, and every plugin discovery
/// rule below, live in the tool plugin crate so the desktop's skill tools and
/// this CLI catalog apply identical rules.
pub(crate) use tauri_plugin_agent_tools::skills::SkillEntry;

/// Summary for the management UI / prompt catalog.
#[derive(Clone, serde::Serialize)]
pub struct SkillMeta {
    pub name: String,
    pub description: String,
    /// The plugin this skill ships in, `None` for a project skill. Plugin
    /// skills are named `<plugin>:<skill>`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin: Option<String>,
    /// Offered in the user-facing invoke surface (slash popup, `/skill:`).
    pub user_invocable: bool,
    /// Offered to the model (system-prompt catalog, `skill_list`/`skill_read`).
    pub model_invocable: bool,
    /// The version the skill declares (AH-123), as written. `None` is "said
    /// nothing", which no constraint can be satisfied by.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// Frontmatter fields we recognize; everything else is ignored.
#[derive(Debug, Default, Deserialize)]
struct Frontmatter {
    #[allow(dead_code)]
    name: Option<String>,
    description: Option<String>,
    /// Claude Code convention: `user-invocable: false` keeps the skill
    /// model-invocable while hiding it from the human's invoke list.
    #[serde(rename = "user-invocable")]
    user_invocable: Option<bool>,
    /// Matt Pocock's SKILL-MECHANICS convention: `disable-model-invocation:
    /// true` keeps the skill user-invocable while removing its description
    /// from the model's reach (no context load).
    #[serde(rename = "disable-model-invocation")]
    disable_model_invocation: Option<bool>,
}

/// A skill's parsed content: optional frontmatter description + markdown body
/// (body has the frontmatter fence stripped so it never leaks into the prompt).
pub(crate) struct ParsedSkill {
    pub description: Option<String>,
    pub body: String,
    pub user_invocable: bool,
    pub model_invocable: bool,
    /// AH-123, read by the plugin's parser so the two surfaces can never
    /// disagree about what a skill calls itself.
    pub version: Option<String>,
    /// AH-124, read by the same parser, for the same reason.
    pub requires: Vec<tauri_plugin_agent_tools::skills::SkillRequirement>,
}

/// Split leading `---\n...\n---` YAML frontmatter from a markdown body.
/// Tolerant: no opening fence or an unterminated fence yields `(None, whole
/// input)`. Shared by skill, plugin-command, and plugin-agent parsing so the
/// fence rules never drift between the three.
pub(crate) fn split_frontmatter(content: &str) -> (Option<String>, String) {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut lines = content.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return (None, content.to_string());
    }
    let mut yaml = String::new();
    let mut body: Vec<&str> = Vec::new();
    let mut closed = false;
    for line in lines {
        if !closed {
            if line.trim_end() == "---" {
                closed = true;
                continue;
            }
            yaml.push_str(line);
            yaml.push('\n');
        } else {
            body.push(line);
        }
    }
    if !closed {
        return (None, content.to_string());
    }
    (
        Some(yaml),
        body.join("\n").trim_start_matches('\n').to_string(),
    )
}

pub(crate) fn parse(content: &str) -> ParsedSkill {
    // Version and dependencies come from the plugin's parser rather than being
    // read twice here: two readers of one frontmatter is two answers waiting to
    // differ, and the answer decides whether a skill loads at all.
    let declared = tauri_plugin_agent_tools::skills::parse(content);
    let (yaml, body) = split_frontmatter(content);
    let Some(yaml) = yaml else {
        return ParsedSkill {
            description: None,
            body,
            user_invocable: true,
            model_invocable: true,
            version: declared.version,
            requires: declared.requires,
        };
    };
    let fm = serde_yaml::from_str::<Frontmatter>(&yaml).unwrap_or_default();
    ParsedSkill {
        description: fm.description.map(|d| d.trim().to_string()),
        body,
        user_invocable: fm.user_invocable.unwrap_or(true),
        model_invocable: !fm.disable_model_invocation.unwrap_or(false),
        version: declared.version,
        requires: declared.requires,
    }
}

/// What a skill declares and this project cannot supply (AH-123, AH-124).
///
/// The tool half is left to the surfaces that know their own toolset: here the
/// question is only whether the skills a skill depends on are installed, and at
/// a version its requirement allows.
pub(crate) fn unmet_requirements(
    root: &Path,
    name: &str,
    requires: &[tauri_plugin_agent_tools::skills::SkillRequirement],
) -> Vec<String> {
    let declared = tauri_plugin_agent_tools::skills::ParsedSkill {
        description: None,
        body: String::new(),
        user_invocable: true,
        model_invocable: true,
        needs: Vec::new(),
        version: None,
        requires: requires.to_vec(),
    };
    let lookup = |wanted: &str| {
        resolve_readable(root, wanted)
            .ok()
            .and_then(|entry| std::fs::read_to_string(&entry.file).ok())
    };
    tauri_plugin_agent_tools::skills::unmet_requirements(name, &declared, &lookup, None)
}

/// First non-empty, non-heading line of `body`, capped at 120 chars. Fallback
/// description when a skill has no frontmatter `description`.
pub(crate) fn first_line(body: &str) -> String {
    body.lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('#'))
        .unwrap_or("")
        .chars()
        .take(120)
        .collect()
}

/// Sanitized identity stem (no path escape, no `.md`). Reuses the workspace name
/// guard so a caller-supplied name can never escape the skills directory.
pub(crate) fn safe_stem(name: &str) -> Result<String, String> {
    let file = workspace_filename(name)?;
    Ok(file.trim_end_matches(".md").to_string())
}

/// All project skills (`.jan/agent/skills`), sorted by name.
pub(crate) fn discover(root: &Path) -> Vec<SkillEntry> {
    tool_skills::discover(&project_store(root))
}

/// The plugins directory `.jan/agent/plugins`.
pub(crate) fn plugins_dir(root: &Path) -> PathBuf {
    tool_skills::plugins_dir(&project_store(root))
}

/// Recursively yield every `*.md` file under `dir`, skipping dotfiles and
/// `README` files (any case). Callers read each file themselves so read-failure
/// handling stays with them. Shared by plugin command and plugin agent
/// discovery.
pub(crate) fn walk_markdown_files(dir: &Path, visit: &mut dyn FnMut(&Path)) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            walk_markdown_files(&path, visit);
            continue;
        }
        if !ft.is_file() || path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(file_name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if file_name.starts_with('.') {
            continue;
        }
        if path
            .file_stem()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.eq_ignore_ascii_case("README"))
        {
            continue;
        }
        visit(&path);
    }
}

/// The machine-generated wrapper line for a skill/command invocation message.
/// `cli::invocation_label` parses exactly this shape back into a compact
/// transcript label on resume, so every producer uses this one helper and the
/// parser's expectations cannot silently drift from what is written.
pub(crate) fn invocation_wrapper(name: &str, kind: &str) -> String {
    format!(
        "[IMPORTANT: You have invoked the \"{name}\" {kind} - follow its instructions. The full {kind} content is loaded below.]"
    )
}

/// Skills shipped by installed plugins, qualified with their plugin name.
/// Each installed plugin is scanned conventionally: a `skills/` subdirectory
/// (folder and flat forms, same rules as project skills) plus an optional
/// single `SKILL.md` at the plugin root (a repo that is itself one skill).
///
/// Plugins listed in `[plugins].disabled` are skipped: a disabled plugin's
/// skills are neither advertised nor resolvable. Management views that must
/// show what a disabled plugin ships use [`discover_plugins_including_disabled`].
pub(crate) fn discover_plugins(root: &Path) -> Vec<SkillEntry> {
    let disabled = crate::core::agent::project::disabled_plugins(root);
    scan_plugin_skills(root, &disabled)
}

/// Every plugin skill on disk, disabled plugins included. For listings and
/// details only; never for anything offered to the model or the human.
pub(crate) fn discover_plugins_including_disabled(root: &Path) -> Vec<SkillEntry> {
    scan_plugin_skills(root, &[])
}

/// Delegates to the tool crate's discovery with this crate's own reading of
/// `[plugins].disabled`; `tests::plugin_rules_match_the_tool_crate` pins the
/// two readings to the same answer.
fn scan_plugin_skills(root: &Path, disabled: &[String]) -> Vec<SkillEntry> {
    tool_skills::discover_plugins(&project_store(root), disabled)
}

/// Project skills, then the user's own skills (AH-121), then plugin skills
/// (qualified). A project skill shadows a user skill and a plugin skill of the
/// same plain name: the project is the more specific scope.
pub(crate) fn discover_all(root: &Path) -> Vec<SkillEntry> {
    let mut out = discover(root);
    let user = discover_user(&out);
    out.extend(user);
    out.extend(discover_plugins(root));
    out
}

/// The user-facing identity of a skill entry: `name` for project skills,
/// `<plugin>:<name>` for plugin skills.
pub(crate) fn qualified_name(entry: &SkillEntry) -> String {
    tool_skills::qualified_name(entry)
}

/// Locate any readable skill: project skill first (project shadows plugins),
/// then the explicit `<plugin>:<plain>` form, then a plain name that is unique
/// across enabled plugins. A disabled plugin's skills resolve to nothing, or
/// disabling would only hide them from the catalog. Used by invocation
/// dispatch so it reaches plugin skills with the names the catalogs advertise.
pub(crate) fn resolve_readable(root: &Path, name: &str) -> Result<SkillEntry, String> {
    let store = project_store(root);
    if let Ok(entry) = tool_skills::resolve_store_skill(&store, name) {
        return Ok(entry);
    }
    // The user's own skill, when no project skill has the name (AH-121).
    if let Some(entry) = discover_user(&[]).into_iter().find(|e| e.name == name) {
        return Ok(entry);
    }
    let disabled = crate::core::agent::project::disabled_plugins(root);
    tool_skills::resolve_readable(&store, name, &disabled)
}

/// Whether a skill is advertised given the `[skills].enabled` whitelist. An
/// empty whitelist means every skill is enabled; matching accepts the
/// qualified `<plugin>:<skill>` name, the plain skill name, or the plugin
/// name alone (enables every skill a plugin ships).
pub(crate) fn is_enabled(enabled: &[String], entry: &SkillEntry) -> bool {
    tool_skills::entry_enabled(enabled, entry)
}

/// A skill's summary line: the frontmatter `description`, or the first body line.
fn describe(parsed: &ParsedSkill) -> String {
    parsed
        .description
        .clone()
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| first_line(&parsed.body))
}

/// A discovered skill's metadata with its invocation flags resolved.
fn meta_for(entry: &SkillEntry, parsed: &ParsedSkill) -> SkillMeta {
    SkillMeta {
        name: qualified_name(entry),
        description: describe(parsed),
        plugin: entry.plugin.clone(),
        user_invocable: parsed.user_invocable,
        model_invocable: parsed.model_invocable,
        version: parsed.version.clone(),
    }
}
/// Whether a name refers to the built-in Flint skill (aliased `jan`), which is
/// always available even with no project skills installed.
fn is_default_jan_skill(name: &str) -> bool {
    matches!(
        safe_stem(name).ok().as_deref(),
        Some(DEFAULT_JAN_SKILL_NAME) | Some(LEGACY_DEFAULT_SKILL_NAME)
    )
}

/// The built-in Flint skill's metadata: the plugin-embedded onboarding skill is
/// advertised in every catalog even with zero project skills installed, but
/// never force-loaded - its full body stays embedded and is fetched on demand
/// via `skill_read` / `/skill:jan`, honoring the same invocation flags as any
/// other skill. A project or plugin skill named "jan" shadows this default.
fn default_jan_skill_meta() -> SkillMeta {
    let parsed = parse(DEFAULT_JAN_SKILL);
    SkillMeta {
        name: DEFAULT_JAN_SKILL_NAME.to_string(),
        description: describe(&parsed),
        plugin: None,
        user_invocable: true,
        model_invocable: true,
        version: parsed.version.clone(),
    }
}

/// Metadata for every project skill (name + description + invocation
/// flags). Keeps empty stubs so the user can see and edit them.
///
/// Test-only: the management UI edits skills through the plugin crate's
/// `list_meta`, which reads the same project store.
#[cfg(test)]
pub(crate) fn list_meta(root: &Path) -> Vec<SkillMeta> {
    discover(root)
        .into_iter()
        .filter_map(|e| {
            let parsed = parse(&std::fs::read_to_string(&e.file).ok()?);
            Some(meta_for(&e, &parsed))
        })
        .collect()
}

/// Filter discovered skills (project + plugins) by the `[skills].enabled`
/// whitelist and one invocation side. Skills with neither a description nor a
fn side_catalog(
    root: &Path,
    enabled: &[String],
    side: impl Fn(&ParsedSkill) -> bool,
) -> Vec<SkillMeta> {
    let mut skills: Vec<SkillMeta> = discover_all(root)
        .into_iter()
        .filter(|e| is_enabled(enabled, e))
        .filter_map(|e| {
            let parsed = parse(&std::fs::read_to_string(&e.file).ok()?);
            if !side(&parsed) {
                return None;
            }
            let description = describe(&parsed);
            if description.is_empty() && parsed.body.trim().is_empty() {
                return None;
            }
            Some(meta_for(&e, &parsed))
        })
        .collect();
    // The built-in Flint skill is always advertised so onboarding works even in
    // an empty project (mirrors the plugin's side_catalog). It honors the
    // enabled whitelist and side filter, and is skipped if a project or plugin
    // skill named "jan" already shadows it.
    if (enabled.is_empty()
        || enabled
            .iter()
            .any(|n| n == DEFAULT_JAN_SKILL_NAME || n == LEGACY_DEFAULT_SKILL_NAME))
        && side(&parse(DEFAULT_JAN_SKILL))
        && !skills.iter().any(|m| m.name == DEFAULT_JAN_SKILL_NAME)
    {
        skills.push(default_jan_skill_meta());
    }
    skills
}

/// Skills worth advertising in the system prompt: name + description, skipping
/// skills with neither a description nor a body. This is the progressive-
/// disclosure catalog — the model calls `skill_read` to load a body on demand.
/// Skills with `disable-model-invocation: true` are excluded: their
/// description would cost permanent context load, and only the human may fire
/// them (Matt Pocock's SKILL-MECHANICS model-invoked vs user-invoked cut).
///
/// `enabled` is a whitelist of skill names; an empty list means "all skills"
/// (backward-compatible with the agent.toml scaffold, which ships `enabled = []`).
pub(crate) fn catalog(root: &Path, enabled: &[String]) -> Vec<SkillMeta> {
    side_catalog(root, enabled, |p| p.model_invocable)
}

/// User-invocable skills: what the slash popup offers and `/skill:<name>`
/// dispatches. Skills with `user-invocable: false` (Claude Code convention)
/// are excluded — the human must not be able to fire them; the agent still
/// can. Both sides of the popup share this list.
pub(crate) fn user_catalog(root: &Path, enabled: &[String]) -> Vec<SkillMeta> {
    side_catalog(root, enabled, |p| p.user_invocable)
}

/// Metadata for every skill one plugin ships (both invocation sides), for the
/// `/plugin list` view. The enabled whitelist is intentionally ignored here:
/// the management view shows what the plugin contributes, not what is active.
#[cfg(feature = "cli")]
pub(crate) fn plugin_skill_metas(root: &Path, plugin: &str) -> Vec<SkillMeta> {
    let mut metas = side_catalog(root, &[], |_| true);
    metas.retain(|m| m.plugin.as_deref() == Some(plugin));
    metas
}

/// Raw SKILL.md text (frontmatter included). Test-only: the desktop editor
/// reads skills through the plugin crate's `read_raw` (which also resolves the
/// built-in jan skill); core resolves the same files for invocation dispatch.
#[cfg(test)]
pub(crate) fn read_raw(root: &Path, name: &str) -> Result<String, String> {
    if is_default_jan_skill(name) {
        return Ok(parse(DEFAULT_JAN_SKILL).body);
    }
    let entry = resolve_readable(root, name)?;
    std::fs::read_to_string(&entry.file).map_err(|e| format!("ERROR: {e}"))
}

/// Parse a `/skill:<name>` invocation in a user draft.
///
/// Returns `(name, args)` for:
///   - the leading form (`/skill:deploy staging` -> `deploy`, `staging`), and
///   - a mid-prompt token (`fix the bug /skill:deploy focus on auth` ->
///     `deploy`, with the surrounding prose collapsed into `args`).
///
/// Mid-prompt detection is skipped when the draft starts with another slash
/// command (`/compact /skill:foo` is a command argument, not an invocation) or
/// a local-execution sigil (`!cmd` / `$ cmd`), whose bodies routinely contain
/// `/skill:` references that are not meant as skill invocations.
#[cfg(any(feature = "cli", test))]
pub(crate) fn parse_invocation(text: &str) -> Option<(String, String)> {
    let trimmed = text.trim_start();
    if let Some(rest) = trimmed.strip_prefix("/skill:") {
        let name = rest.split_whitespace().next()?;
        if name.is_empty() {
            return None;
        }
        let args = rest[name.len()..].trim();
        return Some((name.to_string(), args.to_string()));
    }
    if trimmed.starts_with('/') || trimmed.starts_with('!') || trimmed.starts_with('$') {
        return None;
    }
    // Mid-prompt: `/skill:<name>` preceded by start/space and followed by
    // space/end. The name excludes `/` so a path like `/skill:foo/bar` is not
    // an invocation.
    let bytes = text.as_bytes();
    let mut search_from = 0;
    while search_from < text.len() {
        let rel = text[search_from..].find("/skill:")?;
        let start = search_from + rel;
        let prev_ok = start == 0 || bytes[start - 1].is_ascii_whitespace();
        let after = start + "/skill:".len();
        let name_end = text[after..]
            .find(|c: char| c.is_whitespace() || c == '/')
            .map(|i| after + i)
            .unwrap_or(text.len());
        let name = &text[after..name_end];
        let next_ok = name_end == text.len()
            || text[name_end..]
                .chars()
                .next()
                .is_some_and(char::is_whitespace);
        if prev_ok && next_ok && !name.is_empty() {
            let before = text[..start].trim_end();
            let after_part = text[name_end..].trim_start();
            let args = [before, after_part]
                .into_iter()
                .filter(|p| !p.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            return Some((name.to_string(), args));
        }
        search_from = (start + 1).max(name_end);
    }
    None
}

/// Build the user message for invoking a user-invocable skill (`/skill:<name>` /
/// `<skill>` semantics shared with the console): the full skill body
/// (frontmatter stripped) wrapped in an invocation header, the skill's
/// directory announced so bundled files resolve relative paths, and the user's
/// `args` threaded in. Returns `(message, description)`; `Err` when the skill
/// is unknown, disabled, or not user-invocable (same visibility rules as the
/// slash popup; the opposite side of the `skill_read` tool).
pub(crate) fn build_invocation_message(
    root: &Path,
    name: &str,
    args: &str,
) -> Result<(String, String), String> {
    let enabled = crate::core::agent::project::load_agent_config(root)
        .ok()
        .map(|c| c.skills.enabled)
        .unwrap_or_default();
    let user_skills = user_catalog(root, &enabled);
    let meta =
        find_user_skill(&user_skills, name).ok_or_else(|| format!("skill '{name}' not found"))?;
    let mut declared: Vec<tauri_plugin_agent_tools::skills::SkillRequirement> = Vec::new();
    let body = match resolve_readable(root, name) {
        Ok(entry) => {
            let parsed =
                parse(&std::fs::read_to_string(&entry.file).map_err(|e| format!("ERROR: {e}"))?);
            declared = parsed.requires.clone();
            let body = parsed.body;
            // Folder skills (and single-skill plugins) may bundle files next to
            // their SKILL.md; announce that directory so relative paths resolve.
            let dir_note = entry.is_folder.then(|| {
                let base = entry.file.parent().unwrap_or(root);
                format!(
                    "\n\n---\n[Skill directory: {}]\nResolve relative paths in the skill against that directory.\n",
                    base.display()
                )
            });
            (body, dir_note)
        }
        // The built-in Flint skill has no file on disk; serve its embedded body
        // on demand, exactly like the plugin's skill_read path.
        Err(_) if is_default_jan_skill(name) => (parse(DEFAULT_JAN_SKILL).body, None),
        Err(e) => return Err(e),
    };
    // AH-124: a skill that depends on skills this project does not have is
    // refused by name, rather than invoked so its first instruction can fail.
    let unmet = unmet_requirements(root, name, &declared);
    if !unmet.is_empty() {
        return Err(format!(
            "skill '{name}' cannot be used here: {}",
            unmet.join("; ")
        ));
    }
    let args = args.trim();
    let mut msg = format!("{}\n\n{}", invocation_wrapper(name, "skill"), body.0);
    if let Some(note) = body.1 {
        msg.push_str(&note);
    }
    if !args.is_empty() {
        msg.push_str(&format!("User: {args}\n"));
    }
    Ok((msg, meta.description))
}

/// Find a skill in a user-side catalog by the name a human typed: exact
/// match first (project names and the explicit `<plugin>:<skill>` form), then
/// a plain name that is unique across plugin skills.
fn find_user_skill(user_skills: &[SkillMeta], name: &str) -> Option<SkillMeta> {
    if let Some(meta) = user_skills.iter().find(|m| m.name == name).cloned() {
        return Some(meta);
    }
    let mut matches = user_skills
        .iter()
        .filter(|m| m.plugin.is_some() && m.name.rsplit_once(':').map(|(_, s)| s) == Some(name));
    let first = matches.next()?.clone();
    matches.next().is_none().then_some(first)
}

/// Create or overwrite a skill. Existing skills are written in place (preserving
/// their form); new skills are written as the folder form `<name>/SKILL.md`.
///
/// Test-only: the desktop UI writes skills through the plugin crate's `write`.
#[cfg(test)]
pub(crate) fn write(root: &Path, name: &str, content: &str) -> Result<(), String> {
    let stem = safe_stem(name)?;
    let dir = skills_dir(root);
    let flat = dir.join(format!("{stem}.md"));
    let target = if flat.is_file() {
        flat
    } else {
        let folder = dir.join(&stem);
        std::fs::create_dir_all(&folder).map_err(|e| format!("ERROR: {e}"))?;
        folder.join("SKILL.md")
    };
    std::fs::write(&target, content).map_err(|e| format!("ERROR: {e}"))
}

/// Delete a skill (folder or flat form). Idempotent: a missing skill is Ok.
///
/// Test-only: the desktop UI deletes skills through the plugin crate's `delete`.
#[cfg(test)]
pub(crate) fn delete(root: &Path, name: &str) -> Result<(), String> {
    let stem = safe_stem(name)?;
    let dir = skills_dir(root);
    let folder = dir.join(&stem);
    let flat = dir.join(format!("{stem}.md"));
    if folder.is_dir() {
        std::fs::remove_dir_all(&folder).map_err(|e| format!("ERROR: {e}"))
    } else if flat.is_file() {
        std::fs::remove_file(&flat).map_err(|e| format!("ERROR: {e}"))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_extracts_description_and_strips_frontmatter() {
        let p = parse("---\nname: deploy\ndescription: Ship it\n---\n\nRun the script.");
        assert_eq!(p.description.as_deref(), Some("Ship it"));
        assert_eq!(p.body, "Run the script.");
    }

    #[test]
    fn parse_without_frontmatter_returns_whole_body() {
        let p = parse("Just a body.\nMore.");
        assert!(p.description.is_none());
        assert_eq!(p.body, "Just a body.\nMore.");
    }

    #[test]
    fn parse_unterminated_fence_is_all_body() {
        let p = parse("---\nname: x\nbody without close");
        assert!(p.description.is_none());
        assert!(p.body.starts_with("---"));
    }

    #[test]
    fn discover_finds_folder_and_flat_skills_sorted() {
        let root = std::env::temp_dir().join(format!(
            "jan_skills_test_{}",
            std::time::SystemTime::UNIX_EPOCH
                .elapsed()
                .unwrap()
                .as_nanos()
        ));
        let dir = skills_dir(&root);
        std::fs::create_dir_all(dir.join("b_folder")).unwrap();
        std::fs::write(dir.join("b_folder").join("SKILL.md"), "folder body").unwrap();
        std::fs::write(dir.join("a_flat.md"), "flat body").unwrap();

        let names: Vec<_> = discover(&root).into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["a_flat", "b_folder"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_new_creates_folder_form_read_delete_roundtrip() {
        let root = std::env::temp_dir().join(format!(
            "jan_skills_rt_{}",
            std::time::SystemTime::UNIX_EPOCH
                .elapsed()
                .unwrap()
                .as_nanos()
        ));
        write(&root, "deploy", "---\ndescription: d\n---\nbody").unwrap();
        assert!(skills_dir(&root).join("deploy").join("SKILL.md").is_file());

        let meta = list_meta(&root);
        assert_eq!(meta.len(), 1);
        assert_eq!(meta[0].name, "deploy");
        assert_eq!(meta[0].description, "d");

        assert!(read_raw(&root, "deploy").unwrap().contains("body"));
        delete(&root, "deploy").unwrap();
        assert!(!skills_dir(&root).join("deploy").exists());
        delete(&root, "deploy").unwrap(); // idempotent
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn parse_invocation_leading_and_mid_prompt_forms() {
        // Leading form: name + args.
        let (name, args) = parse_invocation("/skill:deploy staging --force").unwrap();
        assert_eq!(name, "deploy");
        assert_eq!(args, "staging --force");
        // Bare leading form.
        let (name, args) = parse_invocation("/skill:deploy").unwrap();
        assert_eq!(name, "deploy");
        assert_eq!(args, "");
        // Mid-prompt: surrounding prose collapses into args.
        let (name, args) =
            parse_invocation("fix the auth flow /skill:deploy focus on security").unwrap();
        assert_eq!(name, "deploy");
        assert_eq!(args, "fix the auth flow focus on security");
        // Token at the end: only the prose before it.
        let (name, args) = parse_invocation("fix the auth flow /skill:deploy").unwrap();
        assert_eq!(name, "deploy");
        assert_eq!(args, "fix the auth flow");
        // Trailing token with nothing before.
        let (name, args) = parse_invocation("/skill:deploy harden").unwrap();
        assert_eq!(name, "deploy");
        assert_eq!(args, "harden");
    }

    #[test]
    fn parse_invocation_skips_commands_sigils_and_paths() {
        // Another slash command takes precedence.
        assert!(parse_invocation("/compact /skill:deploy").is_none());
        // Local-execution sigils pass through.
        assert!(parse_invocation("!run /skill:deploy now").is_none());
        assert!(parse_invocation("$ python /skill:deploy.py").is_none());
        // A path-like token is not an invocation.
        assert!(parse_invocation("see /skill:foo/bar for details").is_none());
        // Unknown/plain text has no token.
        assert!(parse_invocation("just some words").is_none());
    }

    #[test]
    fn parse_invocation_flags_from_frontmatter() {
        // Default: both sides.
        let p = parse("---\ndescription: d\n---\nbody");
        assert!(p.user_invocable && p.model_invocable);
        // Claude Code convention: model-only.
        let p = parse("---\ndescription: d\nuser-invocable: false\n---\nbody");
        assert!(!p.user_invocable && p.model_invocable);
        // Matt Pocock convention: user-only.
        let p = parse("---\ndescription: d\ndisable-model-invocation: true\n---\nbody");
        assert!(p.user_invocable && !p.model_invocable);
        // Both set: fully private.
        let p = parse("---\nuser-invocable: false\ndisable-model-invocation: true\n---\nbody");
        assert!(!p.user_invocable && !p.model_invocable);
        // No frontmatter at all: both sides.
        let p = parse("just a body");
        assert!(p.user_invocable && p.model_invocable);
    }

    #[test]
    fn catalog_and_user_catalog_split_invocation_sides() {
        let root = std::env::temp_dir().join(format!(
            "jan_skills_sides_{}",
            std::time::SystemTime::UNIX_EPOCH
                .elapsed()
                .unwrap()
                .as_nanos()
        ));
        let dir = skills_dir(&root);
        let write = |name: &str, fm: &str| {
            std::fs::create_dir_all(dir.join(name)).unwrap();
            std::fs::write(
                dir.join(name).join("SKILL.md"),
                format!("---\ndescription: {name} desc\n{fm}---\nbody of {name}"),
            )
            .unwrap();
        };
        write("both", "");
        write("model_only", "user-invocable: false\n");
        write("user_only", "disable-model-invocation: true\n");

        let model: Vec<_> = catalog(&root, &[]).into_iter().map(|m| m.name).collect();
        assert_eq!(
            model,
            vec!["both", "model_only", "jan"],
            "model side: {model:?}"
        );
        let user: Vec<_> = user_catalog(&root, &[])
            .into_iter()
            .map(|m| m.name)
            .collect();
        assert_eq!(
            user,
            vec!["both", "user_only", "jan"],
            "user side: {user:?}"
        );

        // Both flags still visible to the management list.
        let all = list_meta(&root);
        assert_eq!(all.len(), 3);
        assert!(
            !all.iter()
                .find(|m| m.name == "model_only")
                .unwrap()
                .user_invocable
        );
        assert!(
            !all.iter()
                .find(|m| m.name == "user_only")
                .unwrap()
                .model_invocable
        );

        // User invocation refuses model-only skills.
        assert!(build_invocation_message(&root, "model_only", "").is_err());
        assert!(build_invocation_message(&root, "user_only", "").is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// AH-124: a human invoking a skill whose dependency is missing is told
    /// so by name, rather than handed instructions whose first step refers to
    /// a skill that is not there. Installing the dependency at an allowed
    /// version makes the same invocation work.
    #[test]
    fn a_skill_whose_dependency_is_missing_is_not_invoked() {
        let root = std::env::temp_dir().join(format!(
            "jan_skills_requires_{}_{}",
            std::process::id(),
            std::time::SystemTime::UNIX_EPOCH
                .elapsed()
                .unwrap()
                .as_nanos()
        ));
        let skills = skills_dir(&root);
        std::fs::create_dir_all(skills.join("release")).unwrap();
        std::fs::write(
            skills.join("release").join("SKILL.md"),
            "---\ndescription: Cut a release\nrequires:\n  - deploy >=2.0\n---\n\nCut it.\n",
        )
        .unwrap();

        let refused = build_invocation_message(&root, "release", "").unwrap_err();
        assert!(refused.contains("'deploy'"), "{refused}");
        assert!(refused.contains("not installed"), "{refused}");

        std::fs::create_dir_all(skills.join("deploy")).unwrap();
        std::fs::write(
            skills.join("deploy").join("SKILL.md"),
            "---\ndescription: Ship it\nversion: 1.0.0\n---\n\nShip it.\n",
        )
        .unwrap();
        let too_old = build_invocation_message(&root, "release", "").unwrap_err();
        assert!(too_old.contains("is 1.0.0"), "{too_old}");

        std::fs::write(
            skills.join("deploy").join("SKILL.md"),
            "---\ndescription: Ship it\nversion: 2.0.0\n---\n\nShip it.\n",
        )
        .unwrap();
        let (msg, _) = build_invocation_message(&root, "release", "").expect("now satisfied");
        assert!(msg.contains("Cut it."), "{msg}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn build_invocation_message_injects_body_and_args() {
        let root = std::env::temp_dir().join(format!(
            "jan_skills_inv_{}",
            std::time::SystemTime::UNIX_EPOCH
                .elapsed()
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(skills_dir(&root).join("deploy")).unwrap();
        std::fs::write(
            skills_dir(&root).join("deploy").join("SKILL.md"),
            "---\ndescription: Ship it\n---\n\n# Deploy\n\nRun the script.\n",
        )
        .unwrap();

        let (msg, description) = build_invocation_message(&root, "deploy", "staging").unwrap();
        assert_eq!(description, "Ship it");
        assert!(
            msg.contains("You have invoked the \"deploy\" skill"),
            "{msg}"
        );
        assert!(msg.contains("# Deploy\n\nRun the script."), "body: {msg}");
        assert!(msg.contains("Skill directory:"), "folder announced: {msg}");
        assert!(msg.contains("User: staging"), "{msg}");

        // Unknown or disabled skills are rejected.
        assert!(build_invocation_message(&root, "nope", "").is_err());
        std::fs::write(
            root.join(".jan").join("agent").join("agent.toml"),
            "[skills]\nenabled = [\"other\"]\n",
        )
        .unwrap();
        assert!(
            build_invocation_message(&root, "deploy", "").is_err(),
            "disabled"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn catalog_enabled_whitelist_filters() {
        let root = std::env::temp_dir().join(format!(
            "jan_skills_wl_{}",
            std::time::SystemTime::UNIX_EPOCH
                .elapsed()
                .unwrap()
                .as_nanos()
        ));
        write(&root, "a", "body a").unwrap();
        write(&root, "b", "body b").unwrap();
        // Empty whitelist = all skills (both project skills + built-in jan).
        assert_eq!(catalog(&root, &[]).len(), 3);
        // Non-empty whitelist restricts to the listed names.
        let only_a = catalog(&root, &["a".to_string()]);
        assert_eq!(only_a.len(), 1);
        assert_eq!(only_a[0].name, "a");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_existing_flat_stays_flat() {
        let root = std::env::temp_dir().join(format!(
            "jan_skills_flat_{}",
            std::time::SystemTime::UNIX_EPOCH
                .elapsed()
                .unwrap()
                .as_nanos()
        ));
        let dir = skills_dir(&root);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("legacy.md"), "old").unwrap();

        write(&root, "legacy", "new").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("legacy.md")).unwrap(),
            "new"
        );
        assert!(!dir.join("legacy").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    fn temp_root(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "jan_pluginskills_{tag}_{}",
            std::time::SystemTime::UNIX_EPOCH
                .elapsed()
                .unwrap()
                .as_nanos()
        ))
    }

    /// A folder skill inside an installed plugin.
    fn plugin_skill(root: &std::path::Path, plugin: &str, name: &str, body: &str) {
        let dir = plugins_dir(root).join(plugin).join("skills").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), body).unwrap();
    }

    /// A single-skill plugin: `SKILL.md` at the plugin root.
    fn single_plugin(root: &std::path::Path, plugin: &str, body: &str) {
        let dir = plugins_dir(root).join(plugin);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), body).unwrap();
    }

    /// A project folder skill.
    fn project_skill(root: &std::path::Path, name: &str, body: &str) {
        let dir = skills_dir(root).join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), body).unwrap();
    }

    /// AH-121: the user's own skills are offered in every project, readable
    /// by name, and a project skill of the same name wins.
    #[test]
    fn user_skills_apply_in_every_project_and_a_project_skill_shadows_them() {
        let user = temp_root("user-scope");
        let user_dir = user.join("skills");
        for (name, body) in [
            ("house-style", "---\ndescription: How this user writes commit messages\n---\nUse the imperative.\n"),
            ("deploy", "---\ndescription: user deploy\n---\nuser deploy body\n"),
        ] {
            let d = user_dir.join(name);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("SKILL.md"), body).unwrap();
        }
        TEST_USER_SKILLS.with(|d| *d.borrow_mut() = Some(user.clone()));

        for tag in ["proj-a", "proj-b"] {
            let root = temp_root(tag);
            let names: Vec<String> = discover_all(&root).iter().map(qualified_name).collect();
            assert!(
                names.contains(&"house-style".to_string()),
                "{tag}: {names:?}"
            );
            assert!(read_raw(&root, "house-style")
                .unwrap()
                .contains("Use the imperative."));
            let listed = catalog(&root, &[]);
            let meta = listed
                .iter()
                .find(|m| m.name == "house-style")
                .expect("in the catalog");
            assert_eq!(meta.description, "How this user writes commit messages");
        }

        // A project skill with the same name shadows the user's.
        let root = temp_root("proj-shadow");
        project_skill(
            &root,
            "deploy",
            "---\ndescription: project deploy\n---\nproject deploy body\n",
        );
        let deploys: Vec<SkillEntry> = discover_all(&root)
            .into_iter()
            .filter(|e| e.name == "deploy")
            .collect();
        assert_eq!(deploys.len(), 1, "one deploy, not both");
        assert!(read_raw(&root, "deploy")
            .unwrap()
            .contains("project deploy body"));

        // The enabled whitelist still applies to user skills.
        assert!(catalog(&root, &["deploy".to_string()])
            .iter()
            .all(|m| m.name != "house-style"));

        TEST_USER_SKILLS.with(|d| *d.borrow_mut() = None);
        let root = temp_root("proj-none");
        assert!(discover_all(&root).iter().all(|e| e.name != "house-style"));
        assert!(read_raw(&root, "house-style").is_err());
    }

    #[test]
    fn discover_all_tags_plugin_skills_and_single_skill_plugins() {
        let root = temp_root("disc");
        project_skill(&root, "deploy", "---\ndescription: d\n---\nproj body\n");
        plugin_skill(
            &root,
            "release",
            "prepare",
            "---\ndescription: prep\n---\nrel body\n",
        );
        plugin_skill(&root, "release", "changelog", "flat body");
        single_plugin(
            &root,
            "triage",
            "---\ndescription: triage\n---\ntriage body\n",
        );

        let entries = discover_all(&root);
        let names: Vec<(String, Option<String>)> = entries
            .iter()
            .map(|e| (qualified_name(e), e.plugin.clone()))
            .collect();
        assert_eq!(
            names,
            vec![
                ("deploy".to_string(), None),
                ("release:changelog".to_string(), Some("release".to_string())),
                ("release:prepare".to_string(), Some("release".to_string())),
                ("triage:triage".to_string(), Some("triage".to_string())),
            ]
        );
        // Project-only discovery stays project-only.
        let project_names: Vec<_> = discover(&root).into_iter().map(|e| e.name).collect();
        assert_eq!(project_names, vec!["deploy"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn discover_plugins_skips_installing_staging_dirs() {
        let root = temp_root("stag");
        // A completed plugin is discoverable.
        plugin_skill(&root, "release", "prepare", "flat body");
        // An interrupted install stage must not leak its skills.
        let staging = plugins_dir(&root).join(".installing-12345");
        std::fs::create_dir_all(staging.join("skills").join("half")).unwrap();
        std::fs::write(
            staging.join("skills").join("half").join("SKILL.md"),
            "partial",
        )
        .unwrap();

        let entries = discover_plugins(&root);
        let names: Vec<String> = entries.iter().map(qualified_name).collect();
        assert_eq!(names, vec!["release:prepare"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_readable_project_shadows_plugin_and_qualified_form_wins() {
        let root = temp_root("prec");
        project_skill(&root, "deploy", "proj\n");
        plugin_skill(&root, "release", "deploy", "plugin\n");

        // Plain name resolves to the project skill (project shadows plugins).
        let entry = resolve_readable(&root, "deploy").unwrap();
        assert_eq!(entry.plugin, None);
        // Explicit qualified form reaches the plugin copy.
        let entry = resolve_readable(&root, "release:deploy").unwrap();
        assert_eq!(entry.plugin.as_deref(), Some("release"));
        assert_eq!(entry.name, "deploy");
        assert!(entry.is_folder);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_readable_unique_plain_name_and_ambiguity() {
        let root = temp_root("ambig");
        plugin_skill(&root, "release", "prepare", "rel\n");
        plugin_skill(&root, "triage", "prepare", "tri\n");
        plugin_skill(&root, "triage", "labels", "lab\n");

        // Duplicated plain name across plugins is ambiguous.
        let err = resolve_readable(&root, "prepare").unwrap_err();
        assert!(err.contains("not found"), "{err}");
        // Qualified forms both work.
        assert!(resolve_readable(&root, "release:prepare").is_ok());
        assert!(resolve_readable(&root, "triage:prepare").is_ok());
        // A plain name unique across plugins resolves.
        let entry = resolve_readable(&root, "labels").unwrap();
        assert_eq!(entry.plugin.as_deref(), Some("triage"));
        // Single-skill plugin: the plugin name itself resolves.
        single_plugin(&root, "triage", "---\ndescription: t\n---\nbody\n");
        let entry = resolve_readable(&root, "triage").unwrap();
        assert_eq!(entry.plugin.as_deref(), Some("triage"));
        assert_eq!(entry.name, "triage");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn catalog_and_user_catalog_include_plugin_skills_with_flags() {
        let root = temp_root("cat");
        project_skill(&root, "deploy", "---\ndescription: ship\n---\nbody\n");
        plugin_skill(
            &root,
            "release",
            "prepare",
            "---\ndescription: prep\n---\nbody\n",
        );
        // Model-only plugin skill: hidden from the user catalog, visible to the model.
        plugin_skill(
            &root,
            "release",
            "internals",
            "---\ndescription: impl\ndisable-model-invocation: false\nuser-invocable: false\n---\nbody\n",
        );
        // User-only plugin skill: hidden from the model catalog.
        plugin_skill(
            &root,
            "triage",
            "labels",
            "---\ndescription: lab\ndisable-model-invocation: true\n---\nbody\n",
        );

        let enabled: Vec<String> = Vec::new();
        let model: Vec<String> = catalog(&root, &enabled)
            .into_iter()
            .map(|m| m.name)
            .collect();
        assert!(model.contains(&"deploy".to_string()));
        assert!(model.contains(&"release:prepare".to_string()));
        assert!(model.contains(&"release:internals".to_string()));
        assert!(!model.contains(&"triage:labels".to_string()));

        let user: Vec<String> = user_catalog(&root, &enabled)
            .into_iter()
            .map(|m| m.name)
            .collect();
        assert!(user.contains(&"release:prepare".to_string()));
        assert!(user.contains(&"triage:labels".to_string()));
        assert!(!user.contains(&"release:internals".to_string()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn is_enabled_whitelist_matches_plugin_names() {
        let root = temp_root("en");
        project_skill(&root, "deploy", "body\n");
        plugin_skill(&root, "release", "prepare", "body\n");
        plugin_skill(&root, "release", "changelog", "body\n");

        let entries = discover_all(&root);
        // Plugin name alone enables every skill it ships.
        let enabled = vec!["release".to_string()];
        let active: Vec<_> = entries
            .iter()
            .filter(|e| is_enabled(&enabled, e))
            .map(qualified_name)
            .collect();
        assert_eq!(active, vec!["release:changelog", "release:prepare"]);
        // Qualified name enables a single skill.
        let enabled = vec!["release:prepare".to_string()];
        let active: Vec<_> = entries
            .iter()
            .filter(|e| is_enabled(&enabled, e))
            .map(qualified_name)
            .collect();
        assert_eq!(active, vec!["release:prepare"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn build_invocation_message_reaches_plugin_skills() {
        let root = temp_root("invoke");
        let plugin_dir = plugins_dir(&root).join("release");
        std::fs::create_dir_all(plugin_dir.join("skills").join("prepare")).unwrap();
        std::fs::write(
            plugin_dir.join("skills").join("prepare").join("SKILL.md"),
            "---\ndescription: Prep the release\n---\n\nRun the release steps.\n",
        )
        .unwrap();
        std::fs::write(plugin_dir.join("assets.txt"), "bundled").unwrap();

        let (msg, description) =
            build_invocation_message(&root, "release:prepare", "staging").unwrap();
        assert_eq!(description, "Prep the release");
        assert!(msg.contains("Run the release steps."));
        assert!(msg.contains("User: staging"));
        // The announced base directory is the plugin skill folder, so bundled
        // files resolve.
        let expected_dir = plugin_dir.join("skills").join("prepare");
        assert!(
            msg.contains(&format!("[Skill directory: {}]", expected_dir.display())),
            "{msg}"
        );

        // Short plain form works when unambiguous.
        let (msg, _) = build_invocation_message(&root, "prepare", "").unwrap();
        assert!(msg.contains("Run the release steps."));
        // Unknown skill errors.
        assert!(build_invocation_message(&root, "nope", "").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The CLI catalog (this crate reading agent.toml with `load_agent_config`)
    /// and the desktop skill tools (the tool crate reading the same file with
    /// its own two-key reader) must offer the model the same skills and refuse
    /// the same reads, across disabled plugins and every whitelist shape.
    #[test]
    fn plugin_rules_match_the_tool_crate() {
        let root = temp_root("parity");
        project_skill(&root, "deploy", "---\ndescription: ship\n---\nbody\n");
        plugin_skill(
            &root,
            "release",
            "prepare",
            "---\ndescription: prep\n---\nbody\n",
        );
        plugin_skill(&root, "release", "changelog", "log body\n");
        plugin_skill(&root, "muted", "hush", "muted body\n");
        single_plugin(&root, "triage", "---\ndescription: t\n---\nbody\n");
        std::fs::write(
            root.join(".jan/agent/agent.toml"),
            "[plugins]\ndisabled = [\"muted\"]\n",
        )
        .unwrap();
        let store = project_store(&root);

        let whitelists: [&[&str]; 6] = [
            &[],
            &["release"],
            &["release:prepare", "deploy"],
            &["changelog"],
            &["triage", "jan"],
            &[""],
        ];
        for wl in whitelists {
            let enabled: Vec<String> = wl.iter().map(|s| s.to_string()).collect();
            let cli: Vec<String> = catalog(&root, &enabled)
                .into_iter()
                .map(|m| m.name)
                .collect();
            let tools: Vec<String> = tool_skills::catalog(&store, &enabled)
                .into_iter()
                .map(|m| m.name)
                .collect();
            assert_eq!(cli, tools, "catalog differs for whitelist {wl:?}");
            for name in [
                "deploy",
                "release:prepare",
                "prepare",
                "changelog",
                "triage",
                "muted:hush",
                "hush",
            ] {
                let cli_ok = resolve_readable(&root, name)
                    .map(|e| is_enabled(&enabled, &e))
                    .unwrap_or(false);
                let tools_ok = tool_skills::read_for_model(None, &store, &enabled, name).is_ok();
                assert_eq!(cli_ok, tools_ok, "readability of {name} differs for {wl:?}");
            }
        }
        assert_eq!(
            crate::core::agent::project::disabled_plugins(&root),
            tool_skills::load_config(&store).disabled_plugins
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn discover_user_plugins_are_tagged_and_shadowed_by_project() {
        let data = tempfile::tempdir().unwrap();
        let store = tauri_plugin_agent_tools::workspace::permanent_store(data.path());
        let gdir = tauri_plugin_agent_tools::skills::plugins_dir(&store).join("caveman");
        std::fs::create_dir_all(gdir.join("skills")).unwrap();
        std::fs::write(
            gdir.join("skills").join("SKILL.md"),
            "---\ndescription: g\n---\nbody",
        )
        .unwrap();
        set_test_user_plugins(Some(store));

        let project: Vec<SkillEntry> = Vec::new();
        let got = discover_user_plugins(&project);
        assert!(
            got.iter().any(|e| e.plugin.as_deref() == Some("caveman")),
            "global plugin skill not discovered: {got:?}"
        );
    }
}
