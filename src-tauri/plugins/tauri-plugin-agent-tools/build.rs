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
    "tool_schemas",
    "sandbox_status",
    "environment_readiness",
    "environment_readiness_retry",
    "advertised_tool_schemas",
    "execute_tool",
    "execute_tool_streaming",
    "undo_journal",
    "undo_turn",
    "redo_turn",
    "preview_change",
    "project_list_dir",
    "project_read_file",
    "project_survey",
    "project_init_accept",
    "bash_jobs_list",
    "bash_job_kill",
];

fn main() {
    #[cfg(feature = "tauri")]
    tauri_plugin::Builder::new(COMMANDS).build();

    #[cfg(not(feature = "tauri"))]
    let _ = COMMANDS;
}
