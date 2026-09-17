//! Per-surface enablement matrix for GLOBAL skills/plugins:
//! `<jan_data_folder>/agent-workspace/extensions.json`.
//!
//! A skill/plugin id that never appears in the matrix is enabled everywhere
//! (Home, Rooms, every Cowork project). Once `set(..., on = true)` is called
//! for one of its surfaces, the item flips into restricted mode: it is then
//! enabled ONLY on the surfaces explicitly listed, and every other surface
//! (including ones never mentioned) is disabled. `set(..., on = false)`
//! removes a surface from that list; the entry itself is left in place (even
//! if its list becomes empty) so restricted mode persists.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const EXTENSIONS_FILE: &str = "extensions.json";

/// A place skills/plugins can run: the desktop Home chat, the Rooms surface,
/// or a specific Cowork project (identified by its stable project id from
/// `projects_registry`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Surface {
    Home,
    Rooms,
    Cowork(String),
}

impl Surface {
    /// The string key used in `extensions.json`'s `surfaces` lists.
    pub fn key(&self) -> String {
        match self {
            Surface::Home => "home".to_string(),
            Surface::Rooms => "rooms".to_string(),
            Surface::Cowork(id) => format!("cowork:{id}"),
        }
    }
}

/// Which namespace of the matrix an id belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemKind {
    Skill,
    Plugin,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ItemEntry {
    #[serde(default)]
    surfaces: Vec<String>,
}

/// The on-disk shape: `{ "skills": { id: { "surfaces": [...] } }, "plugins": {...} }`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Matrix {
    #[serde(default)]
    skills: std::collections::BTreeMap<String, ItemEntry>,
    #[serde(default)]
    plugins: std::collections::BTreeMap<String, ItemEntry>,
}

#[cfg(not(test))]
fn extensions_root() -> Option<PathBuf> {
    let data = crate::core::app::commands::resolve_jan_data_folder();
    (!data.as_os_str().is_empty())
        .then(|| tauri_plugin_agent_tools::workspace::permanent_store(&data))
}

// Tests point the matrix at a temp store rather than the real data folder,
// mirroring `TEST_USER_SKILLS` in skills.rs, so tests never touch (or leak
// state into/out of) the real jan_data_folder.
#[cfg(test)]
thread_local! {
    static TEST_EXTENSIONS_ROOT: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn set_test_extensions_root(store: Option<PathBuf>) {
    TEST_EXTENSIONS_ROOT.with(|d| *d.borrow_mut() = store);
}

#[cfg(test)]
fn extensions_root() -> Option<PathBuf> {
    TEST_EXTENSIONS_ROOT.with(|d| d.borrow().clone())
}

fn extensions_path() -> Option<PathBuf> {
    extensions_root().map(|root| root.join(EXTENSIONS_FILE))
}

/// Writes `value` to `path` crash-safely: serialize to `<path>.tmp`, then
/// `rename` into place. A rename within the same directory is atomic on both
/// Windows and POSIX filesystems, so a reader never observes a partial file.
pub(crate) fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(value)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let tmp_path = path.with_extension("json.tmp");
    std::fs::write(&tmp_path, json)?;
    std::fs::rename(&tmp_path, path)
}

impl Matrix {
    /// Loads the matrix from disk. Missing or corrupt file -> `Matrix::default()`;
    /// never panics.
    pub fn load() -> Matrix {
        let Some(path) = extensions_path() else {
            return Matrix::default();
        };
        let Ok(raw) = std::fs::read_to_string(&path) else {
            return Matrix::default();
        };
        serde_json::from_str(&raw).unwrap_or_default()
    }

    /// Persists the matrix to disk via an atomic write. No-op if no data
    /// folder resolves.
    pub fn save(&self) {
        let Some(path) = extensions_path() else {
            return;
        };
        let _ = atomic_write_json(&path, self);
    }

    fn map(&self, kind: ItemKind) -> &std::collections::BTreeMap<String, ItemEntry> {
        match kind {
            ItemKind::Skill => &self.skills,
            ItemKind::Plugin => &self.plugins,
        }
    }

    fn map_mut(&mut self, kind: ItemKind) -> &mut std::collections::BTreeMap<String, ItemEntry> {
        match kind {
            ItemKind::Skill => &mut self.skills,
            ItemKind::Plugin => &mut self.plugins,
        }
    }

    /// Whether `id` is enabled on `surface`. Absent from the matrix -> enabled
    /// everywhere. Present -> enabled only for surfaces in its list.
    pub fn is_enabled(&self, kind: ItemKind, id: &str, surface: &Surface) -> bool {
        match self.map(kind).get(id) {
            None => true,
            Some(entry) => entry.surfaces.iter().any(|s| s == &surface.key()),
        }
    }

    /// `on = true` inserts `surface`'s key into `id`'s list (creating the
    /// entry if absent, which flips `id` into restricted mode). `on = false`
    /// removes that key; the entry (and restricted mode) persists even if its
    /// list becomes empty.
    pub fn set(&mut self, kind: ItemKind, id: &str, surface: &Surface, on: bool) {
        let key = surface.key();
        let entry = self.map_mut(kind).entry(id.to_string()).or_default();
        if on {
            if !entry.surfaces.iter().any(|s| s == &key) {
                entry.surfaces.push(key);
            }
        } else {
            entry.surfaces.retain(|s| s != &key);
        }
    }

    /// Replaces `id`'s entire surface list with exactly `surfaces` (creating
    /// the entry if absent). A full-vector set for grid UIs, where toggling
    /// one cell recomputes the whole boolean vector rather than one surface.
    pub fn set_item(&mut self, kind: ItemKind, id: &str, surfaces: Vec<String>) {
        self.map_mut(kind)
            .insert(id.to_string(), ItemEntry { surfaces });
    }

    /// Removes `id`'s entry entirely, returning it to the default: enabled on
    /// every surface.
    pub fn clear_item(&mut self, kind: ItemKind, id: &str) {
        self.map_mut(kind).remove(id);
    }
}

/// The matrix's namespace + item id for a resolved skill meta: a plugin skill
/// is keyed by its plugin id, a standalone skill by its own name.
fn kind_of(meta: &crate::core::agent::skills::SkillMeta) -> ItemKind {
    if meta.plugin.is_some() {
        ItemKind::Plugin
    } else {
        ItemKind::Skill
    }
}

fn item_id(meta: &crate::core::agent::skills::SkillMeta) -> String {
    meta.plugin.clone().unwrap_or_else(|| meta.name.clone())
}

/// The single loader behind Home/Rooms/Cowork's skill catalog: builds the base
/// catalog (project-aware when `project_root` is given, global-only for
/// folderless Home/Rooms), then filters it by the per-surface enablement
/// matrix. Project items have no matrix entry, so they default enabled;
/// global items are exactly what the `/extensions` UI toggles.
pub(crate) fn resolve_extensions(
    surface: &Surface,
    project_root: Option<&Path>,
) -> Vec<crate::core::agent::skills::SkillMeta> {
    let mut catalog = match project_root {
        Some(root) => {
            let enabled = crate::core::agent::project::enabled_skills(root);
            crate::core::agent::skills::catalog(root, &enabled)
        }
        None => crate::core::agent::skills::global_catalog(),
    };
    let matrix = Matrix::load();
    catalog.retain(|meta| matrix.is_enabled(kind_of(meta), &item_id(meta), surface));
    catalog
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_item_enabled_everywhere_present_is_restricted() {
        let m = Matrix::default();
        assert!(m.is_enabled(ItemKind::Skill, "caveman", &Surface::Home));
        let mut m = m;
        m.set(ItemKind::Skill, "caveman", &Surface::Rooms, true); // now restricted to listed surfaces
        assert!(m.is_enabled(ItemKind::Skill, "caveman", &Surface::Rooms));
        assert!(!m.is_enabled(ItemKind::Skill, "caveman", &Surface::Home));
    }

    #[test]
    fn set_false_removes_surface_but_keeps_restricted_mode() {
        let mut m = Matrix::default();
        m.set(ItemKind::Plugin, "foo", &Surface::Home, true);
        m.set(ItemKind::Plugin, "foo", &Surface::Rooms, true);
        assert!(m.is_enabled(ItemKind::Plugin, "foo", &Surface::Home));
        m.set(ItemKind::Plugin, "foo", &Surface::Home, false);
        assert!(!m.is_enabled(ItemKind::Plugin, "foo", &Surface::Home));
        assert!(m.is_enabled(ItemKind::Plugin, "foo", &Surface::Rooms));
        // Absent-elsewhere surface remains disabled, since "foo" is restricted.
        assert!(!m.is_enabled(
            ItemKind::Plugin,
            "foo",
            &Surface::Cowork("proj1".to_string())
        ));
    }

    #[test]
    fn set_item_replaces_full_surface_vector() {
        let mut m = Matrix::default();
        m.set_item(
            ItemKind::Skill,
            "caveman",
            vec!["rooms".to_string(), "cowork:p1".to_string()],
        );
        assert!(m.is_enabled(ItemKind::Skill, "caveman", &Surface::Rooms));
        assert!(m.is_enabled(
            ItemKind::Skill,
            "caveman",
            &Surface::Cowork("p1".to_string())
        ));
        assert!(!m.is_enabled(ItemKind::Skill, "caveman", &Surface::Home));

        // Replacing again overwrites the previous list wholesale.
        m.set_item(ItemKind::Skill, "caveman", vec!["home".to_string()]);
        assert!(m.is_enabled(ItemKind::Skill, "caveman", &Surface::Home));
        assert!(!m.is_enabled(ItemKind::Skill, "caveman", &Surface::Rooms));
    }

    #[test]
    fn clear_item_returns_to_default_enabled_everywhere() {
        let mut m = Matrix::default();
        m.set_item(ItemKind::Plugin, "octo", vec!["home".to_string()]);
        assert!(!m.is_enabled(ItemKind::Plugin, "octo", &Surface::Rooms));
        m.clear_item(ItemKind::Plugin, "octo");
        assert!(m.is_enabled(ItemKind::Plugin, "octo", &Surface::Home));
        assert!(m.is_enabled(ItemKind::Plugin, "octo", &Surface::Rooms));
        assert!(m.is_enabled(ItemKind::Plugin, "octo", &Surface::Cowork("p1".to_string())));
    }

    #[test]
    fn cowork_surface_key_format() {
        assert_eq!(Surface::Cowork("abc123".to_string()).key(), "cowork:abc123");
        assert_eq!(Surface::Home.key(), "home");
        assert_eq!(Surface::Rooms.key(), "rooms");
    }

    #[test]
    fn save_load_round_trip_persists_to_disk() {
        let dir = tempfile::tempdir().expect("tempdir");
        set_test_extensions_root(Some(dir.path().to_path_buf()));

        let mut m = Matrix::load();
        assert!(m.is_enabled(ItemKind::Skill, "caveman", &Surface::Home));
        m.set(ItemKind::Skill, "caveman", &Surface::Home, true);
        m.set(
            ItemKind::Plugin,
            "octo",
            &Surface::Cowork("p1".to_string()),
            true,
        );
        m.save();

        // File actually landed on disk, atomically (no leftover .tmp).
        let path = dir.path().join(EXTENSIONS_FILE);
        assert!(path.exists());
        assert!(!dir.path().join("extensions.json.tmp").exists());

        let reloaded = Matrix::load();
        assert!(reloaded.is_enabled(ItemKind::Skill, "caveman", &Surface::Home));
        assert!(!reloaded.is_enabled(ItemKind::Skill, "caveman", &Surface::Rooms));
        assert!(reloaded.is_enabled(ItemKind::Plugin, "octo", &Surface::Cowork("p1".to_string())));
        assert!(!reloaded.is_enabled(ItemKind::Plugin, "octo", &Surface::Home));

        set_test_extensions_root(None);
    }

    #[test]
    fn missing_or_corrupt_file_yields_default() {
        let dir = tempfile::tempdir().expect("tempdir");
        set_test_extensions_root(Some(dir.path().to_path_buf()));

        // Missing file.
        let m = Matrix::load();
        assert!(m.is_enabled(ItemKind::Skill, "anything", &Surface::Home));

        // Corrupt file.
        std::fs::write(dir.path().join(EXTENSIONS_FILE), "not json").unwrap();
        let m = Matrix::load();
        assert!(m.is_enabled(ItemKind::Skill, "anything", &Surface::Home));

        set_test_extensions_root(None);
    }

    fn write_global_skill(dir: &Path, name: &str, body: &str) {
        let skills_dir = tauri_plugin_agent_tools::skills::skills_dir(dir).join(name);
        std::fs::create_dir_all(&skills_dir).unwrap();
        std::fs::write(skills_dir.join("SKILL.md"), body).unwrap();
    }

    #[test]
    fn resolve_extensions_filters_global_skill_by_surface() {
        let user_store = tempfile::tempdir().expect("tempdir");
        write_global_skill(
            user_store.path(),
            "caveman",
            "---\ndescription: caveman talk\n---\nbody\n",
        );
        crate::core::agent::skills::set_test_user_skills(Some(user_store.path().to_path_buf()));
        crate::core::agent::skills::set_test_user_plugins(None);

        let ext_store = tempfile::tempdir().expect("tempdir");
        let mut matrix = Matrix::default();
        matrix.set(ItemKind::Skill, "caveman", &Surface::Rooms, true);
        set_test_extensions_root(Some(ext_store.path().to_path_buf()));
        matrix.save();

        let home = resolve_extensions(&Surface::Home, None);
        assert!(
            !home.iter().any(|m| m.name == "caveman"),
            "restricted-to-rooms skill leaked into home: {:?}",
            home.iter().map(|m| &m.name).collect::<Vec<_>>()
        );

        let rooms = resolve_extensions(&Surface::Rooms, None);
        assert!(
            rooms.iter().any(|m| m.name == "caveman"),
            "restricted-to-rooms skill missing from rooms: {:?}",
            rooms.iter().map(|m| &m.name).collect::<Vec<_>>()
        );

        set_test_extensions_root(None);
        crate::core::agent::skills::set_test_user_skills(None);
    }

    #[test]
    fn resolve_extensions_unset_global_skill_appears_on_all_surfaces() {
        let user_store = tempfile::tempdir().expect("tempdir");
        write_global_skill(
            user_store.path(),
            "always-on",
            "---\ndescription: always on\n---\nbody\n",
        );
        crate::core::agent::skills::set_test_user_skills(Some(user_store.path().to_path_buf()));
        crate::core::agent::skills::set_test_user_plugins(None);

        let ext_store = tempfile::tempdir().expect("tempdir");
        set_test_extensions_root(Some(ext_store.path().to_path_buf()));

        for surface in [
            Surface::Home,
            Surface::Rooms,
            Surface::Cowork("p1".to_string()),
        ] {
            let resolved = resolve_extensions(&surface, None);
            assert!(
                resolved.iter().any(|m| m.name == "always-on"),
                "unset global skill missing on {surface:?}"
            );
        }

        set_test_extensions_root(None);
        crate::core::agent::skills::set_test_user_skills(None);
    }
}
