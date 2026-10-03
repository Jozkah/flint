//! Live links from Flint to Claude Code.
//!
//! Importing from Claude Code does not leave Flint with a frozen snapshot: each
//! imported skill/plugin is recorded here as a *link* back to where it came
//! from, so a later edit in `~/.claude` reaches Flint without importing again
//! (see `cc_import::sync_links`). The same file records whether the user also
//! opted in to running their Claude Code hooks (see `cc_hooks`).
//!
//! Stored at `<jan_data_folder>/agent-workspace/cc-links.json`. A missing or
//! unreadable file is "nothing linked", never an error: this file can only
//! ever add behaviour the user asked for at import time.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkKind {
    Skill,
    Plugin,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub kind: LinkKind,
    pub name: String,
    /// `"cc-user"` for `~/.claude`, `"project:<folder>"` for a project scan hit.
    pub origin: String,
    /// Where the item was last read from. For a `cc-user` plugin this is
    /// re-resolved on every sync, because an update installs into a new
    /// versioned directory.
    pub source_path: String,
    /// Fingerprint of the source when it was last copied in.
    #[serde(default)]
    pub fingerprint: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Links {
    #[serde(default)]
    pub items: Vec<Link>,
    /// The user opted in to running Claude Code hooks (`SessionStart` and
    /// `UserPromptSubmit`) from `~/.claude/settings.json` and linked plugins.
    #[serde(default)]
    pub hooks: bool,
}

impl Links {
    pub fn is_linked(&self, kind: LinkKind, name: &str) -> bool {
        self.items.iter().any(|l| l.kind == kind && l.name == name)
    }

    /// Add `link`, replacing an existing link to the same item.
    pub fn upsert(&mut self, link: Link) {
        match self
            .items
            .iter_mut()
            .find(|l| l.kind == link.kind && l.name == link.name)
        {
            Some(existing) => *existing = link,
            None => self.items.push(link),
        }
    }
}

fn path() -> Option<PathBuf> {
    crate::core::agent::skills::user_skill_store_raw().map(|store| store.join("cc-links.json"))
}

pub fn load() -> Links {
    path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Written beside the target and renamed in, so a crash mid-write never leaves
/// a half file that reads back as "nothing linked".
pub fn save(links: &Links) -> Result<(), String> {
    let path = path().ok_or_else(|| "no global agent store resolved".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(links).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, raw).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// A hash of every file's relative path, size and mtime under `path` (or of the
/// single file at `path`), skipping `.git` and `node_modules` like the copy
/// does. Equal fingerprints mean "nothing to re-copy"; it is a change detector,
/// not an integrity check.
pub fn fingerprint(path: &Path) -> u64 {
    let mut hasher = DefaultHasher::new();
    walk(path, path, &mut hasher);
    hasher.finish()
}

fn walk(root: &Path, dir: &Path, hasher: &mut DefaultHasher) {
    if dir.is_file() {
        stamp(root, dir, hasher);
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name();
        if name == ".git" || name == "node_modules" {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            walk(root, &path, hasher);
        } else if path.is_file() {
            stamp(root, &path, hasher);
        }
    }
}

fn stamp(root: &Path, file: &Path, hasher: &mut DefaultHasher) {
    file.strip_prefix(root).unwrap_or(file).hash(hasher);
    if let Ok(meta) = std::fs::metadata(file) {
        meta.len().hash(hasher);
        if let Some(modified) = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        {
            modified.as_nanos().hash(hasher);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_changes_when_a_file_changes_and_ignores_git() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("SKILL.md"), "one").unwrap();
        let before = fingerprint(dir.path());
        assert_eq!(before, fingerprint(dir.path()));

        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        std::fs::write(dir.path().join(".git").join("HEAD"), "x").unwrap();
        assert_eq!(before, fingerprint(dir.path()), ".git must not count");

        std::fs::write(dir.path().join("SKILL.md"), "longer body").unwrap();
        assert_ne!(before, fingerprint(dir.path()));
    }

    #[test]
    fn upsert_replaces_the_same_item() {
        let mut links = Links::default();
        let link = |src: &str| Link {
            kind: LinkKind::Skill,
            name: "caveman".into(),
            origin: "cc-user".into(),
            source_path: src.into(),
            fingerprint: 0,
        };
        links.upsert(link("a"));
        links.upsert(link("b"));
        assert_eq!(links.items.len(), 1);
        assert_eq!(links.items[0].source_path, "b");
        assert!(links.is_linked(LinkKind::Skill, "caveman"));
        assert!(!links.is_linked(LinkKind::Plugin, "caveman"));
    }
}
