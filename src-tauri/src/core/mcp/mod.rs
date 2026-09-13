// Tauri command surface + the AppHandle-driven server lifecycle are
// desktop-only; the CLI drives MCP through `core::cli::mcp`.
pub mod budget;
#[cfg(not(feature = "cli"))]
pub mod commands;
pub mod server_log;
pub mod constants;
#[cfg(not(feature = "cli"))]
pub mod helpers;
// `launch` is Tauri-free by construction: it builds a confined child process
// for a stdio MCP server and is the single place that confinement is applied.
// Both the desktop path (`mcp::helpers`) and the CLI path (`cli::mcp`) go
// through it, so it must not be gated to one of them.
pub mod launch;
// The lock files are addressed through `AppHandle::path()`, so this module is
// desktop-only; the CLI does not run the AppHandle-driven server lifecycle.
#[cfg(not(feature = "cli"))]
pub mod lockfile;
pub mod models;
// OAuth for remote MCP servers: Tauri-free so the CLI drives it today and the
// desktop activation stack can adopt it unchanged.
pub mod oauth;
#[cfg(not(feature = "cli"))]
pub mod progress;
pub mod truncate;

#[cfg(test)]
#[cfg(not(feature = "cli"))]
mod tests;
#[cfg(test)]
#[cfg(not(feature = "cli"))]
mod config_durability_tests;
