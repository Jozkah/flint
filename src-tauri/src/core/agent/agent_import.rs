//! Importing agent definitions written for other harnesses (AH-118, AH-119).
//!
//! Two ecosystems put their agent definitions somewhere Flint can read them, and
//! both describe roughly what a Flint subagent is: a name, a description of when
//! to use it, a system prompt, and the tools it is allowed:
//!
//! * **OpenCode** — `.opencode/agent/<name>.md` (and `~/.config/opencode/
//!   agent/<name>.md`), YAML frontmatter over a markdown prompt, plus agents
//!   declared under `"agent"` in an `opencode.json`.
//! * **Qwen Code** — `.qwen/agents/<name>.md`, the same shape with the
//!   Claude Code key set.
//!
//! What this does *not* do is guess. A key it knows is mapped; a key it does
//! not know is reported, by name, in the import's notes, so nothing is
//! silently dropped and nobody has to diff two directories to find out what
//! survived. Where the two formats genuinely disagree -- OpenCode writes
//! `tools` as a map of on/off switches, Qwen writes a list of names -- both are
//! read, and which dialect a file was read as is part of the report.
//!
//! Nothing is written until every file has been read: an import that refuses
//! one definition leaves the others unwritten too, so a half-imported
//! directory is not a state anyone has to reason about. `--dry-run` reads and
//! reports and writes nothing at all.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};

use crate::core::agent::subagent::{SubagentDefinition, SubagentScope};

/// Which ecosystem a definition was written for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    /// AH-118: `.opencode/agent/*.md`, or an `opencode.json`'s `agent` object.
    OpenCode,
    /// AH-119: `.qwen/agents/*.md`.
    Qwen,
}

impl Dialect {
    pub fn label(self) -> &'static str {
        match self {
            Dialect::OpenCode => "opencode",
            Dialect::Qwen => "qwen",
        }
    }
}

/// One definition, as Flint would hold it, plus everything true of the original
/// that Flint does not hold.
#[derive(Debug, Clone)]
pub struct Imported {
    pub definition: SubagentDefinition,
    pub dialect: Dialect,
    /// Where it was read from.
    pub source: PathBuf,
    /// What was in the original and is not in the result, each said plainly.
    pub notes: Vec<String>,
}

/// What an import did, or -- for a dry run -- would do.
#[derive(Debug, Clone, Default)]
pub struct ImportReport {
    pub imported: Vec<Imported>,
    /// Definitions deliberately passed over, with the reason.
    pub skipped: Vec<String>,
    /// True when nothing was written.
    pub dry_run: bool,
}

fn invalid(message: impl Into<String>) -> HarnessError {
    HarnessError::new(ErrorKind::InvalidInput, message).at(Stage::Startup)
}

fn not_found(message: impl Into<String>) -> HarnessError {
    HarnessError::new(ErrorKind::NotFound, message).at(Stage::Startup)
}

/// The frontmatter both dialects are read through.
///
/// Every field is optional because this is somebody else's file: what is
/// missing is decided on below, where the message can say which file and what
/// was wanted.
#[derive(Debug, Default, Deserialize)]
struct AgentFrontmatter {
    name: Option<String>,
    description: Option<String>,
    /// OpenCode: `primary`, `subagent` or `all`.
    mode: Option<String>,
    model: Option<String>,
    /// OpenCode: sampling temperature. Flint has no per-subagent temperature.
    temperature: Option<serde_yaml::Value>,
    /// OpenCode writes a map of switches; Qwen writes a list, or a
    /// comma-separated string.
    tools: Option<serde_yaml::Value>,
    /// OpenCode: per-tool permission rules. Flint's permissions are the run's.
    permission: Option<serde_yaml::Value>,
    /// OpenCode: an agent its author turned off.
    disable: Option<bool>,
    /// Qwen/Claude: display colour.
    color: Option<String>,
    /// Anything else the author wrote, reported rather than dropped.
    #[serde(flatten)]
    rest: BTreeMap<String, serde_yaml::Value>,
}

/// Tool names the two ecosystems use, mapped to Flint's. Unknown names are
/// dropped *and reported*: the author's runtime has tools Flint does not, and a
/// silent drop turns a narrow agent into a wide one.
fn map_tool(name: &str) -> Option<&'static str> {
    match name.trim().to_ascii_lowercase().as_str() {
        "read" => Some("read"),
        "ls" | "list" => Some("ls"),
        "glob" => Some("glob"),
        "grep" => Some("grep"),
        "find" => Some("find"),
        "bash" | "shell" => Some("bash"),
        "edit" | "patch" | "multiedit" => Some("edit"),
        "write" => Some("write"),
        "websearch" | "web_search" => Some("web_search"),
        "webfetch" | "web_fetch" | "fetch" => Some("web_fetch"),
        "todowrite" | "todoread" | "todo" => Some("todo"),
        "ask" => Some("ask"),
        "task" => Some("dispatch_subagent"),
        _ => None,
    }
}

/// The tools an imported agent's author could have had: Flint's side of the
/// mapping above, and nothing else.
///
/// This is what "everything except these" means for a subtractive switch map.
/// Not every Flint tool: an OpenCode agent's author never had `memory_write` or
/// `screenshot`, and turning off `write` is not a request to be handed them.
fn importable_tools() -> Vec<String> {
    let mut tools: Vec<String> = [
        "read", "ls", "find", "grep", "bash", "edit", "write", "web_search", "web_fetch", "todo",
        "ask",
    ]
    .iter()
    .map(|t| t.to_string())
    .collect();
    tools.sort();
    tools
}

/// Read the `tools` field of either dialect into an allowlist.
///
/// * A list, or a comma-separated string (Qwen): those tools, mapped.
/// * A map of switches (OpenCode): the ones switched on. A map that only
///   switches things *off* is subtractive -- it means "everything but these" --
///   so it becomes every Flint tool except those, which is the same sentence in
///   the only grammar Flint's format has.
///
/// `None` means the author said nothing, and the child inherits the parent's
/// policy; an empty list would mean "no tools at all", which is a different
/// claim.
fn map_tools(value: Option<&serde_yaml::Value>, notes: &mut Vec<String>) -> Option<Vec<String>> {
    let value = value?;
    let mut unknown: Vec<String> = Vec::new();
    let mut take = |name: &str| match map_tool(name) {
        Some(jan) => Some(jan.to_string()),
        None => {
            unknown.push(name.trim().to_string());
            None
        }
    };
    let mapped: Vec<String> = match value {
        serde_yaml::Value::String(list) => list.split(',').filter_map(&mut take).collect(),
        serde_yaml::Value::Sequence(items) => items
            .iter()
            .filter_map(|i| i.as_str())
            .filter_map(&mut take)
            .collect(),
        serde_yaml::Value::Mapping(switches) => {
            let on: Vec<String> = switches
                .iter()
                .filter(|(_, v)| v.as_bool() == Some(true))
                .filter_map(|(k, _)| k.as_str())
                .filter_map(&mut take)
                .collect();
            let off: Vec<String> = switches
                .iter()
                .filter(|(_, v)| v.as_bool() == Some(false))
                .filter_map(|(k, _)| k.as_str())
                .filter_map(take)
                .collect();
            if on.is_empty() && !off.is_empty() {
                notes.push(format!(
                    "tools were written as switches that only turn things off ({}); imported as \
                     every tool an imported agent can name, except those",
                    off.join(", ")
                ));
                importable_tools()
                    .into_iter()
                    .filter(|t| !off.contains(t))
                    .collect()
            } else {
                on
            }
        }
        _ => Vec::new(),
    };
    if !unknown.is_empty() {
        unknown.sort();
        unknown.dedup();
        notes.push(format!(
            "these tools have no Jan equivalent and were not imported: {}",
            unknown.join(", ")
        ));
    }
    (!mapped.is_empty()).then(|| {
        let mut tools = mapped;
        tools.sort();
        tools.dedup();
        tools
    })
}

/// Which dialect a markdown file is written in.
///
/// Decided by what the file itself carries -- `mode`, `permission`,
/// `temperature` or tools-as-switches are OpenCode's -- and otherwise by the
/// directory it was found in. When neither says, it is read as Qwen's key set,
/// which is the plainer of the two and the one the shared keys belong to.
fn dialect_of(path: &Path, fm: &AgentFrontmatter) -> Dialect {
    if fm.mode.is_some()
        || fm.permission.is_some()
        || fm.temperature.is_some()
        || matches!(fm.tools, Some(serde_yaml::Value::Mapping(_)))
    {
        return Dialect::OpenCode;
    }
    let in_dir = |needle: &str| {
        path.components()
            .any(|c| c.as_os_str().to_string_lossy().eq_ignore_ascii_case(needle))
    };
    // `.qwen`, and any other folder, reads as Qwen's dialect.
    if in_dir(".opencode") {
        Dialect::OpenCode
    } else {
        Dialect::Qwen
    }
}

/// Read one markdown agent file. `Ok(None)` is a definition deliberately
/// passed over (its author turned it off, or it is a primary agent rather than
/// a subagent); the reason is pushed onto `skipped`.
fn read_markdown(path: &Path, skipped: &mut Vec<String>) -> Result<Option<Imported>, HarnessError> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| not_found(format!("cannot read {}: {e}", path.display())))?;
    let (yaml, body) = crate::core::agent::skills::split_frontmatter(&raw);
    let Some(yaml) = yaml else {
        return Err(invalid(format!(
            "{} has no YAML frontmatter, so there is nothing to say what it is",
            path.display()
        )));
    };
    let fm: AgentFrontmatter = serde_yaml::from_str(&yaml)
        .map_err(|e| invalid(format!("{}: frontmatter is not readable: {e}", path.display())))?;
    let dialect = dialect_of(path, &fm);

    if fm.disable == Some(true) {
        skipped.push(format!(
            "{}: its author disabled it (disable: true)",
            path.display()
        ));
        return Ok(None);
    }
    if let Some(mode) = fm.mode.as_deref() {
        // `primary` is OpenCode's word for the agent a person talks to, not one
        // another agent dispatches. Importing it as a subagent would be
        // importing something the author did not write.
        if mode.eq_ignore_ascii_case("primary") {
            skipped.push(format!(
                "{}: it is a primary agent, not a subagent",
                path.display()
            ));
            return Ok(None);
        }
        if !mode.eq_ignore_ascii_case("subagent") && !mode.eq_ignore_ascii_case("all") {
            return Err(invalid(format!(
                "{}: mode '{mode}' is not one this understands (primary, subagent, all)",
                path.display()
            )));
        }
    }

    // OpenCode names an agent by its file; Qwen writes the name in the
    // frontmatter. Either is a name, and a file that carries both is read as
    // what it says.
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string();
    let name = fm
        .name
        .clone()
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or(stem);
    if name.is_empty() {
        return Err(invalid(format!(
            "{} has no name, in its frontmatter or its filename",
            path.display()
        )));
    }
    let description = fm
        .description
        .clone()
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
        .ok_or_else(|| {
            invalid(format!(
                "{name} ({}) has no description; a subagent without one cannot be dispatched, \
                 because the description is what says when to use it",
                path.display()
            ))
        })?;
    let system_prompt = body.trim().to_string();
    if system_prompt.is_empty() {
        return Err(invalid(format!(
            "{name} ({}) has no prompt below its frontmatter",
            path.display()
        )));
    }

    let mut notes = Vec::new();
    let allowed_tools = map_tools(fm.tools.as_ref(), &mut notes);
    note_unmapped(&fm, &mut notes);
    Ok(Some(Imported {
        definition: SubagentDefinition {
            name,
            description,
            system_prompt,
            allowed_tools,
            // Kept exactly as written. It names a model in the author's
            // provider, and rewriting it to something Flint has would be
            // choosing a model on their behalf; an unknown one fails when it
            // is dispatched, saying so.
            model: fm.model.clone().map(|m| m.trim().to_string()).filter(|m| !m.is_empty()),
            scope: SubagentScope::User,
        },
        dialect,
        source: path.to_path_buf(),
        notes,
    }))
}

/// Everything the original said that the result does not hold.
fn note_unmapped(fm: &AgentFrontmatter, notes: &mut Vec<String>) {
    if let Some(t) = &fm.temperature {
        notes.push(format!(
            "temperature ({}) was not imported: Jan has no per-subagent temperature",
            serde_yaml::to_string(t).unwrap_or_default().trim()
        ));
    }
    if fm.permission.is_some() {
        notes.push(
            "per-agent permission rules were not imported: in Jan a subagent runs under the \
             run's own permissions, narrowed by its tool list"
                .to_string(),
        );
    }
    if fm.color.is_some() {
        notes.push("color was not imported: Jan does not colour subagents".to_string());
    }
    for key in fm.rest.keys() {
        notes.push(format!("'{key}' is not a key this understands, and was not imported"));
    }
}

/// An `opencode.json`'s `"agent"` object (AH-118).
///
/// Each entry is the same shape as the markdown frontmatter, with the prompt
/// in a `prompt` field rather than below a fence.
#[derive(Debug, Deserialize)]
struct OpenCodeConfig {
    #[serde(default)]
    agent: BTreeMap<String, serde_json::Value>,
}

fn read_opencode_json(path: &Path, skipped: &mut Vec<String>) -> Result<Vec<Imported>, HarnessError> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| not_found(format!("cannot read {}: {e}", path.display())))?;
    let config: OpenCodeConfig = serde_json::from_str(&raw)
        .map_err(|e| invalid(format!("{} is not readable as JSON: {e}", path.display())))?;
    if config.agent.is_empty() {
        return Err(invalid(format!(
            "{} declares no agents (no \"agent\" object)",
            path.display()
        )));
    }
    let mut out = Vec::new();
    for (name, value) in config.agent {
        // Read through the same frontmatter shape, so one file format cannot
        // drift from the other.
        let yaml = serde_yaml::to_string(&value)
            .map_err(|e| invalid(format!("{}: agent '{name}' is not readable: {e}", path.display())))?;
        let fm: AgentFrontmatter = serde_yaml::from_str(&yaml)
            .map_err(|e| invalid(format!("{}: agent '{name}' is not readable: {e}", path.display())))?;
        if fm.disable == Some(true) {
            skipped.push(format!("{name}: its author disabled it (disable: true)"));
            continue;
        }
        if fm.mode.as_deref().is_some_and(|m| m.eq_ignore_ascii_case("primary")) {
            skipped.push(format!("{name}: it is a primary agent, not a subagent"));
            continue;
        }
        let description = fm
            .description
            .clone()
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty())
            .ok_or_else(|| invalid(format!("agent '{name}' in {} has no description", path.display())))?;
        let system_prompt = fm
            .rest
            .get("prompt")
            .and_then(|p| p.as_str())
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .ok_or_else(|| {
                invalid(format!(
                    "agent '{name}' in {} has no prompt",
                    path.display()
                ))
            })?;
        let mut notes = Vec::new();
        let allowed_tools = map_tools(fm.tools.as_ref(), &mut notes);
        let mut without_prompt = AgentFrontmatter {
            rest: fm.rest.clone(),
            ..Default::default()
        };
        without_prompt.rest.remove("prompt");
        without_prompt.temperature = fm.temperature.clone();
        without_prompt.permission = fm.permission.clone();
        without_prompt.color = fm.color.clone();
        note_unmapped(&without_prompt, &mut notes);
        out.push(Imported {
            definition: SubagentDefinition {
                name: name.clone(),
                description,
                system_prompt,
                allowed_tools,
                model: fm.model.clone().map(|m| m.trim().to_string()).filter(|m| !m.is_empty()),
                scope: SubagentScope::User,
            },
            dialect: Dialect::OpenCode,
            source: path.to_path_buf(),
            notes,
        });
    }
    Ok(out)
}

/// Every definition at `path`, which may be one file or a directory of them.
///
/// Reading is separate from writing on purpose: a directory where one file is
/// malformed refuses as a whole, rather than importing the good half and
/// leaving somebody to work out which half that was.
pub fn read_all(path: &Path) -> Result<(Vec<Imported>, Vec<String>), HarnessError> {
    let mut skipped = Vec::new();
    if !path.exists() {
        return Err(not_found(format!("{} does not exist", path.display())));
    }
    if path.is_file() {
        let found = match path.extension().and_then(|e| e.to_str()) {
            Some("json") => read_opencode_json(path, &mut skipped)?,
            _ => read_markdown(path, &mut skipped)?.into_iter().collect(),
        };
        return Ok((found, skipped));
    }
    let mut files: Vec<PathBuf> = std::fs::read_dir(path)
        .map_err(|e| not_found(format!("cannot read {}: {e}", path.display())))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().and_then(|e| e.to_str()) == Some("md"))
        .filter(|p| {
            // A README is documentation, not a definition, and every one of
            // these directories has one.
            !p.file_stem()
                .and_then(|s| s.to_str())
                .is_some_and(|s| s.eq_ignore_ascii_case("readme"))
        })
        .collect();
    files.sort();
    if files.is_empty() {
        return Err(not_found(format!(
            "{} holds no agent definitions (*.md)",
            path.display()
        )));
    }
    let mut out = Vec::new();
    for file in files {
        if let Some(imported) = read_markdown(&file, &mut skipped)? {
            out.push(imported);
        }
    }
    Ok((out, skipped))
}

/// Read every definition at `path` and write them into `scope_dir` as native
/// subagents. Nothing is written when `dry_run`, and nothing is written at all
/// if any definition is refused.
pub fn import(
    path: &Path,
    scope_dir: &Path,
    scope: SubagentScope,
    overwrite: bool,
    dry_run: bool,
) -> Result<ImportReport, HarnessError> {
    let (found, skipped) = read_all(path)?;
    if found.is_empty() {
        return Err(not_found(format!(
            "{} holds nothing importable",
            path.display()
        )));
    }
    let mut report = ImportReport {
        imported: found,
        skipped,
        dry_run,
    };
    if dry_run {
        return Ok(report);
    }
    let refused = |e: crate::core::agent::subagent::SubagentError| match e {
        crate::core::agent::subagent::SubagentError::PermissionDenied(m) => {
            HarnessError::new(ErrorKind::PolicyViolation, m).at(Stage::Startup)
        }
        other => invalid(other.to_string()),
    };
    let mut registry = crate::core::agent::subagent::SubagentRegistry::load_one(scope_dir, scope);
    // Every refusal is found before anything is written (Jozkah/jan#208): an
    // illegal name, a read-only scope, an existing name without `overwrite`,
    // and two definitions in this batch that share a name -- `overwrite`
    // governs what is already there, not which of two new files wins.
    let mut seen = std::collections::HashSet::new();
    for entry in &report.imported {
        let name = entry.definition.name.as_str();
        registry.check_create(name, scope, overwrite).map_err(refused)?;
        if !seen.insert(name) {
            return Err(invalid(format!(
                "two definitions in this import are both named '{name}'; rename one"
            )));
        }
    }
    // A write can still fail (the disk, permissions). What this import
    // already wrote is put back the way it was, so a failure writes nothing.
    let mut undo: Vec<(std::path::PathBuf, Option<Vec<u8>>)> = Vec::new();
    for entry in report.imported.iter_mut() {
        entry.definition.scope = scope;
        let target = scope_dir.join(format!("{}.toml", entry.definition.name));
        let before = std::fs::read(&target).ok();
        if let Err(e) = registry.create_in(scope_dir, entry.definition.clone(), scope, overwrite) {
            for (path, content) in undo.into_iter().rev() {
                let _ = match content {
                    Some(bytes) => std::fs::write(&path, bytes),
                    None => std::fs::remove_file(&path),
                };
            }
            return Err(refused(e));
        }
        undo.push((target, before));
    }
    Ok(report)
}

/// The import, as a person reads it: what was written, where it came from, and
/// everything about the original that did not survive the crossing.
pub fn render(report: &ImportReport) -> String {
    let mut out = String::new();
    let verb = if report.dry_run {
        "would import"
    } else {
        "imported"
    };
    out.push_str(&format!(
        "{verb} {} subagent(s)\n",
        report.imported.len()
    ));
    for entry in &report.imported {
        out.push_str(&format!(
            "  {} ({}, from {})\n",
            entry.definition.name,
            entry.dialect.label(),
            entry.source.display()
        ));
        match &entry.definition.allowed_tools {
            Some(tools) => out.push_str(&format!("    tools: {}\n", tools.join(", "))),
            None => out.push_str("    tools: not narrowed (inherits the run's)\n"),
        }
        if let Some(model) = &entry.definition.model {
            out.push_str(&format!("    model: {model}\n"));
        }
        for note in &entry.notes {
            out.push_str(&format!("    note: {note}\n"));
        }
    }
    for reason in &report.skipped {
        out.push_str(&format!("  skipped {reason}\n"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "jan_agent_import_{tag}_{}_{}",
            std::process::id(),
            std::time::SystemTime::UNIX_EPOCH
                .elapsed()
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("temp root");
        root
    }

    fn write(dir: &Path, name: &str, content: &str) -> PathBuf {
        std::fs::create_dir_all(dir).expect("dir");
        let path = dir.join(name);
        std::fs::write(&path, content).expect("write");
        path
    }

    /// AH-118: an OpenCode agent, with its switches, its mode and the fields
    /// Flint has no room for.
    #[test]
    fn an_opencode_agent_becomes_a_subagent_and_says_what_it_left_behind() {
        let root = temp_root("opencode");
        let dir = root.join(".opencode").join("agent");
        let path = write(
            &dir,
            "reviewer.md",
            "---\n\
             description: Reviews code for defects\n\
             mode: subagent\n\
             model: anthropic/claude-sonnet-4\n\
             temperature: 0.1\n\
             tools:\n  \
             write: false\n  \
             edit: false\n  \
             read: true\n  \
             grep: true\n\
             permission:\n  \
             bash: ask\n\
             ---\n\n\
             Read the diff and report real defects.\n",
        );
        let (found, skipped) = read_all(&path).expect("reads");
        assert!(skipped.is_empty(), "{skipped:?}");
        assert_eq!(found.len(), 1);
        let one = &found[0];
        assert_eq!(one.dialect, Dialect::OpenCode);
        // The name comes from the file, the way OpenCode names them.
        assert_eq!(one.definition.name, "reviewer");
        assert_eq!(one.definition.description, "Reviews code for defects");
        assert_eq!(one.definition.model.as_deref(), Some("anthropic/claude-sonnet-4"));
        assert!(one.definition.system_prompt.starts_with("Read the diff"));
        assert_eq!(
            one.definition.allowed_tools.as_deref(),
            Some(["grep".to_string(), "read".to_string()].as_slice())
        );
        let notes = one.notes.join(" | ");
        assert!(notes.contains("temperature"), "{notes}");
        assert!(notes.contains("permission"), "{notes}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// OpenCode's switches can be subtractive: a map that only turns things
    /// off means everything else stays on, and Flint's allowlist says so.
    #[test]
    fn switches_that_only_turn_things_off_import_as_everything_else() {
        let root = temp_root("subtractive");
        let path = write(
            &root.join(".opencode").join("agent"),
            "safe.md",
            "---\ndescription: Looks, never touches\ntools:\n  write: false\n  edit: false\n---\n\nLook only.\n",
        );
        let (found, _) = read_all(&path).expect("reads");
        let tools = found[0].definition.allowed_tools.clone().expect("an allowlist");
        assert!(tools.contains(&"read".to_string()), "{tools:?}");
        assert!(!tools.contains(&"write".to_string()), "{tools:?}");
        assert!(!tools.contains(&"edit".to_string()), "{tools:?}");
        assert!(
            found[0].notes.iter().any(|n| n.contains("only turn things off")),
            "{:?}",
            found[0].notes
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// AH-119: a Qwen agent, whose tools are a list and whose name is in the
    /// frontmatter.
    #[test]
    fn a_qwen_agent_becomes_a_subagent() {
        let root = temp_root("qwen");
        let path = write(
            &root.join(".qwen").join("agents"),
            "tester.md",
            "---\nname: test-runner\ndescription: Runs the tests\ntools: read, bash, NotebookEdit\ncolor: blue\n---\n\nRun the suite and report.\n",
        );
        let (found, _) = read_all(&path).expect("reads");
        assert_eq!(found[0].dialect, Dialect::Qwen);
        assert_eq!(found[0].definition.name, "test-runner");
        assert_eq!(
            found[0].definition.allowed_tools.as_deref(),
            Some(["bash".to_string(), "read".to_string()].as_slice())
        );
        let notes = found[0].notes.join(" | ");
        assert!(notes.contains("NotebookEdit"), "{notes}");
        assert!(notes.contains("color"), "{notes}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A primary agent is not a subagent, and a disabled one is not wanted:
    /// both are passed over by name rather than imported or refused.
    #[test]
    fn a_primary_or_disabled_agent_is_passed_over_and_said_so() {
        let root = temp_root("skips");
        let dir = root.join(".opencode").join("agent");
        write(&dir, "build.md", "---\ndescription: The main one\nmode: primary\n---\n\nbe helpful\n");
        write(&dir, "off.md", "---\ndescription: Turned off\ndisable: true\n---\n\nnothing\n");
        write(&dir, "keep.md", "---\ndescription: Kept\nmode: subagent\n---\n\ndo the thing\n");
        let (found, skipped) = read_all(&dir).expect("reads");
        assert_eq!(found.len(), 1, "{found:#?}");
        assert_eq!(found[0].definition.name, "keep");
        assert_eq!(skipped.len(), 2, "{skipped:?}");
        assert!(skipped.iter().any(|s| s.contains("primary agent")), "{skipped:?}");
        assert!(skipped.iter().any(|s| s.contains("disabled")), "{skipped:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// What cannot be imported is refused as invalid input, by file, saying
    /// what was wanted -- never imported half-formed.
    #[test]
    fn what_cannot_be_imported_is_refused_with_a_typed_error() {
        let root = temp_root("refusals");
        let dir = root.join(".qwen").join("agents");

        let no_fence = write(&dir, "bare.md", "just a prompt, no frontmatter\n");
        let err = read_all(&no_fence).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::InvalidInput);
        assert!(err.message().contains("no YAML frontmatter"), "{err}");

        let no_description = write(&dir, "nodesc.md", "---\nname: x\n---\n\nbody\n");
        let err = read_all(&no_description).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::InvalidInput);
        assert!(err.message().contains("no description"), "{err}");

        let no_prompt = write(&dir, "noprompt.md", "---\nname: y\ndescription: Something\n---\n");
        let err = read_all(&no_prompt).unwrap_err();
        assert!(err.message().contains("no prompt"), "{err}");

        let bad_mode = write(&dir, "mode.md", "---\ndescription: d\nmode: sideways\n---\n\nbody\n");
        let err = read_all(&bad_mode).unwrap_err();
        assert!(err.message().contains("not one this understands"), "{err}");

        let missing = read_all(&root.join("nowhere")).unwrap_err();
        assert_eq!(missing.kind(), ErrorKind::NotFound);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// AH-118: agents declared in an `opencode.json` rather than as files.
    #[test]
    fn agents_declared_in_an_opencode_json_import_too() {
        let root = temp_root("json");
        let path = write(
            &root,
            "opencode.json",
            r#"{
              "agent": {
                "docs": {
                  "description": "Writes documentation",
                  "mode": "subagent",
                  "prompt": "Write the docs.",
                  "tools": { "read": true, "write": true }
                },
                "main": { "description": "The primary", "mode": "primary", "prompt": "hi" }
              }
            }"#,
        );
        let (found, skipped) = read_all(&path).expect("reads");
        assert_eq!(found.len(), 1, "{found:#?}");
        assert_eq!(found[0].definition.name, "docs");
        assert_eq!(found[0].definition.system_prompt, "Write the docs.");
        assert_eq!(
            found[0].definition.allowed_tools.as_deref(),
            Some(["read".to_string(), "write".to_string()].as_slice())
        );
        assert!(skipped.iter().any(|s| s.contains("primary")), "{skipped:?}");

        let empty = write(&root, "empty.json", r#"{"model": "x"}"#);
        let err = read_all(&empty).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::InvalidInput);
        assert!(err.message().contains("declares no agents"), "{err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// An import writes native definitions that load back as subagents, and a
    /// dry run writes nothing at all.
    #[test]
    fn an_import_writes_native_definitions_and_a_dry_run_writes_none() {
        let root = temp_root("write");
        let dir = root.join(".qwen").join("agents");
        write(
            &dir,
            "tester.md",
            "---\nname: tester\ndescription: Runs the tests\ntools: read, bash\n---\n\nRun them.\n",
        );
        let scope_dir = root.join("subagents");

        let dry = import(&dir, &scope_dir, SubagentScope::User, false, true).expect("dry run");
        assert_eq!(dry.imported.len(), 1);
        assert!(!scope_dir.join("tester.toml").exists(), "a dry run wrote a file");

        let done = import(&dir, &scope_dir, SubagentScope::User, false, false).expect("import");
        assert_eq!(done.imported.len(), 1);
        let written = std::fs::read_to_string(scope_dir.join("tester.toml")).expect("written");
        assert!(written.contains("name = \"tester\""), "{written}");
        assert!(written.contains("Run them."), "{written}");

        // Importing the same definition again refuses rather than clobbering.
        let again = import(&dir, &scope_dir, SubagentScope::User, false, false).unwrap_err();
        assert_eq!(again.kind(), ErrorKind::PolicyViolation);
        assert!(import(&dir, &scope_dir, SubagentScope::User, true, false).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A name refused only when it is written (illegal characters) still
    /// stops the import before the valid definitions ahead of it are written
    /// (Jozkah/jan#208).
    #[test]
    fn an_illegal_name_late_in_the_batch_writes_nothing() {
        let root = temp_root("late-refusal");
        let dir = root.join(".qwen").join("agents");
        write(&dir, "a.md", "---\nname: alpha\ndescription: Fine\n---\n\nbody\n");
        write(&dir, "b.md", "---\nname: code reviewer\ndescription: Fine\n---\n\nbody\n");
        let scope_dir = root.join("subagents");
        let err = import(&dir, &scope_dir, SubagentScope::User, false, false).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::PolicyViolation, "{err}");
        assert!(!scope_dir.join("alpha.toml").exists(), "a refused import still wrote");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Two definitions in one import with the same name are refused, with or
    /// without overwrite, instead of the second silently replacing the first.
    #[test]
    fn two_definitions_with_one_name_are_refused() {
        let root = temp_root("dupe");
        let dir = root.join(".qwen").join("agents");
        write(&dir, "a.md", "---\nname: helper\ndescription: One\n---\n\nfirst\n");
        write(&dir, "b.md", "---\nname: helper\ndescription: Two\n---\n\nsecond\n");
        let scope_dir = root.join("subagents");
        for overwrite in [false, true] {
            let err = import(&dir, &scope_dir, SubagentScope::User, overwrite, false).unwrap_err();
            assert_eq!(err.kind(), ErrorKind::InvalidInput, "{err}");
            assert!(!scope_dir.join("helper.toml").exists());
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A directory where one definition is malformed imports none of them: a
    /// half-imported directory is a state nobody can reason about.
    #[test]
    fn one_bad_definition_stops_the_whole_import() {
        let root = temp_root("atomic");
        let dir = root.join(".qwen").join("agents");
        write(&dir, "good.md", "---\nname: good\ndescription: Fine\n---\n\nbody\n");
        write(&dir, "bad.md", "---\nname: bad\n---\n\nbody\n");
        let scope_dir = root.join("subagents");
        let err = import(&dir, &scope_dir, SubagentScope::User, false, false).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::InvalidInput);
        assert!(!scope_dir.join("good.toml").exists(), "a refused import still wrote");
        let _ = std::fs::remove_dir_all(&root);
    }
}
