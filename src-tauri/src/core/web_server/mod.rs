//! Headless HTTP server for the production browser application.

pub mod auth;
pub mod control;
pub mod data;
pub mod engine;
pub mod events;
pub mod files;
pub mod limiter;
pub mod mcp;
pub mod provider;
pub mod rooms;
pub mod resources;
pub mod server;
pub mod settings;
pub mod uploads;
#[path = "../remote/static_files.rs"]
pub mod static_files;
