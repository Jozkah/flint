//! Detection of an existing legacy JAN installation.
//!
//! [`detect_legacy`] inspects the injected [`Roots`] and reports what legacy
//! data exists, where it lives, how big it is, and the health of each category.
//! It detects strictly via the established paths and identifiers (never by
//! guessing filenames), and degrades gracefully: absent -> `None`, unreadable
//! or partially-present -> a report with the reachable parts filled in.
//!
//! The category catalogue defined here is the single source of truth for which
//! entries belong to which category and under which root (config dir vs data
//! folder); [`crate::core::migration::plan`] and
//! [`crate::core::migration::execute`] consume it so the mapping is defined once.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::fsutil;
use super::paths::{legacy_paths, Roots};
use super::schema::{self, ItemStatus};

/// A migratable data category.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    /// Chat threads and assistant profiles (`threads`, `assistants`).
    Conversations,
    /// Downloaded models and engine binaries (`models`, `llamacpp`, `mlx`, `openclaw`).
    Models,
    /// Config files (`mcp_config.json`).
    Configs,
    /// `settings.json` (config dir) + encrypted provider secrets (data folder).
    Settings,
    /// Extensions, logs and caches (`extensions`, `logs`, `.npx`, `.uvx`).
    Common,
    /// Agent store and discussion rooms (`agent-workspace`, `rooms`, plus any
    /// other top-level data dirs discovered by scanning).
    Agent,
}

impl Category {
    /// Every category, in a stable migration order (settings/config before the
    /// bulk data so path rewrites land first).
    pub fn all() -> &'static [Category] {
        &[
            Category::Settings,
            Category::Configs,
            Category::Conversations,
            Category::Agent,
            Category::Common,
            Category::Models,
        ]
    }

    /// Stable snake_case identifier (matches the serde representation).
    pub fn as_str(self) -> &'static str {
        match self {
            Category::Conversations => "conversations",
            Category::Models => "models",
            Category::Configs => "configs",
            Category::Settings => "settings",
            Category::Common => "common",
            Category::Agent => "agent",
        }
    }

    /// Parse a category from its stable identifier.
    pub fn parse(s: &str) -> Option<Category> {
        Category::all()
            .iter()
            .copied()
            .find(|c| c.as_str().eq_ignore_ascii_case(s))
    }
}

/// Which legacy root an entry hangs off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceRoot {
    /// The config dir (`<data_dir>/Jan`), mapped to Flint's config dir.
    Config,
    /// The data folder (`<data_dir>/Jan/data`), mapped to Flint's data folder.
    Data,
}

/// A static catalogue entry: a named item under a root, and whether it is a dir.
struct CatalogEntry {
    root: SourceRoot,
    name: &'static str,
    is_dir: bool,
}

fn catalogue(category: Category) -> &'static [CatalogEntry] {
    match category {
        Category::Conversations => &[
            CatalogEntry { root: SourceRoot::Data, name: "threads", is_dir: true },
            CatalogEntry { root: SourceRoot::Data, name: "assistants", is_dir: true },
        ],
        Category::Models => &[
            CatalogEntry { root: SourceRoot::Data, name: "models", is_dir: true },
            CatalogEntry { root: SourceRoot::Data, name: "llamacpp", is_dir: true },
            CatalogEntry { root: SourceRoot::Data, name: "mlx", is_dir: true },
            CatalogEntry { root: SourceRoot::Data, name: "openclaw", is_dir: true },
        ],
        Category::Configs => &[CatalogEntry {
            root: SourceRoot::Data,
            name: "mcp_config.json",
            is_dir: false,
        }],
        Category::Settings => &[
            CatalogEntry { root: SourceRoot::Config, name: "settings.json", is_dir: false },
            CatalogEntry { root: SourceRoot::Data, name: "provider_secrets.enc", is_dir: false },
            CatalogEntry {
                root: SourceRoot::Data,
                name: "provider_secrets.index.json",
                is_dir: false,
            },
        ],
        Category::Common => &[
            CatalogEntry { root: SourceRoot::Data, name: "extensions", is_dir: true },
            CatalogEntry { root: SourceRoot::Data, name: "logs", is_dir: true },
            CatalogEntry { root: SourceRoot::Data, name: ".npx", is_dir: true },
            CatalogEntry { root: SourceRoot::Data, name: ".uvx", is_dir: true },
        ],
        // Agent's known members; extra data-folder dirs are discovered at
        // runtime in `resolved_entries` so nothing is hard-coded away.
        Category::Agent => &[
            CatalogEntry { root: SourceRoot::Data, name: "agent-workspace", is_dir: true },
            CatalogEntry { root: SourceRoot::Data, name: "rooms", is_dir: true },
        ],
    }
}

/// Names claimed by any *non-Agent* category's data-folder catalogue entries,
/// plus Agent's own known dirs. Used to decide which discovered top-level data
/// dirs are "extra" and belong to Agent.
fn known_data_names() -> Vec<&'static str> {
    let mut names = Vec::new();
    for cat in Category::all() {
        for entry in catalogue(*cat) {
            if matches!(entry.root, SourceRoot::Data) {
                names.push(entry.name);
            }
        }
    }
    names
}

/// Where the legacy data was found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacyLocation {
    /// `<data_dir>/Jan/data` (or the override).
    DataFolder,
    /// `~/.jan` (legacy home held data directly in older builds).
    LegacyHome,
    /// `<data_dir>/jan.ai.app` (bundle-id fallback).
    BundleId,
}

/// The resolved legacy source: the config dir and data folder actually in use,
/// and which of them the data came from. Shared with plan/execute.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedSource {
    pub config_dir: PathBuf,
    pub data_folder: PathBuf,
    pub location: LegacyLocation,
}

/// A concrete, resolved top-level entry to migrate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedEntry {
    pub category: Category,
    pub root: SourceRoot,
    /// Top-level name (`threads`, `settings.json`, ...), preserved verbatim in
    /// the destination.
    pub name: String,
    pub source_path: PathBuf,
    pub is_dir: bool,
}

/// Report for one category.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CategoryReport {
    pub category: Category,
    pub present: bool,
    pub item_count: usize,
    pub size_bytes: u64,
    pub schema_version: Option<u32>,
    pub items: Vec<ItemInfo>,
}

/// Report for one top-level item within a category.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ItemInfo {
    pub name: String,
    pub root: SourceRoot,
    pub source_path: PathBuf,
    pub is_dir: bool,
    pub size_bytes: u64,
    pub file_count: usize,
    pub status: ItemStatus,
}

/// The full detection result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacyData {
    pub source: ResolvedSource,
    pub total_size_bytes: u64,
    pub schema_version: Option<u32>,
    pub categories: Vec<CategoryReport>,
}

impl LegacyData {
    /// The report for one category, if present.
    pub fn category(&self, category: Category) -> Option<&CategoryReport> {
        self.categories.iter().find(|c| c.category == category)
    }
}

/// Resolve the config dir that actually holds `settings.json`.
fn resolve_config_dir(roots: &Roots) -> PathBuf {
    let legacy = legacy_paths(roots);
    if legacy.config_dir.join("settings.json").is_file() {
        return legacy.config_dir;
    }
    if legacy.bundle_dir.join("settings.json").is_file() {
        return legacy.bundle_dir;
    }
    // Default to the canonical config dir even if empty; entries simply report
    // as missing.
    legacy.config_dir
}

/// Resolve the data folder that actually holds data, preferring the configured
/// data folder, then the legacy home, then the bundle-id dir.
fn resolve_data_folder(roots: &Roots) -> (PathBuf, LegacyLocation) {
    let legacy = legacy_paths(roots);
    let candidates = [
        (legacy.data_folder.clone(), LegacyLocation::DataFolder),
        (legacy.home.clone(), LegacyLocation::LegacyHome),
        (legacy.bundle_dir.join("data"), LegacyLocation::BundleId),
    ];
    for (path, loc) in &candidates {
        if data_root_has_known_content(path) {
            return (path.clone(), *loc);
        }
    }
    // Nothing populated; return the canonical default so callers can still see
    // an (empty) report.
    (legacy.data_folder, LegacyLocation::DataFolder)
}

/// Whether a candidate data root contains any known data-folder entry.
fn data_root_has_known_content(root: &std::path::Path) -> bool {
    if !root.is_dir() {
        return false;
    }
    for name in known_data_names() {
        if root.join(name).exists() {
            return true;
        }
    }
    // A non-empty dir with unknown contents still counts as "present" so extra
    // dirs get discovered into Agent.
    fsutil::size_of(root) > 0 && super::paths::is_non_empty_dir(root)
}

/// Resolve every concrete entry for a category against a resolved source. This
/// is the shared mapping consumed by plan and execute.
pub fn resolved_entries(category: Category, source: &ResolvedSource) -> Vec<ResolvedEntry> {
    let mut out = Vec::new();
    for entry in catalogue(category) {
        let base = match entry.root {
            SourceRoot::Config => &source.config_dir,
            SourceRoot::Data => &source.data_folder,
        };
        let source_path = base.join(entry.name);
        if source_path.exists() {
            out.push(ResolvedEntry {
                category,
                root: entry.root,
                name: entry.name.to_string(),
                source_path,
                is_dir: entry.is_dir,
            });
        }
    }

    // Agent additionally sweeps up any top-level data dir not claimed by a
    // known category (discussion rooms, mailbox state, future stores).
    if category == Category::Agent {
        let known = known_data_names();
        if let Ok(rd) = std::fs::read_dir(&source.data_folder) {
            for de in rd.flatten() {
                let name = de.file_name().to_string_lossy().into_owned();
                let path = de.path();
                if !path.is_dir() {
                    continue;
                }
                if known.iter().any(|k| *k == name) {
                    continue; // already claimed by some category
                }
                if out.iter().any(|e| e.name == name) {
                    continue;
                }
                out.push(ResolvedEntry {
                    category: Category::Agent,
                    root: SourceRoot::Data,
                    name,
                    source_path: path,
                    is_dir: true,
                });
            }
        }
    }

    out
}

/// Detect an existing legacy JAN installation.
///
/// Returns `None` when no legacy data is found at all. Otherwise returns a
/// report covering every category (missing ones included, marked not present).
pub fn detect_legacy(roots: &Roots) -> Option<LegacyData> {
    let config_dir = resolve_config_dir(roots);
    let (data_folder, location) = resolve_data_folder(roots);
    let source = ResolvedSource {
        config_dir: config_dir.clone(),
        data_folder: data_folder.clone(),
        location,
    };

    // Schema version comes from settings.json (config dir preferred, then the
    // data folder for old layouts). A corrupt settings.json is not fatal here;
    // it surfaces per-item during classification.
    let settings_in_config = config_dir.join("settings.json");
    let settings_in_data = data_folder.join("settings.json");
    let schema_version = schema::read_schema_version(&settings_in_config)
        .ok()
        .flatten()
        .or_else(|| schema::read_schema_version(&settings_in_data).ok().flatten());

    let mut categories = Vec::new();
    let mut total_size = 0u64;
    let mut any_present = false;

    for &category in Category::all() {
        let entries = resolved_entries(category, &source);
        let mut items = Vec::new();
        let mut cat_size = 0u64;
        let mut cat_count = 0usize;
        for entry in &entries {
            let size = fsutil::size_of(&entry.source_path);
            let count = fsutil::count_files(&entry.source_path);
            let status = schema::classify_item(&entry.source_path, schema_version);
            cat_size = cat_size.saturating_add(size);
            cat_count += count;
            items.push(ItemInfo {
                name: entry.name.clone(),
                root: entry.root,
                source_path: entry.source_path.clone(),
                is_dir: entry.is_dir,
                size_bytes: size,
                file_count: count,
                status,
            });
        }
        let present = !items.is_empty();
        any_present |= present;
        total_size = total_size.saturating_add(cat_size);
        categories.push(CategoryReport {
            category,
            present,
            item_count: cat_count,
            size_bytes: cat_size,
            schema_version,
            items,
        });
    }

    if !any_present {
        return None;
    }

    Some(LegacyData {
        source,
        total_size_bytes: total_size,
        schema_version,
        categories,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    /// Build a legacy JAN tree under a temp `data_dir`/`home` and return roots.
    pub(crate) fn seed_legacy(data_dir: &std::path::Path, home: &std::path::Path) {
        let jan = data_dir.join("Jan");
        let data = jan.join("data");
        fs::create_dir_all(data.join("threads/thread_1")).unwrap();
        fs::create_dir_all(data.join("assistants")).unwrap();
        fs::create_dir_all(data.join("models/m1")).unwrap();
        fs::create_dir_all(data.join("agent-workspace/skills")).unwrap();
        fs::create_dir_all(data.join("rooms")).unwrap();
        fs::create_dir_all(data.join("mailbox")).unwrap(); // discovered -> Agent
        fs::create_dir_all(&jan).unwrap();
        let _ = home;

        write(&jan.join("settings.json"), br#"{"schema_version":1,"data_folder":"X"}"#);
        write(&data.join("mcp_config.json"), br#"{"servers":{}}"#);
        write(
            &data.join("threads/thread_1/thread.json"),
            br#"{"id":"thread_1"}"#,
        );
        write(&data.join("models/m1/model.gguf"), b"\x00binarymodel");
        write(&data.join("provider_secrets.enc"), b"\xDE\xAD\xBE\xEF");
        write(&data.join("agent-workspace/skills/s.md"), b"# skill");
        write(&data.join("mailbox/msg.json"), br#"{"to":"a"}"#);
    }

    pub(crate) fn write(path: &std::path::Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = fs::File::create(path).unwrap();
        f.write_all(bytes).unwrap();
    }

    #[test]
    fn no_legacy_found_returns_none() {
        let td = tempfile::tempdir().unwrap();
        let roots = Roots::new(td.path().join("appdata"), td.path().join("home"));
        assert!(detect_legacy(&roots).is_none());
    }

    #[test]
    fn detects_categories_sizes_and_schema() {
        let td = tempfile::tempdir().unwrap();
        let data_dir = td.path().join("appdata");
        let home = td.path().join("home");
        seed_legacy(&data_dir, &home);
        let roots = Roots::new(&data_dir, &home);

        let d = detect_legacy(&roots).expect("legacy present");
        assert_eq!(d.schema_version, Some(1));
        assert_eq!(d.source.location, LegacyLocation::DataFolder);
        assert!(d.total_size_bytes > 0);

        let conv = d.category(Category::Conversations).unwrap();
        assert!(conv.present);
        assert!(conv.item_count >= 1);

        let settings = d.category(Category::Settings).unwrap();
        assert!(settings.present);
        assert!(settings
            .items
            .iter()
            .any(|i| i.name == "settings.json" && i.root == SourceRoot::Config));
        assert!(settings
            .items
            .iter()
            .any(|i| i.name == "provider_secrets.enc"));

        // The unknown `mailbox` dir was discovered into Agent.
        let agent = d.category(Category::Agent).unwrap();
        assert!(agent.items.iter().any(|i| i.name == "mailbox"));
        assert!(agent.items.iter().any(|i| i.name == "agent-workspace"));
        assert!(agent.items.iter().any(|i| i.name == "rooms"));
    }

    #[test]
    fn partially_present_is_graceful() {
        let td = tempfile::tempdir().unwrap();
        let data_dir = td.path().join("appdata");
        let data = data_dir.join("Jan/data");
        fs::create_dir_all(data.join("threads")).unwrap();
        write(&data.join("threads/t.json"), br#"{"id":"t"}"#);
        // No settings.json, no models, no config dir contents.
        let roots = Roots::new(&data_dir, td.path().join("home"));

        let d = detect_legacy(&roots).expect("threads present");
        assert!(d.category(Category::Conversations).unwrap().present);
        assert!(!d.category(Category::Models).unwrap().present);
        assert!(!d.category(Category::Settings).unwrap().present);
        assert_eq!(d.schema_version, None);
    }
}
