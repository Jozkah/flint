//! Keeps Flint off a JAN install's data until the user has asked for it.
//!
//! Flint keeps its app config in the same `<data_dir>/Jan/settings.json` JAN
//! does, so with JAN installed a Flint that has never been told otherwise reads
//! JAN's `data_folder` and runs on JAN's threads, settings and provider keys
//! from its first second: before the first-run choice, and whatever the choice
//! was. This module is the persisted answer to "may Flint use JAN's data?".
//!
//! - **Undecided** (no decision, no manifest): the profile is isolated. Flint
//!   runs on its own empty folder and the first-run assistant offers the choice.
//! - **Fresh** (`Start fresh`, `Don't ask again`): isolated for good. JAN's
//!   data and JAN's OS-keyring provider keys are never read.
//! - **Use** (reuse, copy or move completed): not isolated. For a reuse the
//!   saved folder is JAN's, and Flint is meant to run on it.
//! - An install that already has a manifest but no decision file predates this
//!   guard (0.9.0): it is left exactly as it was.
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

/// Whether Flint must not touch JAN's data: the decision is Fresh, or there is
/// none and nothing in the Flint config dir predates this guard.
fn isolated(roots: &Roots) -> bool {
    let flint = flint_paths(roots);
    match read_decision(&flint.config_dir) {
        Some(Decision::Fresh) => true,
        Some(Decision::Use) => false,
        None => matches!(manifest::read(&flint.config_dir), Ok(None)),
    }
}

/// Whether JAN has a data folder to isolate from.
fn legacy_present(roots: &Roots) -> bool {
    legacy_paths(roots).data_folder.is_dir()
}

/// The data folder to run against, given the one the app config names.
///
/// Returns `saved` untouched unless it is JAN's own data folder and the user
/// has not allowed Flint to use it; then it is Flint's own folder.
pub fn effective_data_folder(saved: &Path, roots: &Roots) -> PathBuf {
    let legacy = legacy_paths(roots).data_folder;
    if fsutil::canonical_or_lexical(saved) != fsutil::canonical_or_lexical(&legacy) {
        return saved.to_path_buf();
    }
    if legacy_present(roots) && isolated(roots) {
        log::info!(
            "not using JAN's data folder {}: no decision to use it; running on {}",
            legacy.display(),
            flint_paths(roots).data_folder.display()
        );
        return flint_paths(roots).data_folder;
    }
    saved.to_path_buf()
}

/// Whether provider keys must come from a keyring service of Flint's own
/// instead of the `jan-providers` one JAN shares.
///
/// True after Start fresh, and while undecided with JAN installed. A Use
/// decision, or an install from before this guard, keeps `jan-providers`.
pub fn keyring_isolated(roots: &Roots) -> bool {
    let flint = flint_paths(roots);
    match read_decision(&flint.config_dir) {
        Some(Decision::Fresh) => true,
        Some(Decision::Use) => false,
        None => legacy_present(roots) && matches!(manifest::read(&flint.config_dir), Ok(None)),
    }
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

    #[test]
    fn jan_data_is_not_used_before_the_user_chooses() {
        let fx = jan_install();
        let jan = jan_folder(&fx);
        assert_eq!(
            effective_data_folder(&jan, &fx.roots),
            flint_paths(&fx.roots).data_folder
        );
        assert!(keyring_isolated(&fx.roots));
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
