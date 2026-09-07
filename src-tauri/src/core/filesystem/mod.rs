pub mod commands;
pub mod helpers;
pub mod models;

#[cfg(test)]
mod tests;

/// Test-only scripting seam for the native picker. Compiled out of release
/// builds: `cowork-smoke` is not part of the default feature set.
#[cfg(feature = "cowork-smoke")]
pub mod smoke_dialog;
