//! Whose `jan` is this?
//!
//! The desktop app ships a `jan` CLI and installs it on launch. So does the
//! standalone agent installer, and on Unix both default to `~/.local/bin/jan`.
//! The desktop side used to copy over whatever was there on every version
//! change -- no existence check, no version check, no record of what it
//! destroyed -- so installing or updating the desktop app silently downgraded a
//! separately managed CLI. On Windows it could not overwrite (the two live in
//! different directories), but it removed the standalone install's PATH entry
//! and put its own bundled copy first, which displaced it just as silently.
//! Reported upstream as janhq/jan#8812.
//!
//! The rule now: the automatic install only ever touches a `jan` it put there
//! itself. A user who presses "Install CLI" in settings is asking for the
//! replacement, and gets it.

use std::fs;
use std::path::{Path, PathBuf};

/// Written beside a CLI the desktop app installed, naming the file it owns.
pub const MARKER_FILE: &str = ".jan-desktop-cli";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ownership {
    /// Nothing at the destination.
    Absent,
    /// Installed by this app: the marker names it, or it is byte-for-byte the
    /// binary this app bundles.
    Ours,
    /// Something else put it there.
    Foreign,
}

fn marker_path(dest: &Path) -> PathBuf {
    dest.with_file_name(MARKER_FILE)
}

/// Who owns the CLI at `dest`.
///
/// A copy identical to the bundled one counts as ours even without a marker:
/// replacing a file with itself destroys nothing, and it lets an install made
/// before the marker existed be recognised when it is current.
pub fn ownership(dest: &Path, bundled: &Path) -> Ownership {
    if !dest.exists() {
        return Ownership::Absent;
    }
    let named = dest.file_name().map(|n| n.to_string_lossy().into_owned());
    let marked = fs::read_to_string(marker_path(dest))
        .ok()
        .map(|content| content.trim().to_string());
    if named.is_some() && marked == named {
        return Ownership::Ours;
    }
    match (fs::read(dest), fs::read(bundled)) {
        (Ok(a), Ok(b)) if a == b => Ownership::Ours,
        _ => Ownership::Foreign,
    }
}

/// Record that the CLI at `dest` was installed by this app.
pub fn record_ours(dest: &Path) -> Result<(), String> {
    let name = dest
        .file_name()
        .ok_or_else(|| format!("not a file path: {}", dest.display()))?;
    fs::write(marker_path(dest), name.to_string_lossy().as_bytes()).map_err(|e| e.to_string())
}

/// What the automatic, on-launch install should do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutoAction {
    /// No CLI anywhere this app would use: install ours.
    Install,
    /// Ours is installed and the app version changed: refresh it.
    Update,
    /// Ours is installed and current.
    UpToDate,
    /// A `jan` this app did not install is in the way. Leave it alone.
    LeaveForeign(PathBuf),
}

fn same_path(a: &Path, b: &Path) -> bool {
    let a = fs::canonicalize(a).unwrap_or_else(|_| a.to_path_buf());
    let b = fs::canonicalize(b).unwrap_or_else(|_| b.to_path_buf());
    if cfg!(windows) {
        a.to_string_lossy()
            .eq_ignore_ascii_case(b.to_string_lossy().as_ref())
    } else {
        a == b
    }
}

/// Decide the on-launch install.
///
/// - `on_path`: the first `jan` the shell would run, if any.
/// - `target`: where this app installs its CLI.
/// - `target_owner`: who owns what is at `target` now.
pub fn decide_auto(
    on_path: Option<&Path>,
    target: &Path,
    target_owner: &Ownership,
    version_changed: bool,
) -> AutoAction {
    // Another `jan` resolves first. Installing ours would either shadow it (the
    // Windows PATH is prepended) or be shadowed by it, and neither is what the
    // user who installed that one asked for.
    if let Some(found) = on_path {
        if !same_path(found, target) {
            return AutoAction::LeaveForeign(found.to_path_buf());
        }
    }
    match target_owner {
        Ownership::Absent => AutoAction::Install,
        Ownership::Foreign => AutoAction::LeaveForeign(target.to_path_buf()),
        Ownership::Ours if version_changed => AutoAction::Update,
        // Ours, but nothing on PATH reaches it -- a fresh Windows install whose
        // PATH entry was never written, or a Unix bin dir not yet on PATH.
        Ownership::Ours if on_path.is_none() => AutoAction::Install,
        Ownership::Ours => AutoAction::UpToDate,
    }
}

/// First line of `which jan` / `where jan` output, as a path.
pub fn first_resolved(stdout: &str) -> Option<PathBuf> {
    stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(PathBuf::from)
}

/// Whether a PATH entry the Windows install would prune as stale still holds a
/// CLI. Such an entry is somebody's install, not debris.
pub fn path_entry_holds_cli(dir: &Path) -> bool {
    dir.join("jan.exe").is_file() || dir.join("jan").is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let bundled = tmp.path().join("bundled-jan");
        fs::write(&bundled, b"desktop build 0.8.4").unwrap();
        let bin = tmp.path().join("bin");
        fs::create_dir_all(&bin).unwrap();
        (tmp, bundled, bin.join("jan"))
    }

    #[test]
    fn nothing_there_is_absent() {
        let (_tmp, bundled, dest) = fixture();
        assert_eq!(ownership(&dest, &bundled), Ownership::Absent);
    }

    // janhq/jan#8812: this is the file the desktop used to overwrite.
    #[test]
    fn a_standalone_install_is_foreign() {
        let (_tmp, bundled, dest) = fixture();
        fs::write(&dest, b"standalone agent build 0.9.1").unwrap();
        assert_eq!(ownership(&dest, &bundled), Ownership::Foreign);
    }

    #[test]
    fn a_marked_install_is_ours_even_when_older() {
        let (_tmp, bundled, dest) = fixture();
        fs::write(&dest, b"desktop build 0.8.3").unwrap();
        record_ours(&dest).unwrap();
        assert_eq!(ownership(&dest, &bundled), Ownership::Ours);
    }

    #[test]
    fn an_identical_copy_is_ours_without_a_marker() {
        let (_tmp, bundled, dest) = fixture();
        fs::copy(&bundled, &dest).unwrap();
        assert_eq!(ownership(&dest, &bundled), Ownership::Ours);
    }

    #[test]
    fn a_marker_naming_another_file_does_not_claim_this_one() {
        let (_tmp, bundled, dest) = fixture();
        fs::write(&dest, b"standalone").unwrap();
        fs::write(dest.with_file_name(MARKER_FILE), "jan-old").unwrap();
        assert_eq!(ownership(&dest, &bundled), Ownership::Foreign);
    }

    #[test]
    fn a_foreign_cli_at_the_target_is_left_alone_even_on_update() {
        let (_tmp, _bundled, dest) = fixture();
        assert_eq!(
            decide_auto(Some(&dest), &dest, &Ownership::Foreign, true),
            AutoAction::LeaveForeign(dest.clone())
        );
        assert_eq!(
            decide_auto(None, &dest, &Ownership::Foreign, true),
            AutoAction::LeaveForeign(dest)
        );
    }

    #[test]
    fn another_cli_earlier_on_path_is_left_alone() {
        let (tmp, _bundled, dest) = fixture();
        let elsewhere = tmp.path().join("other").join("jan");
        assert_eq!(
            decide_auto(Some(&elsewhere), &dest, &Ownership::Absent, true),
            AutoAction::LeaveForeign(elsewhere)
        );
    }

    #[test]
    fn our_own_cli_is_refreshed_only_when_the_version_changed() {
        let (_tmp, _bundled, dest) = fixture();
        assert_eq!(
            decide_auto(Some(&dest), &dest, &Ownership::Ours, true),
            AutoAction::Update
        );
        assert_eq!(
            decide_auto(Some(&dest), &dest, &Ownership::Ours, false),
            AutoAction::UpToDate
        );
    }

    #[test]
    fn our_own_cli_that_nothing_reaches_is_installed_again() {
        let (_tmp, _bundled, dest) = fixture();
        assert_eq!(
            decide_auto(None, &dest, &Ownership::Ours, false),
            AutoAction::Install
        );
    }

    #[test]
    fn a_fresh_machine_gets_the_cli() {
        let (_tmp, _bundled, dest) = fixture();
        assert_eq!(
            decide_auto(None, &dest, &Ownership::Absent, false),
            AutoAction::Install
        );
    }

    #[test]
    fn which_output_yields_the_first_resolution() {
        assert_eq!(
            first_resolved("\r\nC:\\a\\jan.exe\r\nC:\\b\\jan.exe\r\n"),
            Some(PathBuf::from("C:\\a\\jan.exe"))
        );
        assert_eq!(first_resolved(""), None);
    }

    #[test]
    fn a_path_entry_with_a_cli_in_it_is_not_stale() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!path_entry_holds_cli(tmp.path()));
        fs::write(tmp.path().join("jan.exe"), b"x").unwrap();
        assert!(path_entry_holds_cli(tmp.path()));
    }
}
