pub mod agent;
pub mod app;
pub mod compat_env;
#[cfg(feature = "cli")]
pub mod cli;
// Native file dialogs/IO commands and the system/tray command surface are
// desktop-only; the CLI uses std::fs and its own tools.
#[cfg(not(feature = "cli"))]
pub mod filesystem;
pub mod mcp;
pub mod migration;
pub mod net;
pub mod openai_schema;
// Discussion room files; the commands are desktop-only like filesystem.
#[cfg(not(feature = "cli"))]
pub mod rooms;
pub mod secret_values;
pub mod server;
// Desktop-only app setup (tray, theme, window wiring); pulls in Tauri GUI types
// (Wry/AppHandle) the headless `jan` CLI build does not link.
#[cfg(not(feature = "cli"))]
pub mod setup;
pub mod state;
#[cfg(not(feature = "cli"))]
pub mod system;
pub mod threads;
pub mod window_state;
