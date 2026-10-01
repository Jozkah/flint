//! Local image and video generation with stable-diffusion.cpp.
//!
//! `sd-server` runs as its own process, one model resident at a time, and is
//! driven over HTTP on a loopback port. It is a separate process and not linked
//! into the llama.cpp worker, which keeps the two engines' GPU libraries apart.

pub mod args;
pub mod catalog;
pub mod commands;
pub mod engine;
pub mod gallery;
pub mod progress;
pub mod runtime;
