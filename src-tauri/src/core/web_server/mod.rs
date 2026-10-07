//! Headless HTTP server for the production browser application.

pub mod auth;
pub mod data;
pub mod mcp;
pub mod provider;
pub mod resources;
pub mod server;
pub mod uploads;
#[path = "../remote/static_files.rs"]
pub mod static_files;
