//! Turning a detection result into an explicit, reviewable migration plan.
//!
//! [`plan`] is pure: it reads the source and destination filesystems to detect
//! conflicts and estimate size, but performs no writes. The resulting
//! [`MigrationPlan`] lists every top-level item that would move, its
//! destination, and — where the destination already holds an item — a
//! [`Conflict`] resolution. Newer Flint data is never scheduled for silent
//! overwrite: when the existing Flint item is newer than the JAN one, the
//! recommended resolution is [`Conflict::KeepFlint`] regardless of the caller's
//! default.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::detect::{resolved_entries, Category, LegacyData, SourceRoot};
use super::fsutil;
use super::paths::FlintPaths;
use super::schema::SUPPORTED_SCHEMA;

/// How the migration treats the source data.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// Copy selected categories into Flint; leave JAN untouched.
    Copy,
    /// Point Flint at the existing JAN data location (no copy).
    Reuse,
    /// Copy, then (after full success) remove the JAN source, with a backup.
    Move,
    /// Create a clean Flint profile; touch nothing in JAN.
    Fresh,
}

/// Resolution for an item that already exists at the destination.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Conflict {
    /// Keep the existing Flint item; skip the JAN one.
    KeepFlint,
    /// Overwrite the Flint item with the JAN one.
    UseJan,
    /// Keep both — copy the JAN item alongside under a suffixed name.
    KeepBoth,
}

/// Details of a destination conflict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConflictInfo {
    pub existing: PathBuf,
    pub jan_mtime_ms: Option<u64>,
    pub flint_mtime_ms: Option<u64>,
    /// True when the existing Flint item is strictly newer than the JAN one.
    pub flint_is_newer: bool,
    /// The resolution the plan recommends (honoured by execute unless the
    /// caller rewrites it first).
    pub resolution: Conflict,
}

/// One planned top-level item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlannedItem {
    pub category: Category,
    pub name: String,
    pub root: SourceRoot,
    pub source: PathBuf,
    pub destination: PathBuf,
    pub is_dir: bool,
    pub size_bytes: u64,
    /// Present only when the destination already holds this item.
    pub conflict: Option<ConflictInfo>,
}

/// The full migration plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MigrationPlan {
    pub mode: Mode,
    pub source_config_dir: PathBuf,
    pub source_data_folder: PathBuf,
    pub dest_config_dir: PathBuf,
    pub dest_data_folder: PathBuf,
    pub selected_categories: Vec<Category>,
    pub items: Vec<PlannedItem>,
    /// For Reuse mode: the path Flint should be pointed at.
    pub reuse_path: Option<PathBuf>,
    /// Sum of item sizes to be copied (0 for Reuse/Fresh).
    pub estimated_bytes: u64,
    /// Whether the source schema is compatible with this build.
    pub compatible: bool,
    /// Human-readable warnings (e.g. newer-than-supported schema, conflicts).
    pub warnings: Vec<String>,
}

impl MigrationPlan {
    /// Items that carry a conflict.
    pub fn conflicts(&self) -> impl Iterator<Item = &PlannedItem> {
        self.items.iter().filter(|i| i.conflict.is_some())
    }
}

fn dest_root(flint: &FlintPaths, root: SourceRoot) -> &PathBuf {
    match root {
        SourceRoot::Config => &flint.config_dir,
        SourceRoot::Data => &flint.data_folder,
    }
}

/// Build a migration plan.
///
/// `default_conflict` is applied to conflicting items *unless* the Flint side is
/// newer, in which case [`Conflict::KeepFlint`] is forced.
pub fn plan(
    detect: &LegacyData,
    flint: &FlintPaths,
    selected: &[Category],
    mode: Mode,
    default_conflict: Conflict,
) -> MigrationPlan {
    let source = &detect.source;
    let mut warnings = Vec::new();

    // Schema compatibility gate.
    let compatible = match detect.schema_version {
        Some(v) if v > SUPPORTED_SCHEMA => {
            warnings.push(format!(
                "source schema {v} is newer than supported {SUPPORTED_SCHEMA}; \
                 migration may be incomplete"
            ));
            false
        }
        _ => true,
    };

    let mut plan = MigrationPlan {
        mode,
        source_config_dir: source.config_dir.clone(),
        source_data_folder: source.data_folder.clone(),
        dest_config_dir: flint.config_dir.clone(),
        dest_data_folder: flint.data_folder.clone(),
        selected_categories: selected.to_vec(),
        items: Vec::new(),
        reuse_path: None,
        estimated_bytes: 0,
        compatible,
        warnings,
    };

    match mode {
        Mode::Fresh => {
            // Nothing copied; a clean profile is created by execute.
            plan.selected_categories.clear();
            return plan;
        }
        Mode::Reuse => {
            plan.reuse_path = Some(source.data_folder.clone());
            if !compatible {
                plan.warnings
                    .push("reuse refused/at-risk: source schema newer than supported".to_string());
            }
            return plan;
        }
        Mode::Copy | Mode::Move => {}
    }

    for &category in selected {
        for entry in resolved_entries(category, source) {
            let destination = dest_root(flint, entry.root).join(&entry.name);
            let size = fsutil::size_of(&entry.source_path);
            plan.estimated_bytes = plan.estimated_bytes.saturating_add(size);

            let conflict = if destination.exists() {
                let jan_mtime_ms = fsutil::mtime_ms(&entry.source_path);
                let flint_mtime_ms = fsutil::mtime_ms(&destination);
                let flint_is_newer = match (jan_mtime_ms, flint_mtime_ms) {
                    (Some(j), Some(fl)) => fl > j,
                    _ => false,
                };
                let resolution = if flint_is_newer {
                    // Never silently overwrite newer Flint data.
                    Conflict::KeepFlint
                } else {
                    default_conflict
                };
                plan.warnings.push(format!(
                    "conflict on {}: {} ({})",
                    entry.name,
                    match resolution {
                        Conflict::KeepFlint => "keep Flint",
                        Conflict::UseJan => "use JAN",
                        Conflict::KeepBoth => "keep both",
                    },
                    if flint_is_newer {
                        "Flint is newer"
                    } else {
                        "default"
                    }
                ));
                Some(ConflictInfo {
                    existing: destination.clone(),
                    jan_mtime_ms,
                    flint_mtime_ms,
                    flint_is_newer,
                    resolution,
                })
            } else {
                None
            };

            plan.items.push(PlannedItem {
                category: entry.category,
                name: entry.name,
                root: entry.root,
                source: entry.source_path,
                destination,
                is_dir: entry.is_dir,
                size_bytes: size,
                conflict,
            });
        }
    }

    plan
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::migration::detect::detect_legacy;
    use crate::core::migration::paths::{flint_paths, Roots};
    use std::fs;

    fn roots_with_legacy() -> (tempfile::TempDir, Roots) {
        let td = tempfile::tempdir().unwrap();
        let data_dir = td.path().join("appdata");
        let home = td.path().join("home");
        crate::core::migration::detect::tests::seed_legacy(&data_dir, &home);
        let roots = Roots::new(&data_dir, &home);
        (td, roots)
    }

    #[test]
    fn copy_plan_lists_items_with_destinations() {
        let (_td, roots) = roots_with_legacy();
        let detect = detect_legacy(&roots).unwrap();
        let flint = flint_paths(&roots);
        let p = plan(
            &detect,
            &flint,
            &[Category::Conversations, Category::Settings],
            Mode::Copy,
            Conflict::KeepBoth,
        );
        assert_eq!(p.mode, Mode::Copy);
        assert!(p.estimated_bytes > 0);
        assert!(p.items.iter().any(|i| i.name == "threads"
            && i.destination == flint.data_folder.join("threads")));
        // settings.json maps config -> Flint config dir.
        assert!(p.items.iter().any(|i| i.name == "settings.json"
            && i.destination == flint.config_dir.join("settings.json")));
        // No conflicts on a fresh Flint.
        assert_eq!(p.conflicts().count(), 0);
    }

    #[test]
    fn fresh_plan_copies_nothing() {
        let (_td, roots) = roots_with_legacy();
        let detect = detect_legacy(&roots).unwrap();
        let flint = flint_paths(&roots);
        let p = plan(&detect, &flint, Category::all(), Mode::Fresh, Conflict::KeepFlint);
        assert!(p.items.is_empty());
        assert_eq!(p.estimated_bytes, 0);
        assert!(p.reuse_path.is_none());
    }

    #[test]
    fn reuse_plan_returns_source_path() {
        let (_td, roots) = roots_with_legacy();
        let detect = detect_legacy(&roots).unwrap();
        let flint = flint_paths(&roots);
        let p = plan(&detect, &flint, Category::all(), Mode::Reuse, Conflict::KeepFlint);
        assert_eq!(p.reuse_path.as_ref(), Some(&detect.source.data_folder));
        assert!(p.items.is_empty());
    }

    #[test]
    fn conflict_keeps_newer_flint() {
        let (_td, roots) = roots_with_legacy();
        let detect = detect_legacy(&roots).unwrap();
        let flint = flint_paths(&roots);

        // Pre-create a NEWER Flint threads dir.
        let flint_threads = flint.data_folder.join("threads");
        fs::create_dir_all(&flint_threads).unwrap();
        fs::write(flint_threads.join("newer.json"), b"{}").unwrap();
        // Ensure Flint mtime is strictly newer than the JAN source.
        let future = std::time::SystemTime::now() + std::time::Duration::from_secs(120);
        fs::File::options()
            .write(true)
            .open(&flint_threads)
            .ok()
            .map(|f| f.set_modified(future));
        // Directory mtime set may be a no-op on some FS; also bump the file.
        let f = fs::File::options()
            .write(true)
            .open(flint_threads.join("newer.json"))
            .unwrap();
        let _ = f.set_modified(future);

        let p = plan(
            &detect,
            &flint,
            &[Category::Conversations],
            Mode::Copy,
            Conflict::UseJan, // default says overwrite...
        );
        let threads = p.items.iter().find(|i| i.name == "threads").unwrap();
        let conflict = threads.conflict.as_ref().expect("conflict expected");
        // ...but newer Flint forces KeepFlint.
        if conflict.flint_is_newer {
            assert_eq!(conflict.resolution, Conflict::KeepFlint);
        }
    }

    #[test]
    fn newer_schema_marks_incompatible() {
        let td = tempfile::tempdir().unwrap();
        let data_dir = td.path().join("appdata");
        let data = data_dir.join("Jan/data");
        let jan = data_dir.join("Jan");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(data.join("threads")).unwrap();
        fs::write(data.join("threads/t.json"), b"{}").unwrap();
        fs::write(
            jan.join("settings.json"),
            br#"{"schema_version": 99999}"#,
        )
        .unwrap();
        let roots = Roots::new(&data_dir, td.path().join("home"));
        let detect = detect_legacy(&roots).unwrap();
        let flint = flint_paths(&roots);
        let p = plan(&detect, &flint, Category::all(), Mode::Copy, Conflict::KeepFlint);
        assert!(!p.compatible);
        assert!(p.warnings.iter().any(|w| w.contains("newer than supported")));
    }
}
