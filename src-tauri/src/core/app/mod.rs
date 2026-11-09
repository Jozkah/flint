pub mod commands;
pub mod constants;
// Plain std file helpers. The CLI uses only the tree copy (agent config
// import); the data-folder move that uses the rest is desktop-only.
#[cfg_attr(feature = "cli", allow(dead_code))]
pub mod helpers;
pub mod models;
// Desktop settings.json store, driven by Tauri commands + a flush thread.
#[cfg(not(feature = "cli"))]
pub mod settings_store;
