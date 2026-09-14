//! First-launch JAN -> Flint data-migration assistant.
//!
//! Pure, testable core plus a thin Tauri command layer:
//! - [`paths`]    — legacy JAN and new Flint path construction (roots injected).
//! - [`fsutil`]   — dependency-free recursive size/count/copy (mtime-preserving).
//! - [`schema`]   — schema version + per-item health classification.
//! - [`detect`]   — discover an existing legacy install and its categories.
//! - [`plan`]     — turn a detection into an explicit, conflict-aware plan.
//! - [`execute`]  — run a plan (Copy/Reuse/Move/Fresh) atomically & idempotently.
//! - [`manifest`] — the durable `migration_manifest.json` record.
//! - [`lock`]     — a profile lock preventing concurrent writers.
//! - [`commands`] — desktop-only `#[tauri::command]` wrappers (feature-gated).
//!
//! Everything except [`commands`] compiles and runs without Tauri (usable from
//! the `jan` CLI build). Nothing here decrypts, parses, or logs provider
//! secrets: `provider_secrets.enc` is only ever copied as opaque bytes.

pub mod detect;
pub mod execute;
pub mod fsutil;
pub mod lock;
pub mod manifest;
pub mod paths;
pub mod plan;
pub mod schema;

// Desktop-only: pulls in the `tauri` attribute macro.
#[cfg(not(feature = "cli"))]
pub mod commands;

// Re-export the primary surface for ergonomic callers.
pub use detect::{detect_legacy, Category, LegacyData, LegacyLocation, ResolvedSource};
pub use execute::{execute, rollback_from_manifest, ExecuteOpts, MigrationResult};
pub use manifest::{
    is_first_launch_pending, mark_complete, mark_dismissed, MigrationManifest, Status,
};
pub use plan::{plan, Conflict, MigrationPlan, Mode};
pub use schema::{ItemStatus, SUPPORTED_SCHEMA};
