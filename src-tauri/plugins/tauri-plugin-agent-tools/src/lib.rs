//! The built-in agent toolset, shared by the Jan desktop app and the headless
//! `jan` CLI.
//!
//! The toolset is Tauri-free: executing a tool needs nothing but
//! `(&BuiltinTool, &serde_json::Value, &ToolContext)`, never an `AppHandle`.
//! `tauri` is an optional dependency behind the `tauri` feature, so the CLI
//! builds this crate with `default-features = false` and links no GUI crates.
//! Everything under `permissions`, `skills`, `tools` and `workspace` is
//! available in both configurations; only `init()` and the IPC shims in
//! `commands` are gated.

pub mod access;
pub mod atomic_file;
pub mod breadcrumb;
pub mod browser;
pub mod browser_discovery;
pub mod activity;
pub mod audit;
pub mod compat_env;
pub mod format;
pub mod event_export;
pub mod event_log;
pub mod resources;
pub mod run_replay;
/// How a harness failure is classified: kind, retryability, audience (AH-009).
pub mod compaction_policy;
pub mod context_report;
pub mod harness_error;
pub mod hooks;
pub mod mailbox;
pub mod org_policy;
pub mod identity;
pub mod job_record;
/// The security identity (fingerprint) of an MCP server definition.
pub mod mcp_identity;
/// Which MCP servers the user has agreed to run tools from (AH-041).
pub mod mcp_trust;
/// A proposed change held as reviewable hunks (AH-146/147/148).
pub mod patch;
pub mod patch_export;
pub mod lifecycle;
/// Cross-session agent messaging (docs/SESSION_MESSAGING.md).
pub mod session_mailbox;
pub mod memory;
pub mod permissions;
pub mod policy;
pub mod policy_transfer;
pub mod run_tree;
pub mod sandbox_apply;
pub mod project_browse;
pub mod project_init;
pub mod proposal;
pub mod readiness;
pub mod resource;
pub mod retention;
pub mod review_flags;
pub mod secrets;
pub mod skills;
pub mod snapshot;
pub mod subject;
pub mod tools;
pub mod undo;
pub mod unsandboxed_retry;
pub mod usage;
pub mod utility;
pub mod worker;
pub mod workspace;

#[cfg(feature = "tauri")]
mod commands;
/// Session-scoped write grants. The grant machinery is gated internally to
/// `feature = "tauri"` (or tests), so a CLI build compiles only the pure
/// `child_session_id`/`CHILD_SEP` helpers it re-exports and carries none of the
/// grant surface as dead code. The module itself must stay unconditional
/// because `child_session_id` is re-exported (and used by the CLI subagent /
/// team-children paths).
mod grants;

/// Runs the confined-spawn helper and exits, when this process was re-exec'd as
/// one by the Windows sandbox backend. A no-op on every other platform and on a
/// normal launch, but it must be called before anything else in `main`: the
/// helper's whole job is to spawn and wait, so starting the app first would run a
/// second copy of it per shell command.
pub use tools::appcontainer::run_helper_if_requested as run_sandbox_helper_if_requested;

/// Make the *test* binary a valid confined-spawn helper.
///
/// The Windows AppContainer backend confines a command by re-exec'ing the
/// running binary with `--internal-sandbox-exec` (see [`tools::appcontainer`]),
/// which the application's `main` intercepts before anything else. A libtest
/// harness has no such `main`: it parses argv itself, rejects the unknown flag
/// with "Unrecognized option", and every sandboxed `bash`/`proc` test fails at
/// exit 101 instead of exercising the sandbox.
///
/// Registering the helper as a CRT static initializer runs it during process
/// startup, before libtest sees argv — so a re-exec'd test binary performs the
/// confined spawn and exits, while a normal test run finds no flag and returns
/// immediately. Test-only and Windows-only; nothing about the shipping binary
/// changes.
#[cfg(all(test, windows))]
#[used]
#[link_section = ".CRT$XCU"]
static RUN_SANDBOX_HELPER_ON_STARTUP: extern "C" fn() = {
    extern "C" fn init() {
        tools::appcontainer::run_helper_if_requested();
    }
    init
};

#[cfg(feature = "tauri")]
pub use commands::{AgentToolsError, ToolResult};
/// The owner id a team's isolated child holds its grant and worktree under.
pub use grants::child_session_id;

/// Initializes the agent tools plugin.
#[cfg(feature = "tauri")]
pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("agent-tools")
        .invoke_handler(tauri::generate_handler![
            commands::workspace_path,
            commands::thread_workspace_path,
            commands::thread_workspace_delete,
            commands::thread_workspace_sweep,
            commands::session_workspace_path,
            commands::session_workspace_delete,
            commands::session_workspace_sweep,
            commands::direct_edit_capability,
            commands::managed_worktree_capability,
            commands::direct_edit_authorize,
            commands::direct_edit_revoke,
            commands::direct_edit_revoke_session,
            commands::access_prepare,
            commands::access_grant,
            commands::access_record_decision,
            commands::access_revoke,
            commands::access_revoke_session,
            commands::access_list,
            commands::secrets_redact,
            commands::skill_list,
            commands::skill_read,
            commands::skill_write,
            commands::skill_delete,
            memory::commands::memory_records_list,
            memory::commands::memory_record_get,
            memory::commands::memory_record_edit,
            memory::commands::memory_record_propose,
            memory::commands::memory_record_propose_inferred,
            memory::commands::memory_proposals_list,
            memory::commands::memory_proposal_resolve,
            memory::commands::memory_record_commit,
            memory::commands::memory_record_forget,
            memory::commands::memory_record_restore,
            memory::commands::memory_record_pin,
            memory::commands::memory_record_set_expiration,
            memory::commands::memory_record_move_scope,
            memory::commands::memory_storage_summary,
            memory::commands::memory_settings_get,
            memory::commands::memory_settings_update,
            memory::commands::memory_retrieve,
            memory::commands::memory_conflicts,
            memory::commands::memory_scope_clear,
            memory::commands::memory_export,
            memory::commands::memory_import,
            memory::commands::memory_record_uses,
            commands::memory_list,
            commands::memory_read,
            commands::memory_write,
            commands::memory_delete,
            commands::tool_schemas,
            commands::sandbox_status,
            commands::sandbox_toolchains,
            commands::sandbox_toolchain_grants,
            commands::sandbox_toolchain_grant,
            commands::sandbox_toolchain_revoke,
            commands::environment_readiness,
            commands::environment_readiness_retry,
            commands::advertised_tool_schemas,
            commands::execute_tool,
            commands::execute_tool_streaming,
            commands::execute_tool_unsandboxed_retry,
            commands::execute_tool_unsandboxed_withdraw,
            commands::tool_resources_finish_run,
            commands::fire_post_tool_batch,
            commands::undo_journal,
            commands::undo_turn,
            commands::redo_turn,
            commands::preview_change,
            commands::project_list_dir,
            commands::project_read_file,
            commands::project_survey,
            commands::project_init_accept,
            commands::bash_jobs_list,
            commands::bash_job_kill,
            commands::permission_audit_recent,
            commands::mailbox_session_register,
            commands::mailbox_session_status,
            commands::mailbox_session_heartbeat,
            commands::mailbox_session_waiting,
            commands::mailbox_session_remove,
            commands::mailbox_session_revive,
            commands::mailbox_take_for_delivery,
            commands::mailbox_pending,
            commands::mailbox_mark_read,
            commands::mailbox_claim,
            commands::mailbox_reply,
            commands::mailbox_auto_reply,
            commands::mailbox_list_sessions,
            commands::mailbox_stop_approve,
            commands::mailbox_stop_pending,
            commands::mailbox_stop_resolve
        ])
        .setup(|app, _api| {
            // Folder grants live in process memory, so none survives a
            // restart; withdraw any sandbox ACE a previous run left on a
            // user's folder (a crash, a quit mid-run) before anything runs.
            // Off the setup thread (it touches ACLs, which can be slow), with
            // every sandboxed spawn held until it is done.
            tools::appcontainer::start_startup_sweep();
            // Every mailbox append -- from a command or from a tool handler,
            // which has no AppHandle -- is announced through this one hook.
            use tauri::Emitter;
            let handle = app.clone();
            session_mailbox::set_emitter(move |session_id, message_id| {
                let _ = handle.emit(
                    "agent-mailbox-updated",
                    serde_json::json!({ "sessionId": session_id, "messageId": message_id }),
                );
            });
            // A recorded stop request, announced to the target's renderer. The
            // payload carries only ids: the renderer re-reads the request.
            let stop_handle = app.clone();
            session_mailbox::set_stop_emitter(move |session_id, request_id| {
                let _ = stop_handle.emit(
                    session_mailbox::STOP_REQUESTED_EVENT,
                    serde_json::json!({ "sessionId": session_id, "requestId": request_id }),
                );
            });
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod permission_tests {
    /// A command reaches the frontend only if it is BOTH in `generate_handler!`
    /// and in `build.rs`'s `COMMANDS` (which generates its permission). Missing
    /// the latter compiles and tests clean, then fails at runtime with
    /// "not allowed. Command not found" -- invisible to any suite that mocks
    /// `invoke`. Keep the two lists in lockstep.
    fn names_between<'a>(src: &'a str, start: &str, end: &str) -> Vec<&'a str> {
        let Some(rest) = src.split_once(start).map(|(_, r)| r) else {
            return Vec::new();
        };
        let Some(block) = rest.split_once(end).map(|(b, _)| b) else {
            return Vec::new();
        };
        block
            .split(',')
            .map(|s| s.trim().trim_matches('"'))
            .filter(|s| !s.is_empty())
            .map(|s| s.rsplit("::").next().unwrap_or(s))
            .collect()
    }

    #[test]
    fn every_registered_command_has_a_permission() {
        let handlers = names_between(include_str!("lib.rs"), "tauri::generate_handler![", "])");
        let declared = names_between(include_str!("../build.rs"), "COMMANDS: &[&str] = &[", "];");
        assert!(!handlers.is_empty(), "failed to parse generate_handler!");
        assert!(!declared.is_empty(), "failed to parse build.rs COMMANDS");
        let missing: Vec<_> = handlers.iter().filter(|c| !declared.contains(c)).collect();
        assert!(
            missing.is_empty(),
            "commands registered but absent from build.rs COMMANDS: {missing:?}"
        );
    }

    #[test]
    fn every_permission_is_in_the_default_set() {
        let declared = names_between(include_str!("../build.rs"), "COMMANDS: &[&str] = &[", "];");
        let default_toml = include_str!("../permissions/default.toml");
        let missing: Vec<_> = declared
            .iter()
            .filter(|c| {
                let permission = format!("allow-{}", c.replace('_', "-"));
                !default_toml.contains(&permission)
            })
            .collect();
        assert!(
            missing.is_empty(),
            "commands missing an allow-* entry in permissions/default.toml: {missing:?}"
        );
    }
}
