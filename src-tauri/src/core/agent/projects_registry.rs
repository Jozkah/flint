//! Stable project ids: `<jan_data_folder>/agent-workspace/projects.json`.
//!
//! Per-project enablement toggles (Task 6 and beyond) key off a project id
//! rather than a filesystem path, so moving or renaming a project folder
//! doesn't orphan its settings. The id is minted once and then carried in a
//! marker file inside the project itself (`<folder>/.jan/agent/.project-id`),
//! so a folder that gets moved/renamed still resolves to the same entry: the
//! marker travels with it, while the registry's `folder`/`name` fields are
//! refreshed to match on the next `register_folder` call.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const MARKER_REL: &str = ".jan/agent/.project-id";
const REGISTRY_FILE: &str = "projects.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectEntry {
    pub id: String,
    pub folder: String,
    pub name: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Registry {
    #[serde(default)]
    projects: Vec<ProjectEntry>,
}

#[cfg(not(test))]
fn registry_root() -> Option<PathBuf> {
    let data = crate::core::app::commands::resolve_jan_data_folder();
    (!data.as_os_str().is_empty())
        .then(|| tauri_plugin_agent_tools::workspace::permanent_store(&data))
}

// Tests point the registry at a temp store rather than the real data folder,
// mirroring `TEST_USER_SKILLS` in skills.rs, so registry tests never touch
// (or leak state into/out of) the real jan_data_folder.
#[cfg(test)]
thread_local! {
    static TEST_REGISTRY_ROOT: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn set_test_registry_root(store: Option<PathBuf>) {
    TEST_REGISTRY_ROOT.with(|d| *d.borrow_mut() = store);
}

#[cfg(test)]
fn registry_root() -> Option<PathBuf> {
    TEST_REGISTRY_ROOT.with(|d| d.borrow().clone())
}

/// `<permanent_store>/projects.json`, or `None` when no data folder resolves.
pub(crate) fn registry_path() -> Option<PathBuf> {
    registry_root().map(|root| root.join(REGISTRY_FILE))
}

/// Loads the registry from disk. Missing or corrupt file -> empty list;
/// never panics.
fn load_registry() -> Registry {
    let Some(path) = registry_path() else {
        return Registry::default();
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Registry::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_registry(registry: &Registry) {
    let Some(path) = registry_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    if let Ok(json) = serde_json::to_string_pretty(registry) {
        let _ = std::fs::write(&path, json);
    }
}

/// Every registered project, in registry order.
pub(crate) fn list_projects() -> Vec<ProjectEntry> {
    load_registry().projects
}

fn marker_path(folder: &Path) -> PathBuf {
    folder.join(MARKER_REL)
}

fn read_marker(folder: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(marker_path(folder)).ok()?;
    let id = raw.trim();
    (!id.is_empty()).then(|| id.to_string())
}

fn write_marker(folder: &Path, id: &str) {
    let marker = marker_path(folder);
    if let Some(parent) = marker.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    let _ = std::fs::write(&marker, id);
}

fn folder_name(folder: &Path) -> String {
    folder
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Resolves a folder to a previously-registered project id, if any: marker
/// file first (so a moved/renamed folder still resolves), else an exact path
/// match in the registry.
pub(crate) fn resolve_project_id(folder: &Path) -> Option<String> {
    if let Some(id) = read_marker(folder) {
        let registry = load_registry();
        if registry.projects.iter().any(|p| p.id == id) {
            return Some(id);
        }
    }
    let folder_str = folder.to_string_lossy().to_string();
    load_registry()
        .projects
        .into_iter()
        .find(|p| p.folder == folder_str)
        .map(|p| p.id)
}

/// Registers `folder`, returning its stable entry. Idempotent: calling this
/// again for the same folder (or the same marker after a move/rename)
/// returns the same id, refreshing `folder`/`name` in place.
pub(crate) fn register_folder(folder: &Path) -> ProjectEntry {
    let folder_str = folder.to_string_lossy().to_string();
    let name = folder_name(folder);
    let mut registry = load_registry();

    // Marker carries the id across a move/rename.
    if let Some(id) = read_marker(folder) {
        if let Some(entry) = registry.projects.iter_mut().find(|p| p.id == id) {
            entry.folder = folder_str;
            entry.name = name;
            let updated = entry.clone();
            save_registry(&registry);
            return updated;
        }
    }

    // No usable marker: an exact path match in the registry is the same
    // project re-registering without having moved.
    if let Some(entry) = registry.projects.iter().find(|p| p.folder == folder_str) {
        let entry = entry.clone();
        write_marker(folder, &entry.id);
        return entry;
    }

    // Genuinely new project.
    let id = uuid::Uuid::new_v4().to_string();
    write_marker(folder, &id);
    let entry = ProjectEntry {
        id,
        folder: folder_str,
        name,
    };
    registry.projects.push(entry.clone());
    save_registry(&registry);
    entry
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_is_idempotent_and_survives_rename() {
        let data = tempfile::tempdir().unwrap();
        set_test_registry_root(Some(data.path().to_path_buf()));
        let a = tempfile::tempdir().unwrap();
        let e1 = register_folder(a.path());
        let e2 = register_folder(a.path());
        assert_eq!(e1.id, e2.id, "same folder must reuse id");
        // Simulate rename: new path, but the .project-id marker carries the id.
        let b = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(b.path().join(".jan/agent")).unwrap();
        std::fs::copy(
            a.path().join(".jan/agent/.project-id"),
            b.path().join(".jan/agent/.project-id"),
        )
        .unwrap();
        let e3 = register_folder(b.path());
        assert_eq!(e1.id, e3.id, "moved folder keeps id via marker");
        assert_eq!(e3.folder, b.path().to_string_lossy());
    }

    #[test]
    fn corrupt_registry_file_yields_empty_list() {
        let data = tempfile::tempdir().unwrap();
        set_test_registry_root(Some(data.path().to_path_buf()));
        let path = registry_path().unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "not json").unwrap();
        assert!(list_projects().is_empty());
    }

    #[test]
    fn missing_registry_file_yields_empty_list() {
        let data = tempfile::tempdir().unwrap();
        set_test_registry_root(Some(data.path().to_path_buf()));
        assert!(list_projects().is_empty());
    }

    #[test]
    fn resolve_project_id_matches_by_path_without_marker() {
        let data = tempfile::tempdir().unwrap();
        set_test_registry_root(Some(data.path().to_path_buf()));
        let a = tempfile::tempdir().unwrap();
        let entry = register_folder(a.path());
        // Remove the marker; a fresh resolve should still find it by path.
        std::fs::remove_file(marker_path(a.path())).unwrap();
        assert_eq!(resolve_project_id(a.path()), Some(entry.id));
    }
}
