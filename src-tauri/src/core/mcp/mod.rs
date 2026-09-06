// Tauri command surface + the AppHandle-driven server lifecycle are
// desktop-only; the CLI drives MCP through `core::cli::mcp`.
#[cfg(not(feature = "cli"))]
pub mod commands;
pub mod constants;
#[cfg(not(feature = "cli"))]
pub mod helpers;
// Confinement-as-a-type for stdio servers: Tauri-free, and the CLI's own
// connect path spawns through it, so it must exist in both configurations.
pub mod launch;
// The lock file is written against an `AppHandle`'s data directory; every
// caller is a desktop command surface, and the CLI does not link `tauri`.
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
