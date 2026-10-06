//! Headless HTTP server for the production browser application.

pub mod auth;
pub mod server;
#[path = "../remote/static_files.rs"]
pub mod static_files;
