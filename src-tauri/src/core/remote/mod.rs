//! Remote access: a paired phone uses Flint running on this computer.
//!
//! Chat, Cowork and Rooms run in the desktop window, not in Rust, so the
//! phone's requests go through to the window:
//!
//! ```text
//! phone <-HTTPS/WebSocket-> server.rs <-> hub.rs <-Tauri events/commands-> window bridge
//! ```
//!
//! Off by default. When on, it binds one chosen interface (Tailscale, home
//! Wi-Fi or loopback) -- see `config.rs` for how the address and transport
//! are picked and why -- and serves only paired devices, each holding a token
//! whose hash is all that is stored (`auth.rs`).

pub mod auth;
pub mod commands;
pub mod config;
pub mod hub;
pub mod server;
pub mod preview;
pub mod push;
pub mod static_files;
pub mod tls;
pub mod uploads;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod push_tests;
#[cfg(test)]
mod upload_tests;
