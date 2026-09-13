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

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::workspace::{store_dir, workspace_filename};

const KIND: &str = "skills";

/// `<store_root>/skills`.
pub fn skills_dir(store: &Path) -> PathBuf {
    store_dir(store, KIND)
}

/// One skill on disk, located by its identity name (folder name or flat stem).
pub struct SkillEntry {
    pub name: String,
    /// The markdown file to read (the `SKILL.md`, or the flat `<name>.md`).
    pub file: PathBuf,
    /// True for the folder form `<name>/SKILL.md`, false for legacy flat.
    pub is_folder: bool,
}

/// Summary for the management UI / prompt catalog.
#[derive(serde::Serialize)]
pub struct SkillMeta {
    pub name: String,
    pub description: String,
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

/// All skills in the store, sorted by name. Folder skills (`<name>/SKILL.md`)
/// and legacy flat skills (`<name>.md`) are both discovered. When both forms
/// share a name, the folder form wins so a skill is never listed/injected twice.
pub fn discover(store: &Path) -> Vec<SkillEntry> {
    let dir = skills_dir(store);
    let Ok(rd) = std::fs::read_dir(&dir) else {
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
                    });
                }
            }
        } else if path.extension().and_then(|x| x.to_str()) == Some("md") {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                consider(SkillEntry {
                    name: stem.to_string(),
                    file: path,
                    is_folder: false,
                });
            }
        }
    }
    let mut out: Vec<SkillEntry> = by_name.into_values().collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Locate an existing skill by name, preferring the folder form.
fn resolve(store: &Path, name: &str) -> Result<SkillEntry, String> {
    let stem = safe_stem(name)?;
    let dir = skills_dir(store);
    let folder = dir.join(&stem).join("SKILL.md");
    if folder.is_file() {
        return Ok(SkillEntry {
            name: stem,
            file: folder,
            is_folder: true,
        });
    }
    let flat = dir.join(format!("{stem}.md"));
    if flat.is_file() {
        return Ok(SkillEntry {
            name: stem,
            file: flat,
            is_folder: false,
        });
    }
    Err(format!("ERROR: skill '{name}' not found"))
}

/// Whether a skill is advertised given the `[skills].enabled` whitelist. An
/// empty whitelist means every skill is enabled.
pub fn is_enabled(enabled: &[String], name: &str) -> bool {
    enabled.is_empty() || enabled.iter().any(|n| n == name)
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
pub const DEFAULT_JAN_SKILL_NAME: &str = "jan";
pub const DEFAULT_JAN_SKILL: &str = include_str!("default_jan_skill.md");

/// Whether a name refers to the built-in Jan skill (aliased `jan`), which is
/// always available even with no project skills installed.
fn is_default_jan_skill(name: &str) -> bool {
    safe_stem(name).ok().as_deref() == Some(DEFAULT_JAN_SKILL_NAME)
}
fn default_jan_skill_meta() -> SkillMeta {
    let parsed = parse(DEFAULT_JAN_SKILL);
    SkillMeta {
        name: DEFAULT_JAN_SKILL_NAME.to_string(),
        description: describe(&parsed),
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

fn meta_for(name: String, parsed: &ParsedSkill) -> SkillMeta {
    SkillMeta {
        name,
        description: describe(parsed),
        user_invocable: parsed.user_invocable,
        model_invocable: parsed.model_invocable,
        needs: parsed.needs.clone(),
        version: parsed.version.clone(),
    }
}

/// Metadata for every discovered skill (name + description + invocation
/// flags) — for the management UI, which must see disabled and private skills.
/// Keeps empty stubs so the user can see and edit them.
pub fn list_meta(store: &Path) -> Vec<SkillMeta> {
    discover(store)
        .into_iter()
        .filter_map(|e| {
            let parsed = parse(&std::fs::read_to_string(&e.file).ok()?);
            Some(meta_for(e.name, &parsed))
        })
        .collect()
}

/// Filter discovered skills by the `[skills].enabled` whitelist and one
/// invocation side. Skills with neither a description nor a body are skipped
/// (nothing to advertise or invoke).
fn side_catalog(
    root: &Path,
    user: Option<&Path>,
    enabled: &[String],
    side: impl Fn(&ParsedSkill) -> bool,
) -> Vec<SkillMeta> {
    let allow: Option<std::collections::HashSet<&str>> =
        (!enabled.is_empty()).then(|| enabled.iter().map(String::as_str).collect());
    let mut skills = discover_with_user(root, user)
        .into_iter()
        .filter_map(|e| {
            if let Some(allow) = &allow {
                if !allow.contains(e.name.as_str()) {
                    return None;
                }
            }
            let parsed = parse(&std::fs::read_to_string(&e.file).ok()?);
            if !side(&parsed) {
                return None;
            }
            let description = describe(&parsed);
            if description.is_empty() && parsed.body.trim().is_empty() {
                return None;
            }
            Some(meta_for(e.name, &parsed))
        })
        .collect::<Vec<_>>();
    if is_enabled(enabled, DEFAULT_JAN_SKILL_NAME)
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
/// Test-only: the `skill_list` tool goes through [`catalog_with_user`].
#[cfg(test)]
pub(crate) fn catalog(root: &Path, enabled: &[String]) -> Vec<SkillMeta> {
    side_catalog(root, None, enabled, |p| p.model_invocable)
}

/// [`catalog`] over the store and the user's own skills (AH-121). A skill in
/// the store shadows a user skill of the same name.
pub(crate) fn catalog_with_user(root: &Path, user: Option<&Path>, enabled: &[String]) -> Vec<SkillMeta> {
    side_catalog(root, user, enabled, |p| p.model_invocable)
}

/// The store's skills, then the user store's skills that no store skill
/// shadows. `user` equal to `store` (the desktop, whose store is the user
/// store) adds nothing twice.
fn discover_with_user(store: &Path, user: Option<&Path>) -> Vec<SkillEntry> {
    let mut out = discover(store);
    if let Some(user) = user.filter(|u| *u != store) {
        let extra: Vec<SkillEntry> = discover(user)
            .into_iter()
            .filter(|u| !out.iter().any(|p| p.name == u.name))
            .collect();
        out.extend(extra);
    }
    out
}

/// Raw SKILL.md text (frontmatter included) for the editor.
pub fn read_raw(store: &Path, name: &str) -> Result<String, String> {
    if is_default_jan_skill(name) {
        return Ok(parse(DEFAULT_JAN_SKILL).body);
    }
    let entry = resolve(store, name)?;
    std::fs::read_to_string(&entry.file).map_err(|e| format!("ERROR: {e}"))
}

/// [`read_raw`], falling back to the user's own skills when the store has
/// none of that name (AH-121).
pub fn read_raw_with_user(store: &Path, user: Option<&Path>, name: &str) -> Result<String, String> {
    match read_raw(store, name) {
        Ok(raw) => Ok(raw),
        Err(missing) => match user.filter(|u| *u != store) {
            Some(user) => read_raw(user, name),
            None => Err(missing),
        },
    }
}

/// A skill's markdown body with the frontmatter fence stripped — what the
/// `skill_read` tool hands the model when it loads a skill on demand.
pub fn read_body(store: &Path, name: &str) -> Result<String, String> {
    Ok(parse(&read_raw(store, name)?).body)
}

/// Create or overwrite a skill. Existing skills are written in place (preserving
/// their form); new skills are written as the folder form `<name>/SKILL.md`.
pub fn write(store: &Path, name: &str, content: &str) -> Result<(), String> {
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
}
