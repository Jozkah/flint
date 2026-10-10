//! Provider network transport: how a configured endpoint becomes a connection.
//!
//! `resolver` decides which address a hostname should be dialled at;
//! `transport` is the single request path every provider call takes;
//! `commands` exposes both to the web app.

pub mod proxy;
pub mod resolver;
pub mod transport;
pub mod tls;

#[cfg(not(feature = "cli"))]
pub mod commands;
