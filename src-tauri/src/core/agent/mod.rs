//! Shared agent orchestration: the server-side loop and its upstream/provider
//! plumbing, consumed by both the API-server proxy and `tauri-plugin-agent`.
//!
//! The toolset the loop drives -- the built-in tools, their capability gate,
//! permissions, and skill storage -- lives in `tauri_plugin_agent_tools`, which
//! builds with or without Tauri so the desktop app and the headless CLI share
//! one implementation. This module owns orchestration only.

// Tauri IPC surface for the desktop agent; the CLI drives the loop directly.
pub mod agent_bundle;
pub mod agent_import;
pub mod bundle_import;
pub mod checkpoint;
#[cfg(not(feature = "cli"))]
pub mod commands;
pub mod auto_mode;
pub mod compaction;
pub mod compaction_policy;
#[cfg(not(feature = "cli"))]
pub mod memory_consolidation;
pub mod context;
pub mod context_pressure;
pub mod events;
pub mod extensions;
pub mod genai_bridge;
pub mod git;
#[cfg(feature = "cli")]
pub mod global_config;
#[cfg(feature = "cli")]
pub mod goal;
pub mod interaction;
pub mod r#loop;
pub mod notify;
pub mod plan;
pub mod plugin_commands;
pub mod plugins;
pub mod project;
pub(crate) mod projects_registry;
pub mod quota;
pub mod proposals;
pub mod reminder;
pub mod diagnostics;
pub mod fixtures;
pub mod impact;
pub mod health;
pub mod index;
pub mod lsp;
pub mod consensus;
pub mod licenses;
pub mod vcs;
pub mod pull_request;
pub mod semantic;
pub mod replay;
pub mod review;
pub mod spend;
pub mod state_schema;
pub mod roles;
pub mod routing;
pub mod session_bundle;
pub mod session;
pub mod skill_hub;
pub mod skills;
pub mod subagent;
pub mod durable_subagent;
pub mod team_children;
pub mod test_triage;
pub mod todo;
pub mod transcript;
pub mod tooling;
pub mod upstream;
pub mod worktree;
pub mod worktree_export;
