//! Shared agent orchestration: the server-side loop and its upstream/provider
//! plumbing, consumed by both the API-server proxy and `tauri-plugin-agent`.
//!
//! The toolset the loop drives -- the built-in tools, their capability gate,
//! permissions, and skill storage -- lives in `tauri_plugin_agent_tools`, which
//! builds with or without Tauri so the desktop app and the headless CLI share
//! one implementation. This module owns orchestration only.

// Tauri IPC surface for the desktop agent; the CLI drives the loop directly.
pub mod accepted_history;
pub mod agent_bundle;
pub mod agent_import;
pub mod auto_mode;
pub mod bundle_import;
// Claude Code import exposes only Tauri commands (desktop-only); the `cli`
// build has no `tauri` crate linked, so gate it out like `commands`.
#[cfg(not(feature = "cli"))]
pub mod cc_import;
pub mod checkpoint;
#[cfg(not(feature = "cli"))]
pub mod commands;
pub mod compaction;
/// Request correlation with the provider's billing records (upstream #9034).
pub mod correlation;
pub mod compaction_policy;
pub mod consensus;
pub mod context;
pub mod context_pressure;
pub mod desktop_bridge;
pub mod destructive;
pub mod diagnostics;
pub mod durable_subagent;
pub mod events;
pub mod extensions;
pub mod fixtures;
pub mod genai_bridge;
pub mod git;
#[cfg(feature = "cli")]
pub mod global_config;
pub mod github_recovery;
// `/goal` is a terminal-UI command; the desktop build compiles the module
// but calls none of it.
#[cfg_attr(not(feature = "cli"), allow(dead_code))]
pub mod goal;
pub mod health;
pub mod impact;
pub mod index;
// Host tools are executed by a client over the headless stdio channel, so the
// capability exists only where that channel does. The desktop build has no peer
// that could answer a `tool_request`.
#[cfg(feature = "cli")]
pub mod host_tools;
// Only host tools consume these helpers, so they share host_tools' gate.
#[cfg(feature = "cli")]
pub mod host_schema;
pub mod interaction;
pub mod licenses;
pub mod r#loop;
pub mod lsp;
pub mod mcp_catalog;
#[cfg(not(feature = "cli"))]
pub mod memory_consolidation;
pub mod notify;
pub mod plan;
pub mod plugin_commands;
pub mod plugins;
pub mod project;
pub(crate) mod projects_registry;
pub mod proposals;
pub mod provenance;
pub mod pull_request;
pub mod quota;
pub mod reminder;
pub mod replay;
pub mod review;
pub mod roles;
pub mod routing;
pub mod semantic;
pub mod session;
pub mod session_bundle;
pub mod skill_hub;
pub mod skills;
pub mod spend;
pub mod state_schema;
pub mod subagent;
pub mod team_children;
pub mod test_triage;
pub mod todo;
pub mod tooling;
pub mod transcript;
pub mod upstream;
pub mod vcs;
pub mod verification;
pub mod worktree;
pub mod worktree_export;
pub(crate) mod partial_dirs;
