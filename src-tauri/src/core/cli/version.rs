//! What version this build reports.
//!
//! Kept when the CLI's self-updater was removed: reporting a version is not
//! checking for one. Nothing here reaches the network.

/// The version string shown by `jan --version` and in the TUI.
///
/// Overridable at build time so nightly builds can carry their own label.
pub fn build_version() -> &'static str {
    option_env!("JAN_CLI_BUILD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))
}
