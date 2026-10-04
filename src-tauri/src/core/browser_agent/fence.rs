//! Fencing of page-derived text before it reaches the model. The implementation
//! lives in the agent-tools crate, where the interactive `browser` tool needs
//! it too; this keeps the pane tools' existing path.

pub use tauri_plugin_agent_tools::browser::fence::*;
