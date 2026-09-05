const COMMANDS: &[&str] = &[
    "workspace_path",
    "thread_workspace_path",
    "thread_workspace_delete",
    "thread_workspace_sweep",
    "session_workspace_path",
    "session_workspace_delete",
    "session_workspace_sweep",
    "direct_edit_capability",
    "direct_edit_authorize",
    "direct_edit_revoke",
    "direct_edit_revoke_session",
    "skill_list",
    "skill_read",
    "skill_write",
    "skill_delete",
    "memory_list",
    "memory_read",
    "memory_write",
    "memory_delete",
    "tool_schemas",
    "sandbox_status",
    "execute_tool",
    "execute_tool_streaming",
    "project_list_dir",
    "project_read_file",
    "bash_jobs_list",
    "bash_job_kill",
];

fn main() {
    #[cfg(feature = "tauri")]
    tauri_plugin::Builder::new(COMMANDS).build();

    #[cfg(not(feature = "tauri"))]
    let _ = COMMANDS;
}
