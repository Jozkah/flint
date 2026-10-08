//! The migration manifest: `<flint_config>/migration_manifest.json`.
//!
//! The manifest is the durable record of a migration and the basis for
//! idempotency: a re-run consults it to skip categories already marked done,
//! and the first-launch prompt consults it to decide whether to offer migration
//! at all.
//!
//! It NEVER contains secrets or message/thread contents — only paths, counts,
//! statuses and reasons. `skipped_items` records a file path plus a short,
//! content-free reason.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::detect::{Category, LegacyLocation};
use super::fsutil;

/// Manifest filename inside the Flint config dir.
pub const MANIFEST_FILE_NAME: &str = "migration_manifest.json";

/// Overall migration status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Detected, not started.
    Pending,
    /// Started, not finished (crash/interruption leaves this on disk).
    InProgress,
    /// Finished successfully.
    Complete,
    /// User declined migration; do not offer again.
    Dismissed,
    /// Attempted and failed (after rollback). May be retried.
    Failed,
}

/// The chosen migration mode, mirrored into the manifest for auditing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModeTag {
    Copy,
    Reuse,
    Move,
    Fresh,
}

/// Per-category outcome record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CategoryResultRecord {
    pub category: Category,
    pub ok_count: usize,
    pub skipped_count: usize,
    pub failed_count: usize,
    /// Done marker: a re-run skips categories where this is true.
    pub done: bool,
}

/// A skipped item, path + content-free reason. Never holds file contents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkippedRecord {
    pub path: PathBuf,
    pub reason: String,
}

/// The source description (paths + which root the data came from).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceInfo {
    pub config_dir: PathBuf,
    pub data_folder: PathBuf,
    pub location: LegacyLocation,
}

/// The destination description (Flint paths).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DestInfo {
    pub config_dir: PathBuf,
    pub data_folder: PathBuf,
}

/// A Flint item overwritten by a migration, with the backup of the original.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplacedRecord {
    pub dest: PathBuf,
    pub backup: PathBuf,
}

/// The migration manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MigrationManifest {
    pub source: SourceInfo,
    pub destination: DestInfo,
    /// `{"source": <n>, "supported": <n>}` and any per-category versions.
    pub schema_versions: BTreeMap<String, u32>,
    pub selected_categories: Vec<Category>,
    pub mode: ModeTag,
    pub results: Vec<CategoryResultRecord>,
    pub skipped_items: Vec<SkippedRecord>,
    /// Destination paths this migration created (did not exist before). The
    /// undo ledger: a later rollback removes only these, never other Flint data.
    #[serde(default)]
    pub created: Vec<PathBuf>,
    /// Destination items this migration overwrote, with a backup of each
    /// original, so a rollback can restore them.
    #[serde(default)]
    pub replaced: Vec<ReplacedRecord>,
    pub backup_path: Option<PathBuf>,
    /// For Reuse mode: the JAN path Flint was pointed at.
    pub reuse_path: Option<PathBuf>,
    pub status: Status,
    pub started_at: u64,
    pub finished_at: Option<u64>,
}

impl MigrationManifest {
    /// A fresh, pending manifest for a run.
    pub fn new(
        source: SourceInfo,
        destination: DestInfo,
        mode: ModeTag,
        selected_categories: Vec<Category>,
        schema_versions: BTreeMap<String, u32>,
    ) -> Self {
        Self {
            source,
            destination,
            schema_versions,
            selected_categories,
            mode,
            results: Vec::new(),
            skipped_items: Vec::new(),
            created: Vec::new(),
            replaced: Vec::new(),
            backup_path: None,
            reuse_path: None,
            status: Status::Pending,
            started_at: fsutil::now_ms(),
            finished_at: None,
        }
    }

    /// Whether a category is already recorded as done (idempotency check).
    pub fn is_category_done(&self, category: Category) -> bool {
        self.results
            .iter()
            .any(|r| r.category == category && r.done)
    }

    /// Insert or replace a category's result record.
    pub fn upsert_result(&mut self, record: CategoryResultRecord) {
        if let Some(existing) = self
            .results
            .iter_mut()
            .find(|r| r.category == record.category)
        {
            *existing = record;
        } else {
            self.results.push(record);
        }
    }

    /// Mark the manifest complete (sets `finished_at`).
    pub fn mark_complete(&mut self) {
        self.status = Status::Complete;
        self.finished_at = Some(fsutil::now_ms());
    }

    /// Mark the manifest dismissed by the user (sets `finished_at`).
    pub fn mark_dismissed(&mut self) {
        self.status = Status::Dismissed;
        self.finished_at = Some(fsutil::now_ms());
    }

    /// Mark the manifest failed (sets `finished_at`).
    pub fn mark_failed(&mut self) {
        self.status = Status::Failed;
        self.finished_at = Some(fsutil::now_ms());
    }
}

/// Full path to the manifest inside a Flint config dir.
pub fn manifest_path(flint_config_dir: &Path) -> PathBuf {
    flint_config_dir.join(MANIFEST_FILE_NAME)
}

/// Read the manifest, if present. `Ok(None)` when absent; `Err` when present but
/// unreadable/unparseable.
pub fn read(flint_config_dir: &Path) -> Result<Option<MigrationManifest>, String> {
    let path = manifest_path(flint_config_dir);
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read manifest: {e}"))?;
    let manifest =
        serde_json::from_str(&text).map_err(|e| format!("parse manifest: {e}"))?;
    Ok(Some(manifest))
}

/// Write the manifest atomically (temp file + rename).
pub fn write(flint_config_dir: &Path, manifest: &MigrationManifest) -> Result<(), String> {
    std::fs::create_dir_all(flint_config_dir)
        .map_err(|e| format!("create flint config dir: {e}"))?;
    let path = manifest_path(flint_config_dir);
    let tmp = path.with_extension("json.tmp");
    let text =
        serde_json::to_string_pretty(manifest).map_err(|e| format!("serialize manifest: {e}"))?;
    std::fs::write(&tmp, text).map_err(|e| format!("write manifest tmp: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename manifest: {e}"))?;
    Ok(())
}

/// Mark an existing manifest complete and persist it.
pub fn mark_complete(flint_config_dir: &Path) -> Result<(), String> {
    let mut m = read(flint_config_dir)?
        .ok_or_else(|| "no manifest to complete".to_string())?;
    m.mark_complete();
    write(flint_config_dir, &m)
}

/// Mark migration dismissed, creating a minimal dismissed manifest when none
/// exists (the user declined before any run).
pub fn mark_dismissed(flint_config_dir: &Path) -> Result<(), String> {
    match read(flint_config_dir)? {
        Some(mut m) => {
            m.mark_dismissed();
            write(flint_config_dir, &m)
        }
        None => {
            let now = fsutil::now_ms();
            let m = MigrationManifest {
                source: SourceInfo {
                    config_dir: PathBuf::new(),
                    data_folder: PathBuf::new(),
                    location: LegacyLocation::DataFolder,
                },
                destination: DestInfo {
                    config_dir: flint_config_dir.to_path_buf(),
                    data_folder: flint_config_dir.join("data"),
                },
                schema_versions: BTreeMap::new(),
                selected_categories: Vec::new(),
                mode: ModeTag::Fresh,
                results: Vec::new(),
                skipped_items: Vec::new(),
                created: Vec::new(),
                replaced: Vec::new(),
                backup_path: None,
                reuse_path: None,
                status: Status::Dismissed,
                started_at: now,
                finished_at: Some(now),
            };
            write(flint_config_dir, &m)
        }
    }
}

/// Whether the first-launch migration prompt should be offered.
///
/// True when legacy data is present AND migration has not reached a terminal
/// user decision. `Complete` and `Dismissed` are terminal (never re-offer);
/// `Pending`, `InProgress` and `Failed` are all still pending (a failed or
/// interrupted run can be retried/resumed).
pub fn is_first_launch_pending(flint_config_dir: &Path, legacy_present: bool) -> bool {
    if !legacy_present {
        return false;
    }
    match read(flint_config_dir) {
        Ok(None) => true,
        Ok(Some(m)) => !matches!(m.status, Status::Complete | Status::Dismissed),
        // An unreadable manifest is treated as still-pending: better to offer
        // migration than to silently skip it.
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(flint_config: &Path) -> MigrationManifest {
        let mut sv = BTreeMap::new();
        sv.insert("source".to_string(), 1);
        sv.insert("supported".to_string(), 1);
        MigrationManifest::new(
            SourceInfo {
                config_dir: PathBuf::from("/jan"),
                data_folder: PathBuf::from("/jan/data"),
                location: LegacyLocation::DataFolder,
            },
            DestInfo {
                config_dir: flint_config.to_path_buf(),
                data_folder: flint_config.join("data"),
            },
            ModeTag::Copy,
            vec![Category::Conversations, Category::Settings],
            sv,
        )
    }

    #[test]
    fn roundtrip_read_write() {
        let td = tempfile::tempdir().unwrap();
        let m = sample(td.path());
        write(td.path(), &m).unwrap();
        let back = read(td.path()).unwrap().unwrap();
        assert_eq!(back, m);
    }

    #[test]
    fn first_launch_pending_transitions() {
        let td = tempfile::tempdir().unwrap();
        // No manifest + legacy present -> pending.
        assert!(is_first_launch_pending(td.path(), true));
        // Legacy absent -> never pending.
        assert!(!is_first_launch_pending(td.path(), false));

        let mut m = sample(td.path());
        write(td.path(), &m).unwrap();
        assert!(is_first_launch_pending(td.path(), true)); // Pending

        m.mark_complete();
        write(td.path(), &m).unwrap();
        assert!(!is_first_launch_pending(td.path(), true)); // Complete -> no

        m.status = Status::Dismissed;
        write(td.path(), &m).unwrap();
        assert!(!is_first_launch_pending(td.path(), true)); // Dismissed -> no

        m.status = Status::Failed;
        write(td.path(), &m).unwrap();
        assert!(is_first_launch_pending(td.path(), true)); // Failed -> retry
    }

    #[test]
    fn mark_dismissed_without_manifest_creates_one() {
        let td = tempfile::tempdir().unwrap();
        mark_dismissed(td.path()).unwrap();
        let m = read(td.path()).unwrap().unwrap();
        assert_eq!(m.status, Status::Dismissed);
        assert!(!is_first_launch_pending(td.path(), true));
    }

    #[test]
    fn category_done_marker() {
        let td = tempfile::tempdir().unwrap();
        let mut m = sample(td.path());
        assert!(!m.is_category_done(Category::Conversations));
        m.upsert_result(CategoryResultRecord {
            category: Category::Conversations,
            ok_count: 3,
            skipped_count: 0,
            failed_count: 0,
            done: true,
        });
        assert!(m.is_category_done(Category::Conversations));
        // upsert replaces rather than duplicates.
        m.upsert_result(CategoryResultRecord {
            category: Category::Conversations,
            ok_count: 5,
            skipped_count: 1,
            failed_count: 0,
            done: true,
        });
        assert_eq!(m.results.len(), 1);
        assert_eq!(m.results[0].ok_count, 5);
    }
}
