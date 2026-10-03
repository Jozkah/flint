//! Thin Tauri command layer over the pure migration core.
//!
//! These commands are desktop-only (`#[cfg(not(feature = "cli"))]`): they pull
//! in the `tauri` attribute macro. They hold no logic beyond resolving the real
//! [`Roots`] from the environment and delegating to the pure functions in
//! `detect` / `plan` / `execute` / `manifest`, all of which stay callable
//! without Tauri. Everything returned is serde-serializable.
//!
//! Registration: add these to the `tauri::generate_handler!` list in
//! `src-tauri/src/lib.rs`. They are intentionally *not* auto-registered here to
//! keep the merge surface to the single `pub mod migration;` line in
//! `core/mod.rs`. See [`command_paths`] for the exact list.

#![cfg(not(feature = "cli"))]

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::core::app::commands as app_commands;

use super::detect::{self, Category, LegacyData};
use super::execute::{self, ExecuteOpts, MigrationResult};
use super::manifest::{self, MigrationManifest};
use super::paths::{flint_paths, Roots};
use super::plan::{self, Conflict, MigrationPlan, Mode};

/// Result of `migration_detect`: whether legacy data exists, and its report.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectDto {
    pub found: bool,
    pub first_launch_pending: bool,
    pub legacy: Option<LegacyData>,
}

fn roots() -> Roots {
    Roots::discover()
}

/// Detect a legacy JAN installation and whether the first-launch prompt is due.
#[tauri::command]
pub async fn migration_detect() -> Result<DetectDto, String> {
    let roots = roots();
    let flint = flint_paths(&roots);
    let legacy = detect::detect_legacy(&roots);
    let found = legacy.is_some();
    let first_launch_pending = manifest::is_first_launch_pending(&flint.config_dir, found);
    Ok(DetectDto {
        found,
        first_launch_pending,
        legacy,
    })
}

/// Build (but do not run) a migration plan.
#[tauri::command]
pub async fn migration_plan(
    selected_categories: Vec<Category>,
    mode: Mode,
    default_conflict: Conflict,
) -> Result<MigrationPlan, String> {
    let roots = roots();
    let flint = flint_paths(&roots);
    let legacy = detect::detect_legacy(&roots)
        .ok_or_else(|| "no legacy JAN data found to plan".to_string())?;
    Ok(plan::plan(
        &legacy,
        &flint,
        &selected_categories,
        mode,
        default_conflict,
    ))
}

/// Rebuild the plan the webview sent from the real roots, keeping only the
/// user's choices from it.
///
/// The plan comes back over IPC, so every path in it is caller-controlled: a
/// script in the webview could name any source to copy (and, in Move mode,
/// delete) and any destination to overwrite. Paths are therefore never taken
/// from it. The mode and categories are re-planned against the legacy and
/// Flint roots the backend discovers itself; from the client plan only the
/// set of items to migrate (matched by category, root and name) and each
/// conflict's resolution carry over.
pub(crate) fn trusted_plan(client: &MigrationPlan, roots: &Roots) -> Result<MigrationPlan, String> {
    let flint = flint_paths(roots);
    let legacy = detect::detect_legacy(roots)
        .ok_or_else(|| "no legacy JAN data found to migrate".to_string())?;
    let mut trusted = plan::plan(
        &legacy,
        &flint,
        &client.selected_categories,
        client.mode,
        Conflict::KeepFlint,
    );
    let chosen = |item: &plan::PlannedItem| {
        client
            .items
            .iter()
            .find(|c| c.category == item.category && c.root == item.root && c.name == item.name)
    };
    trusted.items.retain(|item| chosen(item).is_some());
    for item in trusted.items.iter_mut() {
        let resolution = chosen(item)
            .and_then(|c| c.conflict.as_ref())
            .map(|c| c.resolution);
        if let (Some(conflict), Some(resolution)) = (item.conflict.as_mut(), resolution) {
            conflict.resolution = resolution;
        }
    }
    trusted.estimated_bytes = trusted.items.iter().map(|i| i.size_bytes).sum();
    Ok(trusted)
}

/// The data folder the app should run against once `plan` has completed.
///
/// Reuse keeps the JAN folder in place; every other mode ends on the Flint
/// data folder (empty for Fresh, populated for Copy and Move).
pub(crate) fn data_folder_after(plan: &MigrationPlan) -> PathBuf {
    match plan.mode {
        Mode::Reuse => plan
            .reuse_path
            .clone()
            .unwrap_or_else(|| plan.source_data_folder.clone()),
        Mode::Fresh | Mode::Copy | Mode::Move => plan.dest_data_folder.clone(),
    }
}

/// Whether a migration from this plan's source already completed, in which
/// case `execute` returns that earlier outcome without doing anything.
fn already_complete(plan: &MigrationPlan) -> bool {
    matches!(
        manifest::read(&plan.dest_config_dir),
        Ok(Some(m)) if m.status == manifest::Status::Complete
            && m.source.data_folder == plan.source_data_folder
    )
}

/// Point the app configuration at `target`. Returns whether the configured
/// data folder changed, i.e. whether a restart is needed to pick it up.
fn apply_data_folder<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    target: &Path,
) -> Result<bool, String> {
    // An explicit FLINT_/JAN_DATA_FOLDER override wins over the saved setting
    // on every start, so there is nothing to persist.
    if crate::core::compat_env::var("DATA_FOLDER").is_ok_and(|f| !f.is_empty())
        || std::env::var("CI").unwrap_or_default() == "e2e"
    {
        return Ok(false);
    }
    let mut configuration = app_commands::get_app_configurations(app.clone());
    if Path::new(&configuration.data_folder) == target {
        return Ok(false);
    }
    configuration.data_folder = target.to_string_lossy().into_owned();
    configuration.unavailable_data_folder = None;
    app_commands::update_app_configuration(app.clone(), configuration)?;
    Ok(true)
}

/// Execute a previously built plan.
///
/// A run that completes also points the app at the data folder the chosen mode
/// ends on; without that the app kept reading the JAN folder whatever the user
/// picked. A plan whose migration had already completed earlier is left alone:
/// installs that finished one before this took effect keep the data folder
/// they have been running on.
#[tauri::command]
pub async fn migration_execute<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    plan: MigrationPlan,
) -> Result<MigrationResult, String> {
    let plan = trusted_plan(&plan, &roots())?;
    let opts = ExecuteOpts::with_holder("flint-migration");
    let was_complete = already_complete(&plan);
    let target = data_folder_after(&plan);
    // Run the (blocking) filesystem work off the async runtime.
    let mut result = tauri::async_runtime::spawn_blocking(move || execute::execute(&plan, &opts))
        .await
        .map_err(|e| format!("migration task failed: {e}"))?;
    if !was_complete && result.status == manifest::Status::Complete {
        match apply_data_folder(&app, &target) {
            Ok(changed) => result.restart_required = changed,
            Err(e) => result.error = Some(format!("could not switch the data folder: {e}")),
        }
    }
    Ok(result)
}

/// The current manifest, if any.
#[tauri::command]
pub async fn migration_status() -> Result<Option<MigrationManifest>, String> {
    let roots = roots();
    let flint = flint_paths(&roots);
    manifest::read(&flint.config_dir)
}

/// Roll back a completed/failed migration (removes Flint copies; restores JAN
/// for a Move via its backup).
#[tauri::command]
pub async fn migration_rollback() -> Result<(), String> {
    let roots = roots();
    let flint = flint_paths(&roots);
    tauri::async_runtime::spawn_blocking(move || execute::rollback_from_manifest(&flint.config_dir))
        .await
        .map_err(|e| format!("rollback task failed: {e}"))?
}

/// Dismiss the migration prompt (records a dismissed manifest; never re-offered).
#[tauri::command]
pub async fn migration_dismiss() -> Result<(), String> {
    let roots = roots();
    let flint = flint_paths(&roots);
    manifest::mark_dismissed(&flint.config_dir)
}

/// The command paths to add to `tauri::generate_handler!` in `lib.rs`.
///
/// Kept here as documentation so registration is a copy-paste that does not
/// require editing any migration file:
///
/// ```text
/// core::migration::commands::migration_detect,
/// core::migration::commands::migration_plan,
/// core::migration::commands::migration_execute,
/// core::migration::commands::migration_status,
/// core::migration::commands::migration_rollback,
/// core::migration::commands::migration_dismiss,
/// ```
pub fn command_paths() -> &'static [&'static str] {
    &[
        "migration_detect",
        "migration_plan",
        "migration_execute",
        "migration_status",
        "migration_rollback",
        "migration_dismiss",
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #72: paths in a webview-supplied plan are never trusted; the executed
    /// plan's paths all come from the real roots.
    #[test]
    fn a_tampered_plan_is_replanned_from_the_real_roots() {
        use crate::core::migration::detect::{detect_legacy, Category};
        let td = tempfile::tempdir().unwrap();
        let data_dir = td.path().join("appdata");
        let home = td.path().join("home");
        crate::core::migration::detect::tests::seed_legacy(&data_dir, &home);
        let roots = Roots::new(&data_dir, &home);
        let flint = flint_paths(&roots);
        let honest = plan::plan(
            &detect_legacy(&roots).unwrap(),
            &flint,
            &[Category::Conversations],
            Mode::Move,
            Conflict::KeepBoth,
        );
        assert!(!honest.items.is_empty());

        let evil = td.path().join("elsewhere");
        let mut tampered = honest.clone();
        tampered.dest_config_dir = evil.clone();
        tampered.dest_data_folder = evil.join("data");
        tampered.source_data_folder = evil.clone();
        for item in tampered.items.iter_mut() {
            item.source = evil.join("victim");
            item.destination = evil.join("overwritten");
        }

        let trusted = trusted_plan(&tampered, &roots).unwrap();
        assert_eq!(trusted.dest_config_dir, flint.config_dir);
        assert_eq!(trusted.dest_data_folder, flint.data_folder);
        assert_eq!(trusted.source_data_folder, honest.source_data_folder);
        assert_eq!(trusted.items.len(), honest.items.len());
        for item in &trusted.items {
            assert!(!item.source.starts_with(&evil), "{:?}", item.source);
            assert!(!item.destination.starts_with(&evil), "{:?}", item.destination);
        }
    }

    #[test]
    fn items_the_client_dropped_are_not_migrated() {
        use crate::core::migration::detect::{detect_legacy, Category};
        let td = tempfile::tempdir().unwrap();
        let data_dir = td.path().join("appdata");
        let home = td.path().join("home");
        crate::core::migration::detect::tests::seed_legacy(&data_dir, &home);
        let roots = Roots::new(&data_dir, &home);
        let mut client = plan::plan(
            &detect_legacy(&roots).unwrap(),
            &flint_paths(&roots),
            &[Category::Conversations, Category::Settings],
            Mode::Copy,
            Conflict::KeepBoth,
        );
        let kept = client.items.remove(0);
        client.items.truncate(0);
        client.items.push(kept.clone());
        let trusted = trusted_plan(&client, &roots).unwrap();
        assert_eq!(trusted.items.len(), 1);
        assert_eq!(trusted.items[0].name, kept.name);
    }

    /// Only Reuse leaves the app on the JAN folder; Fresh, Copy and Move all
    /// end on the Flint data folder.
    #[test]
    fn the_data_folder_follows_the_chosen_mode() {
        use crate::core::migration::detect::detect_legacy;
        let td = tempfile::tempdir().unwrap();
        let data_dir = td.path().join("appdata");
        let home = td.path().join("home");
        crate::core::migration::detect::tests::seed_legacy(&data_dir, &home);
        let roots = Roots::new(&data_dir, &home);
        let flint = flint_paths(&roots);
        let legacy = detect_legacy(&roots).unwrap();
        for mode in [Mode::Fresh, Mode::Copy, Mode::Move] {
            let p = plan::plan(&legacy, &flint, Category::all(), mode, Conflict::KeepFlint);
            assert_eq!(data_folder_after(&p), flint.data_folder, "mode={mode:?}");
        }
        let p = plan::plan(&legacy, &flint, Category::all(), Mode::Reuse, Conflict::KeepFlint);
        assert_eq!(data_folder_after(&p), legacy.source.data_folder);
    }

    /// A migration that completed before is not applied a second time.
    #[test]
    fn a_completed_migration_is_recognised() {
        use crate::core::migration::detect::detect_legacy;
        let td = tempfile::tempdir().unwrap();
        let data_dir = td.path().join("appdata");
        let home = td.path().join("home");
        crate::core::migration::detect::tests::seed_legacy(&data_dir, &home);
        let roots = Roots::new(&data_dir, &home);
        let p = plan::plan(
            &detect_legacy(&roots).unwrap(),
            &flint_paths(&roots),
            &[],
            Mode::Fresh,
            Conflict::KeepFlint,
        );
        assert!(!already_complete(&p));
        let r = execute::execute(&p, &ExecuteOpts::with_holder("test"));
        assert_eq!(r.status, manifest::Status::Complete);
        assert!(already_complete(&p));
    }

    #[test]
    fn command_paths_lists_all_six() {
        assert_eq!(command_paths().len(), 6);
        assert!(command_paths().contains(&"migration_execute"));
    }
}
