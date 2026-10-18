/*!
   Discussion room persistence (docs/DISCUSSION_ROOMS.md, "Persistence").

   `store` holds the Tauri-free logic (typed room/journal structs, validation,
   atomic writes, revisions, the journal) and `commands` exposes it as thin
   Tauri commands. Desktop only; registered in `lib.rs`.
*/

pub mod commands;
pub mod store;
pub mod workspace;

#[cfg(test)]
mod tests;
