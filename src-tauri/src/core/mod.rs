pub mod agent;
// Archive instead of delete; desktop-only like rooms.
#[cfg(not(feature = "cli"))]
pub mod archive;
pub mod app;
// Local image and video generation (stable-diffusion.cpp sidecar); desktop-only.
#[cfg(not(feature = "cli"))]
pub mod diffusion;
// "Verify in browser": a separate, confined browser; desktop-only.
#[cfg(not(feature = "cli"))]
pub mod browser_verify;
pub mod compat_env;
// Jev (TypeSafe) decision support: optional, off by default; desktop-only.
#[cfg(not(feature = "cli"))]
pub mod jev;
#[cfg(feature = "cli")]
pub mod cli;
// Explicit, user-initiated Hugging Face model discovery/downloads. Kept
// desktop-only so the CLI remains network-agnostic unless the user configures
// a provider there.
#[cfg(not(feature = "cli"))]
pub mod huggingface;
// Native file dialogs/IO commands and the system/tray command surface are
// desktop-only; the CLI uses std::fs and its own tools.
#[cfg(not(feature = "cli"))]
pub mod filesystem;
pub mod mcp;
// Read-only lookup of models other apps already keep on disk; desktop-only.
#[cfg(not(feature = "cli"))]
pub mod model_scan;
pub mod migration;
pub mod net;
pub mod openai_schema;
// Sandboxed HTML preview scheme (#135); desktop-only like filesystem.
#[cfg(not(feature = "cli"))]
pub mod preview;
// Discussion room files; the commands are desktop-only like filesystem.
#[cfg(not(feature = "cli"))]
pub mod rooms;
// Remote access for a paired phone; desktop-only (the WebSocket stack is not
// built for mobile targets, and the CLI has no window to bridge to).
#[cfg(all(not(feature = "cli"), not(any(target_os = "android", target_os = "ios"))))]
pub mod remote;
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
// Native child-webview web preview; desktop-only like preview.
#[cfg(not(feature = "cli"))]
pub mod web_preview;
pub mod window_state;
