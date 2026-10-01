//! Scheduled tasks: prompts that run on a timetable with nobody watching.
//!
//! * `cron` / `spec` / `engine` -- pure: what a task is, when it fires, which
//!   fires are due given a clock and what has already been seen.
//! * `store` -- tasks, watermarks and run records on disk.
//! * `runner` -- turns a due fire into a detached job.
//!
//! Runs execute in a separate `flint` process (see `cli::schedule`); the app
//! only ticks and starts them, so a run outlives the app that started it.

// The Tauri surface (commands and the tick driver) is desktop-only; the pure
// modules and the runner are shared with the headless CLI.
#[cfg(not(feature = "cli"))]
pub mod commands;
pub mod cron;
#[cfg(not(feature = "cli"))]
pub mod driver;
pub mod engine;
pub mod os_scheduler;
pub mod runner;
pub mod spec;
pub mod store;
