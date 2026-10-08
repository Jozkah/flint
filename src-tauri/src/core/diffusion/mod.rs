//! Local image and video generation with stable-diffusion.cpp.
//!
//! `sd-server` runs as its own process, one model resident at a time, and is
//! driven over HTTP on a loopback port. It is a separate process and not linked
//! into the llama.cpp worker, which keeps the two engines' GPU libraries apart.

use std::sync::OnceLock;

/// The running app, so the local API server (which has no app handle of its own)
/// can reach the image engine.
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

pub fn register(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());
    custom::load(app);
}

pub fn app() -> Option<&'static tauri::AppHandle> {
    APP.get()
}

pub mod args;
pub mod catalog;
pub mod commands;
pub mod custom;
pub mod engine;
pub mod installation;
pub mod gallery;
pub mod progress;
pub mod runtime;
