//! A project's agents, skills, commands and policy as one portable file
//! (AH-145).
//!
//! What a project has taught Flint lives in several places under
//! `<project>/.jan/agent/`: subagent definitions, skills (with the files a
//! skill bundles), plugin command templates, and the `[tools]` policy in
//! `agent.toml`. Moving that to another project meant copying four trees and
//! hand-merging a TOML section. This writes them as one bundle and reads one
//! back, so the same set arrives intact.
//!
//! Hostile input is assumed on import -- a bundle may have travelled:
//!
//! * **Paths are checked, never trusted.** Each entry is relative, inside one
//!   of the four component roots, free of `..`, drive letters, UNC and device
//!   names, and does not collide with another entry by case.
//! * **Contents are checked.** Each entry carries a SHA-256; a mismatch refuses
//!   the whole bundle. Text only, bounded per file and in total.
//! * **Policy cannot widen silently.** The `[tools]` section goes through the
//!   same comparison `flint cli agent policy import` uses: a bundle that would
//!   allow more than the project does now is refused unless widening is
//!   accepted explicitly.
//! * **All or nothing.** Everything is written to a staging directory first
//!   and moved into place only when every entry has been written; a failure
//!   part-way removes the staging directory and leaves the project as it was.
//! * **Nothing is overwritten by surprise.** An entry that exists with
//!   different content refuses the import unless `overwrite` is set.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};

pub const FORMAT: &str = "jan-agent-bundle";
pub const VERSION: u32 = 1;
pub const MAX_FILE_BYTES: usize = 1024 * 1024;
pub const MAX_TOTAL_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 2000;

/// The component roots a bundle may contain, relative to `.jan/agent`.
const ROOTS: &[(&str, Kind)] = &[
    ("subagents", Kind::Agent),
    ("skills", Kind::Skill),
    ("plugins", Kind::Command),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Agent,
    Skill,
    Command,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub kind: Kind,
    /// Relative to `.jan/agent`, `/`-separated.
    pub path: String,
    pub sha256: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bundle {
    pub format: String,
    pub version: u32,
    pub entries: Vec<Entry>,
    /// The `[tools]` policy, as `policy_transfer::render` writes it. `None`
    /// when the project has no readable configuration.
    pub policy: Option<String>,
}

/// What an export or import did, for a person to read.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub counts: BTreeMap<String, usize>,
    /// Entries left out, and why (a link, a binary file, a file too large).
    pub skipped: Vec<String>,
    /// Entries an import left alone because they were already identical.
    pub unchanged: usize,
    pub written: usize,
    pub policy: Option<String>,
}

fn err(kind: ErrorKind, stage: Stage, message: impl Into<String>) -> HarnessError {
    HarnessError::new(kind, message).at(stage)
}

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn agent_dir(project: &Path) -> PathBuf {
    project.join(".jan").join("agent")
}

/// Whether a bundle path is one this will write. Refuses everything that is
/// not a plain relative path under a component root.
fn checked_path(path: &str) -> Result<(Kind, PathBuf), String> {
    if path.is_empty() || path.len() > 512 {
        return Err(format!("{path:?} is not a usable path"));
    }
    if path.contains('\\') || path.contains(':') || path.starts_with('/') {
        return Err(format!("{path:?} is not a relative, /-separated path"));
    }
    let relative = PathBuf::from(path);
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(p) => {
                let s = p.to_string_lossy().to_string();
                let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
                let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
                    || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                        && stem.len() == 4
                        && stem.as_bytes()[3].is_ascii_digit());
                if reserved || s.ends_with('.') || s.ends_with(' ') || s == ".git" || s == ".jan" {
                    return Err(format!("{path:?} names something this will not write"));
                }
                parts.push(s);
            }
            _ => return Err(format!("{path:?} steps outside the bundle")),
        }
    }
    let Some(root) = parts.first() else {
        return Err(format!("{path:?} is empty"));
    };
    let Some((_, kind)) = ROOTS.iter().find(|(r, _)| r == root) else {
        return Err(format!("{path:?} is not under subagents/, skills/ or plugins/"));
    };
    // A plugin contributes only its command templates.
    if *kind == Kind::Command && (parts.len() != 4 || parts[2] != "commands" || !parts[3].ends_with(".md")) {
        return Err(format!("{path:?} is not a plugin command template (plugins/<p>/commands/<name>.md)"));
    }
    if parts.len() < 2 {
        return Err(format!("{path:?} names a directory, not a file"));
    }
    Ok((*kind, relative))
}

fn walk(dir: &Path, base: &Path, out: &mut Vec<PathBuf>, skipped: &mut Vec<String>) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = read.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        let rel = path.strip_prefix(base).unwrap_or(&path).to_string_lossy().replace('\\', "/");
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        // A link is where somebody's file is, not a file in this project.
        if meta.file_type().is_symlink() || is_reparse_point(&meta) {
            skipped.push(format!("{rel}: a link, not followed"));
            continue;
        }
        if meta.is_dir() {
            if rel.starts_with("plugins/") && rel.matches('/').count() == 1 {
                // plugins/<p> -> only its commands directory.
                walk(&path.join("commands"), base, out, skipped);
            } else if !rel.starts_with("plugins") || rel.contains("/commands") {
                walk(&path, base, out, skipped);
            }
        } else if meta.is_file() {
            out.push(path);
        }
    }
}

#[cfg(windows)]
fn is_reparse_point(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes() & 0x400 != 0
}
#[cfg(not(windows))]
fn is_reparse_point(_meta: &std::fs::Metadata) -> bool {
    false
}

/// Gather a project's components into a bundle.
pub fn export(project: &Path) -> Result<(Bundle, Report), HarnessError> {
    let base = agent_dir(project);
    let mut files = Vec::new();
    let mut report = Report::default();
    for (root, _) in ROOTS {
        if *root == "plugins" {
            let Ok(read) = std::fs::read_dir(base.join("plugins")) else { continue };
            for p in read.flatten() {
                if p.file_name().to_string_lossy().starts_with(".installing-") {
                    continue;
                }
                walk(&p.path().join("commands"), &base, &mut files, &mut report.skipped);
            }
        } else {
            walk(&base.join(root), &base, &mut files, &mut report.skipped);
        }
    }
    let mut entries = Vec::new();
    let mut total = 0usize;
    for file in files {
        let rel = file.strip_prefix(&base).unwrap_or(&file).to_string_lossy().replace('\\', "/");
        let Ok((kind, _)) = checked_path(&rel) else {
            report.skipped.push(format!("{rel}: not a component this bundle carries"));
            continue;
        };
        let bytes = std::fs::read(&file).map_err(|e| {
            err(ErrorKind::Io, Stage::Export, format!("{rel} could not be read: {e}"))
        })?;
        if bytes.len() > MAX_FILE_BYTES {
            report.skipped.push(format!("{rel}: larger than {MAX_FILE_BYTES} bytes"));
            continue;
        }
        let Ok(content) = String::from_utf8(bytes.clone()) else {
            report.skipped.push(format!("{rel}: not text"));
            continue;
        };
        total += bytes.len();
        if total > MAX_TOTAL_BYTES || entries.len() >= MAX_ENTRIES {
            return Err(err(
                ErrorKind::Export,
                Stage::Export,
                format!("the components exceed a bundle's bounds ({MAX_ENTRIES} files, {MAX_TOTAL_BYTES} bytes)"),
            ));
        }
        *report.counts.entry(format!("{kind:?}").to_lowercase()).or_default() += 1;
        entries.push(Entry { kind, path: rel, sha256: sha(&bytes), content });
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    let policy = crate::core::agent::project::load_agent_config(project).ok().map(|cfg| {
        tauri_plugin_agent_tools::policy_transfer::render(&tauri_plugin_agent_tools::policy_transfer::export(
            cfg.tools.default.as_deref().unwrap_or("read-only"),
            &cfg.tools.allow,
            &cfg.tools.deny,
            &cfg.tools.allow_write,
        ))
    });
    report.policy = policy.as_ref().map(|_| "included".to_string());
    Ok((Bundle { format: FORMAT.into(), version: VERSION, entries, policy }, report))
}

/// Read and check a bundle's text before anything is written.
pub fn parse(text: &str) -> Result<Bundle, HarnessError> {
    if text.len() > MAX_TOTAL_BYTES * 2 {
        return Err(err(ErrorKind::InvalidInput, Stage::Startup, "the bundle is larger than any bundle this writes"));
    }
    let bundle: Bundle = serde_json::from_str(text).map_err(|e| {
        err(ErrorKind::InvalidInput, Stage::Startup, format!("this is not a bundle this can read: {e}"))
    })?;
    if bundle.format != FORMAT || bundle.version != VERSION {
        return Err(err(
            ErrorKind::Unsupported,
            Stage::Startup,
            format!("a {} v{} bundle is not one this reads ({FORMAT} v{VERSION})", bundle.format, bundle.version),
        ));
    }
    if bundle.entries.len() > MAX_ENTRIES {
        return Err(err(ErrorKind::InvalidInput, Stage::Startup, "the bundle has more entries than a bundle may"));
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut total = 0usize;
    for entry in &bundle.entries {
        let (kind, _) = checked_path(&entry.path)
            .map_err(|m| err(ErrorKind::InvalidInput, Stage::Startup, m))?;
        if kind != entry.kind {
            return Err(err(ErrorKind::InvalidInput, Stage::Startup, format!("{} claims to be a {:?} and is not", entry.path, entry.kind)));
        }
        if !seen.insert(entry.path.to_lowercase()) {
            return Err(err(ErrorKind::InvalidInput, Stage::Startup, format!("{} appears twice (paths are compared without case)", entry.path)));
        }
        if entry.content.len() > MAX_FILE_BYTES {
            return Err(err(ErrorKind::InvalidInput, Stage::Startup, format!("{} is larger than a bundle entry may be", entry.path)));
        }
        total += entry.content.len();
        if sha(entry.content.as_bytes()) != entry.sha256 {
            return Err(err(ErrorKind::InvalidInput, Stage::Startup, format!("{} does not match its checksum", entry.path)));
        }
    }
    if total > MAX_TOTAL_BYTES {
        return Err(err(ErrorKind::InvalidInput, Stage::Startup, "the bundle's contents exceed a bundle's bounds"));
    }
    Ok(bundle)
}

/// Write a bundle into a project. Nothing is written when `dry_run`.
pub fn import(
    project: &Path,
    bundle: &Bundle,
    overwrite: bool,
    accept_widening: bool,
    dry_run: bool,
) -> Result<Report, HarnessError> {
    let base = agent_dir(project);
    let mut report = Report::default();
    let mut to_write = Vec::new();
    for entry in &bundle.entries {
        let target = base.join(&entry.path);
        // The target itself, and every directory above it inside the agent
        // dir, must not be a link: writing through one writes somewhere else.
        let mut probe = base.clone();
        for part in Path::new(&entry.path).components() {
            probe.push(part);
            if let Ok(meta) = std::fs::symlink_metadata(&probe) {
                if meta.file_type().is_symlink() || is_reparse_point(&meta) {
                    return Err(err(ErrorKind::PolicyViolation, Stage::Persistence, format!("{} would be written through a link", entry.path)));
                }
            }
        }
        match std::fs::read(&target) {
            Ok(existing) if existing == entry.content.as_bytes() => report.unchanged += 1,
            Ok(_) if !overwrite => {
                return Err(err(
                    ErrorKind::PolicyViolation,
                    Stage::Persistence,
                    format!("{} already exists with different content; pass overwrite to replace it", entry.path),
                ))
            }
            _ => to_write.push(entry),
        }
        *report.counts.entry(format!("{:?}", entry.kind).to_lowercase()).or_default() += 1;
    }
    // Policy is planned before anything is written, so a refused widening
    // leaves the components unwritten too.
    let mut policy_write = None;
    if let Some(text) = &bundle.policy {
        let current = crate::core::agent::project::load_agent_config(project)
            .map(|cfg| {
                tauri_plugin_agent_tools::policy_transfer::export(
                    cfg.tools.default.as_deref().unwrap_or("read-only"),
                    &cfg.tools.allow,
                    &cfg.tools.deny,
                    &cfg.tools.allow_write,
                )
            })
            .unwrap_or_else(|_| tauri_plugin_agent_tools::policy_transfer::export("read-only", &[], &[], &[]));
        let (document, change) = tauri_plugin_agent_tools::policy_transfer::plan_import(
            &current,
            text,
            if accept_widening {
                tauri_plugin_agent_tools::policy_transfer::Widening::Accept
            } else {
                tauri_plugin_agent_tools::policy_transfer::Widening::Refuse
            },
        )?;
        report.policy = Some(if change.is_empty() { "unchanged".into() } else { "changed".into() });
        if !change.is_empty() {
            policy_write = Some(document);
        }
    }
    if dry_run {
        report.written = to_write.len();
        return Ok(report);
    }
    std::fs::create_dir_all(&base).map_err(|e| err(ErrorKind::Io, Stage::Persistence, format!("the project's agent directory is not writable: {e}")))?;
    let staging = base.join(format!(".bundle-import-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    let staged = (|| -> Result<(), HarnessError> {
        for entry in &to_write {
            let path = staging.join(&entry.path);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| err(ErrorKind::Io, Stage::Persistence, format!("{}: {e}", entry.path)))?;
            }
            std::fs::write(&path, entry.content.as_bytes()).map_err(|e| err(ErrorKind::Io, Stage::Persistence, format!("{}: {e}", entry.path)))?;
        }
        Ok(())
    })();
    if let Err(e) = staged {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    for entry in &to_write {
        let from = staging.join(&entry.path);
        let to = base.join(&entry.path);
        if let Some(parent) = to.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::remove_file(&to);
        if let Err(e) = std::fs::rename(&from, &to) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(err(ErrorKind::Io, Stage::Persistence, format!("{} could not be moved into place: {e}", entry.path)));
        }
        report.written += 1;
    }
    let _ = std::fs::remove_dir_all(&staging);
    if let Some(document) = policy_write {
        let path = base.join("agent.toml");
        let existing = std::fs::read_to_string(&path).unwrap_or_default();
        let rewritten = crate::core::agent::project::replace_tools_section(
            &existing,
            &tauri_plugin_agent_tools::policy_transfer::to_toml(&document),
        );
        std::fs::write(&path, rewritten).map_err(|e| err(ErrorKind::Io, Stage::Persistence, format!("the policy could not be written: {e}")))?;
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "jan_bundle_{tag}_{}_{}",
            std::process::id(),
            std::time::SystemTime::UNIX_EPOCH.elapsed().unwrap().as_nanos()
        ));
        std::fs::create_dir_all(agent_dir(&root)).unwrap();
        root
    }

    fn put(root: &Path, rel: &str, text: &str) {
        let p = agent_dir(root).join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    fn seeded() -> PathBuf {
        let root = project("src");
        put(&root, "agent.toml", "[agent]\nmodel = \"m\"\n\n[tools]\ndefault = \"read-only\"\ndeny = [\"bash\"]\n");
        put(&root, "subagents/reviewer.toml", "name = \"reviewer\"\ndescription = \"d\"\nsystem_prompt = \"p\"\n");
        put(&root, "skills/deploy/SKILL.md", "---\ndescription: ship\n---\nsteps\n");
        put(&root, "skills/deploy/scripts/run.sh", "echo ship\n");
        put(&root, "skills/flat.md", "flat skill\n");
        put(&root, "plugins/release/commands/cut.md", "cut a release\n");
        put(&root, "plugins/release/plugin.json", "{\"not\": \"a command\"}");
        std::fs::create_dir_all(agent_dir(&root).join("plugins/.installing-x/commands")).unwrap();
        put(&root, "plugins/.installing-x/commands/half.md", "half installed\n");
        std::fs::write(agent_dir(&root).join("skills/deploy/logo.bin"), [0u8, 159, 146, 150]).unwrap();
        root
    }

    #[test]
    fn components_round_trip_into_an_empty_project_unchanged() {
        let src = seeded();
        let (bundle, report) = export(&src).unwrap();
        let paths: Vec<&str> = bundle.entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                "plugins/release/commands/cut.md",
                "skills/deploy/SKILL.md",
                "skills/deploy/scripts/run.sh",
                "skills/flat.md",
                "subagents/reviewer.toml"
            ]
        );
        assert!(report.skipped.iter().any(|s| s.contains("logo.bin") && s.contains("not text")), "{:?}", report.skipped);
        assert!(bundle.policy.as_deref().unwrap().contains("bash"));

        let text = serde_json::to_string(&bundle).unwrap();
        let dst = project("dst");
        let parsed = parse(&text).unwrap();
        let written = import(&dst, &parsed, false, false, false).unwrap();
        assert_eq!(written.written, 5);
        let (again, _) = export(&dst).unwrap();
        assert_eq!(again.entries, bundle.entries, "a second export is the first");
        assert!(again.policy.as_deref().unwrap().contains("bash"), "the policy came across");
        // A second import of the same bundle changes nothing.
        let repeat = import(&dst, &parsed, false, false, false).unwrap();
        assert_eq!((repeat.written, repeat.unchanged), (0, 5));
    }

    #[test]
    fn a_hostile_bundle_is_refused_before_anything_is_written() {
        let src = seeded();
        let (bundle, _) = export(&src).unwrap();
        let dst = project("hostile");
        let tamper = |f: &dyn Fn(&mut Bundle)| {
            let mut b = bundle.clone();
            f(&mut b);
            parse(&serde_json::to_string(&b).unwrap())
        };
        for bad in ["../escape.md", "skills/../../x.md", "C:/x.md", "/abs.md", "skills\\x.md", "skills/CON.md", "other/x.md", "plugins/p/plugin.json", "skills/.git"] {
            let r = tamper(&|b| { b.entries[1].path = bad.to_string(); });
            assert!(r.is_err(), "{bad} was accepted");
        }
        let r = tamper(&|b| b.entries[1].content.push_str("tampered"));
        assert!(r.unwrap_err().message().contains("checksum"));
        let r = tamper(&|b| { let e = b.entries[1].clone(); let mut e2 = e.clone(); e2.path = e.path.to_uppercase().replacen("SKILLS", "skills", 1); b.entries.push(e2); });
        assert!(r.unwrap_err().message().contains("twice"));
        let r = tamper(&|b| b.version = 99);
        assert_eq!(r.unwrap_err().kind(), ErrorKind::Unsupported);
        assert!(parse("{\"format\":\"jan-agent-bundle\",\"version\":1,\"entries\":[],\"policy\":null,\"extra\":1}").is_err());
        assert!(std::fs::read_dir(agent_dir(&dst)).unwrap().next().is_none(), "nothing was written");
    }

    #[test]
    fn a_widening_policy_or_a_conflict_refuses_the_whole_import() {
        let src = seeded();
        let (mut bundle, _) = export(&src).unwrap();
        bundle.policy = Some(tauri_plugin_agent_tools::policy_transfer::render(
            &tauri_plugin_agent_tools::policy_transfer::export("allow", &["bash".into()], &[], &[]),
        ));
        let dst = project("widen");
        put(&dst, "agent.toml", "[tools]\ndefault = \"read-only\"\ndeny = [\"bash\"]\n");
        let refused = import(&dst, &bundle, false, false, false).unwrap_err();
        assert!(!agent_dir(&dst).join("subagents").exists(), "no component was written: {refused}");
        assert!(import(&dst, &bundle, false, true, false).is_ok(), "an explicit acceptance allows it");

        let conflict = project("conflict");
        put(&conflict, "skills/flat.md", "mine\n");
        let (plain, _) = export(&src).unwrap();
        let e = import(&conflict, &plain, false, false, false).unwrap_err();
        assert_eq!(e.kind(), ErrorKind::PolicyViolation);
        assert_eq!(std::fs::read_to_string(agent_dir(&conflict).join("skills/flat.md")).unwrap(), "mine\n");
        assert!(!agent_dir(&conflict).join("subagents").exists());
        assert!(import(&conflict, &plain, true, false, false).is_ok());
    }

    #[test]
    fn a_dry_run_writes_nothing_and_no_staging_is_left_behind() {
        let src = seeded();
        let (bundle, _) = export(&src).unwrap();
        let dst = project("dry");
        let r = import(&dst, &bundle, false, false, true).unwrap();
        assert_eq!(r.written, 5);
        assert!(!agent_dir(&dst).join("skills").exists());
        import(&dst, &bundle, false, false, false).unwrap();
        let leftovers: Vec<_> = std::fs::read_dir(agent_dir(&dst)).unwrap().flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".bundle-import")).collect();
        assert!(leftovers.is_empty());
    }
}
