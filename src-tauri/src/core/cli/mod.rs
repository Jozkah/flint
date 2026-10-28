//! CLI adapter layer — thin wrappers that call core logic without an AppHandle.
//!
//! This module is only compiled when the `cli` feature is enabled.

mod agent_status;
pub mod auth;
pub mod approvals_cmd;
pub mod brand;
pub mod color;
pub(crate) mod display_safe;
pub mod browser;
#[cfg(test)]
mod contract_conformance;
pub mod device_auth;
pub mod doctor;
pub mod file_log;
pub mod inflight;
pub mod journal;
pub mod json_api;
pub mod bench;
pub mod login;
pub mod cc_import_cmd;
pub mod hf_cmd;
pub mod mcp;
pub mod memory_cmd;
pub mod migrate_cmd;
/// `jan mcp serve`: the other direction, Jan's toolset served over MCP.
pub mod mcp_serve;
pub(crate) mod model_capabilities;
mod path_refs;
pub(crate) mod pathnorm;
/// `jan cli agent schema`: the protocol's JSON Schema, generated from the types.
pub mod protocol_schema;
/// `jan cli agent rpc`: persistent, session-scoped JSON-RPC transport.
pub mod rpc;
/// `flint cli acp`: Agent Client Protocol server on stdin/stdout.
pub mod acp;
/// `jan cli agent rpc-schema`: the RPC request and event schemas.
pub mod rpc_schema;
/// The turn steps the stdio RPC loop and the HTTP session runner share.
pub(crate) mod turn_host;
pub mod providers;
pub mod run_report;
pub mod archive_cmd;
pub mod run_data_cmd;
pub mod automation_cmd;
pub mod launch_cmd;
pub mod schedule;
pub mod skills_cmd;
pub mod system_cmd;
pub mod thread_export;
pub mod schedule_manage;
pub mod secrets;
mod secret_input;
pub mod stream_input;
pub mod terminal_setup;
pub mod tokamak;
mod tui;
/// Renders reported usage from the Tokamak usage API (upstream #9034).
pub mod usage_view;
pub mod version;
/// The user-message wire shape, shared by the TUI and the headless channel.
mod user_message;
pub mod worktree;
pub mod worktree_cmd;

use std::path::PathBuf;
use std::sync::Arc;

use crate::core::app::commands::resolve_jan_data_folder;
use crate::core::threads::{
    constants::THREADS_FILE,
    helpers::{read_messages_from_file, update_thread_metadata, write_messages_to_file},
    utils::{
        ensure_data_dirs, get_data_dir, get_messages_path, get_thread_dir, get_thread_metadata_path,
    },
};

mod threads;
pub use threads::*;

mod output;
pub use output::*;

mod input;
use input::*;

mod run;
pub use run::*;

mod session;
pub use session::*;

mod agent_cmds;
pub use agent_cmds::*;

// ── Agent operations ───────────────────────────────────────────────────────

use crate::core::agent::events::StreamEvent;
use crate::core::agent::project::{
    ensure_project, load_agent_config, load_agent_config_with_profile, permissions_from,
    set_model_in_agent_toml,
};
use crate::core::agent::r#loop::{
    run_orchestration_steered, run_orchestration_streamed, OrchestrationArgs, PermissionRegistry,
    SteeringRequest,
};
use crate::core::cli::providers::{load_provider_configs, ProviderOverrides};
use crate::core::cli::run_report::{
    ndjson_line, Init, InputContentParts, OutputFormat, PermissionDecisionRecord, RunReport,
};
use crate::core::cli::stream_input::{
    parse_input_line, InputErrorRecord, InputFormat, InputMessage, StreamInput, INPUT_KINDS,
    MAX_ECHO_BYTES, MAX_LINE_BYTES,
};
use crate::core::mcp::models::McpSettings;
use std::collections::HashMap;
use std::io::Write as _;
use tauri_plugin_agent_tools::tools::gate::PermissionDecision;
use tauri_plugin_agent_tools::workspace;
use tokio::sync::{mpsc, Mutex};

#[cfg(test)]
mod tests;
