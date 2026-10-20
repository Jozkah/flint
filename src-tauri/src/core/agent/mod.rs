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
pub mod approval_flow;
pub mod auto_mode;
pub mod bundle_import;
pub mod campaign;
pub mod campaign_integration;
pub mod campaign_scheduler;
pub mod cc_hooks;
pub(crate) mod code_mode;
// Claude Code import: Tauri commands on the desktop, plain async fns that the
// `import-claude` command calls in the `cli` build.
pub mod cc_import;
pub mod cc_links;
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
// Settings plumbing for the desktop commands; the CLI build uses only part of it.
#[cfg_attr(feature = "cli", allow(dead_code))]
pub mod desktop_bridge;
pub mod destructive;
pub mod diagnostics;
pub mod durable_subagent;
pub mod end_reason;
pub mod final_checks;
pub mod events;
pub mod extensions;
pub mod failure_stats;
pub mod fixtures;
pub mod genai_bridge;
pub mod git;
#[cfg(feature = "cli")]
pub mod global_config;
#[cfg(not(feature = "cli"))]
pub mod github_pr;
pub mod github_recovery;
// `/goal` is a terminal-UI command; the desktop build compiles the module
// but calls none of it.
#[cfg_attr(not(feature = "cli"), allow(dead_code))]
pub mod goal;
pub mod health;
pub mod impact;
pub mod index;
pub mod learned_window;
pub mod ledger;
pub mod lease;
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
pub(crate) mod screening;
pub mod lsp;
pub mod mcp_catalog;
pub(crate) mod tool_name_cap;
#[cfg(not(feature = "cli"))]
pub mod memory_consolidation;
pub mod notify;
pub mod plan;
pub mod plugin_commands;
pub mod plugins;
pub mod project;
pub(crate) mod projects_registry;
pub(crate) mod prompt;
pub(crate) mod fast_path;
pub(crate) mod prompt_trim;
pub(crate) mod ram_guard;
pub mod proposals;
pub mod provenance;
pub mod pull_request;
pub mod quota;
pub mod reminder;
pub mod replay;
pub(crate) mod repo_map;
pub mod review;
pub mod roles;
pub mod routing;
pub mod tool_profile;
pub mod semantic;
pub mod secrets;
pub mod session;
pub mod session_bundle;
pub mod skill_hub;
pub mod skills;
// The slash-command catalog serves the desktop popup only.
#[cfg(not(feature = "cli"))]
pub mod slash;
pub mod advisor;
pub mod attribution;
pub mod monitor;
pub mod schedule_tool;
pub mod spend;
pub mod state_schema;
pub mod subagent;
pub mod team_children;
pub mod test_triage;
pub mod todo;
pub mod tool_rules;
pub mod tooling;
pub mod turn_limit;
#[cfg(not(feature = "cli"))]
pub mod trust_commands;
pub mod transcript;
pub mod upstream;
pub mod vcs;
pub mod verification;
pub mod session_copy;
pub mod worktree;
pub mod worktree_export;
pub(crate) mod partial_dirs;
