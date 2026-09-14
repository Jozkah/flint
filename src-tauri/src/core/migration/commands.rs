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

use serde::{Deserialize, Serialize};

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

/// Execute a previously built plan.
#[tauri::command]
pub async fn migration_execute(plan: MigrationPlan) -> Result<MigrationResult, String> {
    let opts = ExecuteOpts::with_holder("flint-migration");
    // Run the (blocking) filesystem work off the async runtime.
    tauri::async_runtime::spawn_blocking(move || execute::execute(&plan, &opts))
        .await
        .map_err(|e| format!("migration task failed: {e}"))
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

    #[test]
    fn command_paths_lists_all_six() {
        assert_eq!(command_paths().len(), 6);
        assert!(command_paths().contains(&"migration_execute"));
    }
}
