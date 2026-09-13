//! Test-only scripting seam for the native file/folder picker.
//!
//! The Cowork attach flow calls `serviceHub.dialog().open({ directory: true })`,
//! which reaches the `open_dialog` command and opens a *native modal*. A WebView
//! automation harness cannot drive a native modal, so the `cowork-smoke` binary
//! scripts the picker's answer instead and leaves every other part of the attach
//! path -- the React handler, the service hub, the IPC hop, the command, and all
//! downstream project wiring -- completely real.
//!
//! This module only exists when the crate is built with the `cowork-smoke`
//! feature, which is absent from `default`, so release builds contain none of
//! it. Nothing here is reachable from JavaScript: the script is read from the
//! process environment, which only the harness (the same process) can set.
//! A scripted path must already exist, so the seam cannot conjure access to a
//! path the picker could not have returned anyway.

use std::path::Path;

/// Environment variable holding the picker's scripted answer.
///
/// * unset -- no script; the real native dialog opens.
/// * `"cancel"` -- the picker was dismissed; the command returns `None`.
/// * any other value -- an existing path the picker "returned".
pub const SCRIPT_ENV: &str = "JAN_SMOKE_DIALOG_RESULT";

/// The literal that scripts a dismissed picker.
pub const CANCEL: &str = "cancel";

/// Resolve the scripted picker answer.
///
/// Returns `None` when no script is set, so the caller falls through to the
/// real dialog. `Some(None)` is a cancelled picker; `Some(Some(path))` is a
/// selection.
pub fn scripted_response() -> Option<Option<serde_json::Value>> {
    let script = std::env::var(SCRIPT_ENV).ok()?;
    if script.is_empty() {
        return None;
    }
    if script == CANCEL {
        return Some(None);
    }
    // Refuse to invent a path the user could not have picked.
    if !Path::new(&script).exists() {
        log::warn!("{SCRIPT_ENV} points at {script:?}, which does not exist; ignoring the script");
        return None;
    }
    Some(Some(serde_json::Value::String(script)))
}

/// Resolve the scripted answer of a *save* picker.
///
/// A save picker names a file that usually does not exist yet, so the rule is
/// the folder it goes in must: the seam still cannot conjure a location the
/// native dialog could not have offered.
pub fn scripted_save_response() -> Option<Option<String>> {
    let script = std::env::var(SCRIPT_ENV).ok()?;
    if script.is_empty() {
        return None;
    }
    if script == CANCEL {
        return Some(None);
    }
    let parent_exists = Path::new(&script).parent().is_some_and(|p| p.is_dir());
    if !parent_exists {
        log::warn!("{SCRIPT_ENV} names {script:?}, whose folder does not exist; ignoring the script");
        return None;
    }
    Some(Some(script))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The env var is process-global, so these cases share one test rather than
    /// racing each other across threads.
    #[test]
    fn the_script_is_honoured_only_when_it_names_something_real() {
        let dir = tempfile::tempdir().expect("tempdir");
        let existing = dir.path().to_string_lossy().to_string();

        std::env::remove_var(SCRIPT_ENV);
        assert!(
            scripted_response().is_none(),
            "with no script the real dialog must run"
        );

        std::env::set_var(SCRIPT_ENV, "");
        assert!(
            scripted_response().is_none(),
            "an empty script must not count as a cancellation"
        );

        std::env::set_var(SCRIPT_ENV, CANCEL);
        assert_eq!(
            scripted_response(),
            Some(None),
            "`cancel` must script a dismissed picker"
        );

        std::env::set_var(SCRIPT_ENV, &existing);
        assert_eq!(
            scripted_response(),
            Some(Some(serde_json::Value::String(existing))),
            "an existing path must be returned as the picked path"
        );

        std::env::set_var(SCRIPT_ENV, "/definitely/not/here/at/all");
        assert!(
            scripted_response().is_none(),
            "a path that does not exist must fall through, not be fabricated"
        );

        std::env::remove_var(SCRIPT_ENV);

        // A save picker may name a new file, but only in a folder that exists.
        let new_file = dir.path().join("export.json").to_string_lossy().to_string();
        std::env::set_var(SCRIPT_ENV, &new_file);
        assert_eq!(scripted_save_response(), Some(Some(new_file)));
        std::env::set_var(SCRIPT_ENV, "/definitely/not/here/export.json");
        assert!(scripted_save_response().is_none());
        std::env::set_var(SCRIPT_ENV, CANCEL);
        assert_eq!(scripted_save_response(), Some(None));
        std::env::remove_var(SCRIPT_ENV);
    }
}
