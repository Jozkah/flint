//! Import from Claude Code: scan `~/.claude` (and `<root>/*/.claude` project
//! dirs) for Claude Code skills and plugins, and copy selected items into
//! Flint's global agent store (`user_skills_dir()` / `user_plugins_dir()`).
//!
//! Claude Code skills live at `~/.claude/skills/<name>/SKILL.md`; a directory
//! without a `SKILL.md` is not a valid skill and is ignored. Claude Code
//! plugins are recorded in `~/.claude/plugins/installed_plugins.json`, whose
//! `installPath` points at the on-disk plugin directory. Project-scoped
//! sources are found one level under a scan root, at
//! `<root>/<project>/.claude/{skills,plugins}`.
//!
//! Flint's plugin layout mirrors Claude Code's: `<plugin>/skills`,
//! `<plugin>/commands`, `<plugin>/agents`, plus a handful of top-level
//! manifest files. Only those are copied in; anything else (`.mcp.json`,
//! hooks, `.git`, `node_modules`, ...) is left behind.
//!
//! An import is a *live link*, not a one-off copy: each imported item is
//! recorded in `cc-links.json` (see `cc_links`) and [`sync_links`] re-copies it
//! whenever its source in `~/.claude` changes. Plugin hooks are not copied --
//! `cc_hooks` runs them from the source, so their scripts keep working.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::core::agent::cc_links::{self, Link, LinkKind};
use crate::core::agent::skills::{user_plugins_dir, user_skills_dir};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CcItemKind {
    Skill,
    Plugin,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CcItem {
    pub kind: CcItemKind,
    pub name: String,
    pub source_path: String,
    /// `"cc-user"` for `~/.claude`, `"project:<folder>"` for a project scan hit.
    pub origin: String,
    pub already_exists: bool,
    /// Imported as a live link: edits at the source reach Flint on their own.
    pub linked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CcScan {
    pub items: Vec<CcItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CcImportSelection {
    pub kind: CcItemKind,
    pub name: String,
    pub source_path: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CcImportResult {
    pub imported: Vec<String>,
    pub skipped: Vec<String>,
    pub errors: Vec<String>,
}

// ---------------------------------------------------------------------
// Hermetic test overrides for the CC home (`~/.claude`) and the default
// project scan root, mirroring `TEST_USER_SKILLS` / `TEST_USER_PLUGINS` in
// `skills.rs` so tests never touch the real filesystem.
// ---------------------------------------------------------------------

#[cfg(not(test))]
fn cc_home() -> Option<PathBuf> {
    crate::core::app::commands::jan_home_dir().map(|h| h.join(".claude"))
}

#[cfg(test)]
thread_local! {
    static TEST_CC_HOME: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
    static TEST_SCAN_ROOT: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn cc_home() -> Option<PathBuf> {
    TEST_CC_HOME.with(|d| d.borrow().clone())
}

#[cfg(test)]
pub(crate) fn set_test_cc_home(dir: Option<PathBuf>) {
    TEST_CC_HOME.with(|d| *d.borrow_mut() = dir);
}

#[cfg(not(test))]
fn default_scan_root() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join("Desktop").join("Coding"))
}

#[cfg(test)]
fn default_scan_root() -> Option<PathBuf> {
    TEST_SCAN_ROOT.with(|d| d.borrow().clone())
}

#[cfg(test)]
pub(crate) fn set_test_scan_root(dir: Option<PathBuf>) {
    TEST_SCAN_ROOT.with(|d| *d.borrow_mut() = dir);
}

// ---------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------

/// A dir is a valid skill iff it directly contains `SKILL.md`.
fn is_skill_dir(dir: &Path) -> bool {
    dir.is_dir() && dir.join("SKILL.md").is_file()
}

fn scan_skills_under(skills_root: &Path, origin: &str, out: &mut Vec<(String, PathBuf, String)>) {
    let Ok(entries) = fs::read_dir(skills_root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if is_skill_dir(&path) {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                out.push((name.to_string(), path.clone(), origin.to_string()));
            }
        }
    }
}

#[derive(Deserialize)]
struct InstalledPlugins {
    #[serde(default)]
    plugins: std::collections::BTreeMap<String, Vec<InstalledPluginEntry>>,
}

#[derive(Deserialize)]
struct InstalledPluginEntry {
    #[serde(rename = "installPath")]
    install_path: String,
    #[serde(rename = "lastUpdated", default)]
    last_updated: Option<String>,
}

/// Parse `installed_plugins.json`, resolving each `<name>@<marketplace>` key
/// to its simple name and its install dir (latest `lastUpdated`, else first).
fn scan_installed_plugins(
    claude_home: &Path,
    origin: &str,
    out: &mut Vec<(String, PathBuf, String)>,
) {
    let path = claude_home.join("plugins").join("installed_plugins.json");
    let Ok(raw) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(parsed) = serde_json::from_str::<InstalledPlugins>(&raw) else {
        return;
    };
    for (key, entries) in parsed.plugins {
        if entries.is_empty() {
            continue;
        }
        let best = entries
            .iter()
            .max_by(|a, b| a.last_updated.cmp(&b.last_updated))
            .unwrap_or(&entries[0]);
        let simple_name = key.split('@').next().unwrap_or(&key).to_string();
        out.push((
            simple_name,
            PathBuf::from(&best.install_path),
            origin.to_string(),
        ));
    }
}

fn scan_project_plugins(
    project_claude: &Path,
    origin: &str,
    out: &mut Vec<(String, PathBuf, String)>,
) {
    let plugins_dir = project_claude.join("plugins");
    let Ok(entries) = fs::read_dir(&plugins_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                out.push((name.to_string(), path.clone(), origin.to_string()));
            }
        }
    }
}

fn dir_exists(name: &str, base: Option<PathBuf>) -> bool {
    base.map(|b| b.join(name).is_dir()).unwrap_or(false)
}

/// Whether the skill store already holds `name`, in either form: the folder
/// (`<name>/SKILL.md`) or a legacy flat `<name>.md` (Jozkah/jan#286). The
/// folder form wins on lookup, so importing over a flat skill silently
/// hides it unless this counts it as existing.
fn skill_exists(name: &str, base: Option<PathBuf>) -> bool {
    base.map(|b| b.join(name).is_dir() || b.join(format!("{name}.md")).is_file())
        .unwrap_or(false)
}

#[cfg_attr(not(feature = "cli"), tauri::command)]
pub async fn agent_cc_scan(root: Option<String>) -> Result<CcScan, String> {
    let mut skill_hits: Vec<(String, PathBuf, String)> = Vec::new();
    let mut plugin_hits: Vec<(String, PathBuf, String)> = Vec::new();

    if let Some(home) = cc_home() {
        scan_skills_under(&home.join("skills"), "cc-user", &mut skill_hits);
        scan_installed_plugins(&home, "cc-user", &mut plugin_hits);
    }

    let scan_root = root.map(PathBuf::from).or_else(default_scan_root);
    if let Some(scan_root) = scan_root {
        if let Ok(entries) = fs::read_dir(&scan_root) {
            for entry in entries.flatten() {
                let project_dir = entry.path();
                if !project_dir.is_dir() {
                    continue;
                }
                let Some(project_name) = project_dir.file_name().and_then(|n| n.to_str()) else {
                    continue;
                };
                let origin = format!("project:{project_name}");
                let project_claude = project_dir.join(".claude");
                scan_skills_under(&project_claude.join("skills"), &origin, &mut skill_hits);
                scan_project_plugins(&project_claude, &origin, &mut plugin_hits);
            }
        }
    }

    let global_skills = user_skills_dir();
    let global_plugins = user_plugins_dir();
    let links = cc_links::load();

    let mut items: Vec<CcItem> = Vec::new();
    for (name, path, origin) in skill_hits {
        items.push(CcItem {
            kind: CcItemKind::Skill,
            already_exists: skill_exists(&name, global_skills.clone()),
            linked: links.is_linked(LinkKind::Skill, &name),
            name,
            source_path: path.to_string_lossy().into_owned(),
            origin,
        });
    }
    for (name, path, origin) in plugin_hits {
        items.push(CcItem {
            kind: CcItemKind::Plugin,
            already_exists: dir_exists(&name, global_plugins.clone()),
            linked: links.is_linked(LinkKind::Plugin, &name),
            name,
            source_path: path.to_string_lossy().into_owned(),
            origin,
        });
    }

    Ok(CcScan { items })
}

// ---------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------

/// Reject path separators and `..` segments so a crafted name cannot escape
/// the target store.
fn sanitize_name(name: &str) -> Result<&str, String> {
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.split(['/', '\\']).any(|seg| seg == "..")
        || name == ".."
        || name == "."
    {
        return Err(format!("invalid item name: {name:?}"));
    }
    Ok(name)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_name = entry.file_name();
        let name_str = file_name.to_string_lossy();
        if name_str == ".git" || name_str == "node_modules" {
            continue;
        }
        let src_path = entry.path();
        let dst_path = dst.join(&file_name);
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else if src_path.is_file() {
            fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

fn remove_target_if_present(target: &Path) -> std::io::Result<()> {
    if target.is_dir() {
        fs::remove_dir_all(target)?;
    } else if target.is_file() {
        fs::remove_file(target)?;
    }
    Ok(())
}

/// Build `target`'s new contents in a staging directory beside it, and only
/// once that succeeded swap it in (Jozkah/jan#278). The old copy is moved
/// aside rather than deleted first, and put back if the swap fails, so a
/// missing source or an IO error part-way through never leaves the user with
/// neither the old skill nor the new one.
fn replace_dir(target: &Path, fill: impl FnOnce(&Path) -> std::io::Result<()>) -> Result<(), String> {
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let pid = std::process::id();
    let staging = target.with_file_name(format!(".{name}.importing-{pid}"));
    let aside = target.with_file_name(format!(".{name}.replaced-{pid}"));
    let _ = remove_target_if_present(&staging);
    let _ = remove_target_if_present(&aside);
    if let Err(e) = fs::create_dir_all(&staging).and_then(|_| fill(&staging)) {
        let _ = remove_target_if_present(&staging);
        return Err(e.to_string());
    }
    let had_old = target.exists();
    if had_old {
        if let Err(e) = fs::rename(target, &aside) {
            let _ = remove_target_if_present(&staging);
            return Err(e.to_string());
        }
    }
    if let Err(e) = fs::rename(&staging, target) {
        if had_old {
            let _ = fs::rename(&aside, target);
        }
        let _ = remove_target_if_present(&staging);
        return Err(e.to_string());
    }
    if had_old {
        let _ = remove_target_if_present(&aside);
    }
    Ok(())
}

fn import_skill(source_path: &Path, name: &str, overwrite: bool) -> Result<String, String> {
    let dest_root =
        user_skills_dir().ok_or_else(|| "no global skills store resolved".to_string())?;
    let target = dest_root.join(name);
    let flat = dest_root.join(format!("{name}.md"));
    if (target.exists() || flat.is_file()) && !overwrite {
        return Err("skipped".to_string());
    }
    // Checked before anything at the destination is touched.
    if !source_path.is_dir() && !source_path.is_file() {
        return Err(format!("source not found: {}", source_path.display()));
    }
    fs::create_dir_all(&dest_root).map_err(|e| e.to_string())?;
    replace_dir(&target, |staging| {
        if source_path.is_dir() {
            copy_dir_recursive(source_path, staging)
        } else {
            // Flat SKILL.md-only source: write it into `<target>/SKILL.md`.
            fs::copy(source_path, staging.join("SKILL.md")).map(|_| ())
        }
    })?;
    // An overwrite replaced the flat form too: left in place it would only
    // be a shadowed copy the folder now hides.
    if flat.is_file() {
        let _ = fs::remove_file(&flat);
    }
    Ok("imported".to_string())
}

const PLUGIN_SUBDIRS: [&str; 3] = ["skills", "commands", "agents"];
const PLUGIN_TOP_FILES: [&str; 3] = ["SKILL.md", "README.md", "plugin.json"];

fn import_plugin(source_path: &Path, name: &str, overwrite: bool) -> Result<String, String> {
    let dest_root =
        user_plugins_dir().ok_or_else(|| "no global plugins store resolved".to_string())?;
    let target = dest_root.join(name);
    if target.exists() && !overwrite {
        return Err("skipped".to_string());
    }
    if !source_path.is_dir() {
        return Err(format!(
            "plugin source not found: {}",
            source_path.display()
        ));
    }
    fs::create_dir_all(&dest_root).map_err(|e| e.to_string())?;
    replace_dir(&target, |staging| {
        for sub in PLUGIN_SUBDIRS {
            let src_sub = source_path.join(sub);
            if src_sub.is_dir() {
                copy_dir_recursive(&src_sub, &staging.join(sub))?;
            }
        }
        for f in PLUGIN_TOP_FILES {
            let src_f = source_path.join(f);
            if src_f.is_file() {
                fs::copy(&src_f, staging.join(f))?;
            }
        }
        // `.claude-plugin/plugin.json` manifest.
        let manifest = source_path.join(".claude-plugin").join("plugin.json");
        if manifest.is_file() {
            let dest_dir = staging.join(".claude-plugin");
            fs::create_dir_all(&dest_dir)?;
            fs::copy(&manifest, dest_dir.join("plugin.json"))?;
        }
        Ok(())
    })?;
    Ok("imported".to_string())
}

#[cfg_attr(not(feature = "cli"), tauri::command)]
pub async fn agent_cc_import(
    items: Vec<CcImportSelection>,
    overwrite: bool,
    link_hooks: Option<bool>,
) -> Result<CcImportResult, String> {
    let mut result = CcImportResult::default();
    let mut links = cc_links::load();

    // One name, two sources (a user skill and a project skill both called
    // `foo`) would land on the same target: the second would silently
    // replace the first, or be reported as a mere skip (Jozkah/jan#290).
    // Neither is imported; the user is asked to pick one.
    let mut sources: std::collections::HashMap<(bool, String), Vec<String>> = Default::default();
    for item in &items {
        sources
            .entry((matches!(item.kind, CcItemKind::Skill), item.name.trim().to_string()))
            .or_default()
            .push(item.source_path.clone());
    }
    let mut reported = std::collections::HashSet::new();

    for item in items {
        let key = (matches!(item.kind, CcItemKind::Skill), item.name.trim().to_string());
        if let Some(paths) = sources.get(&key).filter(|p| p.len() > 1) {
            if reported.insert(key.clone()) {
                result.errors.push(format!(
                    "{}: selected from {} places ({}); choose one to import",
                    key.1,
                    paths.len(),
                    paths.join(", ")
                ));
            }
            continue;
        }
        let name = match sanitize_name(&item.name) {
            Ok(n) => n,
            Err(e) => {
                result.errors.push(format!("{}: {e}", item.name));
                continue;
            }
        };
        let source_path = PathBuf::from(&item.source_path);
        let outcome = match item.kind {
            CcItemKind::Skill => import_skill(&source_path, name, overwrite),
            CcItemKind::Plugin => import_plugin(&source_path, name, overwrite),
        };
        match outcome {
            Ok(_) => {
                // The import is a live link: remember where it came from so
                // `sync_links` can bring later edits across.
                links.upsert(Link {
                    kind: match item.kind {
                        CcItemKind::Skill => LinkKind::Skill,
                        CcItemKind::Plugin => LinkKind::Plugin,
                    },
                    name: name.to_string(),
                    origin: origin_of(&item.source_path),
                    source_path: item.source_path.clone(),
                    fingerprint: cc_links::fingerprint(&source_path),
                });
                result.imported.push(name.to_string());
            }
            Err(e) if e == "skipped" => result.skipped.push(name.to_string()),
            Err(e) => result.errors.push(format!("{name}: {e}")),
        }
    }

    if let Some(hooks) = link_hooks {
        links.hooks = hooks;
    }
    if let Err(e) = cc_links::save(&links) {
        result
            .errors
            .push(format!("could not record the live link: {e}"));
    }

    Ok(result)
}

/// `cc-user` when `source_path` is something Claude Code itself installed
/// (under `~/.claude`, or a plugin `installed_plugins.json` points at), else
/// `project`. Only `cc-user` plugins are re-resolved through
/// `installed_plugins.json` on sync.
fn origin_of(source_path: &str) -> String {
    let Some(home) = cc_home() else {
        return "project".to_string();
    };
    if Path::new(source_path).starts_with(&home) {
        return "cc-user".to_string();
    }
    let mut hits = Vec::new();
    scan_installed_plugins(&home, "cc-user", &mut hits);
    if hits.iter().any(|(_, p, _)| p == Path::new(source_path)) {
        "cc-user".to_string()
    } else {
        "project".to_string()
    }
}

// ---------------------------------------------------------------------
// Live sync
// ---------------------------------------------------------------------

/// How long a sync result is trusted. Every reader of the global stores asks
/// for a refresh; this keeps that from walking `~/.claude` on each call.
#[cfg(not(test))]
const SYNC_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

#[cfg(not(test))]
static SYNCING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
#[cfg(not(test))]
static LAST_SYNC: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);

/// Refresh linked items if the last refresh is older than [`SYNC_INTERVAL`].
/// Re-entrant calls (the refresh itself reads the stores) are ignored.
#[cfg(not(test))]
pub(crate) fn sync_if_due() {
    use std::sync::atomic::Ordering;
    if SYNCING.swap(true, Ordering::AcqRel) {
        return;
    }
    struct Done;
    impl Drop for Done {
        fn drop(&mut self) {
            SYNCING.store(false, Ordering::Release);
        }
    }
    let _done = Done;
    let due = match LAST_SYNC.lock() {
        Ok(mut last) => match *last {
            Some(at) if at.elapsed() < SYNC_INTERVAL => false,
            _ => {
                *last = Some(std::time::Instant::now());
                true
            }
        },
        Err(_) => false,
    };
    if due {
        sync_links();
    }
}

/// Where a link's item lives now. A `cc-user` plugin is looked up in
/// `installed_plugins.json` again, because updating it installs a new
/// versioned directory and leaves the old path behind.
fn current_source(link: &Link) -> PathBuf {
    if link.kind == LinkKind::Plugin && link.origin == "cc-user" {
        if let Some(home) = cc_home() {
            let mut hits = Vec::new();
            scan_installed_plugins(&home, "cc-user", &mut hits);
            if let Some((_, path, _)) = hits.into_iter().find(|(n, _, _)| *n == link.name) {
                return path;
            }
        }
    }
    PathBuf::from(&link.source_path)
}

/// Bring every linked item up to date with its source. Returns how many were
/// re-copied.
///
/// * A source that is gone keeps the last copy: deleting something in Claude
///   Code must not silently empty Flint mid-session.
/// * A target the user removed from Flint drops its link instead of being
///   recreated: removing an item in Flint has to stay removed.
pub(crate) fn sync_links() -> usize {
    let mut links = cc_links::load();
    if links.items.is_empty() {
        return 0;
    }
    let mut refreshed = 0;
    let mut changed = false;
    let mut kept: Vec<Link> = Vec::with_capacity(links.items.len());
    for mut link in std::mem::take(&mut links.items) {
        let target_present = match link.kind {
            LinkKind::Skill => skill_exists(&link.name, user_skills_dir()),
            LinkKind::Plugin => dir_exists(&link.name, user_plugins_dir()),
        };
        if !target_present {
            changed = true;
            continue;
        }
        let source = current_source(&link);
        if source.exists() {
            let fingerprint = cc_links::fingerprint(&source);
            let moved = source.to_string_lossy() != link.source_path;
            if fingerprint != link.fingerprint || moved {
                let outcome = match link.kind {
                    LinkKind::Skill => import_skill(&source, &link.name, true),
                    LinkKind::Plugin => import_plugin(&source, &link.name, true),
                };
                match outcome {
                    Ok(_) => {
                        link.fingerprint = fingerprint;
                        link.source_path = source.to_string_lossy().into_owned();
                        refreshed += 1;
                        changed = true;
                    }
                    Err(e) => log::warn!("cc link: could not refresh {}: {e}", link.name),
                }
            }
        }
        kept.push(link);
    }
    links.items = kept;
    if changed {
        let _ = cc_links::save(&links);
    }
    refreshed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::agent::skills::{set_test_user_plugins, set_test_user_skills};
    use std::fs;
    use tempfile::tempdir;

    fn write_skill(dir: &Path, name: &str, body: &str) {
        let skill_dir = dir.join(name);
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), body).unwrap();
    }

    #[test]
    fn scan_finds_cc_user_skill_and_flags_existing() {
        let cc_home = tempdir().unwrap();
        let global_store = tempdir().unwrap();
        set_test_cc_home(Some(cc_home.path().to_path_buf()));
        set_test_scan_root(None);
        set_test_user_skills(Some(global_store.path().to_path_buf()));
        set_test_user_plugins(None);

        fs::create_dir_all(cc_home.path().join("skills")).unwrap();
        write_skill(&cc_home.path().join("skills"), "my-skill", "# hi");
        // Loose file, not a valid skill dir.
        fs::write(cc_home.path().join("skills").join("stray.json"), "{}").unwrap();

        // Pre-seed the global store so "my-skill" is already present.
        let global_skills_dir = tauri_plugin_agent_tools::skills::skills_dir(global_store.path());
        fs::create_dir_all(&global_skills_dir).unwrap();
        write_skill(&global_skills_dir, "my-skill", "# existing");

        let scan = tokio_test_block_on(agent_cc_scan(None)).unwrap();
        let hit = scan
            .items
            .iter()
            .find(|i| i.kind == CcItemKind::Skill && i.name == "my-skill")
            .expect("skill found");
        assert_eq!(hit.origin, "cc-user");
        assert!(hit.already_exists);
        assert!(!scan.items.iter().any(|i| i.name == "stray"));

        set_test_cc_home(None);
        set_test_scan_root(None);
        set_test_user_skills(None);
        set_test_user_plugins(None);
    }

    #[test]
    fn scan_parses_installed_plugins_and_project_plugins() {
        let cc_home = tempdir().unwrap();
        let scan_root = tempdir().unwrap();
        set_test_cc_home(Some(cc_home.path().to_path_buf()));
        set_test_scan_root(Some(scan_root.path().to_path_buf()));
        set_test_user_skills(None);
        set_test_user_plugins(None);

        // cc-user installed plugin.
        let plugin_install_dir = cc_home.path().join("plugin-store").join("foo-1.0");
        fs::create_dir_all(&plugin_install_dir).unwrap();
        let plugins_json_dir = cc_home.path().join("plugins");
        fs::create_dir_all(&plugins_json_dir).unwrap();
        let manifest = serde_json::json!({
            "version": 2,
            "plugins": {
                "foo@some-marketplace": [
                    {
                        "installPath": plugin_install_dir.to_string_lossy(),
                        "version": "1.0.0",
                        "lastUpdated": "2026-01-01T00:00:00Z"
                    }
                ]
            }
        });
        fs::write(
            plugins_json_dir.join("installed_plugins.json"),
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();

        // Project plugin.
        let project_plugin_dir = scan_root
            .path()
            .join("my-project")
            .join(".claude")
            .join("plugins")
            .join("bar");
        fs::create_dir_all(&project_plugin_dir).unwrap();

        let scan = tokio_test_block_on(agent_cc_scan(None)).unwrap();
        let cc_hit = scan
            .items
            .iter()
            .find(|i| i.kind == CcItemKind::Plugin && i.name == "foo")
            .expect("cc-user plugin found");
        assert_eq!(cc_hit.origin, "cc-user");
        assert_eq!(cc_hit.source_path, plugin_install_dir.to_string_lossy());

        let project_hit = scan
            .items
            .iter()
            .find(|i| i.kind == CcItemKind::Plugin && i.name == "bar")
            .expect("project plugin found");
        assert_eq!(project_hit.origin, "project:my-project");

        set_test_cc_home(None);
        set_test_scan_root(None);
        set_test_user_skills(None);
        set_test_user_plugins(None);
    }

    #[test]
    fn import_copies_skill_into_global_store() {
        let cc_home = tempdir().unwrap();
        let global_store = tempdir().unwrap();
        set_test_user_skills(Some(global_store.path().to_path_buf()));
        set_test_user_plugins(None);

        write_skill(&cc_home.path().join("skills-src"), "cool-skill", "# body");
        let src = cc_home.path().join("skills-src").join("cool-skill");

        let result = tokio_test_block_on(agent_cc_import(
            vec![CcImportSelection {
                kind: CcItemKind::Skill,
                name: "cool-skill".to_string(),
                source_path: src.to_string_lossy().into_owned(),
            }],
            false,
            None,
        ))
        .unwrap();

        assert_eq!(result.imported, vec!["cool-skill".to_string()]);
        assert!(result.errors.is_empty());
        let target = tauri_plugin_agent_tools::skills::skills_dir(global_store.path())
            .join("cool-skill")
            .join("SKILL.md");
        assert!(target.is_file());

        set_test_user_skills(None);
    }

    /// Jozkah/jan#278: an overwrite whose source is missing refuses and keeps
    /// the existing skill; a successful one replaces it whole and leaves no
    /// staging directory behind.
    #[test]
    fn an_overwrite_never_loses_the_existing_skill() {
        let cc_home = tempdir().unwrap();
        let global_store = tempdir().unwrap();
        set_test_user_skills(Some(global_store.path().to_path_buf()));
        set_test_user_plugins(None);
        let skills = tauri_plugin_agent_tools::skills::skills_dir(global_store.path());
        write_skill(&skills, "keep", "# mine");

        let missing = cc_home.path().join("nowhere");
        let result = tokio_test_block_on(agent_cc_import(
            vec![CcImportSelection {
                kind: CcItemKind::Skill,
                name: "keep".to_string(),
                source_path: missing.to_string_lossy().into_owned(),
            }],
            true,
            None,
        ))
        .unwrap();
        assert!(result.imported.is_empty() && !result.errors.is_empty());
        assert_eq!(std::fs::read_to_string(skills.join("keep").join("SKILL.md")).unwrap(), "# mine");

        write_skill(&cc_home.path().join("src"), "keep", "# theirs");
        tokio_test_block_on(agent_cc_import(
            vec![CcImportSelection {
                kind: CcItemKind::Skill,
                name: "keep".to_string(),
                source_path: cc_home.path().join("src").join("keep").to_string_lossy().into_owned(),
            }],
            true,
            None,
        ))
        .unwrap();
        assert!(std::fs::read_to_string(skills.join("keep").join("SKILL.md")).unwrap().contains("theirs"));
        let leftovers: Vec<_> = std::fs::read_dir(&skills)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with('.'))
            .collect();
        assert!(leftovers.is_empty(), "staging left behind");
        set_test_user_skills(None);
    }

    /// Jozkah/jan#286: a legacy flat `<name>.md` skill counts as existing, so
    /// an import without overwrite skips it instead of hiding it.
    #[test]
    fn a_flat_skill_counts_as_existing() {
        let cc_home = tempdir().unwrap();
        let global_store = tempdir().unwrap();
        set_test_user_skills(Some(global_store.path().to_path_buf()));
        set_test_user_plugins(None);
        let skills = tauri_plugin_agent_tools::skills::skills_dir(global_store.path());
        fs::create_dir_all(&skills).unwrap();
        fs::write(skills.join("foo.md"), "# flat").unwrap();
        write_skill(&cc_home.path().join("src"), "foo", "# cc");
        assert!(skill_exists("foo", Some(skills.clone())));
        let result = tokio_test_block_on(agent_cc_import(
            vec![CcImportSelection {
                kind: CcItemKind::Skill,
                name: "foo".to_string(),
                source_path: cc_home.path().join("src").join("foo").to_string_lossy().into_owned(),
            }],
            false,
            None,
        ))
        .unwrap();
        assert!(result.imported.is_empty(), "{result:?}");
        assert!(!skills.join("foo").exists(), "the flat skill was shadowed");
        assert_eq!(fs::read_to_string(skills.join("foo.md")).unwrap(), "# flat");
        set_test_user_skills(None);
    }

    /// Jozkah/jan#290: two selected items with one name are a collision the
    /// user must resolve, not an overwrite or a "skipped".
    #[test]
    fn two_sources_for_one_name_are_reported_not_imported() {
        let cc_home = tempdir().unwrap();
        let global_store = tempdir().unwrap();
        set_test_user_skills(Some(global_store.path().to_path_buf()));
        set_test_user_plugins(None);
        write_skill(&cc_home.path().join("a"), "foo", "# from a");
        write_skill(&cc_home.path().join("b"), "foo", "# from b");
        let pick = |dir: &str| CcImportSelection {
            kind: CcItemKind::Skill,
            name: "foo".to_string(),
            source_path: cc_home.path().join(dir).join("foo").to_string_lossy().into_owned(),
        };
        for overwrite in [false, true] {
            let result = tokio_test_block_on(agent_cc_import(vec![pick("a"), pick("b")], overwrite, None)).unwrap();
            assert!(result.imported.is_empty() && result.skipped.is_empty(), "{result:?}");
            assert_eq!(result.errors.len(), 1, "{result:?}");
            assert!(result.errors[0].contains("2 places"));
        }
        let skills = tauri_plugin_agent_tools::skills::skills_dir(global_store.path());
        assert!(!skills.join("foo").exists());
        set_test_user_skills(None);
    }

    #[test]
    fn import_copies_plugin_subdirs_but_not_mcp_json() {
        let cc_home = tempdir().unwrap();
        let global_store = tempdir().unwrap();
        set_test_user_skills(None);
        set_test_user_plugins(Some(global_store.path().to_path_buf()));

        let plugin_src = cc_home.path().join("plugins-src").join("my-plugin");
        fs::create_dir_all(plugin_src.join("skills").join("s1")).unwrap();
        fs::write(
            plugin_src.join("skills").join("s1").join("SKILL.md"),
            "# s1",
        )
        .unwrap();
        fs::create_dir_all(plugin_src.join("commands")).unwrap();
        fs::write(plugin_src.join("commands").join("c1.md"), "cmd").unwrap();
        fs::create_dir_all(plugin_src.join("agents")).unwrap();
        fs::write(plugin_src.join("agents").join("a1.md"), "agent").unwrap();
        fs::write(plugin_src.join(".mcp.json"), "{}").unwrap();
        fs::write(plugin_src.join("README.md"), "readme").unwrap();

        let result = tokio_test_block_on(agent_cc_import(
            vec![CcImportSelection {
                kind: CcItemKind::Plugin,
                name: "my-plugin".to_string(),
                source_path: plugin_src.to_string_lossy().into_owned(),
            }],
            false,
            None,
        ))
        .unwrap();

        assert_eq!(result.imported, vec!["my-plugin".to_string()]);
        let target =
            tauri_plugin_agent_tools::skills::plugins_dir(global_store.path()).join("my-plugin");
        assert!(target.join("skills").join("s1").join("SKILL.md").is_file());
        assert!(target.join("commands").join("c1.md").is_file());
        assert!(target.join("agents").join("a1.md").is_file());
        assert!(target.join("README.md").is_file());
        assert!(!target.join(".mcp.json").exists());

        set_test_user_plugins(None);
    }

    #[test]
    fn overwrite_false_skips_existing_target() {
        let global_store = tempdir().unwrap();
        set_test_user_skills(Some(global_store.path().to_path_buf()));
        set_test_user_plugins(None);

        let global_skills_dir = tauri_plugin_agent_tools::skills::skills_dir(global_store.path());
        write_skill(&global_skills_dir, "existing", "# already here");

        let src_root = tempdir().unwrap();
        write_skill(src_root.path(), "existing", "# new content");
        let src = src_root.path().join("existing");

        let result = tokio_test_block_on(agent_cc_import(
            vec![CcImportSelection {
                kind: CcItemKind::Skill,
                name: "existing".to_string(),
                source_path: src.to_string_lossy().into_owned(),
            }],
            false,
            None,
        ))
        .unwrap();

        assert!(result.imported.is_empty());
        assert_eq!(result.skipped, vec!["existing".to_string()]);
        let content =
            fs::read_to_string(global_skills_dir.join("existing").join("SKILL.md")).unwrap();
        assert_eq!(content, "# already here");

        set_test_user_skills(None);
    }

    #[test]
    fn dotdot_in_name_is_rejected() {
        let global_store = tempdir().unwrap();
        set_test_user_skills(Some(global_store.path().to_path_buf()));
        set_test_user_plugins(None);

        let result = tokio_test_block_on(agent_cc_import(
            vec![CcImportSelection {
                kind: CcItemKind::Skill,
                name: "../evil".to_string(),
                source_path: "/tmp/whatever".to_string(),
            }],
            false,
            None,
        ))
        .unwrap();

        assert!(result.imported.is_empty());
        assert!(result.skipped.is_empty());
        assert_eq!(result.errors.len(), 1);
        assert!(result.errors[0].contains("invalid item name"));

        set_test_user_skills(None);
    }

    #[test]
    fn import_links_the_item_and_sync_follows_the_source() {
        let cc_home = tempdir().unwrap();
        let store = tempdir().unwrap();
        set_test_cc_home(Some(cc_home.path().to_path_buf()));
        set_test_scan_root(None);
        set_test_user_skills(Some(store.path().to_path_buf()));
        set_test_user_plugins(None);

        write_skill(&cc_home.path().join("skills"), "caveman", "v1");
        let source = cc_home.path().join("skills").join("caveman");
        let target = tauri_plugin_agent_tools::skills::skills_dir(store.path())
            .join("caveman")
            .join("SKILL.md");

        let result = tokio_test_block_on(agent_cc_import(
            vec![CcImportSelection {
                kind: CcItemKind::Skill,
                name: "caveman".into(),
                source_path: source.to_string_lossy().into_owned(),
            }],
            false,
            Some(true),
        ))
        .unwrap();
        assert_eq!(result.imported, vec!["caveman".to_string()]);
        assert!(cc_links::load().is_linked(LinkKind::Skill, "caveman"));
        assert!(cc_links::load().hooks, "the hooks opt-in is recorded");
        assert_eq!(fs::read_to_string(&target).unwrap(), "v1");

        // Nothing changed: nothing re-copied.
        assert_eq!(sync_links(), 0);

        // An edit in Claude Code reaches Flint without importing again.
        fs::write(source.join("SKILL.md"), "version two").unwrap();
        assert_eq!(sync_links(), 1);
        assert_eq!(fs::read_to_string(&target).unwrap(), "version two");

        // Removing the source keeps the last copy.
        fs::remove_dir_all(&source).unwrap();
        assert_eq!(sync_links(), 0);
        assert_eq!(fs::read_to_string(&target).unwrap(), "version two");
        assert!(cc_links::load().is_linked(LinkKind::Skill, "caveman"));

        // Removing it from Flint drops the link rather than recreating it.
        write_skill(&cc_home.path().join("skills"), "caveman", "back again");
        fs::remove_dir_all(target.parent().unwrap()).unwrap();
        assert_eq!(sync_links(), 0);
        assert!(!target.exists());
        assert!(!cc_links::load().is_linked(LinkKind::Skill, "caveman"));

        set_test_cc_home(None);
        set_test_user_skills(None);
    }

    #[test]
    fn a_skipped_import_is_not_linked() {
        let cc_home = tempdir().unwrap();
        let store = tempdir().unwrap();
        set_test_cc_home(Some(cc_home.path().to_path_buf()));
        set_test_scan_root(None);
        set_test_user_skills(Some(store.path().to_path_buf()));
        set_test_user_plugins(None);

        write_skill(&cc_home.path().join("skills"), "mine", "claude copy");
        let dir = tauri_plugin_agent_tools::skills::skills_dir(store.path());
        write_skill(&dir, "mine", "flint copy");

        let result = tokio_test_block_on(agent_cc_import(
            vec![CcImportSelection {
                kind: CcItemKind::Skill,
                name: "mine".into(),
                source_path: cc_home
                    .path()
                    .join("skills")
                    .join("mine")
                    .to_string_lossy()
                    .into_owned(),
            }],
            false,
            None,
        ))
        .unwrap();
        assert_eq!(result.skipped, vec!["mine".to_string()]);
        // Linking it would let the next sync overwrite a copy the user kept.
        assert!(!cc_links::load().is_linked(LinkKind::Skill, "mine"));
        assert_eq!(fs::read_to_string(dir.join("mine").join("SKILL.md")).unwrap(), "flint copy");

        set_test_cc_home(None);
        set_test_user_skills(None);
    }

    /// Minimal blocking executor for these `async fn`s (they contain no real
    /// `.await` points -- everything is sync `std::fs` -- so a tiny no-dependency
    /// poll loop is enough without pulling in `#[tokio::test]` machinery.
    fn tokio_test_block_on<F: std::future::Future>(fut: F) -> F::Output {
        use std::future::Future as _;
        use std::pin::Pin;
        use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};

        fn noop(_: *const ()) {}
        fn clone(_: *const ()) -> RawWaker {
            RawWaker::new(std::ptr::null(), &VTABLE)
        }
        static VTABLE: RawWakerVTable = RawWakerVTable::new(clone, noop, noop, noop);
        let raw_waker = RawWaker::new(std::ptr::null(), &VTABLE);
        let waker = unsafe { Waker::from_raw(raw_waker) };
        let mut cx = Context::from_waker(&waker);
        let mut fut = Box::pin(fut);
        loop {
            match Pin::new(&mut fut).as_mut().poll(&mut cx) {
                Poll::Ready(v) => return v,
                Poll::Pending => continue,
            }
        }
    }
}
