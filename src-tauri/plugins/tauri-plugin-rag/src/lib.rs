#[cfg(feature = "tauri")]
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(feature = "tauri")]
mod commands;
mod constants;
mod error;
pub mod parser;

pub use constants::*;
pub use error::RagError;

#[cfg(feature = "tauri")]
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("rag")
        .invoke_handler(tauri::generate_handler![
            commands::parse_document,
        ])
        .setup(|_app, _api| Ok(()))
        .build()
}
