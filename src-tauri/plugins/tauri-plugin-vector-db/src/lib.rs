#[cfg(feature = "tauri")]
mod commands;
mod compat_env;
pub mod db;
mod error;
mod state;
mod utils;

pub use error::VectorDBError;
pub use state::{migrate_legacy_vector_db, VectorDBState};

/// Register the vector-db state with its collections under `base` (the app
/// puts them in `<data folder>/vectordb`). Moves the legacy per-user database
/// files across once. Call before any frontend command can run.
#[cfg(feature = "tauri")]
pub fn manage_state<R: tauri::Runtime>(app: &tauri::AppHandle<R>, base: std::path::PathBuf) {
    use tauri::Manager;

    let state = state::VectorDBState::at(base.clone());
    // A test or portable run (its own data folder) copies, so it never takes
    // the real install's databases.
    let copy_only = compat_env::var_os("DATA_FOLDER").is_some();
    match state::migrate_legacy_vector_db(&db::default_base_dir(), &base, copy_only) {
        Ok(0) => {}
        Ok(n) => log::info!("vector-db: brought {n} legacy database file(s) into {}", base.display()),
        Err(e) => log::warn!("vector-db: legacy database migration failed: {e}"),
    }
    app.manage(state);
}

#[cfg(feature = "tauri")]
pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("vector-db")
        .invoke_handler(tauri::generate_handler![
            commands::create_collection,
            commands::insert_chunks,
            commands::create_file,
            commands::search_collection,
            commands::delete_chunks,
            commands::delete_file,
            commands::delete_collection,
            commands::chunk_text,
            commands::get_status,
            commands::list_attachments,
            commands::get_chunks,
            commands::memory_index,
            commands::memory_search,
            commands::memory_clear,
        ])
        .build()
}
