//! Archive instead of delete. See `store` for the layout and the rules.
//!
//! `mod.rs` holds the purge cleanup, the one place that knows what each kind
//! owns outside its archived copy.

pub mod commands;
pub mod store;

use std::path::Path;

use store::{ArchiveMeta, Kind};

/// What destroying an archived item also destroys, run before its directory is
/// removed. A refusal keeps the item: nothing is half-purged.
pub fn purge_cleanup(data: &Path, meta: &ArchiveMeta, _dir: &Path) -> Result<(), String> {
    match meta.kind {
        Kind::Thread => {
            // The sanitized copies of what this conversation sent, and the
            // provider's counts for them, go with it. Best effort, like the
            // directory removal: a log that cannot be rewritten right now must
            // not stop the purge.
            if let Err(e) = tauri_plugin_agent_tools::retention::delete_session(data, &meta.id) {
                log::warn!("could not remove request records for a purged thread: {e}");
            }
            // The thread's agent scratch dir in the OS temp folder is ours to
            // remove too (Jozkah/jan#186).
            if let Some(scratch) = crate::core::threads::utils::thread_scratch_dir(&meta.id) {
                if let Err(e) = std::fs::remove_dir_all(&scratch) {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        log::warn!("could not remove a purged thread's scratch dir: {e}");
                    }
                }
            }
            Ok(())
        }
        Kind::Room | Kind::Project | Kind::Cowork => Ok(()),
    }
}
