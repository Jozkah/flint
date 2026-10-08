//! Executing a [`MigrationPlan`].
//!
//! Guarantees:
//! - **Atomicity per item**: each item is staged into a scratch directory and
//!   then `rename`d into place, so an interrupted copy never leaves a partial
//!   item at the destination.
//! - **Idempotency**: per-category "done" markers in the manifest are consulted;
//!   a re-run after interruption skips completed categories and never
//!   duplicates. A `Complete` manifest short-circuits entirely.
//! - **Quarantine, don't abort**: a corrupt or partial record is copied into
//!   `<flint>/migration-quarantine/` and recorded as skipped; one bad record
//!   never fails the whole migration.
//! - **Verbatim + provenance**: files are copied byte-for-byte with their mtime
//!   preserved. Only `settings.json` is rewritten, and only to repoint absolute
//!   path prefixes from the JAN data folder to the Flint one.
//! - **Secrets**: `provider_secrets.enc` is copied as raw bytes only. It is
//!   never decrypted, never parsed, never logged. The OS keyring is not touched
//!   (Flint reuses the same keyring service name — see the TODO below).
//! - **Rollback**: `Move` creates a recoverable backup before removing the JAN
//!   source; any failure restores the original state.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::detect::{Category, SourceRoot};
use super::fsutil;
use super::manifest::{self, CategoryResultRecord, ModeTag, Status};
use super::plan::{Conflict, MigrationPlan, Mode, PlannedItem};
use super::schema;

/// Subdirectory (under the Flint config dir) that holds quarantined records.
pub const QUARANTINE_DIR_NAME: &str = "migration-quarantine";
/// Subdirectory (under the Flint config dir) that holds Move backups.
pub const BACKUP_DIR_NAME: &str = "migration-backup";
/// Suffix appended to a JAN item copied alongside an existing Flint one
/// ([`Conflict::KeepBoth`]).
pub const KEEP_BOTH_SUFFIX: &str = ".from-jan";

/// Options controlling execution. The `fail_*` hooks exist so tests can force a
/// failure at a precise point and assert rollback; they default to off.
#[derive(Debug, Clone, Default)]
pub struct ExecuteOpts {
    /// Label recorded in any lock this run takes.
    pub holder: String,
    /// Override the Move backup location. Defaults to `<flint_config>/migration-backup`.
    pub backup_root: Option<PathBuf>,
    /// Test hook: force a failure upon reaching this category.
    pub fail_on_category: Option<Category>,
    /// Test hook (Move): fail after copy + backup, before removing the source.
    pub fail_before_source_removal: bool,
}

impl ExecuteOpts {
    /// Convenience constructor with a holder label and no failure hooks.
    pub fn with_holder(holder: impl Into<String>) -> Self {
        Self {
            holder: holder.into(),
            ..Default::default()
        }
    }
}

/// Per-category outcome.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CategoryResult {
    pub category: Category,
    pub ok_count: usize,
    pub skipped_count: usize,
    pub failed_count: usize,
    pub done: bool,
}

/// A skipped item, path + content-free reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkippedItem {
    pub path: PathBuf,
    pub reason: String,
}

/// The outcome of an execute run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MigrationResult {
    pub status: Status,
    pub mode: Mode,
    pub per_category: Vec<CategoryResult>,
    pub skipped: Vec<SkippedItem>,
    pub backup_path: Option<PathBuf>,
    pub reuse_path: Option<PathBuf>,
    pub quarantine_dir: Option<PathBuf>,
    pub manifest_path: PathBuf,
    pub error: Option<String>,
    pub rolled_back: bool,
    /// Set by the command layer when the run changed the data folder the app
    /// is configured to use, which only takes effect on the next start.
    #[serde(default)]
    pub restart_required: bool,
}

impl MigrationResult {
    fn base(plan: &MigrationPlan) -> Self {
        Self {
            status: Status::InProgress,
            mode: plan.mode,
            per_category: Vec::new(),
            skipped: Vec::new(),
            backup_path: None,
            reuse_path: None,
            quarantine_dir: None,
            manifest_path: manifest::manifest_path(&plan.dest_config_dir),
            error: None,
            rolled_back: false,
            restart_required: false,
        }
    }
}

fn mode_tag(mode: Mode) -> ModeTag {
    match mode {
        Mode::Copy => ModeTag::Copy,
        Mode::Reuse => ModeTag::Reuse,
        Mode::Move => ModeTag::Move,
        Mode::Fresh => ModeTag::Fresh,
    }
}

/// Durable (not per-pid) directory holding backups of Flint items a migration
/// overwrote, so `rollback_from_manifest` can restore them after the run.
const UNDO_DIR_NAME: &str = ".migrate-undo";

/// Tracks what this run created/replaced so a failure can be rolled back.
struct RunState {
    staging_root: PathBuf,
    rollback_root: PathBuf,
    /// Destination paths newly created this run (did not exist before).
    created: Vec<PathBuf>,
    /// (destination, backup-of-original) for Flint items overwritten this run.
    replaced: Vec<(PathBuf, PathBuf)>,
    counter: usize,
}

impl RunState {
    fn new(flint_config: &Path) -> Self {
        let pid = std::process::id();
        Self {
            staging_root: flint_config.join(format!(".migrate-staging-{pid}")),
            rollback_root: flint_config.join(UNDO_DIR_NAME),
            created: Vec::new(),
            replaced: Vec::new(),
            counter: 0,
        }
    }

    fn next_staging(&mut self, name: &str) -> PathBuf {
        self.counter += 1;
        self.staging_root
            .join(format!("{}-{}", self.counter, sanitize(name)))
    }

    fn next_rollback(&mut self, name: &str) -> PathBuf {
        self.counter += 1;
        // The timestamp keeps a resumed run from reusing a backup name.
        self.rollback_root.join(format!(
            "{}-{}-{}",
            fsutil::now_ms(),
            self.counter,
            sanitize(name)
        ))
    }

    /// Continue the undo ledger of an interrupted earlier attempt.
    fn seed_from(&mut self, m: &manifest::MigrationManifest) {
        self.created = m.created.clone();
        self.replaced = m
            .replaced
            .iter()
            .map(|r| (r.dest.clone(), r.backup.clone()))
            .collect();
    }

    /// Persist the ledger into the manifest.
    fn sync_into(&self, m: &mut manifest::MigrationManifest) {
        m.created = self.created.clone();
        m.replaced = self
            .replaced
            .iter()
            .map(|(dest, backup)| manifest::ReplacedRecord {
                dest: dest.clone(),
                backup: backup.clone(),
            })
            .collect();
    }

    /// Undo everything this run did: remove created items, restore replaced
    /// ones. Best-effort; returns whether all steps succeeded.
    fn rollback(&self) -> bool {
        let mut ok = true;
        for path in &self.created {
            if path.is_dir() {
                ok &= std::fs::remove_dir_all(path).is_ok();
            } else if path.is_file() {
                ok &= std::fs::remove_file(path).is_ok();
            }
        }
        for (dest, backup) in &self.replaced {
            // Remove whatever we placed, then restore the original from backup.
            if dest.is_dir() {
                let _ = std::fs::remove_dir_all(dest);
            } else if dest.is_file() {
                let _ = std::fs::remove_file(dest);
            }
            ok &= fsutil::copy_tree_preserving_mtime(backup, dest).is_ok();
        }
        ok
    }

    fn cleanup_scratch(&self) {
        let _ = std::fs::remove_dir_all(&self.staging_root);
    }

    /// Drop the overwritten-item backups. Only once the ledger that points at
    /// them is gone (rolled back); a finished run keeps them for a later undo.
    fn discard_undo(&self) {
        let _ = std::fs::remove_dir_all(&self.rollback_root);
    }
}

/// Write a manifest checkpoint. A failure is logged, not fatal: the run can
/// continue, but a later resume or rollback may know less than it should.
fn checkpoint(dir: &Path, m: &manifest::MigrationManifest) {
    if let Err(e) = manifest::write(dir, m) {
        log::warn!("migration manifest checkpoint failed in {}: {e}", dir.display());
    }
}

fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

/// Execute a plan. Never panics; failures are reported in
/// [`MigrationResult::error`] with `status = Failed` (after rollback where
/// applicable).
pub fn execute(plan: &MigrationPlan, opts: &ExecuteOpts) -> MigrationResult {
    let mut result = MigrationResult::base(plan);
    let flint_config = plan.dest_config_dir.clone();
    let flint_data = plan.dest_data_folder.clone();

    // Short-circuit a completed migration for the same source (idempotent).
    if let Ok(Some(existing)) = manifest::read(&flint_config) {
        if existing.status == Status::Complete
            && existing.source.data_folder == plan.source_data_folder
        {
            result.status = Status::Complete;
            result.per_category = existing
                .results
                .iter()
                .map(|r| CategoryResult {
                    category: r.category,
                    ok_count: r.ok_count,
                    skipped_count: r.skipped_count,
                    failed_count: r.failed_count,
                    done: r.done,
                })
                .collect();
            result.backup_path = existing.backup_path.clone();
            result.reuse_path = existing.reuse_path.clone();
            return result;
        }
    }

    if matches!(plan.mode, Mode::Copy | Mode::Move) {
        if let Some(reason) = overlapping_folders(plan) {
            result.status = Status::Failed;
            result.error = Some(reason);
            return result;
        }
    }

    match plan.mode {
        Mode::Fresh => execute_fresh(plan, &flint_config, &flint_data, &mut result),
        Mode::Reuse => execute_reuse(plan, &flint_config, opts, &mut result),
        Mode::Copy | Mode::Move => execute_copy_or_move(plan, opts, &mut result),
    }

    result
}

/// Whether the source and destination data (or config) folders are the same
/// place or nested in one another. Copying or moving then would read what it
/// is writing, and a Move would delete the destination. Checked on canonical
/// paths, before anything is touched.
fn overlapping_folders(plan: &MigrationPlan) -> Option<String> {
    let pairs = [
        ("data", &plan.source_data_folder, &plan.dest_data_folder),
        ("config", &plan.source_config_dir, &plan.dest_config_dir),
    ];
    for (what, src, dst) in pairs {
        let s = fsutil::canonical_or_lexical(src);
        let d = fsutil::canonical_or_lexical(dst);
        if s == d || s.starts_with(&d) || d.starts_with(&s) {
            return Some(format!(
                "source and destination {what} folders are the same or nested ({} and {}); \
                 migration refused",
                s.display(),
                d.display()
            ));
        }
    }
    None
}

fn build_manifest(plan: &MigrationPlan) -> manifest::MigrationManifest {
    // Resume an existing, non-complete manifest for the same source so its
    // done markers survive; otherwise start fresh.
    let source_schema = schema::read_schema_version(&plan.source_config_dir.join("settings.json"))
        .ok()
        .flatten()
        .or_else(|| {
            schema::read_schema_version(&plan.source_data_folder.join("settings.json"))
                .ok()
                .flatten()
        });
    if let Ok(Some(existing)) = manifest::read(&plan.dest_config_dir) {
        if existing.source.data_folder == plan.source_data_folder
            && existing.mode == mode_tag(plan.mode)
            && existing.status != Status::Complete
        {
            return existing;
        }
    }
    let mut schema_versions = std::collections::BTreeMap::new();
    if let Some(v) = source_schema {
        schema_versions.insert("source".to_string(), v);
    }
    schema_versions.insert("supported".to_string(), schema::SUPPORTED_SCHEMA);

    manifest::MigrationManifest::new(
        manifest::SourceInfo {
            config_dir: plan.source_config_dir.clone(),
            data_folder: plan.source_data_folder.clone(),
            location: super::detect::LegacyLocation::DataFolder,
        },
        manifest::DestInfo {
            config_dir: plan.dest_config_dir.clone(),
            data_folder: plan.dest_data_folder.clone(),
        },
        mode_tag(plan.mode),
        plan.selected_categories.clone(),
        schema_versions,
    )
}

fn execute_fresh(
    _plan: &MigrationPlan,
    flint_config: &Path,
    flint_data: &Path,
    result: &mut MigrationResult,
) {
    if let Err(e) = std::fs::create_dir_all(flint_config).and_then(|_| std::fs::create_dir_all(flint_data)) {
        result.status = Status::Failed;
        result.error = Some(format!("create flint profile: {e}"));
        return;
    }
    let mut m = build_manifest(_plan);
    m.status = Status::InProgress;
    checkpoint(flint_config, &m);
    m.mark_complete();
    if let Err(e) = manifest::write(flint_config, &m) {
        result.status = Status::Failed;
        result.error = Some(e);
        return;
    }
    result.status = Status::Complete;
}

fn execute_reuse(
    plan: &MigrationPlan,
    flint_config: &Path,
    opts: &ExecuteOpts,
    result: &mut MigrationResult,
) {
    let mut m = build_manifest(plan);
    m.status = Status::InProgress;
    checkpoint(flint_config, &m);

    if !plan.compatible {
        m.mark_failed();
        checkpoint(flint_config, &m);
        result.status = Status::Failed;
        result.error = Some("source schema newer than supported; reuse refused".to_string());
        return;
    }

    let reuse_path = match &plan.reuse_path {
        Some(p) => p.clone(),
        None => plan.source_data_folder.clone(),
    };

    // Refuse to reuse a profile another live process is writing.
    if super::lock::is_held_by_other(&reuse_path) {
        m.mark_failed();
        checkpoint(flint_config, &m);
        result.status = Status::Failed;
        result.error = Some(format!(
            "reuse refused: {} is locked by another process",
            reuse_path.display()
        ));
        return;
    }

    // Take the lock and keep it: the reused profile is this session's data
    // folder, so it stays locked until the app exits (#168). It is released
    // straight away only when the reuse then fails.
    let lock = match super::lock::acquire(&reuse_path, if opts.holder.is_empty() { "flint-migration" } else { &opts.holder }) {
        Ok(lock) => lock,
        Err(super::lock::LockError::Held(info)) => {
            m.mark_failed();
            checkpoint(flint_config, &m);
            result.status = Status::Failed;
            result.error = Some(format!("reuse refused: locked by pid {}", info.pid));
            return;
        }
        Err(super::lock::LockError::Io(e)) => {
            m.mark_failed();
            checkpoint(flint_config, &m);
            result.status = Status::Failed;
            result.error = Some(format!("reuse lock io error: {e}"));
            return;
        }
    };

    if let Err(e) = std::fs::create_dir_all(flint_config) {
        let _ = lock.release();
        result.status = Status::Failed;
        result.error = Some(format!("create flint config: {e}"));
        return;
    }
    m.reuse_path = Some(reuse_path.clone());
    m.mark_complete();
    if let Err(e) = manifest::write(flint_config, &m) {
        let _ = lock.release();
        result.status = Status::Failed;
        result.error = Some(e);
        return;
    }
    super::lock::hold_for_session(lock);
    result.status = Status::Complete;
    result.reuse_path = Some(reuse_path);
}

fn execute_copy_or_move(plan: &MigrationPlan, opts: &ExecuteOpts, result: &mut MigrationResult) {
    // #67: the same schema gate as execute_reuse. Refuse before creating or
    // writing anything, so data from a newer, unsupported schema is never
    // copied or moved into the profile.
    if !plan.compatible {
        result.status = Status::Failed;
        result.error = Some("source schema newer than supported; copy/move refused".to_string());
        return;
    }

    // A Move deletes the source, but copying skips directory links, so what a
    // link points to would be lost. Refuse before writing anything.
    if plan.mode == Mode::Move {
        for item in &plan.items {
            if let Some(link) = fsutil::find_linked_dir(&item.source) {
                result.status = Status::Failed;
                result.error = Some(format!(
                    "move refused: {} contains a directory link ({}); copy instead, or remove the link first",
                    item.name,
                    link.display()
                ));
                return;
            }
        }
    }

    let flint_config = plan.dest_config_dir.clone();
    let flint_data = plan.dest_data_folder.clone();
    let quarantine_dir = flint_config.join(QUARANTINE_DIR_NAME);
    result.quarantine_dir = Some(quarantine_dir.clone());

    if let Err(e) = std::fs::create_dir_all(&flint_config).and_then(|_| std::fs::create_dir_all(&flint_data)) {
        result.status = Status::Failed;
        result.error = Some(format!("create flint dirs: {e}"));
        return;
    }

    let mut m = build_manifest(plan);
    m.status = Status::InProgress;
    checkpoint(&flint_config, &m);

    let mut run = RunState::new(&flint_config);
    run.seed_from(&m);
    let _ = std::fs::create_dir_all(&run.staging_root);

    // Group planned items by category, preserving plan order.
    for &category in &plan.selected_categories {
        // Idempotency: skip categories already done.
        if m.is_category_done(category) {
            if let Some(rec) = m.results.iter().find(|r| r.category == category) {
                result.per_category.push(CategoryResult {
                    category,
                    ok_count: rec.ok_count,
                    skipped_count: rec.skipped_count,
                    failed_count: rec.failed_count,
                    done: true,
                });
            }
            continue;
        }

        // Test hook: force a failure at this category.
        if opts.fail_on_category == Some(category) {
            fail_and_rollback(
                plan,
                &mut m,
                &run,
                result,
                &format!("forced failure at category {}", category.as_str()),
            );
            return;
        }

        let items: Vec<&PlannedItem> =
            plan.items.iter().filter(|i| i.category == category).collect();

        let mut ok_count = 0usize;
        let mut skipped_count = 0usize;
        let mut cat_skipped: Vec<SkippedItem> = Vec::new();

        for item in items {
            match place_item(plan, item, &quarantine_dir, &mut run, &mut cat_skipped) {
                Ok(placed) => {
                    if placed {
                        ok_count += 1;
                    } else {
                        skipped_count += 1;
                    }
                    // Persist the undo ledger per item, so a crash mid-category
                    // still leaves a rollback that knows what was written.
                    run.sync_into(&mut m);
                    checkpoint(&flint_config, &m);
                }
                Err(e) => {
                    fail_and_rollback(
                        plan,
                        &mut m,
                        &run,
                        result,
                        &format!("failed on {}: {e}", item.name),
                    );
                    return;
                }
            }
        }

        skipped_count += cat_skipped.len();
        result.skipped.extend(cat_skipped.iter().cloned());
        for s in &cat_skipped {
            m.skipped_items.push(manifest::SkippedRecord {
                path: s.path.clone(),
                reason: s.reason.clone(),
            });
        }

        let rec = CategoryResultRecord {
            category,
            ok_count,
            skipped_count,
            failed_count: 0,
            done: true,
        };
        m.upsert_result(rec.clone());
        // Checkpoint the manifest after each category so an interruption resumes
        // cleanly.
        checkpoint(&flint_config, &m);

        result.per_category.push(CategoryResult {
            category,
            ok_count,
            skipped_count,
            failed_count: 0,
            done: true,
        });
    }

    // Move: back up the source, then remove it (only after a clean copy).
    if plan.mode == Mode::Move {
        let backup_root = opts
            .backup_root
            .clone()
            .unwrap_or_else(|| flint_config.join(BACKUP_DIR_NAME));
        match backup_source(plan, &backup_root) {
            Ok(()) => {
                m.backup_path = Some(backup_root.clone());
                result.backup_path = Some(backup_root.clone());
                checkpoint(&flint_config, &m);
            }
            Err(e) => {
                fail_and_rollback(plan, &mut m, &run, result, &format!("backup failed: {e}"));
                return;
            }
        }

        if opts.fail_before_source_removal {
            // Rollback: source is untouched; remove flint writes and the backup.
            let _ = std::fs::remove_dir_all(&backup_root);
            fail_and_rollback(
                plan,
                &mut m,
                &run,
                result,
                "forced failure before source removal",
            );
            return;
        }

        if let Err(e) = remove_source(plan) {
            // Restore removed source from backup, then roll back flint.
            let _ = restore_source_from_backup(plan, &backup_root);
            fail_and_rollback(
                plan,
                &mut m,
                &run,
                result,
                &format!("source removal failed (restored): {e}"),
            );
            return;
        }
    }

    run.cleanup_scratch();
    m.mark_complete();
    if let Err(e) = manifest::write(&flint_config, &m) {
        // The data is in place, but without a Complete manifest the run would
        // look interrupted. Say so rather than report success.
        log::error!("final migration manifest write failed: {e}");
        result.status = Status::Failed;
        result.error = Some(format!("migration finished but its record could not be saved: {e}"));
        return;
    }
    result.status = Status::Complete;
}

fn fail_and_rollback(
    plan: &MigrationPlan,
    m: &mut manifest::MigrationManifest,
    run: &RunState,
    result: &mut MigrationResult,
    reason: &str,
) {
    let rolled = run.rollback();
    run.cleanup_scratch();
    // Rolled-back categories are no longer on disk: forget their done markers
    // or a resume would skip them and report Complete with data missing.
    m.results.clear();
    m.skipped_items.clear();
    if rolled {
        m.created.clear();
        m.replaced.clear();
        run.discard_undo();
    } else {
        run.sync_into(m);
    }
    m.mark_failed();
    checkpoint(&plan.dest_config_dir, m);
    result.status = Status::Failed;
    result.rolled_back = rolled;
    result.error = Some(reason.to_string());
}

/// Stage one item into scratch (diverting quarantinable files), then rename it
/// into place honouring its conflict resolution. Returns `Ok(true)` when the
/// item was placed, `Ok(false)` when it was skipped (kept-Flint or fully
/// quarantined).
fn place_item(
    plan: &MigrationPlan,
    item: &PlannedItem,
    quarantine_dir: &Path,
    run: &mut RunState,
    skipped: &mut Vec<SkippedItem>,
) -> Result<bool, String> {
    // Conflict handling.
    let mut final_dest = item.destination.clone();
    let dest_exists = item.destination.exists();
    if let Some(conflict) = &item.conflict {
        match conflict.resolution {
            Conflict::KeepFlint => {
                skipped.push(SkippedItem {
                    path: item.source.clone(),
                    reason: "kept existing Flint item (conflict)".to_string(),
                });
                return Ok(false);
            }
            Conflict::KeepBoth => {
                let suffixed = format!("{}{}", item.name, KEEP_BOTH_SUFFIX);
                final_dest = item
                    .destination
                    .parent()
                    .map(|p| p.join(&suffixed))
                    .unwrap_or_else(|| PathBuf::from(&suffixed));
            }
            Conflict::UseJan => { /* overwrite handled below */ }
        }
    }

    // Stage.
    let staging = run.next_staging(&item.name);
    let mut ok_files = 0usize;
    stage_tree(
        &item.source,
        &staging,
        &item.source,
        quarantine_dir,
        &item.name,
        skipped,
        &mut ok_files,
    )?;

    if !staging.exists() || (staging.is_dir() && fsutil::count_files(&staging) == 0 && !item.is_dir)
    {
        // Everything was quarantined (single-file item diverted).
        return Ok(false);
    }
    if item.is_dir && !staging.exists() {
        // A directory whose every file was quarantined: create an empty dest so
        // structure is preserved, but count as skipped-empty.
        std::fs::create_dir_all(&final_dest).map_err(|e| e.to_string())?;
        if !dest_exists {
            run.created.push(final_dest.clone());
        }
        return Ok(false);
    }

    // Place: overwrite/backup existing dest as needed, then rename staging in.
    let placing_over_existing = final_dest.exists();
    if placing_over_existing {
        // Back up the existing Flint item so a later failure can restore it.
        let backup = run.next_rollback(&item.name);
        if let Some(parent) = backup.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fsutil::copy_tree_preserving_mtime(&final_dest, &backup).map_err(|e| e.to_string())?;
        if final_dest.is_dir() {
            std::fs::remove_dir_all(&final_dest).map_err(|e| e.to_string())?;
        } else {
            std::fs::remove_file(&final_dest).map_err(|e| e.to_string())?;
        }
        run.replaced.push((final_dest.clone(), backup));
    }

    if let Some(parent) = final_dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Atomic move into place. Falls back to a recursive copy when rename crosses
    // a filesystem boundary.
    if std::fs::rename(&staging, &final_dest).is_err() {
        fsutil::copy_tree_preserving_mtime(&staging, &final_dest).map_err(|e| e.to_string())?;
        let _ = if staging.is_dir() {
            std::fs::remove_dir_all(&staging)
        } else {
            std::fs::remove_file(&staging)
        };
    }
    if !placing_over_existing {
        run.created.push(final_dest.clone());
    }

    // Repoint absolute path prefixes inside settings.json (JAN -> Flint).
    if item.name == "settings.json" {
        rewrite_settings_paths(
            &final_dest,
            &plan.source_data_folder,
            &plan.dest_data_folder,
            &plan.source_config_dir,
            &plan.dest_config_dir,
        );
    }

    let _ = ok_files;
    Ok(true)
}

/// Recursively copy `src` into `staging`, diverting corrupt/partial files into
/// the quarantine dir and recording them as skipped.
#[allow(clippy::too_many_arguments)]
fn stage_tree(
    src: &Path,
    staging: &Path,
    item_root: &Path,
    quarantine_dir: &Path,
    item_name: &str,
    skipped: &mut Vec<SkippedItem>,
    ok_files: &mut usize,
) -> Result<(), String> {
    if src.is_file() {
        let status = schema::classify_item(src, None);
        if status.is_quarantinable() {
            quarantine(src, item_root, quarantine_dir, item_name, &status, skipped)?;
            return Ok(());
        }
        fsutil::copy_file_preserving_mtime(src, staging).map_err(|e| e.to_string())?;
        *ok_files += 1;
        return Ok(());
    }
    if !src.is_dir() {
        return Ok(());
    }
    let entries = std::fs::read_dir(src).map_err(|e| e.to_string())?;
    let mut made_dir = false;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let child = entry.path();
        let child_staging = staging.join(entry.file_name());
        // Never descend into a directory link: one pointing at an ancestor
        // would recurse until the stack overflows (#173).
        if fsutil::is_linked_dir(&child) {
            continue;
        }
        if child.is_dir() {
            stage_tree(
                &child,
                &child_staging,
                item_root,
                quarantine_dir,
                item_name,
                skipped,
                ok_files,
            )?;
        } else {
            let status = schema::classify_item(&child, None);
            if status.is_quarantinable() {
                quarantine(&child, item_root, quarantine_dir, item_name, &status, skipped)?;
                continue;
            }
            if !made_dir {
                std::fs::create_dir_all(staging).map_err(|e| e.to_string())?;
                made_dir = true;
            }
            fsutil::copy_file_preserving_mtime(&child, &child_staging).map_err(|e| e.to_string())?;
            *ok_files += 1;
        }
    }
    // Ensure the staging dir exists even if empty when the source dir existed
    // and had only subdirectories (they created their own).
    if !made_dir && !staging.exists() && fsutil::list_files(src).is_empty() {
        // leave absent; caller handles empty item
    }
    Ok(())
}

fn quarantine(
    file: &Path,
    item_root: &Path,
    quarantine_dir: &Path,
    item_name: &str,
    status: &schema::ItemStatus,
    skipped: &mut Vec<SkippedItem>,
) -> Result<(), String> {
    let rel = file.strip_prefix(item_root).unwrap_or(file);
    let dest = quarantine_dir.join(item_name).join(rel);
    // Copy (not move) so the JAN source stays intact; never parse/log contents.
    fsutil::copy_file_preserving_mtime(file, &dest).map_err(|e| e.to_string())?;
    skipped.push(SkippedItem {
        path: file.to_path_buf(),
        reason: status
            .reason()
            .unwrap_or_else(|| "quarantined".to_string()),
    });
    Ok(())
}

/// Rewrite absolute path prefixes inside a copied `settings.json` so references
/// to the old JAN data/config folders point at the new Flint ones. Operates on
/// the raw text (handling native and forward-slash spellings) so nothing else
/// in the file is disturbed. Best-effort: a read/parse issue leaves the file
/// as-is.
fn rewrite_settings_paths(
    settings: &Path,
    src_data: &Path,
    dst_data: &Path,
    src_config: &Path,
    dst_config: &Path,
) {
    let text = match std::fs::read_to_string(settings) {
        Ok(t) => t,
        Err(e) => {
            log::warn!("settings path rewrite: cannot read {}: {e}", settings.display());
            return;
        }
    };
    let mut value: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("settings path rewrite: {} is not valid JSON: {e}", settings.display());
            return;
        }
    };
    let pairs = [(src_data, dst_data), (src_config, dst_config)];
    if !rewrite_value(&mut value, &pairs) {
        return;
    }
    let out = match serde_json::to_string_pretty(&value) {
        Ok(o) => o,
        Err(e) => {
            log::warn!("settings path rewrite: serialize failed: {e}");
            return;
        }
    };
    // Temp + rename so a crash never leaves a truncated settings file.
    let tmp = settings.with_extension("json.tmp");
    let result = std::fs::write(&tmp, out).and_then(|_| std::fs::rename(&tmp, settings));
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        log::warn!("settings path rewrite: cannot write {}: {e}", settings.display());
    }
}

/// Rewrite string values that start with a source path (on a path boundary).
/// Returns whether anything changed.
fn rewrite_value(value: &mut serde_json::Value, pairs: &[(&Path, &Path)]) -> bool {
    match value {
        serde_json::Value::String(s) => {
            if let Some(new) = rewrite_prefix(s, pairs) {
                *s = new;
                true
            } else {
                false
            }
        }
        serde_json::Value::Array(items) => {
            let mut changed = false;
            for item in items {
                changed |= rewrite_value(item, pairs);
            }
            changed
        }
        serde_json::Value::Object(map) => {
            let mut changed = false;
            for (_, item) in map.iter_mut() {
                changed |= rewrite_value(item, pairs);
            }
            changed
        }
        _ => false,
    }
}

fn rewrite_prefix(s: &str, pairs: &[(&Path, &Path)]) -> Option<String> {
    for (from, to) in pairs {
        let from_native = from.to_string_lossy().to_string();
        let to_native = to.to_string_lossy().to_string();
        if from_native.is_empty() {
            continue;
        }
        let spellings = [
            (from_native.clone(), to_native.clone()),
            (from_native.replace('\\', "/"), to_native.replace('\\', "/")),
        ];
        for (f, t) in spellings {
            if let Some(rest) = s.strip_prefix(&f) {
                if rest.is_empty() || rest.starts_with('/') || rest.starts_with('\\') {
                    return Some(format!("{t}{rest}"));
                }
            }
        }
    }
    None
}

/// Copy every migrated source item into `backup_root`, preserving its root
/// (config/data) and name, so a failed Move can be undone.
fn backup_source(plan: &MigrationPlan, backup_root: &Path) -> Result<(), String> {
    for item in &plan.items {
        // Skip items that were kept-Flint (their source is being superseded but
        // still exists; back it up anyway for a full restore).
        if !item.source.exists() {
            continue;
        }
        let sub = match item.root {
            SourceRoot::Config => "config",
            SourceRoot::Data => "data",
        };
        let dest = backup_root.join(sub).join(&item.name);
        fsutil::copy_tree_preserving_mtime(&item.source, &dest).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Remove every migrated source item (Move only). Errors stop at the first
/// failure so the caller can restore from backup.
fn remove_source(plan: &MigrationPlan) -> Result<(), String> {
    for item in &plan.items {
        if !item.source.exists() {
            continue;
        }
        if item.source.is_dir() {
            std::fs::remove_dir_all(&item.source).map_err(|e| e.to_string())?;
        } else {
            std::fs::remove_file(&item.source).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Restore source items from a Move backup after a failed removal.
fn restore_source_from_backup(plan: &MigrationPlan, backup_root: &Path) -> Result<(), String> {
    for item in &plan.items {
        let sub = match item.root {
            SourceRoot::Config => "config",
            SourceRoot::Data => "data",
        };
        let backup = backup_root.join(sub).join(&item.name);
        if backup.exists() && !item.source.exists() {
            fsutil::copy_tree_preserving_mtime(&backup, &item.source).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Roll back a completed migration: remove the Flint items this run created and,
/// for Move, restore the JAN source from the backup. Used by the
/// `migration_rollback` command after the fact (distinct from the in-run
/// rollback on failure).
///
/// Holds the profile lock on the Flint data folder for the whole rollback and
/// refuses when another live process holds it.
pub fn rollback_from_manifest(flint_config_dir: &Path) -> Result<(), String> {
    let m = manifest::read(flint_config_dir)?
        .ok_or_else(|| "no manifest to roll back".to_string())?;
    let data_folder = m.destination.data_folder.clone();
    // A lock this process already holds (a Reuse session) stays as it is.
    let ours = super::lock::read_lock(&data_folder)
        .is_some_and(|i| i.pid == std::process::id() && !super::lock::is_stale(&i));
    if ours {
        return rollback_with_manifest(flint_config_dir, m);
    }
    let lock = match super::lock::acquire(&data_folder, "flint-rollback") {
        Ok(lock) => lock,
        Err(super::lock::LockError::Held(info)) => {
            return Err(format!(
                "rollback refused: {} is in use by another Flint process (pid {})",
                data_folder.display(),
                info.pid
            ))
        }
        Err(e) => return Err(format!("rollback could not lock the data folder: {e}")),
    };
    let result = rollback_with_manifest(flint_config_dir, m);
    let _ = lock.release();
    result
}

fn rollback_with_manifest(flint_config_dir: &Path, m: manifest::MigrationManifest) -> Result<(), String> {

    // Undo only what this migration recorded: remove the items it created and
    // restore the ones it overwrote. Flint data it never touched (items kept
    // via KeepFlint, anything added since) is left alone. Paths come from the
    // manifest file, so refuse any outside the Flint profile.
    let inside = |p: &Path| {
        p.starts_with(&m.destination.config_dir) || p.starts_with(&m.destination.data_folder)
    };
    for path in &m.created {
        if !inside(path) {
            continue;
        }
        let _ = if path.is_dir() {
            std::fs::remove_dir_all(path)
        } else if path.is_file() {
            std::fs::remove_file(path)
        } else {
            Ok(())
        };
    }
    for rec in &m.replaced {
        if !inside(&rec.dest) || !rec.backup.exists() {
            continue;
        }
        let _ = if rec.dest.is_dir() {
            std::fs::remove_dir_all(&rec.dest)
        } else if rec.dest.is_file() {
            std::fs::remove_file(&rec.dest)
        } else {
            Ok(())
        };
        fsutil::copy_tree_preserving_mtime(&rec.backup, &rec.dest).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_dir_all(m.destination.config_dir.join(UNDO_DIR_NAME));

    // For Move, restore the JAN source from the backup.
    if m.mode == ModeTag::Move {
        if let Some(backup) = &m.backup_path {
            for (sub, base) in [
                ("config", &m.source.config_dir),
                ("data", &m.source.data_folder),
            ] {
                let src_backup = backup.join(sub);
                if src_backup.is_dir() {
                    if let Ok(rd) = std::fs::read_dir(&src_backup) {
                        for de in rd.flatten() {
                            let target = base.join(de.file_name());
                            let _ = fsutil::copy_tree_preserving_mtime(&de.path(), &target);
                        }
                    }
                }
            }
        }
    }

    let mut m = m;
    m.created.clear();
    m.replaced.clear();
    m.results.clear();
    m.skipped_items.clear();
    m.status = Status::Failed;
    m.finished_at = Some(fsutil::now_ms());
    manifest::write(flint_config_dir, &m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::migration::detect::detect_legacy;
    use crate::core::migration::paths::{flint_paths, legacy_paths, Roots};
    use crate::core::migration::plan::plan;
    use std::fs;

    fn setup() -> (tempfile::TempDir, Roots) {
        let td = tempfile::tempdir().unwrap();
        let data_dir = td.path().join("appdata");
        let home = td.path().join("home");
        crate::core::migration::detect::tests::seed_legacy(&data_dir, &home);
        (td, Roots::new(&data_dir, &home))
    }

    fn make_plan(roots: &Roots, mode: Mode, conflict: Conflict) -> MigrationPlan {
        let d = detect_legacy(roots).unwrap();
        let f = flint_paths(roots);
        plan(&d, &f, Category::all(), mode, conflict)
    }

    #[test]
    fn an_incompatible_schema_refuses_copy_and_move() {
        for mode in [Mode::Copy, Mode::Move] {
            let (_td, roots) = setup();
            let mut p = make_plan(&roots, mode, Conflict::KeepBoth);
            p.compatible = false;
            let r = execute(&p, &ExecuteOpts::with_holder("test"));
            assert_eq!(r.status, Status::Failed, "mode={mode:?}");
            assert!(r.error.as_deref().unwrap_or("").contains("schema"), "{:?}", r.error);

            let f = flint_paths(&roots);
            assert!(!f.data_folder.join("threads/thread_1/thread.json").exists());
            assert!(!f.config_dir.join("settings.json").exists());
            // A Move must leave the source where it was.
            let l = legacy_paths(&roots);
            assert!(l.data_folder.join("threads/thread_1/thread.json").is_file());
        }
    }

    #[test]
    fn copy_populates_flint_and_leaves_jan() {
        let (_td, roots) = setup();
        let p = make_plan(&roots, Mode::Copy, Conflict::KeepBoth);
        let r = execute(&p, &ExecuteOpts::with_holder("test"));
        assert_eq!(r.status, Status::Complete, "err={:?}", r.error);

        let f = flint_paths(&roots);
        assert!(f.data_folder.join("threads/thread_1/thread.json").is_file());
        assert!(f.config_dir.join("settings.json").is_file());
        assert!(f.data_folder.join("provider_secrets.enc").is_file());

        // JAN untouched.
        let l = legacy_paths(&roots);
        assert!(l.data_folder.join("threads/thread_1/thread.json").is_file());
        assert!(l.config_dir.join("settings.json").is_file());

        // Manifest complete, contains no secret bytes.
        let man = manifest::read(&f.config_dir).unwrap().unwrap();
        assert_eq!(man.status, Status::Complete);
    }

    #[test]
    fn secrets_copied_byte_identical_no_plaintext() {
        let (_td, roots) = setup();
        let l = legacy_paths(&roots);
        // Overwrite the seeded blob with a recognisable "encrypted" payload.
        let blob = b"FLINT-ENC\x00\x01\x02\x03SECRETBYTES\xFF\xFE";
        fs::write(l.data_folder.join("provider_secrets.enc"), blob).unwrap();

        let p = make_plan(&roots, Mode::Copy, Conflict::UseJan);
        let r = execute(&p, &ExecuteOpts::with_holder("test"));
        assert_eq!(r.status, Status::Complete);

        let f = flint_paths(&roots);
        let copied = fs::read(f.data_folder.join("provider_secrets.enc")).unwrap();
        assert_eq!(copied, blob, "encrypted blob must be byte-identical");

        // The manifest must not embed the secret bytes.
        let manifest_text = fs::read_to_string(manifest::manifest_path(&f.config_dir)).unwrap();
        assert!(!manifest_text.contains("SECRETBYTES"));
    }

    #[test]
    fn preserves_ids_and_structure() {
        let (_td, roots) = setup();
        let l = legacy_paths(&roots);
        // Add a room + mailbox message with stable ids.
        fs::create_dir_all(l.data_folder.join("rooms/room_42")).unwrap();
        fs::write(
            l.data_folder.join("rooms/room_42/room.json"),
            br#"{"id":"room_42","project":"proj_7"}"#,
        )
        .unwrap();

        let p = make_plan(&roots, Mode::Copy, Conflict::UseJan);
        let r = execute(&p, &ExecuteOpts::with_holder("test"));
        assert_eq!(r.status, Status::Complete, "err={:?}", r.error);

        let f = flint_paths(&roots);
        let room = fs::read_to_string(f.data_folder.join("rooms/room_42/room.json")).unwrap();
        assert!(room.contains("\"id\":\"room_42\""));
        assert!(room.contains("\"project\":\"proj_7\""));
        let thread = fs::read_to_string(f.data_folder.join("threads/thread_1/thread.json")).unwrap();
        assert!(thread.contains("\"id\":\"thread_1\""));
        assert!(f.data_folder.join("mailbox/msg.json").is_file());
    }

    #[test]
    fn corrupt_and_partial_are_quarantined() {
        let (_td, roots) = setup();
        let l = legacy_paths(&roots);
        // A corrupt thread JSON and a zero-byte partial.
        fs::write(l.data_folder.join("threads/thread_1/bad.json"), b"{broken").unwrap();
        fs::write(l.data_folder.join("threads/thread_1/empty.json"), b"").unwrap();

        let p = make_plan(&roots, Mode::Copy, Conflict::UseJan);
        let r = execute(&p, &ExecuteOpts::with_holder("test"));
        assert_eq!(r.status, Status::Complete, "err={:?}", r.error);
        assert!(r.skipped.len() >= 2, "skipped={:?}", r.skipped);

        let f = flint_paths(&roots);
        // Good file migrated; bad ones not at destination.
        assert!(f.data_folder.join("threads/thread_1/thread.json").is_file());
        assert!(!f.data_folder.join("threads/thread_1/bad.json").exists());
        assert!(!f.data_folder.join("threads/thread_1/empty.json").exists());
        // Quarantined copies exist.
        let qdir = f.config_dir.join(QUARANTINE_DIR_NAME);
        assert!(fsutil::list_files(&qdir).iter().any(|p| p.ends_with("bad.json")));
    }

    #[test]
    fn move_removes_source_after_success() {
        let (_td, roots) = setup();
        let p = make_plan(&roots, Mode::Move, Conflict::UseJan);
        let r = execute(&p, &ExecuteOpts::with_holder("test"));
        assert_eq!(r.status, Status::Complete, "err={:?}", r.error);
        assert!(r.backup_path.is_some());

        let f = flint_paths(&roots);
        let l = legacy_paths(&roots);
        assert!(f.data_folder.join("threads/thread_1/thread.json").is_file());
        // JAN source removed.
        assert!(!l.data_folder.join("threads").exists());
        assert!(!l.config_dir.join("settings.json").exists());
    }

    #[test]
    fn fresh_touches_nothing_in_jan() {
        let (_td, roots) = setup();
        let p = make_plan(&roots, Mode::Fresh, Conflict::KeepFlint);
        let r = execute(&p, &ExecuteOpts::with_holder("test"));
        assert_eq!(r.status, Status::Complete);

        let f = flint_paths(&roots);
        let l = legacy_paths(&roots);
        assert!(f.config_dir.is_dir());
        assert!(f.data_folder.is_dir());
        // No data copied.
        assert!(!f.data_folder.join("threads").exists());
        // JAN intact.
        assert!(l.data_folder.join("threads/thread_1/thread.json").is_file());
    }

    #[test]
    fn reuse_returns_path_and_respects_lock() {
        let (_td, roots) = setup();
        let p = make_plan(&roots, Mode::Reuse, Conflict::KeepFlint);
        let r = execute(&p, &ExecuteOpts::with_holder("test"));
        assert_eq!(r.status, Status::Complete, "err={:?}", r.error);
        assert_eq!(r.reuse_path.as_ref(), Some(&p.source_data_folder));

        // #168: the reused profile stays locked by this process after the
        // migration returns, so another process sees it as held.
        let held = super::super::lock::read_lock(&p.source_data_folder)
            .expect("the reused profile keeps its lock for the session");
        assert_eq!(held.pid, std::process::id());
        assert_eq!(held.holder, "test");

        // Now simulate another live process holding the lock -> refuse.
        #[cfg(windows)]
        let mut child = std::process::Command::new("ping")
            .args(["-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        #[cfg(not(windows))]
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let foreign = super::super::lock::LockInfo {
            pid: child.id(),
            timestamp_ms: fsutil::now_ms(),
            holder: "other".to_string(),
        };
        fs::write(
            p.source_data_folder.join(super::super::lock::LOCK_FILE_NAME),
            serde_json::to_string(&foreign).unwrap(),
        )
        .unwrap();
        // Re-run reuse against a fresh Flint config so the completed manifest
        // does not short-circuit.
        let mut p2 = p.clone();
        p2.dest_config_dir = p.dest_config_dir.join("second");
        let r2 = execute(&p2, &ExecuteOpts::with_holder("test"));
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(r2.status, Status::Failed);
        assert!(r2.error.unwrap().contains("locked"));
    }

    #[test]
    fn interrupted_then_resume_is_idempotent() {
        let (_td, roots) = setup();
        // First run fails at Conversations (after Settings + Configs done).
        let p = make_plan(&roots, Mode::Copy, Conflict::UseJan);
        let mut opts = ExecuteOpts::with_holder("test");
        opts.fail_on_category = Some(Category::Conversations);
        let r1 = execute(&p, &opts);
        assert_eq!(r1.status, Status::Failed);

        // The failed run rolled Settings back, so it must not stay marked done
        // (a resume would skip it with the files gone).
        let f = flint_paths(&roots);
        let man = manifest::read(&f.config_dir).unwrap().unwrap();
        assert!(!man.is_category_done(Category::Settings));
        assert!(!f.config_dir.join("settings.json").exists());

        // Resume with no failure hook: completes without duplicating.
        let r2 = execute(&p, &ExecuteOpts::with_holder("test"));
        assert_eq!(r2.status, Status::Complete, "err={:?}", r2.error);
        assert!(f.data_folder.join("threads/thread_1/thread.json").is_file());
        // The category rolled back by the failed run must be re-copied, not
        // skipped on its stale done marker.
        assert!(f.config_dir.join("settings.json").is_file());

        // Third launch is a no-op (idempotent).
        let r3 = execute(&p, &ExecuteOpts::with_holder("test"));
        assert_eq!(r3.status, Status::Complete);
    }

    #[test]
    fn rollback_after_forced_failure_restores_state() {
        let (_td, roots) = setup();
        let l = legacy_paths(&roots);
        let p = make_plan(&roots, Mode::Move, Conflict::UseJan);
        let mut opts = ExecuteOpts::with_holder("test");
        opts.fail_before_source_removal = true;
        let r = execute(&p, &opts);
        assert_eq!(r.status, Status::Failed);
        assert!(r.rolled_back);

        // JAN source intact (never removed).
        assert!(l.data_folder.join("threads/thread_1/thread.json").is_file());
        assert!(l.config_dir.join("settings.json").is_file());

        // Flint created items rolled back (threads removed).
        let f = flint_paths(&roots);
        assert!(!f.data_folder.join("threads").exists());
    }

    #[test]
    fn conflict_keep_both_writes_suffixed_copy() {
        let (_td, roots) = setup();
        let f = flint_paths(&roots);
        // Pre-create an existing Flint mcp_config.json (older than JAN).
        fs::create_dir_all(&f.data_folder).unwrap();
        fs::write(f.data_folder.join("mcp_config.json"), br#"{"existing":true}"#).unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(600);
        let _ = fs::File::options()
            .write(true)
            .open(f.data_folder.join("mcp_config.json"))
            .unwrap()
            .set_modified(old);

        let p = make_plan(&roots, Mode::Copy, Conflict::KeepBoth);
        let r = execute(&p, &ExecuteOpts::with_holder("test"));
        assert_eq!(r.status, Status::Complete, "err={:?}", r.error);
        // Existing kept, JAN copy alongside with suffix.
        assert!(f.data_folder.join("mcp_config.json").is_file());
        assert!(f
            .data_folder
            .join(format!("mcp_config.json{KEEP_BOTH_SUFFIX}"))
            .is_file());
    }

    #[test]
    fn settings_path_prefixes_rewritten() {
        let (_td, roots) = setup();
        let l = legacy_paths(&roots);
        // Put an absolute reference to the JAN data folder inside settings.json.
        let jan_data = l.data_folder.to_string_lossy().replace('\\', "/");
        fs::write(
            l.config_dir.join("settings.json"),
            format!(r#"{{"schema_version":1,"data_folder":"{jan_data}"}}"#),
        )
        .unwrap();

        let p = make_plan(&roots, Mode::Copy, Conflict::UseJan);
        let r = execute(&p, &ExecuteOpts::with_holder("test"));
        assert_eq!(r.status, Status::Complete, "err={:?}", r.error);

        let f = flint_paths(&roots);
        let text = fs::read_to_string(f.config_dir.join("settings.json")).unwrap();
        let flint_data = f.data_folder.to_string_lossy().replace('\\', "/");
        assert!(text.contains(&flint_data), "settings not repointed: {text}");
        assert!(!text.contains(&jan_data));
    }

    #[test]
    fn same_or_nested_folders_are_refused_before_touching_anything() {
        let (_td, roots) = setup();
        let l = legacy_paths(&roots);
        let mut p = make_plan(&roots, Mode::Move, Conflict::UseJan);
        p.dest_data_folder = l.data_folder.clone();
        let r = execute(&p, &ExecuteOpts::with_holder("test"));
        assert_eq!(r.status, Status::Failed);
        assert!(r.error.unwrap().contains("same or nested"));
        assert!(l.data_folder.exists(), "source must be untouched");

        let mut p = make_plan(&roots, Mode::Copy, Conflict::UseJan);
        p.dest_data_folder = l.data_folder.join("inside");
        let r = execute(&p, &ExecuteOpts::with_holder("test"));
        assert_eq!(r.status, Status::Failed);
        assert!(!l.data_folder.join("inside").exists());
    }

    #[cfg(unix)]
    #[test]
    fn move_with_a_directory_link_is_refused() {
        let (td, roots) = setup();
        let l = legacy_paths(&roots);
        let outside = td.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(l.data_folder.join("threads")).unwrap();
        std::os::unix::fs::symlink(&outside, l.data_folder.join("threads").join("lnk")).unwrap();
        let p = make_plan(&roots, Mode::Move, Conflict::UseJan);
        let r = execute(&p, &ExecuteOpts::with_holder("test"));
        assert_eq!(r.status, Status::Failed);
        assert!(r.error.unwrap().contains("directory link"));
        assert!(outside.exists());
    }

    #[test]
    fn settings_rewrite_only_touches_values_with_the_source_prefix() {
        let td = tempfile::tempdir().unwrap();
        let settings = td.path().join("settings.json");
        let src = Path::new("/old/jan/data");
        let dst = Path::new("/new/flint/data");
        fs::write(
            &settings,
            r#"{"data_folder":"/old/jan/data","nested":{"p":"/old/jan/data/models"},"note":"see /old/jan/data for more","near":"/old/jan/data2","/old/jan/data":"key stays"}"#,
        )
        .unwrap();
        rewrite_settings_paths(&settings, src, dst, Path::new("/c/old"), Path::new("/c/new"));
        let v: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(v["data_folder"], "/new/flint/data");
        assert_eq!(v["nested"]["p"], "/new/flint/data/models");
        assert_eq!(v["note"], "see /old/jan/data for more");
        assert_eq!(v["near"], "/old/jan/data2");
        assert_eq!(v["/old/jan/data"], "key stays");
        assert!(!td.path().join("settings.json.tmp").exists());
    }

    #[test]
    fn settings_rewrite_leaves_invalid_json_alone() {
        let td = tempfile::tempdir().unwrap();
        let settings = td.path().join("settings.json");
        fs::write(&settings, "{ not json /old/jan/data").unwrap();
        rewrite_settings_paths(
            &settings,
            Path::new("/old/jan/data"),
            Path::new("/new"),
            Path::new("/c/old"),
            Path::new("/c/new"),
        );
        assert_eq!(fs::read_to_string(&settings).unwrap(), "{ not json /old/jan/data");
    }

    #[test]
    fn rollback_after_completion_keeps_flint_data_it_did_not_create() {
        let (_td, roots) = setup();
        let f = flint_paths(&roots);
        // Existing Flint item the user keeps, plus one a migration overwrites.
        fs::create_dir_all(&f.data_folder).unwrap();
        fs::write(f.data_folder.join("mcp_config.json"), br#"{"mine":1}"#).unwrap();

        let p = make_plan(&roots, Mode::Copy, Conflict::KeepFlint);
        let r = execute(&p, &ExecuteOpts::with_holder("test"));
        assert_eq!(r.status, Status::Complete, "err={:?}", r.error);
        assert!(f.data_folder.join("threads/thread_1/thread.json").is_file());

        rollback_from_manifest(&f.config_dir).unwrap();
        // Created by the migration: gone. Pre-existing Flint data: untouched.
        assert!(!f.data_folder.join("threads").exists());
        assert_eq!(
            fs::read(f.data_folder.join("mcp_config.json")).unwrap(),
            br#"{"mine":1}"#
        );
    }

    #[test]
    fn rollback_refuses_while_another_process_holds_the_profile_lock() {
        let (_td, roots) = setup();
        let f = flint_paths(&roots);
        let p = make_plan(&roots, Mode::Copy, Conflict::KeepFlint);
        let r = execute(&p, &ExecuteOpts::with_holder("test"));
        assert_eq!(r.status, Status::Complete, "err={:?}", r.error);

        #[cfg(windows)]
        let mut child = std::process::Command::new("ping")
            .args(["-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        #[cfg(not(windows))]
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let lock_file = f.data_folder.join(super::super::lock::LOCK_FILE_NAME);
        let foreign = super::super::lock::LockInfo {
            pid: child.id(),
            timestamp_ms: fsutil::now_ms(),
            holder: "other".to_string(),
        };
        fs::write(&lock_file, serde_json::to_string(&foreign).unwrap()).unwrap();

        let held = rollback_from_manifest(&f.config_dir);
        let _ = child.kill();
        let _ = child.wait();
        let err = held.expect_err("a held lock must refuse the rollback");
        assert!(err.contains("another Flint process"), "{err}");
        assert!(f.data_folder.join("threads/thread_1/thread.json").is_file());

        fs::remove_file(&lock_file).unwrap();
        rollback_from_manifest(&f.config_dir).unwrap();
        assert!(!f.data_folder.join("threads").exists());
        assert!(!lock_file.exists(), "the rollback releases its lock");
    }

    #[test]
    fn rollback_after_completion_restores_overwritten_flint_items() {
        let (_td, roots) = setup();
        let f = flint_paths(&roots);
        fs::create_dir_all(&f.data_folder).unwrap();
        fs::write(f.data_folder.join("mcp_config.json"), br#"{"orig":1}"#).unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(600);
        let _ = fs::File::options()
            .write(true)
            .open(f.data_folder.join("mcp_config.json"))
            .unwrap()
            .set_modified(old);

        let p = make_plan(&roots, Mode::Copy, Conflict::UseJan);
        let r = execute(&p, &ExecuteOpts::with_holder("test"));
        assert_eq!(r.status, Status::Complete, "err={:?}", r.error);
        assert_ne!(
            fs::read(f.data_folder.join("mcp_config.json")).unwrap(),
            br#"{"orig":1}"#
        );

        rollback_from_manifest(&f.config_dir).unwrap();
        assert_eq!(
            fs::read(f.data_folder.join("mcp_config.json")).unwrap(),
            br#"{"orig":1}"#
        );
    }
}
