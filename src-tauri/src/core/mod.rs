pub mod agent;
// Archive instead of delete; desktop-only like rooms.
#[cfg(not(feature = "cli"))]
pub mod archive;
#[cfg(feature = "cli")]
pub mod archive {
    #[path = "../archive/store.rs"]
    pub mod store;
}
pub mod app;
// Local image and video generation (stable-diffusion.cpp sidecar); desktop-only.
#[cfg(not(feature = "cli"))]
pub mod diffusion;
// "Verify in browser": a separate, confined browser; desktop-only.
#[cfg(not(feature = "cli"))]
pub mod browser_verify;
// The agent's tools for the built-in browser pane; desktop-only like web_preview.
#[cfg(not(feature = "cli"))]
pub mod browser_agent;
pub mod compat_env;
#[cfg(not(feature = "cli"))]
pub mod crash_trace;
// Jev (TypeSafe) decision support: optional, off by default; desktop-only.
#[cfg(not(feature = "cli"))]
pub mod jev;
#[cfg(feature = "cli")]
pub mod cli;
// The CLI's secret scrubber (`flint bug-report`, the persistent log), compiled
// into the desktop app too so "Export logs (redacted)" uses the same rules.
#[cfg(not(feature = "cli"))]
#[allow(dead_code)]
#[path = "cli/secrets.rs"]
pub(crate) mod log_redaction;
// Which Hugging Face hub (HF_ENDPOINT) the downloads use; shared with the CLI.
pub mod hf_endpoint;
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
// Discussion room files. The Tauri commands are desktop-only like filesystem;
// the headless server serves the same store over its RPC.
#[cfg(not(feature = "cli"))]
pub mod rooms;
#[cfg(feature = "cli")]
pub mod rooms {
    #[path = "../rooms/store.rs"]
    pub mod store;
}
// Remote access for a paired phone; desktop-only (the WebSocket stack is not
// built for mobile targets, and the CLI has no window to bridge to).
#[cfg(all(not(feature = "cli"), not(any(target_os = "android", target_os = "ios"))))]
pub mod remote;
pub mod schedule;
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
#[cfg(feature = "cli")]
pub mod web_server;
// Native child-webview web preview; desktop-only like preview.
#[cfg(not(feature = "cli"))]
pub mod web_preview;
pub mod window_state;
