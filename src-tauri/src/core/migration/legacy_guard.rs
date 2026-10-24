//! Keeps Flint off a JAN install's data until the user has asked for it.
//!
//! Flint keeps its app config in the same `<data_dir>/Jan/settings.json` JAN
//! does, so with JAN installed a Flint that has never been told otherwise reads
//! JAN's `data_folder` and runs on JAN's threads, settings and provider keys
//! from its first second: before the first-run choice, and whatever the choice
//! was. This module is the persisted answer to "may Flint use JAN's data?".
//!
//! - **First-ever boot** (no decision, no manifest, and nothing in the saved
//!   JAN folder that Flint wrote): the profile is isolated and `Undecided` is
//!   recorded. Flint runs on its own empty folder and the first-run assistant
//!   offers the choice. Not answering keeps it isolated.
//! - **Fresh** (`Start fresh`, `Don't ask again`): isolated for good. JAN's
//!   data and JAN's OS-keyring provider keys are never read.
//! - **Use** (reuse, copy or move completed): not isolated. For a reuse the
//!   saved folder is JAN's, and Flint is meant to run on it.
//! - **Anything else is today's behaviour, untouched.** A machine Flint has run
//!   on before (a manifest, or a Flint-written marker in the saved folder:
//!   [`PRIOR_RUN_MARKERS`]) keeps running on its saved folder, JAN's included,
//!   so an upgraded 0.9.x install never sees its chats vanish.
//!
//! Only the saved folder being JAN's own folder is ever redirected, so a Flint
//! profile in its own folder, a custom folder, or an explicit
//! `FLINT_DATA_FOLDER` is never touched.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::fsutil;
use super::manifest;
use super::paths::{flint_paths, legacy_paths, Roots};

/// File (in the Flint config dir) holding the persisted decision.
pub const DECISION_FILE: &str = "legacy_data_decision.json";

/// What the user decided about JAN's data.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    /// Never read JAN's data (or its keyring keys).
    Fresh,
    /// First-ever boot with JAN installed, not answered yet: same isolation as
    /// `Fresh`, until the user answers.
    Undecided,
    /// The user chose to bring JAN's data across or to keep using it.
    Use,
}

#[derive(Serialize, Deserialize)]
struct DecisionFile {
    decision: Decision,
}

/// The persisted decision, if one was recorded and is readable.
pub fn read_decision(flint_config_dir: &Path) -> Option<Decision> {
    let text = std::fs::read_to_string(flint_config_dir.join(DECISION_FILE)).ok()?;
    serde_json::from_str::<DecisionFile>(&text).ok().map(|f| f.decision)
}

/// Persist the decision (write-then-rename so a crash never leaves half a file).
pub fn record_decision(flint_config_dir: &Path, decision: Decision) -> Result<(), String> {
    std::fs::create_dir_all(flint_config_dir).map_err(|e| e.to_string())?;
    let body = serde_json::to_string(&DecisionFile { decision }).map_err(|e| e.to_string())?;
    let tmp = flint_config_dir.join(format!("{DECISION_FILE}.tmp"));
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, flint_config_dir.join(DECISION_FILE)).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Files and folders Flint (0.9.x and later) leaves in a data folder it has
/// run on, and JAN never writes: the crash-trace folder (created at every
/// boot on Windows) and run flag, the tool audit log, trusted folders, the
/// provider-secret index, and the stamp [`stamp_boot`] adds from now on.
pub const PRIOR_RUN_MARKERS: &[&str] = &[
    "crashes",
    "running.flag",
    "audit",
    "trusted-folders.json",
    "provider_secrets.index.json",
    BOOT_STAMP,
];

/// File [`stamp_boot`] writes into the data folder Flint runs on.
pub const BOOT_STAMP: &str = "flint-profile.json";

/// Whether Flint has run on `folder` before.
fn flint_ran_on(folder: &Path) -> bool {
    PRIOR_RUN_MARKERS.iter().any(|m| folder.join(m).exists())
}

/// Record that Flint booted on `folder`, so later versions can tell.
pub fn stamp_boot(folder: &Path) {
    let body = format!("{{\"version\":\"{}\"}}", env!("CARGO_PKG_VERSION"));
    let _ = std::fs::write(folder.join(BOOT_STAMP), body);
}

/// Whether JAN has a data folder to isolate from.
fn legacy_present(roots: &Roots) -> bool {
    legacy_paths(roots).data_folder.is_dir()
}

/// The data folder to run against, given the one the app config names.
///
/// Returns `saved` untouched unless it is JAN's own data folder and either the
/// user chose Start fresh, or this is the first-ever Flint boot and nothing
/// has been answered; then it is Flint's own folder.
pub fn effective_data_folder(saved: &Path, roots: &Roots) -> PathBuf {
    let legacy = legacy_paths(roots).data_folder;
    if fsutil::canonical_or_lexical(saved) != fsutil::canonical_or_lexical(&legacy)
        || !legacy_present(roots)
    {
        return saved.to_path_buf();
    }
    let flint = flint_paths(roots);
    // A completed copy or move ends on Flint's folder. The app config is the
    // `settings.json` JAN also reads and writes, so a running JAN can put its
    // own folder back there; without this the next start silently ran on
    // JAN's data again and the migration looked undone.
    if let Some(dest) = migrated_data_folder(&flint.config_dir) {
        log::info!(
            "saved data folder is JAN's {} but a migration completed into {}; using that",
            legacy.display(),
            dest.display()
        );
        return dest;
    }
    let isolate = match read_decision(&flint.config_dir) {
        Some(Decision::Fresh | Decision::Undecided) => true,
        Some(Decision::Use) => false,
        None => {
            // Today's behaviour for any machine Flint has run on before.
            let first_ever = matches!(manifest::read(&flint.config_dir), Ok(None))
                && !flint_ran_on(&legacy);
            if first_ever {
                if let Err(e) = record_decision(&flint.config_dir, Decision::Undecided) {
                    // Not recorded: do not isolate half-way.
                    log::warn!("could not record the first-boot isolation: {e}");
                    return saved.to_path_buf();
                }
            }
            first_ever
        }
    };
    if isolate {
        log::info!(
            "not using JAN's data folder {}: no decision to use it; running on {}",
            legacy.display(),
            flint.data_folder.display()
        );
        return flint.data_folder;
    }
    saved.to_path_buf()
}

/// The data folder a completed copy or move migration populated, if it still
/// exists.
fn migrated_data_folder(flint_config_dir: &Path) -> Option<PathBuf> {
    let m = manifest::read(flint_config_dir).ok().flatten()?;
    let copied = matches!(m.mode, manifest::ModeTag::Copy | manifest::ModeTag::Move);
    (m.status == manifest::Status::Complete && copied && m.destination.data_folder.is_dir())
        .then_some(m.destination.data_folder)
}

/// Whether provider keys must come from a keyring service of Flint's own
/// instead of the `jan-providers` one JAN shares: after Start fresh, and on an
/// unanswered first boot. Read from the recorded decision only, so an install
/// that predates the guard keeps `jan-providers`.
pub fn keyring_isolated(roots: &Roots) -> bool {
    matches!(
        read_decision(&flint_paths(roots).config_dir),
        Some(Decision::Fresh | Decision::Undecided)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::migration::execute::{execute, ExecuteOpts};
    use crate::core::migration::plan::{plan, Conflict, Mode};
    use crate::core::migration::{detect_legacy, Category};

    struct Fx {
        _td: tempfile::TempDir,
        roots: Roots,
    }

    /// A fake JAN install (threads + a provider secrets file) under a temp dir.
    fn jan_install() -> Fx {
        let td = tempfile::tempdir().unwrap();
        let data_dir = td.path().join("appdata");
        let home = td.path().join("home");
        crate::core::migration::detect::tests::seed_legacy(&data_dir, &home);
        let roots = Roots::new(&data_dir, &home);
        Fx { _td: td, roots }
    }

    fn jan_folder(fx: &Fx) -> PathBuf {
        legacy_paths(&fx.roots).data_folder
    }

    fn run(fx: &Fx, mode: Mode, cats: &[Category]) {
        let p = plan(
            &detect_legacy(&fx.roots).unwrap(),
            &flint_paths(&fx.roots),
            cats,
            mode,
            Conflict::KeepFlint,
        );
        let r = execute(&p, &ExecuteOpts::with_holder("test"));
        assert_eq!(r.status, manifest::Status::Complete, "{:?}", r.error);
    }

    /// A running JAN rewriting the shared settings.json back to its own
    /// folder must not undo a completed copy.
    #[test]
    fn a_completed_copy_keeps_flint_on_its_folder_when_the_config_names_jans() {
        let fx = jan_install();
        let jan = jan_folder(&fx);
        run(&fx, Mode::Copy, &[Category::Conversations]);
        assert_eq!(
            effective_data_folder(&jan, &fx.roots),
            flint_paths(&fx.roots).data_folder
        );
    }

    #[test]
    fn a_completed_reuse_still_runs_on_jans_folder() {
        let fx = jan_install();
        let jan = jan_folder(&fx);
        run(&fx, Mode::Reuse, &[]);
        assert_eq!(effective_data_folder(&jan, &fx.roots), jan);
    }

    #[test]
    fn jan_data_is_not_used_before_the_user_chooses() {
        let fx = jan_install();
        let jan = jan_folder(&fx);
        assert_eq!(
            effective_data_folder(&jan, &fx.roots),
            flint_paths(&fx.roots).data_folder
        );
        assert!(keyring_isolated(&fx.roots));
        // And it stays that way on every later boot until answered, even once
        // the isolated run has written its own markers.
        std::fs::create_dir_all(flint_paths(&fx.roots).data_folder.join("crashes")).unwrap();
        assert_eq!(
            effective_data_folder(&jan, &fx.roots),
            flint_paths(&fx.roots).data_folder
        );
        assert_eq!(
            read_decision(&flint_paths(&fx.roots).config_dir),
            Some(Decision::Undecided)
        );
    }

    #[test]
    fn a_090_user_on_jans_folder_without_a_manifest_keeps_the_folder_and_data() {
        // 0.9.0 ran on JAN's shared folder and never answered the prompt: no
        // manifest, no decision file. Its Flint-written markers prove a prior run.
        for marker in PRIOR_RUN_MARKERS {
            let fx = jan_install();
            let jan = jan_folder(&fx);
            let path = jan.join(marker);
            if marker.contains('.') {
                std::fs::write(&path, b"x").unwrap();
            } else {
                std::fs::create_dir_all(&path).unwrap();
            }
            assert_eq!(effective_data_folder(&jan, &fx.roots), jan, "{marker}");
            assert!(jan.join("threads").exists(), "{marker}: chats stay visible");
            assert!(!keyring_isolated(&fx.roots), "{marker}: keys stay visible");
            assert_eq!(read_decision(&flint_paths(&fx.roots).config_dir), None, "{marker}");
        }
    }

    #[test]
    fn a_090_user_with_a_manifest_but_no_decision_keeps_the_folder() {
        let fx = jan_install();
        let jan = jan_folder(&fx);
        let flint = flint_paths(&fx.roots);
        manifest::write(&flint.config_dir, &crate::core::migration::manifest::MigrationManifest::new(
            crate::core::migration::manifest::SourceInfo {
                config_dir: legacy_paths(&fx.roots).config_dir,
                data_folder: jan.clone(),
                location: crate::core::migration::detect::LegacyLocation::DataFolder,
            },
            crate::core::migration::manifest::DestInfo {
                config_dir: flint.config_dir.clone(),
                data_folder: flint.data_folder.clone(),
            },
            crate::core::migration::manifest::ModeTag::Reuse,
            Vec::new(),
            Default::default(),
        )).unwrap();
        assert_eq!(effective_data_folder(&jan, &fx.roots), jan);
        assert!(!keyring_isolated(&fx.roots));
    }

    #[test]
    fn the_boot_stamp_marks_a_flint_profile() {
        let fx = jan_install();
        let jan = jan_folder(&fx);
        stamp_boot(&jan);
        assert_eq!(effective_data_folder(&jan, &fx.roots), jan);
    }

    #[test]
    fn start_fresh_is_persisted_and_never_falls_back_to_jan() {
        let fx = jan_install();
        let jan = jan_folder(&fx);
        run(&fx, Mode::Fresh, &[]);
        let flint = flint_paths(&fx.roots);
        assert_eq!(read_decision(&flint.config_dir), Some(Decision::Fresh));
        // Every later start, however JAN's settings.json looks, stays off JAN.
        assert_eq!(effective_data_folder(&jan, &fx.roots), flint.data_folder);
        assert!(keyring_isolated(&fx.roots));
        // Nothing was copied.
        assert!(!flint.data_folder.join("threads").exists());
    }

    #[test]
    fn dont_ask_again_means_fresh_too() {
        let fx = jan_install();
        let flint = flint_paths(&fx.roots);
        manifest::mark_dismissed(&flint.config_dir).unwrap();
        assert_eq!(read_decision(&flint.config_dir), Some(Decision::Fresh));
        assert_eq!(
            effective_data_folder(&jan_folder(&fx), &fx.roots),
            flint.data_folder
        );
    }

    #[test]
    fn a_reuse_lets_flint_run_on_jan_and_keeps_its_keys() {
        let fx = jan_install();
        let jan = jan_folder(&fx);
        run(&fx, Mode::Reuse, &[]);
        assert_eq!(effective_data_folder(&jan, &fx.roots), jan);
        assert!(!keyring_isolated(&fx.roots));
    }

    #[test]
    fn a_manual_copy_after_start_fresh_still_works() {
        let fx = jan_install();
        run(&fx, Mode::Fresh, &[]);
        run(&fx, Mode::Copy, &[Category::Conversations]);
        let flint = flint_paths(&fx.roots);
        assert!(flint.data_folder.join("threads").exists(), "copy must run after a fresh start");
        assert_eq!(read_decision(&flint.config_dir), Some(Decision::Use));
        assert!(!keyring_isolated(&fx.roots));
    }

    #[test]
    fn an_existing_flint_folder_is_never_redirected() {
        // 0.9.0 upgrade: the app config already names Flint's own folder.
        let fx = jan_install();
        let flint = flint_paths(&fx.roots);
        std::fs::create_dir_all(flint.data_folder.join("threads")).unwrap();
        assert_eq!(effective_data_folder(&flint.data_folder, &fx.roots), flint.data_folder);
        assert!(!keyring_isolated(&fx.roots), "its own folder keeps its keys");
        assert_eq!(read_decision(&flint.config_dir), None);
        let custom = fx._td.path().join("custom-data");
        std::fs::create_dir_all(&custom).unwrap();
        assert_eq!(effective_data_folder(&custom, &fx.roots), custom);
    }

    #[test]
    fn a_pre_guard_install_with_a_manifest_is_left_as_it_was() {
        // 0.9.0 user who chose Reuse: manifest present, no decision file.
        let fx = jan_install();
        let jan = jan_folder(&fx);
        run(&fx, Mode::Reuse, &[]);
        let flint = flint_paths(&fx.roots);
        std::fs::remove_file(flint.config_dir.join(DECISION_FILE)).unwrap();
        assert_eq!(effective_data_folder(&jan, &fx.roots), jan);
        assert!(!keyring_isolated(&fx.roots));
    }

    #[test]
    fn no_jan_install_means_no_isolation() {
        let td = tempfile::tempdir().unwrap();
        let roots = Roots::new(td.path().join("appdata"), td.path().join("home"));
        let folder = legacy_paths(&roots).data_folder;
        assert_eq!(effective_data_folder(&folder, &roots), folder);
        assert!(!keyring_isolated(&roots));
    }
}
