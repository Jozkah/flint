//! Skill storage under `<store_root>/skills/`. A skill is either a folder
//! `<name>/SKILL.md` (SKILL.md-ecosystem compatible; may bundle
//! scripts/resources alongside) or a legacy flat `<name>.md`. Both may carry
//! leading YAML frontmatter (`name`, `description`); the folder form is what
//! new/imported skills are written as.
//!
//! Like memory, every function takes a store root, so skills live in the
//! desktop's permanent store or a project's co-located one. A skill is a
//! reusable procedure, so it must outlive the ephemeral per-thread sandbox.
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
//!
//! # Plugin skills
//!
//! A store may also hold installed plugins under `<store_root>/plugins/<id>/`.
//! Their skills are discovered here -- not in the app crate -- so the desktop's
//! skill tools, the management commands and the CLI all apply one set of rules:
//!
//! - each plugin contributes `skills/` (folder and flat forms, same rules as
//!   store skills) plus an optional single `SKILL.md` at the plugin root;
//! - plugin skills are named `<plugin>:<skill>` and carry their plugin id;
//! - a plugin listed in `[plugins].disabled` of `<store_root>/agent.toml`
//!   contributes nothing: not listed, not in any catalog, not readable by name;
//! - the `[skills].enabled` whitelist matches the qualified name, the plain
//!   skill name, or the plugin id alone;
//! - plugin skills are read-only: writes and deletes addressed to a qualified
//!   name are refused, because the plugin's own source is where edits belong;
//! - a store skill shadows a plugin skill of the same plain name.
//!
//! The app crate (`core::agent::skills`) delegates its plugin discovery to the
//! functions below, so the CLI prompt catalog and these tools cannot drift.
//! Reading `agent.toml` here is read-only and limited to those two keys; the
//! file's format and every write to it stay with the app crate.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::workspace::{store_dir, workspace_filename};

const KIND: &str = "skills";
const PLUGINS: &str = "plugins";

/// `<store_root>/skills`.
pub fn skills_dir(store: &Path) -> PathBuf {
    store_dir(store, KIND)
}

/// `<store_root>/plugins`: where a project's installed plugins live.
pub fn plugins_dir(store: &Path) -> PathBuf {
    store_dir(store, PLUGINS)
}

/// One skill on disk, located by its identity name (folder name or flat stem).
#[derive(Debug, Clone)]
pub struct SkillEntry {
    pub name: String,
    /// The markdown file to read (the `SKILL.md`, or the flat `<name>.md`).
    pub file: PathBuf,
    /// True for the folder form `<name>/SKILL.md`, false for legacy flat.
    pub is_folder: bool,
    /// The plugin this skill ships in (`Some`), or `None` for a store skill.
    pub plugin: Option<String>,
}

/// Summary for the management UI / prompt catalog.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SkillMeta {
    /// `name` for a store skill, `<plugin>:<skill>` for a plugin skill.
    pub name: String,
    pub description: String,
    /// The plugin this skill ships in. Absent for a store skill, so existing
    /// consumers of the JSON shape see no change.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin: Option<String>,
    /// Offered in the user-facing invoke surface (slash popup, `/skill:`).
    pub user_invocable: bool,
    /// Offered to the model (system-prompt catalog, `skill_list`/`skill_read`).
    pub model_invocable: bool,
    /// The tools this skill says it needs (AH-040). Empty means it did not
    /// say, which is not the same as "none": an unsaid requirement is checked
    /// at the gate when the call is made, like any other call.
    #[serde(default)]
    pub needs: Vec<String>,
    /// The version the skill declares (AH-123), exactly as written. `None`
    /// means it declares none, which is not version zero: a skill that has
    /// never said what it is cannot satisfy a constraint on it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// The two `agent.toml` keys skill discovery depends on.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SkillConfig {
    /// `[skills].enabled`; empty means every skill.
    pub enabled: Vec<String>,
    /// `[plugins].disabled`; plugins that contribute nothing.
    pub disabled_plugins: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
struct SkillConfigToml {
    #[serde(default)]
    skills: SkillsSectionToml,
    #[serde(default)]
    plugins: PluginsSectionToml,
}

#[derive(Debug, Default, Deserialize)]
struct SkillsSectionToml {
    #[serde(default)]
    enabled: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
struct PluginsSectionToml {
    #[serde(default)]
    disabled: Vec<String>,
}

/// Read `[skills].enabled` and `[plugins].disabled` from `<store>/agent.toml`.
///
/// A missing or unparseable file yields the defaults, the same fallback the
/// app crate's `load_agent_config(..).unwrap_or_default()` uses, so both sides
/// answer "what is in force" identically.
pub fn load_config(store: &Path) -> SkillConfig {
    let Ok(raw) = std::fs::read_to_string(store.join("agent.toml")) else {
        return SkillConfig::default();
    };
    match toml::from_str::<SkillConfigToml>(&raw) {
        Ok(parsed) => SkillConfig {
            enabled: parsed.skills.enabled,
            disabled_plugins: parsed.plugins.disabled,
        },
        Err(_) => SkillConfig::default(),
    }
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
    /// AH-040. The tools a skill's instructions actually require, by the
    /// convention Claude Code uses. Declaring them lets the harness withhold a
    /// skill this run could never carry out, rather than handing over
    /// instructions whose every step will be refused.
    ///
    /// It is a *ceiling claim*, never a grant: a skill that names `bash` in a
    /// run where `bash` is denied is withheld; a skill can never make a denied
    /// tool callable.
    #[serde(rename = "allowed-tools")]
    allowed_tools: Option<Vec<String>>,
    /// AH-123. What this skill calls itself, so another skill can say which
    /// version of it it was written against.
    version: Option<serde_yaml::Value>,
    /// AH-124. The skills this one's instructions depend on, optionally with
    /// a version bound: `requires: ["formatting", "deploy >=2.1"]`.
    requires: Option<Vec<String>>,
}

/// A declared version (AH-123): three numbers, and whatever the author wrote.
///
/// Deliberately a small subset of semver. Ordering is by the numbers alone; a
/// pre-release or build suffix is kept as written and carried into every
/// message, but never used to decide an order, because guessing at an ordering
/// nobody declared is how a constraint comes to be judged wrongly.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct SkillVersion {
    numbers: (u64, u64, u64),
}

impl std::fmt::Display for SkillVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (a, b, c) = self.numbers;
        write!(f, "{a}.{b}.{c}")
    }
}

/// Read a declared version. `1`, `1.2` and `1.2.3` are all versions; the
/// missing parts are zero, as every version scheme that omits them means.
/// Anything else -- a word, an empty string, a negative number, a part that is
/// not a number -- is not a version, and is refused rather than guessed at.
pub fn parse_version(text: &str) -> Option<SkillVersion> {
    let core = text.trim().trim_start_matches('v');
    let core = core.split(['-', '+']).next().unwrap_or("").trim();
    if core.is_empty() {
        return None;
    }
    let mut parts = core.split('.');
    let mut numbers = [0u64; 3];
    for slot in numbers.iter_mut() {
        match parts.next() {
            None => break,
            Some(part) => *slot = part.trim().parse::<u64>().ok()?,
        }
    }
    // `1.2.3.4` is not a version this understands, and pretending the fourth
    // number is not there would silently accept two different skills as one.
    if parts.next().is_some() {
        return None;
    }
    Some(SkillVersion {
        numbers: (numbers[0], numbers[1], numbers[2]),
    })
}

/// How a requirement bounds the version it names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bound {
    AtLeast,
    Above,
    AtMost,
    Below,
    Exactly,
}

impl Bound {
    fn symbol(self) -> &'static str {
        match self {
            Bound::AtLeast => ">=",
            Bound::Above => ">",
            Bound::AtMost => "<=",
            Bound::Below => "<",
            Bound::Exactly => "==",
        }
    }

    fn holds(self, found: &SkillVersion, wanted: &SkillVersion) -> bool {
        match self {
            Bound::AtLeast => found >= wanted,
            Bound::Above => found > wanted,
            Bound::AtMost => found <= wanted,
            Bound::Below => found < wanted,
            Bound::Exactly => found == wanted,
        }
    }
}

/// One `requires:` entry (AH-124): a skill name, and what it must be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillRequirement {
    pub skill: String,
    /// `None` means the requirement is only that the skill be there at all.
    pub bound: Option<(Bound, SkillVersion)>,
    /// What the author wrote, for the message that names the failure.
    pub raw: String,
}

/// Read one `requires:` entry. `deploy`, `deploy >=2.1`, `deploy>=2.1` and
/// `deploy 2.1` (an exact version, the way a lockfile writes one) are all
/// understood. An entry naming no skill, or a bound whose version cannot be
/// read, is not a requirement that can be judged -- it is returned as a
/// requirement on a skill that cannot exist, so loading fails closed rather
/// than silently ignoring a line the author meant as a constraint.
pub fn parse_requirement(entry: &str) -> Option<SkillRequirement> {
    let raw = entry.trim().to_string();
    if raw.is_empty() {
        return None;
    }
    let ops = [
        (">=", Bound::AtLeast),
        ("<=", Bound::AtMost),
        ("==", Bound::Exactly),
        (">", Bound::Above),
        ("<", Bound::Below),
        ("=", Bound::Exactly),
    ];
    for (symbol, bound) in ops {
        if let Some((name, version)) = raw.split_once(symbol) {
            let skill = name.trim().to_string();
            if skill.is_empty() {
                return None;
            }
            return Some(SkillRequirement {
                bound: parse_version(version).map(|v| (bound, v)),
                skill,
                // A bound that could not be read is kept in `raw`, and judged
                // as unmet: `None` here would quietly widen the requirement to
                // "any version at all".
                raw,
            });
        }
    }
    let mut words = raw.split_whitespace();
    let skill = words.next()?.to_string();
    match words.next() {
        None => Some(SkillRequirement {
            skill,
            bound: None,
            raw,
        }),
        Some(version) => Some(SkillRequirement {
            bound: parse_version(version).map(|v| (Bound::Exactly, v)),
            skill,
            raw,
        }),
    }
}

/// Whether a requirement is one this build can judge at all: an unreadable
/// bound is a requirement whose answer is unknown, and unknown fails closed.
fn bound_is_readable(requirement: &SkillRequirement) -> bool {
    requirement.bound.is_some() || !requirement.raw.contains(|c: char| c.is_ascii_digit())
}

/// A skill's parsed content: optional frontmatter description + markdown body
/// (body has the frontmatter fence stripped so it never leaks into the prompt).
pub struct ParsedSkill {
    pub description: Option<String>,
    pub body: String,
    pub user_invocable: bool,
    pub model_invocable: bool,
    /// The tools the skill declared it needs (AH-040), lowercased and trimmed.
    pub needs: Vec<String>,
    /// The version the skill declares (AH-123), as written. `None` is "said
    /// nothing", never "0".
    pub version: Option<String>,
    /// The skills this one depends on (AH-124).
    pub requires: Vec<SkillRequirement>,
}

/// Split leading `---\n...\n---` YAML frontmatter from the markdown body.
/// Tolerant: no opening/closing fence -> no frontmatter, whole input is body.
pub fn parse(content: &str) -> ParsedSkill {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut lines = content.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return ParsedSkill {
            description: None,
            body: content.to_string(),
            user_invocable: true,
            model_invocable: true,
            needs: Vec::new(),
            version: None,
            requires: Vec::new(),
        };
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
        // Unterminated fence: treat the whole file as body (no frontmatter).
        return ParsedSkill {
            description: None,
            body: content.to_string(),
            user_invocable: true,
            model_invocable: true,
            needs: Vec::new(),
            version: None,
            requires: Vec::new(),
        };
    }
    let fm = serde_yaml::from_str::<Frontmatter>(&yaml).unwrap_or_default();
    ParsedSkill {
        description: fm.description.map(|d| d.trim().to_string()),
        body: body.join("\n").trim_start_matches('\n').to_string(),
        user_invocable: fm.user_invocable.unwrap_or(true),
        model_invocable: !fm.disable_model_invocation.unwrap_or(false),
        needs: fm
            .allowed_tools
            .unwrap_or_default()
            .into_iter()
            .map(|t| t.trim().to_ascii_lowercase())
            .filter(|t| !t.is_empty())
            .collect(),
        // Taken as written. A version is read as YAML, where `1.2` is a
        // number and `1.2.3` is a string, and rendering the number back is
        // what keeps `version: 1.2` from arriving as nothing at all.
        version: fm
            .version
            .and_then(|v| match v {
                serde_yaml::Value::String(s) => Some(s),
                serde_yaml::Value::Number(n) => Some(n.to_string()),
                _ => None,
            })
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        requires: fm
            .requires
            .unwrap_or_default()
            .iter()
            .filter_map(|entry| parse_requirement(entry))
            .collect(),
    }
}

/// What a skill declares that this run cannot supply (AH-123, AH-124).
///
/// Empty means the skill can be loaded. Each entry is a sentence naming one
/// unmet requirement, for the refusal the caller returns; they are written to
/// be read by whoever has to fix the skill, so they say what was found as well
/// as what was wanted.
///
/// `lookup` answers with a skill's raw text, or `None` when it is not
/// installed here -- the caller owns resolution, because the project store,
/// the user's store and the plugins are its business, not this function's.
///
/// `known_tools` is every tool this run could call, when the caller knows:
/// `None` skips the check rather than guessing that an unrecognised name is
/// absent. A tool that exists but is denied is AH-040's business
/// ([`unusable_tools`]), and is not repeated here.
pub fn unmet_requirements(
    name: &str,
    parsed: &ParsedSkill,
    lookup: &dyn Fn(&str) -> Option<String>,
    known_tools: Option<&[String]>,
) -> Vec<String> {
    let mut unmet = Vec::new();
    if let Some(known) = known_tools {
        for tool in &parsed.needs {
            if !known.iter().any(|k| k.eq_ignore_ascii_case(tool)) {
                unmet.push(format!(
                    "'{name}' needs the tool '{tool}', which this run does not have"
                ));
            }
        }
    }
    // A dependency may depend on something in turn, and a pair of skills may
    // name each other. Both are ordinary; neither may loop.
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    seen.insert(name.to_string());
    let mut queue: Vec<(String, SkillRequirement)> = parsed
        .requires
        .iter()
        .map(|r| (name.to_string(), r.clone()))
        .collect();
    while let Some((dependent, requirement)) = queue.pop() {
        if !bound_is_readable(&requirement) {
            unmet.push(format!(
                "'{dependent}' requires \"{}\", whose version is not one this understands \
                 (expected forms: 1, 1.2, 1.2.3)",
                requirement.raw
            ));
            continue;
        }
        let Some(raw) = lookup(&requirement.skill) else {
            unmet.push(format!(
                "'{dependent}' requires the skill '{}', which is not installed",
                requirement.skill
            ));
            continue;
        };
        let required = parse(&raw);
        if let Some((bound, wanted)) = &requirement.bound {
            match required.version.as_deref().and_then(parse_version) {
                Some(found) if bound.holds(&found, wanted) => {}
                Some(found) => unmet.push(format!(
                    "'{dependent}' requires '{}' {} {wanted}, and the installed one is {found}",
                    requirement.skill,
                    bound.symbol()
                )),
                None => unmet.push(format!(
                    "'{dependent}' requires '{}' {} {wanted}, and the installed one declares no \
                     version",
                    requirement.skill,
                    bound.symbol()
                )),
            }
        }
        if seen.insert(requirement.skill.clone()) {
            queue.extend(
                required
                    .requires
                    .iter()
                    .map(|r| (requirement.skill.clone(), r.clone())),
            );
        }
    }
    unmet.sort();
    unmet.dedup();
    unmet
}

/// Which of a skill's declared tools this run may not use (AH-040).
///
/// Empty when the skill can be carried out here. The check is one-directional
/// on purpose: it can withhold a skill, and it can never make a denied tool
/// callable.
pub fn unusable_tools(
    needs: &[String],
    permissions: &crate::permissions::ToolPermissions,
    subject: &crate::subject::Subject,
) -> Vec<String> {
    needs
        .iter()
        .filter(|tool| permissions.is_denied(tool, subject))
        .cloned()
        .collect()
}

/// First non-empty, non-heading line of `body`, capped at 120 chars. Fallback
/// description when a skill has no frontmatter `description`.
fn first_line(body: &str) -> String {
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
pub fn safe_stem(name: &str) -> Result<String, String> {
    let file = workspace_filename(name)?;
    Ok(file.trim_end_matches(".md").to_string())
}

/// All skills in the store's own `skills/` directory, sorted by name. Plugin
/// skills are not included; see [`discover_all`].
pub fn discover(store: &Path) -> Vec<SkillEntry> {
    scan_skill_dir(&skills_dir(store))
}

/// Scan one skills directory, sorted by name. Folder skills (`<name>/SKILL.md`)
/// and legacy flat skills (`<name>.md`) are both discovered. When both forms
/// share a name, the folder form wins so a skill is never listed/injected twice.
/// Entries come back with `plugin: None`; callers tag plugin-owned entries.
pub fn scan_skill_dir(dir: &Path) -> Vec<SkillEntry> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    // Keyed by name so a duplicate stem collapses to one entry; BTreeMap also
    // gives the sorted-by-name order for free.
    let mut by_name: std::collections::BTreeMap<String, SkillEntry> =
        std::collections::BTreeMap::new();
    let mut consider = |entry: SkillEntry| {
        match by_name.get(&entry.name) {
            // Keep an existing folder entry over an incoming flat one.
            Some(existing) if existing.is_folder && !entry.is_folder => {}
            _ => {
                by_name.insert(entry.name.clone(), entry);
            }
        }
    };
    for entry in rd.flatten() {
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            let skill_md = path.join("SKILL.md");
            if skill_md.is_file() {
                if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                    consider(SkillEntry {
                        name: name.to_string(),
                        file: skill_md,
                        is_folder: true,
                        plugin: None,
                    });
                }
            }
        } else if path.extension().and_then(|x| x.to_str()) == Some("md") {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                consider(SkillEntry {
                    name: stem.to_string(),
                    file: path,
                    is_folder: false,
                    plugin: None,
                });
            }
        }
    }
    let mut out: Vec<SkillEntry> = by_name.into_values().collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Skills shipped by the plugins installed in `store`, qualified with their
/// plugin id and sorted by qualified name. Plugins named in `disabled` are
/// skipped, as are interrupted `.installing-*` staging directories.
pub fn discover_plugins(store: &Path, disabled: &[String]) -> Vec<SkillEntry> {
    let Ok(rd) = std::fs::read_dir(plugins_dir(store)) else {
        return Vec::new();
    };
    let mut out: Vec<SkillEntry> = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let Some(plugin) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        // A partially-copied plugin must not leak its skills during an install.
        if plugin.starts_with(".installing-") {
            continue;
        }
        if disabled.iter().any(|d| d == plugin) {
            continue;
        }
        for e in scan_skill_dir(&path.join(KIND)) {
            out.push(SkillEntry {
                plugin: Some(plugin.to_string()),
                ..e
            });
        }
        let root_md = path.join("SKILL.md");
        if root_md.is_file() {
            out.push(SkillEntry {
                name: plugin.to_string(),
                file: root_md,
                is_folder: false,
                plugin: Some(plugin.to_string()),
            });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Store skills followed by the skills of every enabled installed plugin, with
/// `[plugins].disabled` read from the store's own `agent.toml`.
pub fn discover_all(store: &Path) -> Vec<SkillEntry> {
    let disabled = load_config(store).disabled_plugins;
    let mut out = discover(store);
    out.extend(discover_plugins(store, &disabled));
    out
}

/// The user-facing identity of a skill entry: `name` for store skills,
/// `<plugin>:<name>` for plugin skills.
pub fn qualified_name(entry: &SkillEntry) -> String {
    match &entry.plugin {
        Some(plugin) => format!("{plugin}:{}", entry.name),
        None => entry.name.clone(),
    }
}

/// Locate a store skill by name, preferring the folder form. Plugin skills are
/// not resolved here; [`resolve_readable`] handles those.
pub fn resolve_store_skill(store: &Path, name: &str) -> Result<SkillEntry, String> {
    let stem = safe_stem(name)?;
    let dir = skills_dir(store);
    let folder = dir.join(&stem).join("SKILL.md");
    if folder.is_file() {
        return Ok(SkillEntry {
            name: stem,
            file: folder,
            is_folder: true,
            plugin: None,
        });
    }
    let flat = dir.join(format!("{stem}.md"));
    if flat.is_file() {
        return Ok(SkillEntry {
            name: stem,
            file: flat,
            is_folder: false,
            plugin: None,
        });
    }
    Err(format!("ERROR: skill '{name}' not found"))
}

/// Locate a skill inside one installed plugin: `plugins/<plugin>/skills/<plain>`
/// (folder or flat), plus `<plugin>/SKILL.md` when `plain == plugin`. Both names
/// are stem-validated so a caller-supplied name can never escape the plugins
/// directory, and a disabled plugin resolves to nothing.
pub fn resolve_in_plugin(
    store: &Path,
    plugin: &str,
    plain: &str,
    disabled: &[String],
) -> Option<SkillEntry> {
    if safe_stem(plugin).ok()? != plugin || safe_stem(plain).ok()? != plain {
        return None;
    }
    if plugin.starts_with(".installing-") || disabled.iter().any(|d| d == plugin) {
        return None;
    }
    let base = plugins_dir(store).join(plugin);
    let tagged = |file: PathBuf, is_folder: bool| SkillEntry {
        name: plain.to_string(),
        file,
        is_folder,
        plugin: Some(plugin.to_string()),
    };
    let folder = base.join(KIND).join(plain).join("SKILL.md");
    if folder.is_file() {
        return Some(tagged(folder, true));
    }
    let flat = base.join(KIND).join(format!("{plain}.md"));
    if flat.is_file() {
        return Some(tagged(flat, false));
    }
    if plain == plugin {
        let root_md = base.join("SKILL.md");
        if root_md.is_file() {
            return Some(tagged(root_md, false));
        }
    }
    None
}

/// Locate any readable skill: a store skill first (store shadows plugins), then
/// the explicit `<plugin>:<plain>` form, then a plain name unique across the
/// enabled plugins. Disabled plugins are invisible to every step.
pub fn resolve_readable(
    store: &Path,
    name: &str,
    disabled: &[String],
) -> Result<SkillEntry, String> {
    if let Ok(entry) = resolve_store_skill(store, name) {
        return Ok(entry);
    }
    if let Some((plugin, plain)) = name.split_once(':') {
        if let Some(entry) = resolve_in_plugin(store, plugin, plain, disabled) {
            return Ok(entry);
        }
    }
    let mut matches = discover_plugins(store, disabled)
        .into_iter()
        .filter(|e| e.name == name);
    match (matches.next(), matches.next()) {
        (Some(only), None) => Ok(only),
        _ => Err(format!("ERROR: skill '{name}' not found")),
    }
}

/// Whether a skill *name* passes the `[skills].enabled` whitelist, for names
/// that have no entry yet (a write creating a new store skill, the built-in
/// Jan skill). An empty whitelist means every skill is enabled.
pub fn is_enabled(enabled: &[String], name: &str) -> bool {
    enabled.is_empty() || enabled.iter().any(|n| n == name)
}

/// Whether a discovered skill passes the `[skills].enabled` whitelist. Matches
/// the qualified `<plugin>:<skill>` name, the plain skill name, or the plugin
/// id alone (which enables every skill that plugin ships).
pub fn entry_enabled(enabled: &[String], entry: &SkillEntry) -> bool {
    if enabled.is_empty() {
        return true;
    }
    let qualified = qualified_name(entry);
    enabled
        .iter()
        .any(|n| n == &qualified || n == &entry.name || Some(n) == entry.plugin.as_ref())
}

/// Plugin skills are edited in the plugin's own source, never through the
/// store's skill CRUD: a qualified name is refused before any path is built.
fn refuse_plugin_name(name: &str) -> Result<(), String> {
    match name.trim().split_once(':') {
        Some((plugin, _)) => Err(format!(
            "ERROR: skill '{name}' is provided by plugin '{plugin}' and is read-only. \
             Edit it in the plugin's source and reinstall the plugin."
        )),
        None => Ok(()),
    }
}

/// A skill's summary line: the frontmatter `description`, or the first body line.
fn describe(parsed: &ParsedSkill) -> String {
    parsed
        .description
        .clone()
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| first_line(&parsed.body))
}

/// The built-in Jan skill's identity and embedded body: always resolvable
/// (catalog entry + `skill_read`/`/skill:jan` body) even with zero project
/// skills installed, but never force-loaded -- it costs a description line
/// in the catalog like any other skill, and the model/human still has to
/// invoke it to load the body. `core::agent::skills` mirrors this injection
/// for the system-prompt catalog and `/skill:` dispatch, which resolve
/// project + plugin skills but never see this plugin-embedded one.
pub const DEFAULT_JAN_SKILL_NAME: &str = "flint";
/// Legacy name for the built-in skill, still recognised so existing references
/// (agent.toml entries, `/skill:jan`) keep resolving after the Flint rebrand.
pub const LEGACY_DEFAULT_SKILL_NAME: &str = "jan";
pub const DEFAULT_JAN_SKILL: &str = include_str!("default_jan_skill.md");

/// Whether a name refers to the built-in Flint skill (primary `flint`, legacy
/// alias `jan`), which is always available even with no project skills installed.
fn is_default_jan_skill(name: &str) -> bool {
    matches!(
        safe_stem(name).ok().as_deref(),
        Some(DEFAULT_JAN_SKILL_NAME) | Some(LEGACY_DEFAULT_SKILL_NAME)
    )
}
fn default_jan_skill_meta() -> SkillMeta {
    let parsed = parse(DEFAULT_JAN_SKILL);
    SkillMeta {
        name: DEFAULT_JAN_SKILL_NAME.to_string(),
        description: describe(&parsed),
        plugin: None,
        // The built-in Jan skill is available on both invocation sides: dev's
        // baseline ships it as the model-facing onboarding skill (listed in
        // `skill_list`, body loaded via `skill_read`), and the user may also
        // invoke it directly.
        user_invocable: true,
        model_invocable: true,
        needs: parsed.needs.clone(),
        version: parsed.version.clone(),
    }
}

fn meta_for(entry: &SkillEntry, parsed: &ParsedSkill) -> SkillMeta {
    SkillMeta {
        name: qualified_name(entry),
        description: describe(parsed),
        plugin: entry.plugin.clone(),
        user_invocable: parsed.user_invocable,
        model_invocable: parsed.model_invocable,
        needs: parsed.needs.clone(),
        version: parsed.version.clone(),
    }
}

/// Metadata for every discovered skill (name + description + invocation
/// flags) — for the management UI, which must see disabled and private skills.
/// Keeps empty stubs so the user can see and edit them.
///
/// Includes the skills of enabled installed plugins, tagged with `plugin`; a
/// disabled or removed plugin's skills are absent.
pub fn list_meta(store: &Path) -> Vec<SkillMeta> {
    discover_all(store)
        .into_iter()
        .filter_map(|e| {
            let parsed = parse(&std::fs::read_to_string(&e.file).ok()?);
            Some(meta_for(&e, &parsed))
        })
        .collect()
}

/// Filter discovered skills (store + enabled plugins) by the `[skills].enabled`
/// whitelist and one invocation side. Skills with neither a description nor a
/// body are skipped (nothing to advertise or invoke).
fn side_catalog(
    root: &Path,
    enabled: &[String],
    side: impl Fn(&ParsedSkill) -> bool,
    include_default: bool,
) -> Vec<SkillMeta> {
    entries_catalog(discover_all(root), enabled, side, include_default)
}

/// [`side_catalog`] over an explicit list of entries (the user layer offers
/// only its native skills, not a whole store's plugins).
fn entries_catalog(
    entries: Vec<SkillEntry>,
    enabled: &[String],
    side: impl Fn(&ParsedSkill) -> bool,
    include_default: bool,
) -> Vec<SkillMeta> {
    let mut skills = entries
        .into_iter()
        .filter(|e| entry_enabled(enabled, e))
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
        .collect::<Vec<_>>();
    if include_default
        && (is_enabled(enabled, DEFAULT_JAN_SKILL_NAME)
            || is_enabled(enabled, LEGACY_DEFAULT_SKILL_NAME))
        && side(&parse(DEFAULT_JAN_SKILL))
        && !skills
            .iter()
            .any(|skill| skill.name == DEFAULT_JAN_SKILL_NAME)
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
///
/// The `skill_list` tool goes through [`catalog_for_model_with_user`].
pub fn catalog(root: &Path, enabled: &[String]) -> Vec<SkillMeta> {
    side_catalog(root, enabled, |p| p.model_invocable, true)
}

/// The user's own skills layer (AH-121): `user` unless it is the store itself
/// (the desktop, whose store is the user store), so nothing is offered twice.
fn user_layer<'a>(store: &Path, user: Option<&'a Path>) -> Option<&'a Path> {
    user.filter(|u| *u != store)
}

/// Raw SKILL.md text (frontmatter included) for the editor. Resolves store
/// skills, then enabled plugin skills (qualified, or a unique plain name).
pub fn read_raw(store: &Path, name: &str) -> Result<String, String> {
    if is_default_jan_skill(name) {
        return Ok(parse(DEFAULT_JAN_SKILL).body);
    }
    let disabled = load_config(store).disabled_plugins;
    let entry = resolve_readable(store, name, &disabled)?;
    std::fs::read_to_string(&entry.file).map_err(|e| format!("ERROR: {e}"))
}

/// [`read_raw`], falling back to the user's own skills when the store has
/// none of that name (AH-121). No whitelist: this answers "is it installed",
/// for dependency checks, not "may the model read it".
pub fn read_raw_with_user(store: &Path, user: Option<&Path>, name: &str) -> Result<String, String> {
    match read_raw(store, name) {
        Ok(raw) => Ok(raw),
        Err(missing) => match user_layer(store, user) {
            Some(user) => read_raw(user, name),
            None => Err(missing),
        },
    }
}

/// What one skill layer says about a name the model asked for.
enum LayerRead {
    /// Present, enabled and read.
    Found(String),
    /// Present but switched off here: the answer is "not found", and no later
    /// layer may supply a same-named substitute.
    Hidden,
    /// Not in this layer.
    Missing,
}

fn read_in_layer(store: &Path, enabled: &[String], name: &str) -> Result<LayerRead, String> {
    if is_default_jan_skill(name) {
        return Ok(if is_enabled(enabled, DEFAULT_JAN_SKILL_NAME) {
            LayerRead::Found(parse(DEFAULT_JAN_SKILL).body)
        } else {
            LayerRead::Hidden
        });
    }
    let disabled = load_config(store).disabled_plugins;
    let Ok(entry) = resolve_readable(store, name, &disabled) else {
        // A qualified name naming a plugin that exists but is disabled is
        // still "hidden", never something another layer may answer for.
        if let Some((plugin, _)) = name.split_once(':') {
            if plugins_dir(store).join(plugin).is_dir() {
                return Ok(LayerRead::Hidden);
            }
        }
        return Ok(LayerRead::Missing);
    };
    if !entry_enabled(enabled, &entry) {
        return Ok(LayerRead::Hidden);
    }
    std::fs::read_to_string(&entry.file)
        .map(LayerRead::Found)
        .map_err(|e| format!("ERROR: {e}"))
}

/// The user layer (AH-121) is the user's native skills only: a plain name
/// with a skill in the user store's `skills/`, under the caller's whitelist.
fn read_in_user_layer(user: &Path, enabled: &[String], name: &str) -> Result<LayerRead, String> {
    if name.contains(':') {
        return Ok(LayerRead::Missing);
    }
    let Ok(entry) = resolve_store_skill(user, name) else {
        return Ok(LayerRead::Missing);
    };
    if !entry_enabled(enabled, &entry) {
        return Ok(LayerRead::Hidden);
    }
    std::fs::read_to_string(&entry.file)
        .map(LayerRead::Found)
        .map_err(|e| format!("ERROR: {e}"))
}

/// Raw text of a skill the model may read, honouring the whitelist and the
/// disabled-plugin list, across up to two layers. See
/// [`read_for_model_with_user`], of which this is the no-user-store form.
pub fn read_for_model(
    project: Option<&Path>,
    store: &Path,
    enabled: &[String],
    name: &str,
) -> Result<String, String> {
    read_for_model_with_user(project, store, None, enabled, name)
}

/// Raw text of a skill the model may read, across three layers in precedence
/// order: project, store, user.
///
/// `project` is an attached project's store (`<folder>/.jan/agent`): its own
/// skills and its enabled plugins' skills, filtered by that project's
/// `[skills].enabled`, both read from its `agent.toml` here rather than taken
/// from the caller. `store` is the surface's own store with the caller's
/// `enabled` list. `user` is the user's own skills (AH-121), under the same
/// `enabled` list, consulted only for names neither higher layer knows. A name
/// a layer knows -- enabled or hidden -- never falls through, so a disabled
/// skill cannot be replaced by a same-named one from a lower layer, and a store
/// skill shadows a user skill of the same name.
pub fn read_for_model_with_user(
    project: Option<&Path>,
    store: &Path,
    user: Option<&Path>,
    enabled: &[String],
    name: &str,
) -> Result<String, String> {
    let not_found = || format!("ERROR: skill '{name}' not found");
    if let Some(project) = project {
        let config = load_config(project);
        match read_in_layer(project, &config.enabled, name)? {
            LayerRead::Found(raw) => return Ok(raw),
            LayerRead::Hidden => return Err(not_found()),
            LayerRead::Missing if name.contains(':') => return Err(not_found()),
            LayerRead::Missing => {}
        }
    }
    match read_in_layer(store, enabled, name)? {
        LayerRead::Found(raw) => return Ok(raw),
        LayerRead::Hidden => return Err(not_found()),
        LayerRead::Missing => {}
    }
    match user_layer(store, user) {
        Some(user) => match read_in_user_layer(user, enabled, name)? {
            LayerRead::Found(raw) => Ok(raw),
            LayerRead::Hidden | LayerRead::Missing => Err(not_found()),
        },
        None => Err(not_found()),
    }
}

/// The model-side catalog across the same two layers as [`read_for_model`].
pub fn catalog_for_model(
    project: Option<&Path>,
    store: &Path,
    enabled: &[String],
) -> Vec<SkillMeta> {
    catalog_for_model_with_user(project, store, None, enabled)
}

/// The model-side catalog across the same three layers as
/// [`read_for_model_with_user`]: the attached project's skills first (its own
/// whitelist, its enabled plugins), then the store's skills whose names the
/// project does not claim, then the user's own skills neither claims.
pub fn catalog_for_model_with_user(
    project: Option<&Path>,
    store: &Path,
    user: Option<&Path>,
    enabled: &[String],
) -> Vec<SkillMeta> {
    let mut out: Vec<SkillMeta> = Vec::new();
    // Every name a higher layer knows, enabled or not: a disabled skill must
    // not reappear from a lower layer under the same name. The built-in Jan
    // skill belongs to the first layer, which answers for it either way.
    let mut claimed: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut take = |metas: Vec<SkillMeta>, known: Vec<SkillEntry>, out: &mut Vec<SkillMeta>| {
        for meta in metas {
            if !claimed.contains(&meta.name) {
                out.push(meta);
            }
        }
        claimed.extend(out.iter().map(|m| m.name.clone()));
        claimed.extend(known.iter().map(qualified_name));
        claimed.insert(DEFAULT_JAN_SKILL_NAME.to_string());
    };
    if let Some(project) = project {
        let config = load_config(project);
        take(catalog(project, &config.enabled), discover_all(project), &mut out);
    }
    take(
        side_catalog(store, enabled, |p| p.model_invocable, project.is_none()),
        discover_all(store),
        &mut out,
    );
    if let Some(user) = user_layer(store, user) {
        take(
            entries_catalog(discover(user), enabled, |p| p.model_invocable, false),
            Vec::new(),
            &mut out,
        );
    }
    out
}

/// Why a model write to `name` must not land in `store` while `project` is
/// attached: the project already provides a skill by that name, so the write
/// would be shadowed and silently ignored on the next read.
pub fn project_claims(project: &Path, name: &str) -> bool {
    if is_default_jan_skill(name) {
        return false;
    }
    let disabled = load_config(project).disabled_plugins;
    resolve_readable(project, name, &disabled).is_ok()
}

/// A skill's markdown body with the frontmatter fence stripped — what the
/// `skill_read` tool hands the model when it loads a skill on demand.
pub fn read_body(store: &Path, name: &str) -> Result<String, String> {
    Ok(parse(&read_raw(store, name)?).body)
}

/// Create or overwrite a skill. Existing skills are written in place (preserving
/// their form); new skills are written as the folder form `<name>/SKILL.md`.
pub fn write(store: &Path, name: &str, content: &str) -> Result<(), String> {
    refuse_plugin_name(name)?;
    let stem = safe_stem(name)?;
    let dir = skills_dir(store);
    let folder = dir.join(&stem);
    let folder_skill = folder.join("SKILL.md");
    // Mirror `resolve`/`discover`: the folder form `<name>/SKILL.md` is the
    // canonical one and wins over a legacy flat `<name>.md`. When the folder
    // form is absent we fall back to the flat file if one exists; a fresh skill
    // is created as the folder form. So an edit always lands where the skill
    // will be read back from, instead of updating a stale flat file that
    // `resolve` ignores (which would silently swallow the edit).
    let flat = dir.join(format!("{stem}.md"));
    let target = if folder_skill.is_file() {
        folder_skill
    } else if flat.is_file() {
        flat
    } else {
        std::fs::create_dir_all(&folder).map_err(|e| format!("ERROR: {e}"))?;
        folder_skill
    };
    std::fs::write(&target, content).map_err(|e| format!("ERROR: {e}"))
}

/// Delete a skill (folder or flat form). Idempotent: a missing skill is Ok.
pub fn delete(store: &Path, name: &str) -> Result<(), String> {
    refuse_plugin_name(name)?;
    let stem = safe_stem(name)?;
    let dir = skills_dir(store);
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

    /// A store of skills, each installed by name with whatever frontmatter it
    /// declares. Named for this process and this moment so concurrent tests
    /// never read each other's skills.
    fn store_with(skills: &[(&str, &str)]) -> std::path::PathBuf {
        let store = std::env::temp_dir().join(format!(
            "jan_skill_requires_{}_{}",
            std::process::id(),
            std::time::SystemTime::UNIX_EPOCH
                .elapsed()
                .unwrap()
                .as_nanos()
        ));
        let root = skills_dir(&store);
        std::fs::create_dir_all(&root).expect("skills dir");
        for (name, content) in skills {
            let folder = root.join(name);
            std::fs::create_dir_all(&folder).expect("skill folder");
            std::fs::write(folder.join("SKILL.md"), content).expect("skill file");
        }
        store
    }

    /// What a store answers when asked for a skill by name.
    fn lookup_in(store: &std::path::Path) -> impl Fn(&str) -> Option<String> + '_ {
        move |name: &str| read_raw(store, name).ok()
    }

    /// A version is three numbers, and the parts nobody wrote are zero.
    #[test]
    fn a_version_is_read_as_written_and_ordered_by_its_numbers() {
        assert_eq!(parse_version("1.2.3").unwrap().to_string(), "1.2.3");
        assert_eq!(parse_version("2").unwrap().to_string(), "2.0.0");
        assert_eq!(parse_version(" v1.4 ").unwrap().to_string(), "1.4.0");
        // The suffix is not ordered, and saying so is the point: it is dropped
        // from the comparison rather than guessed at.
        assert_eq!(parse_version("1.2.3-beta.1").unwrap().to_string(), "1.2.3");
        assert!(parse_version("2.0.0") > parse_version("1.9.9"));
        assert!(parse_version("1.10.0") > parse_version("1.9.0"));
    }

    /// What is not a version is refused, never guessed at.
    #[test]
    fn what_is_not_a_version_is_not_read_as_one() {
        for text in ["", "   ", "latest", "1.x", "-1", "1.2.3.4", "1..2", "one.two"] {
            assert!(parse_version(text).is_none(), "{text:?} was read as a version");
        }
    }

    /// A declared version reaches the parsed skill, whether YAML made it a
    /// string or a number, and a skill that declares none says none.
    #[test]
    fn a_skill_declares_its_version_in_frontmatter() {
        let quoted = parse("---\nname: deploy\nversion: \"1.2.3\"\n---\n\nbody");
        assert_eq!(quoted.version.as_deref(), Some("1.2.3"));
        // `version: 1.2` is a YAML number, and arriving as nothing at all is
        // the bug this covers.
        let bare = parse("---\nname: deploy\nversion: 1.2\n---\n\nbody");
        assert_eq!(bare.version.as_deref(), Some("1.2"));
        assert!(parse("---\nname: deploy\n---\n\nbody").version.is_none());
    }

    /// Every form a requirement may be written in, and what it means.
    #[test]
    fn a_requirement_names_a_skill_and_optionally_bounds_it() {
        let plain = parse_requirement("formatting").unwrap();
        assert_eq!(plain.skill, "formatting");
        assert!(plain.bound.is_none());

        let bounded = parse_requirement("deploy >=2.1").unwrap();
        assert_eq!(bounded.skill, "deploy");
        assert_eq!(bounded.bound.unwrap().0, Bound::AtLeast);

        let tight = parse_requirement("deploy<1.0").unwrap();
        assert_eq!(tight.skill, "deploy");
        assert_eq!(tight.bound.unwrap().0, Bound::Below);

        // A bare version beside the name is an exact version, the way a
        // lockfile writes one.
        let exact = parse_requirement("deploy 2.0.0").unwrap();
        assert_eq!(exact.bound.unwrap().0, Bound::Exactly);

        assert!(parse_requirement("   ").is_none());
        assert!(parse_requirement(">=2.1").is_none());
    }

    /// The ordinary case: a dependency that is installed, at a version the
    /// requirement allows, is met.
    #[test]
    fn a_dependency_that_is_here_at_the_right_version_is_met() {
        let store = store_with(&[
            ("deploy", "---\nname: deploy\nversion: 2.4.0\n---\n\nship"),
            (
                "release",
                "---\nname: release\nrequires:\n  - deploy >=2.1\n---\n\ncut a release",
            ),
        ]);
        let parsed = parse(&read_raw(&store, "release").unwrap());
        assert_eq!(parsed.version, None);
        assert!(
            unmet_requirements("release", &parsed, &lookup_in(&store), None).is_empty(),
            "{:?}",
            unmet_requirements("release", &parsed, &lookup_in(&store), None)
        );
    }

    /// A dependency that is not installed, one installed too old, and one that
    /// declares no version at all are each refused, and each says which.
    #[test]
    fn a_dependency_that_is_absent_or_too_old_is_unmet_and_says_why() {
        let store = store_with(&[
            ("old", "---\nname: old\nversion: 1.0.0\n---\n\nbody"),
            ("silent", "---\nname: silent\n---\n\nbody"),
            (
                "needs-missing",
                "---\nname: needs-missing\nrequires:\n  - nowhere\n---\n\nbody",
            ),
            (
                "needs-newer",
                "---\nname: needs-newer\nrequires:\n  - old >=2.0\n---\n\nbody",
            ),
            (
                "needs-versioned",
                "---\nname: needs-versioned\nrequires:\n  - silent >=1.0\n---\n\nbody",
            ),
        ]);
        let unmet = |name: &str| {
            let parsed = parse(&read_raw(&store, name).unwrap());
            unmet_requirements(name, &parsed, &lookup_in(&store), None)
        };
        let missing = unmet("needs-missing");
        assert_eq!(missing.len(), 1, "{missing:?}");
        assert!(missing[0].contains("is not installed"), "{missing:?}");

        let newer = unmet("needs-newer");
        assert_eq!(newer.len(), 1, "{newer:?}");
        assert!(newer[0].contains(">= 2.0.0"), "{newer:?}");
        assert!(newer[0].contains("is 1.0.0"), "{newer:?}");

        let silent = unmet("needs-versioned");
        assert_eq!(silent.len(), 1, "{silent:?}");
        assert!(silent[0].contains("declares no version"), "{silent:?}");
    }

    /// A requirement carrying a version this build cannot read is unmet, not
    /// quietly widened to "any version at all".
    #[test]
    fn a_bound_that_cannot_be_read_fails_closed() {
        let store = store_with(&[
            ("deploy", "---\nname: deploy\nversion: 3.0.0\n---\n\nbody"),
            (
                "vague",
                "---\nname: vague\nrequires:\n  - deploy >=2.x\n---\n\nbody",
            ),
        ]);
        let parsed = parse(&read_raw(&store, "vague").unwrap());
        let unmet = unmet_requirements("vague", &parsed, &lookup_in(&store), None);
        assert_eq!(unmet.len(), 1, "{unmet:?}");
        assert!(unmet[0].contains("not one this understands"), "{unmet:?}");
    }

    /// Requirements are followed through: a dependency's own missing
    /// dependency is missing here too, and skills that require each other do
    /// not send the check round forever.
    #[test]
    fn requirements_are_followed_through_and_a_cycle_ends() {
        let store = store_with(&[
            (
                "top",
                "---\nname: top\nrequires:\n  - middle\n---\n\nbody",
            ),
            (
                "middle",
                "---\nname: middle\nrequires:\n  - bottom\n---\n\nbody",
            ),
            ("a", "---\nname: a\nrequires:\n  - b\n---\n\nbody"),
            ("b", "---\nname: b\nrequires:\n  - a\n---\n\nbody"),
        ]);
        let parsed = parse(&read_raw(&store, "top").unwrap());
        let unmet = unmet_requirements("top", &parsed, &lookup_in(&store), None);
        assert_eq!(unmet.len(), 1, "{unmet:?}");
        assert!(unmet[0].contains("'middle' requires the skill 'bottom'"), "{unmet:?}");

        let parsed = parse(&read_raw(&store, "a").unwrap());
        assert!(
            unmet_requirements("a", &parsed, &lookup_in(&store), None).is_empty(),
            "a pair that requires each other is satisfied, not looped"
        );
    }

    /// A tool the run does not have makes the skill unloadable; a tool it has
    /// does not, and a caller that did not say which tools exist is not
    /// answered with a guess.
    #[test]
    fn a_tool_nothing_provides_is_unmet_and_an_unknown_toolset_is_not_guessed_at() {
        let store = store_with(&[(
            "shipping",
            "---\nname: shipping\nallowed-tools:\n  - bash\n  - deploy_tool\n---\n\nbody",
        )]);
        let parsed = parse(&read_raw(&store, "shipping").unwrap());
        let here = vec!["bash".to_string(), "read".to_string()];
        let unmet = unmet_requirements("shipping", &parsed, &lookup_in(&store), Some(&here));
        assert_eq!(unmet.len(), 1, "{unmet:?}");
        assert!(unmet[0].contains("deploy_tool"), "{unmet:?}");

        let all = vec!["bash".to_string(), "deploy_tool".to_string()];
        assert!(unmet_requirements("shipping", &parsed, &lookup_in(&store), Some(&all)).is_empty());
        assert!(
            unmet_requirements("shipping", &parsed, &lookup_in(&store), None).is_empty(),
            "an unsaid toolset is not evidence a tool is absent"
        );
    }

    /// A skill that declares a version carries it into the catalogue, so what
    /// is installed can be seen rather than assumed.
    #[test]
    fn the_catalogue_carries_a_declared_version() {
        let store = store_with(&[
            ("deploy", "---\nname: deploy\ndescription: Ship it\nversion: 2.4.0\n---\n\nbody"),
            ("plain", "---\nname: plain\ndescription: Ordinary\n---\n\nbody"),
        ]);
        let metas = list_meta(&store);
        let deploy = metas.iter().find(|m| m.name == "deploy").expect("deploy");
        assert_eq!(deploy.version.as_deref(), Some("2.4.0"));
        let plain = metas.iter().find(|m| m.name == "plain").expect("plain");
        assert_eq!(plain.version, None);
    }

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
    fn catalog_respects_invocation_flags() {
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

        // Empty whitelist = all skills.
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

    #[test]
    fn write_prefers_folder_form_when_both_exist() {
        // When a folder form and a legacy flat form share a name, `resolve` and
        // `discover` read the folder form. `write` must land on the same file so
        // an edit isn't swallowed into a flat file the reader ignores.
        let root = std::env::temp_dir().join(format!(
            "jan_skills_both_{}",
            std::time::SystemTime::UNIX_EPOCH
                .elapsed()
                .unwrap()
                .as_nanos()
        ));
        let dir = skills_dir(&root);
        std::fs::create_dir_all(dir.join("dup")).unwrap();
        std::fs::write(dir.join("dup").join("SKILL.md"), "folder").unwrap();
        std::fs::write(dir.join("dup.md"), "flat").unwrap();

        write(&root, "dup", "updated").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("dup").join("SKILL.md")).unwrap(),
            "updated",
            "the folder form, which resolve reads, must receive the edit"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("dup.md")).unwrap(),
            "flat",
            "the stale flat form must be left untouched"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // -- Plugin skills ------------------------------------------------------

    fn plugin_store(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static N: AtomicUsize = AtomicUsize::new(0);
        std::env::temp_dir().join(format!(
            "jan_plugin_skills_{tag}_{}_{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ))
    }

    fn plugin_skill(store: &Path, plugin: &str, name: &str, body: &str) {
        let dir = plugins_dir(store).join(plugin).join("skills").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), body).unwrap();
    }

    fn agent_toml(store: &Path, content: &str) {
        std::fs::create_dir_all(store).unwrap();
        std::fs::write(store.join("agent.toml"), content).unwrap();
    }

    fn names(metas: &[SkillMeta]) -> Vec<String> {
        metas.iter().map(|m| m.name.clone()).collect()
    }

    #[test]
    fn enabled_plugin_skills_are_listed_with_provenance() {
        let store = plugin_store("list");
        write(&store, "deploy", "---\ndescription: ship\n---\nbody").unwrap();
        plugin_skill(&store, "release", "prepare", "---\ndescription: prep\n---\nsteps");
        // A single-skill plugin: SKILL.md at the plugin root.
        std::fs::create_dir_all(plugins_dir(&store).join("triage")).unwrap();
        std::fs::write(plugins_dir(&store).join("triage/SKILL.md"), "triage body").unwrap();

        let listed = list_meta(&store);
        assert_eq!(names(&listed), vec!["deploy", "release:prepare", "triage:triage"]);
        let prep = listed.iter().find(|m| m.name == "release:prepare").unwrap();
        assert_eq!(prep.plugin.as_deref(), Some("release"));
        assert_eq!(prep.description, "prep");
        assert!(listed.iter().find(|m| m.name == "deploy").unwrap().plugin.is_none());

        // Serialized provenance: present for plugin skills, absent otherwise.
        let json = serde_json::to_value(&listed).unwrap();
        assert_eq!(json[1]["plugin"], "release");
        assert!(json[0].get("plugin").is_none());

        // Model side too, and readable by qualified and unique plain name.
        assert!(names(&catalog(&store, &[])).contains(&"release:prepare".to_string()));
        assert_eq!(parse(&read_raw(&store, "release:prepare").unwrap()).body, "steps");
        assert_eq!(parse(&read_raw(&store, "prepare").unwrap()).body, "steps");
        let _ = std::fs::remove_dir_all(&store);
    }

    #[test]
    fn disabled_plugin_skills_are_hidden_and_unreadable() {
        let store = plugin_store("disabled");
        plugin_skill(&store, "release", "prepare", "secret steps");
        agent_toml(&store, "[plugins]\ndisabled = [\"release\"]\n");

        assert!(list_meta(&store).is_empty());
        assert_eq!(names(&catalog(&store, &[])), vec!["jan"]);
        assert!(read_raw(&store, "release:prepare").is_err());
        assert!(read_raw(&store, "prepare").is_err());
        assert!(read_for_model(None, &store, &[], "release:prepare").is_err());
        // Naming the plugin in the whitelist does not override disabling it.
        assert!(read_for_model(None, &store, &["release".into()], "release:prepare").is_err());

        // Re-enabling (removing the entry) restores it.
        agent_toml(&store, "[plugins]\ndisabled = []\n");
        assert_eq!(read_raw(&store, "release:prepare").unwrap(), "secret steps");
        let _ = std::fs::remove_dir_all(&store);
    }

    #[test]
    fn removed_plugin_skills_are_gone() {
        let store = plugin_store("removed");
        plugin_skill(&store, "release", "prepare", "steps");
        assert_eq!(names(&list_meta(&store)), vec!["release:prepare"]);
        std::fs::remove_dir_all(plugins_dir(&store).join("release")).unwrap();
        assert!(list_meta(&store).is_empty());
        assert!(read_raw(&store, "release:prepare").is_err());
        let _ = std::fs::remove_dir_all(&store);
    }

    #[test]
    fn staging_directories_contribute_nothing() {
        let store = plugin_store("staging");
        plugin_skill(&store, ".installing-42", "half", "partial");
        assert!(list_meta(&store).is_empty());
        assert!(read_raw(&store, ".installing-42:half").is_err());
        let _ = std::fs::remove_dir_all(&store);
    }

    #[test]
    fn whitelist_matches_qualified_plain_and_plugin_id() {
        let store = plugin_store("whitelist");
        write(&store, "deploy", "deploy body").unwrap();
        plugin_skill(&store, "release", "prepare", "prep body");
        plugin_skill(&store, "release", "changelog", "log body");

        let model = |enabled: &[&str]| {
            let enabled: Vec<String> = enabled.iter().map(|s| s.to_string()).collect();
            names(&catalog(&store, &enabled))
        };
        assert_eq!(model(&["release"]), vec!["release:changelog", "release:prepare"]);
        assert_eq!(model(&["release:prepare"]), vec!["release:prepare"]);
        assert_eq!(model(&["changelog"]), vec!["release:changelog"]);
        assert_eq!(model(&["deploy"]), vec!["deploy"]);
        // The "none" sentinel matches nothing, the built-in skill included.
        assert!(model(&[""]).is_empty());

        let only_prepare = ["release:prepare".to_string()];
        assert!(read_for_model(None, &store, &only_prepare, "release:prepare").is_ok());
        assert!(read_for_model(None, &store, &only_prepare, "release:changelog").is_err());
        assert!(read_for_model(None, &store, &only_prepare, "deploy").is_err());
        let _ = std::fs::remove_dir_all(&store);
    }

    #[test]
    fn plugin_skills_are_read_only() {
        let store = plugin_store("readonly");
        plugin_skill(&store, "release", "prepare", "original");

        let err = write(&store, "release:prepare", "overwritten").unwrap_err();
        assert!(err.contains("read-only") && err.contains("release"), "{err}");
        let err = delete(&store, "release:prepare").unwrap_err();
        assert!(err.contains("read-only"), "{err}");
        assert_eq!(read_raw(&store, "release:prepare").unwrap(), "original");
        assert!(plugins_dir(&store).join("release/skills/prepare/SKILL.md").is_file());
        let _ = std::fs::remove_dir_all(&store);
    }

    #[test]
    fn a_store_skill_shadows_a_plugin_skill_of_the_same_name() {
        let store = plugin_store("shadow");
        write(&store, "prepare", "store copy").unwrap();
        plugin_skill(&store, "release", "prepare", "plugin copy");
        assert_eq!(read_raw(&store, "prepare").unwrap(), "store copy");
        assert_eq!(read_raw(&store, "release:prepare").unwrap(), "plugin copy");
        let _ = std::fs::remove_dir_all(&store);
    }

    #[test]
    fn a_plugin_name_cannot_escape_the_plugins_directory() {
        let store = plugin_store("escape");
        std::fs::create_dir_all(skills_dir(&store)).unwrap();
        std::fs::write(store.join("outside.md"), "outside").unwrap();
        for name in ["..:outside", "release:../../outside", "a/b:c", "release:..\\x"] {
            assert!(read_raw(&store, name).is_err(), "{name}");
        }
        let _ = std::fs::remove_dir_all(&store);
    }

    #[test]
    fn project_layer_comes_first_honours_its_own_config_and_never_falls_through() {
        let project = plugin_store("layer_project");
        let store = plugin_store("layer_store");
        write(&project, "deploy", "project deploy").unwrap();
        write(&project, "off", "project off").unwrap();
        plugin_skill(&project, "release", "prepare", "prep");
        plugin_skill(&project, "muted", "hush", "muted body");
        agent_toml(
            &project,
            "[skills]\nenabled = [\"deploy\", \"release\", \"jan\"]\n[plugins]\ndisabled = [\"muted\"]\n",
        );
        write(&store, "personal", "store personal").unwrap();
        write(&store, "off", "store off").unwrap();
        write(&store, "deploy", "store deploy").unwrap();

        let listed = names(&catalog_for_model(Some(&project), &store, &[]));
        assert_eq!(listed, vec!["deploy", "release:prepare", "jan", "personal"]);

        let read = |name: &str| read_for_model(Some(&project), &store, &[], name);
        assert_eq!(read("deploy").unwrap(), "project deploy");
        assert_eq!(read("release:prepare").unwrap(), "prep");
        assert_eq!(read("personal").unwrap(), "store personal");
        // Disabled in the project: not replaced by the store's same-named copy.
        assert!(read("off").is_err());
        // A disabled plugin's skill is unreadable in every spelling.
        assert!(read("muted:hush").is_err());
        assert!(read("hush").is_err());

        assert!(project_claims(&project, "deploy"));
        assert!(project_claims(&project, "release:prepare"));
        assert!(!project_claims(&project, "personal"));
        assert!(!project_claims(&project, "muted:hush"));
        let _ = std::fs::remove_dir_all(&project);
        let _ = std::fs::remove_dir_all(&store);
    }

    /// Project, store and the user's own skills (AH-121) as three layers: a
    /// name a higher layer knows -- enabled or hidden -- never falls through,
    /// the store shadows a same-named user skill, and the user layer answers
    /// only names neither higher layer knows.
    #[test]
    fn three_layers_resolve_project_then_store_then_user() {
        let project = plugin_store("tri_project");
        let store = plugin_store("tri_store");
        let user = plugin_store("tri_user");
        write(&project, "deploy", "project deploy").unwrap();
        write(&project, "off", "project off").unwrap();
        agent_toml(&project, "[skills]\nenabled = [\"deploy\"]\n");
        write(&store, "off", "store off").unwrap();
        write(&store, "style", "store style").unwrap();
        write(&user, "off", "user off").unwrap();
        write(&user, "deploy", "user deploy").unwrap();
        write(&user, "style", "user style").unwrap();
        write(&user, "personal", "user personal").unwrap();
        write(&user, "jan", "user jan").unwrap();

        let read = |name: &str| read_for_model_with_user(Some(&project), &store, Some(&user), &[], name);
        assert_eq!(read("deploy").unwrap(), "project deploy");
        // Hidden in the project: neither the store's nor the user's copy.
        let off = read("off");
        assert!(off.is_err(), "{off:?}");
        // The store shadows the user.
        assert_eq!(read("style").unwrap(), "store style");
        // Only names no higher layer knows reach the user layer.
        assert_eq!(read("personal").unwrap(), "user personal");
        assert!(read("nowhere").is_err());
        assert!(read("user:personal").is_err());

        let listed = names(&catalog_for_model_with_user(Some(&project), &store, Some(&user), &[]));
        assert_eq!(listed, vec!["deploy", "style", "personal"]);

        // Without a project: the store shadows the user, and a name the store
        // hides (the built-in Jan skill, off by the whitelist) is not answered
        // by the user's same-named skill.
        let bare = |enabled: &[String], name: &str| {
            read_for_model_with_user(None, &store, Some(&user), enabled, name)
        };
        assert_eq!(bare(&[], "off").unwrap(), "store off");
        assert_eq!(bare(&[], "deploy").unwrap(), "user deploy");
        assert_ne!(bare(&[], "jan").unwrap(), "user jan");
        let only_personal = vec!["personal".to_string()];
        assert!(bare(&only_personal, "jan").is_err());
        assert_eq!(bare(&only_personal, "personal").unwrap(), "user personal");
        // The whitelist governs the user layer too.
        assert!(bare(&only_personal, "deploy").is_err());
        let listed = names(&catalog_for_model_with_user(None, &store, Some(&user), &only_personal));
        assert_eq!(listed, vec!["personal"]);
        let listed = names(&catalog_for_model_with_user(None, &store, Some(&user), &[]));
        assert_eq!(listed, vec!["off", "style", "jan", "deploy", "personal"]);

        // A user store equal to the store (the desktop) adds nothing twice.
        let same = names(&catalog_for_model_with_user(None, &store, Some(&store), &[]));
        assert_eq!(same, names(&catalog(&store, &[])));
        for dir in [&project, &store, &user] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn config_is_read_leniently() {
        let store = plugin_store("config");
        assert_eq!(load_config(&store), SkillConfig::default());
        agent_toml(&store, "[skills]\nenabled = [\"a\"]\n[plugins]\ndisabled = [\"p\"]\n[tools]\ndeny = [\"bash\"]\n");
        assert_eq!(
            load_config(&store),
            SkillConfig {
                enabled: vec!["a".into()],
                disabled_plugins: vec!["p".into()],
            }
        );
        agent_toml(&store, "[skills\nbroken");
        assert_eq!(load_config(&store), SkillConfig::default());
        let _ = std::fs::remove_dir_all(&store);
    }
}
