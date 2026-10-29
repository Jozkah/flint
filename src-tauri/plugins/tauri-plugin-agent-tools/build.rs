// The commands the plugin exposes, and the source the permission generator and
// the `permission_tests` in `lib.rs` both read. Those tests parse this array as
// text, so entries stay one plain string literal per line: a comment inside the
// brackets is picked up as a command name and fails the check.
//
// `memory_*` covers the flat `<name>.md` notes; `memory_record*` covers the
// canonical records behind Settings > Memory. Two stores answering different
// questions, deliberately not sharing an entry point.
const COMMANDS: &[&str] = &[
    "workspace_path",
    "thread_workspace_path",
    "thread_workspace_delete",
    "thread_workspace_sweep",
    "session_workspace_path",
    "session_workspace_delete",
    "session_workspace_sweep",
    "direct_edit_capability",
    "managed_worktree_capability",
    "direct_edit_authorize",
    "direct_edit_revoke",
    "direct_edit_revoke_session",
    "access_prepare",
    "access_grant",
    "access_record_decision",
    "access_revoke",
    "access_revoke_session",
    "access_list",
    "secrets_redact",
    "skill_list",
    "skill_read",
    "skill_write",
    "skill_delete",
    "memory_list",
    "memory_read",
    "memory_write",
    "memory_delete",
    "memory_records_list",
    "memory_record_get",
    "memory_record_edit",
    "memory_record_propose",
    "memory_record_propose_inferred",
    "memory_proposals_list",
    "memory_proposal_resolve",
    "memory_record_commit",
    "memory_record_forget",
    "memory_record_restore",
    "memory_record_pin",
    "memory_record_set_expiration",
    "memory_record_move_scope",
    "memory_storage_summary",
    "memory_settings_get",
    "memory_settings_update",
    "memory_retrieve",
    "memory_conflicts",
    "memory_scope_clear",
    "memory_export",
    "memory_import",
    "memory_record_uses",
    "tool_schemas",
    "sandbox_status",
    "sandbox_toolchains",
    "sandbox_toolchain_grants",
    "sandbox_toolchain_grant",
    "sandbox_toolchain_revoke",
    "environment_readiness",
    "environment_readiness_retry",
    "advertised_tool_schemas",
    "execute_tool",
    "execute_tool_streaming",
    "execute_tool_unsandboxed_retry",
    "execute_tool_unsandboxed_withdraw",
    "approval_mint",
    "tool_resources_finish_run",
    "fire_post_tool_batch",
    "undo_journal",
    "undo_turn",
    "redo_turn",
    "preview_change",
    "check_write_secrets",
    "project_list_dir",
    "project_read_file",
    "project_survey",
    "project_init_accept",
    "bash_jobs_list",
    "bash_job_kill",
    "permission_audit_recent",
    "mailbox_session_register",
    "mailbox_session_status",
    "mailbox_session_heartbeat",
    "mailbox_session_waiting",
    "mailbox_session_remove",
    "mailbox_session_revive",
    "mailbox_session_archive",
    "mailbox_take_for_delivery",
    "mailbox_pending",
    "mailbox_mark_read",
    "mailbox_claim",
    "mailbox_reply",
    "mailbox_auto_reply",
    "mailbox_list_sessions",
    "mailbox_held",
    "mailbox_held_approve",
    "mailbox_held_deny",
    "mailbox_stop_approve",
    "mailbox_stop_pending",
    "mailbox_stop_resolve",
    "shared_folder_peers",
    "shared_folder_overview",
    "shared_folder_recent_edits",
    "shared_folder_allow",
    "shared_folder_default_isolation",
];

fn main() {
    #[cfg(feature = "tauri")]
    tauri_plugin::Builder::new(COMMANDS).build();

    #[cfg(not(feature = "tauri"))]
    let _ = COMMANDS;

    // Resolve the sandbox helper's DLL imports from System32 only, never the
    // current directory or PATH. It starts inside the workspace a tool call
    // runs in, so a DLL planted there must not load. All its imports are
    // System32 or API-set DLLs.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        println!("cargo:rustc-link-arg-bin=jan-sandbox-helper=/DEPENDENTLOADFLAG:0x800");
    }
}
