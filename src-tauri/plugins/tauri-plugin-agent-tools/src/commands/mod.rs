//! Desktop IPC shims over the Tauri-free core.
//!
//! Three surfaces:
//!
//! 1. **Management** -- skill and memory CRUD against the permanent store.
//! 2. **Sandbox lifecycle** -- `thread_workspace_{path,delete,sweep}`. Each
//!    thread gets its own ephemeral sandbox, so scratch files from one
//!    conversation are invisible to the next; the store is never swept.
//! 3. **Tool execution** -- `tool_schemas` + `execute_tool`, for the desktop
//!    chat loop. The desktop drives its tool loop in TypeScript
//!    (`custom-chat-transport.ts`), so unlike the CLI agent -- which calls
//!    `tools::handlers` in process -- it has to reach execution over IPC.
//!
//! `execute_tool` treats the gate as the authority rather than the caller, but it
//! answers two of the gate's prompts structurally instead of by asking, because on
//! this surface what the prompt protects is already guaranteed:
//!
//! - **Writes** land in the thread's ephemeral sandbox (`root` is always
//!   `ensure_thread_workspace`): confined by `escapes_project`, deleted with the
//!   conversation, and only a *sibling* of the permanent store. No durable user
//!   data is in range.
//! - **`bash`** runs only when `jail` reports an enforcing OS sandbox, which gives
//!   the same containment. With no sandbox it is refused outright rather than run
//!   unconfined.
//!
//! Everything else still refuses -- notably a read that escapes the sandbox. The
//! gate itself is deliberately left untouched, because the CLI agent shares it and
//! *does* want to prompt: there, the root is the user's real project.
//!
//! Note some command names match built-in tool names (`skill_list`,
//! `memory_list`). The commands are the *management* surface; the tools are what
//! the model calls. They are separate namespaces.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::memory;
use crate::readiness;
use crate::skills::{self, SkillMeta};
use crate::tools::gate::{self, Decision, PromptKind, SessionGrants};
use crate::tools::jail;
use crate::tools::{handlers, lookup, schema, ToolContext};
use crate::workspace;

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("AgentToolsError: {message}")]
pub struct AgentToolsError {
    pub message: String,
}

impl From<String> for AgentToolsError {
    /// Strips the core's `ERROR:` tool-protocol prefix; it is meaningful to the
    /// model, but noise in a dialog.
    fn from(message: String) -> Self {
        let message = message
            .strip_prefix("ERROR:")
            .unwrap_or(&message)
            .trim()
            .to_string();
        Self { message }
    }
}

/// Outcome of a built-in tool execution.
///
/// `error` is the failure's classification (AH-009) when there was one: the
/// kind, the stage, whether another attempt could help and who it is for. The
/// surfaces read that rather than the words, so Chat, Cowork, the Timeline and
/// the CLI cannot disagree about whether a call was refused, timed out or
/// failed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub content: String,
    /// Display-only diff for `write`/`edit`; never part of model context.
    pub diff: Option<String>,
    pub is_error: bool,
    /// The classified failure, when this is one. Versioned and scrubbed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<serde_json::Value>,
    /// What the command this call ran used, or why that was not measured
    /// (AH-174). Present only for a call that ran a command under a run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resources: Option<crate::resources::Resources>,
    /// Set when this `bash` call failed only because the machine's null device
    /// refuses sandboxed processes: an opaque id the renderer can redeem with
    /// `execute_tool_unsandboxed_retry`, once the user approves, to run the
    /// same call outside the sandbox. Never part of model context.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unsandboxed_retry: Option<String>,
    /// Images a tool returned for the model to see (a `read` of a png/jpg/
    /// gif/webp file). The renderer's tool loop turns these into image parts
    /// of the tool-result message when the model has vision.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<crate::tools::ImageContentPart>,
}

/// How the renderer came to allow a call before sending it here: the user
/// answered a prompt, or a mode or standing grant allowed it without asking.
/// Recorded in the audit so an allowed call no longer reads as an open prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalSource {
    Prompted,
    Auto,
    Bypass,
    /// The person answered "Write anyway" on the secret-write card for this
    /// exact call. It lifts the credential scan for that one write and nothing
    /// else: no grant, no rule.
    Secret,
}

/// One tool call as the execute commands receive it: everything
/// `execute_tool_inner` needs besides the output sink, the sandbox choice and
/// the verified approval. An unsandboxed-retry offer keeps one, so the command
/// run again is the one that failed, not one the renderer names at redemption
/// time. The Tauri commands keep their flat arguments (the renderer sends them
/// by name) and build this.
#[derive(Clone)]
struct ToolCallRequest {
    data_folder: String,
    thread_id: String,
    project: Option<String>,
    name: String,
    args: serde_json::Value,
    enabled_skills: Option<Vec<String>>,
    allow_network: Option<bool>,
    read_only_project: Option<String>,
    write_grant: Option<String>,
    scope: Option<WorkspaceScope>,
    call_id: Option<String>,
    undo_run: Option<String>,
    actor: Option<ActorInput>,
    extra_projects: Option<Vec<String>>,
}

/// The refusal for a call that reaches the hidden agent state directory. It is
/// returned to the model as this call's error, not a stop: it says why and how
/// to carry on, because "denied" alone sent models retrying the same command.
pub(crate) fn hidden_state_msg(name: &str) -> String {
    let dir = crate::tools::sandbox::JAN_DIR;
    format!(
        "tool '{name}' is denied: {dir} is the agent's own state directory and is hidden.          This call was not run; the run continues. Leave {dir} out of the command (it does          not exist for you) and carry on with the rest of the task."
    )
}

impl ToolCallRequest {
    /// The request an unsandboxed-retry offer keeps for this call: only a
    /// sandboxed `bash` call can end in the failure that offer is for.
    fn retry_copy(&self, unsandboxed: bool) -> Option<ToolCallRequest> {
        (!unsandboxed && self.name == "bash").then(|| self.clone())
    }
}

fn retry_offers() -> &'static crate::unsandboxed_retry::Offers<ToolCallRequest> {
    static OFFERS: std::sync::OnceLock<crate::unsandboxed_retry::Offers<ToolCallRequest>> =
        std::sync::OnceLock::new();
    OFFERS.get_or_init(Default::default)
}

/// The permanent store root holding `memory/` and `skills/`.
///
/// `project` is an explicit override and is currently always `None`: the desktop
/// has no project picker yet. Once one lands, a project's own co-located store
/// (`<project>/.jan/agent`) layers on top of this one; see the memory-scope TODO.
fn resolve_store(data_folder: &str, project: Option<&str>) -> PathBuf {
    match project.map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => workspace::project_store(Path::new(p)),
        None => workspace::permanent_store(Path::new(data_folder)),
    }
}

/// Ensure the permanent store exists and return its path, so the UI can show
/// where memories and skills live.
#[tauri::command]
pub async fn workspace_path(data_folder: String) -> Result<String, AgentToolsError> {
    let root = workspace::ensure_permanent_store(Path::new(&data_folder)).await?;
    Ok(root.to_string_lossy().to_string())
}

/// Create a thread's ephemeral sandbox and return its path, so the UI can offer
/// to open it and the user can copy files in for the agent to work on.
#[tauri::command]
pub async fn thread_workspace_path(
    data_folder: String,
    thread_id: String,
) -> Result<String, AgentToolsError> {
    let dir = workspace::ensure_thread_workspace(Path::new(&data_folder), &thread_id).await?;
    Ok(dir.to_string_lossy().to_string())
}

/// Delete a thread's sandbox. Called when a thread is deleted; memory and skills
/// are untouched.
#[tauri::command]
pub async fn thread_workspace_delete(
    data_folder: String,
    thread_id: String,
) -> Result<(), AgentToolsError> {
    workspace::remove_thread_workspace(Path::new(&data_folder), &thread_id)
        .await
        .map_err(Into::into)
}

/// Delete every sandbox not belonging to a surviving thread, returning how many
/// were removed. Called once at startup: sandboxes are ephemeral, but a crash or
/// a thread deleted while the app was closed would otherwise leave one behind.
///
/// Abandoned host-temp scratch directories are collected in the same pass. They
/// need their own sweep because they are keyed to ids the caller holds (a run,
/// a thread, a CLI session), so unlike a thread sandbox there is no `keep` list
/// to compare against -- see [`workspace::sweep_stale_scratch_dirs`]. Their
/// count is not added to the return value, which names thread sandboxes.
#[tauri::command]
pub async fn thread_workspace_sweep(
    data_folder: String,
    keep: Vec<String>,
) -> Result<usize, AgentToolsError> {
    workspace::sweep_stale_scratch_dirs().await;
    workspace::sweep_thread_workspaces(Path::new(&data_folder), &keep)
        .await
        .map_err(Into::into)
}

/// The Cowork session sandbox, created if absent.
#[cfg_attr(feature = "tauri", tauri::command)]
pub async fn session_workspace_path(
    data_folder: String,
    session_id: String,
) -> Result<String, AgentToolsError> {
    let dir = workspace::ensure_session_workspace(Path::new(&data_folder), &session_id).await?;
    Ok(dir.to_string_lossy().to_string())
}

/// Can this platform confine both file tools and the shell to a project folder?
///
/// The UI asks before offering to edit a folder directly, so an option that
/// could not be enforced is never shown rather than failing after the user
/// confirms it.
#[cfg_attr(feature = "tauri", tauri::command)]
pub fn direct_edit_capability() -> bool {
    crate::grants::capability()
}

/// Can this platform confine a run to a worktree Jan owns?
///
/// Separate from [`direct_edit_capability`] because the answers differ on
/// Windows: AppContainer can hold a run to a Jan-managed worktree but will not
/// write an ACE onto the user's own folder.
#[cfg_attr(feature = "tauri", tauri::command)]
pub fn managed_worktree_capability() -> bool {
    crate::grants::worktree_capability()
}

/// Authorize this session to edit `folder`, returning an opaque grant id.
///
/// The id is what later runs carry. A path is never accepted at tool time, so
/// nothing a model emits can widen or redirect what a run may write.
#[cfg_attr(feature = "tauri", tauri::command)]
pub async fn direct_edit_authorize(
    data_folder: String,
    session_id: String,
    folder: String,
    // The session's additional attached folders, covered by the same grant.
    extra_folders: Option<Vec<String>>,
    // False grants the extra folders alone and leaves `folder` read-only.
    // Absent keeps the old behaviour: `folder` is writable.
    main_writable: Option<bool>,
) -> Result<String, AgentToolsError> {
    // The session's own workspace, which the folder must not overlap.
    let workspace =
        workspace::ensure_session_workspace(Path::new(&data_folder), &session_id).await?;
    Ok(crate::grants::authorize_roots(
        &session_id,
        &folder,
        &extra_folders.unwrap_or_default(),
        main_writable.unwrap_or(true),
        &workspace,
        Path::new(&data_folder),
    )?)
}

/// Withdraw one grant. Succeeds whether or not it was still live.
#[cfg_attr(feature = "tauri", tauri::command)]
pub async fn direct_edit_revoke(grant_id: String) -> bool {
    // Withdrawing a grant rewrites folder ACLs, which can take seconds on a
    // big tree and waits on the sandbox helper's lock. A synchronous command
    // runs on the main thread, where that froze every other IPC call.
    tokio::task::spawn_blocking(move || crate::grants::revoke(&grant_id))
        .await
        .unwrap_or(false)
}

/// Withdraw every grant a session holds — detaching, switching, deleting.
#[cfg_attr(feature = "tauri", tauri::command)]
pub async fn direct_edit_revoke_session(session_id: String) -> usize {
    // Off the main thread for the same reason as `direct_edit_revoke`.
    tokio::task::spawn_blocking(move || crate::grants::revoke_session(&session_id))
        .await
        .unwrap_or(0)
}

/// A `request_access` request resolved to the exact scope a grant would cover,
/// or the structured reason it cannot be offered.
#[derive(Debug, Serialize)]
#[serde(tag = "status")]
pub enum AccessPrepareResult {
    /// Show the prompt for this.
    #[serde(rename = "ok")]
    Ok {
        #[serde(flatten)]
        prepared: crate::access::Prepared,
    },
    /// Do not prompt. `modelResult` is what the tool call returns.
    #[serde(rename = "refused")]
    Refused {
        code: String,
        message: String,
        #[serde(rename = "modelResult")]
        model_result: String,
    },
}

async fn access_env(
    data_folder: &str,
    session_id: &str,
    scope: Option<WorkspaceScope>,
) -> Result<crate::access::Env, AgentToolsError> {
    let root = scope
        .unwrap_or_default()
        .ensure(Path::new(data_folder), session_id)
        .await?;
    Ok(crate::access::Env::host(Some(Path::new(data_folder)), Some(&root)))
}

/// Canonicalize and vet what a model asked `request_access` for, before the
/// user is asked. The prompt shows `display`, which is what a grant enforces.
#[cfg_attr(feature = "tauri", tauri::command)]
pub async fn access_prepare(
    data_folder: String,
    session_id: String,
    path: String,
    access_mode: Option<String>,
    reason: Option<String>,
    scope: Option<WorkspaceScope>,
    audit: Option<crate::access::AuditIds>,
) -> Result<AccessPrepareResult, AgentToolsError> {
    let env = access_env(&data_folder, &session_id, scope).await?;
    let data = Path::new(&data_folder);
    let ids = audit.unwrap_or_default();
    let prepared = crate::access::AccessMode::parse(access_mode.as_deref())
        .and_then(|mode| crate::access::prepare(&path, mode, &env));
    Ok(match prepared {
        Ok(prepared) => {
            crate::access::audit_event_as(
                data,
                &session_id,
                "requested",
                &prepared.display,
                prepared.mode,
                reason.as_deref().unwrap_or(""),
                &ids,
            );
            AccessPrepareResult::Ok { prepared }
        }
        Err(refusal) => {
            crate::access::audit_event_as(
                data,
                &session_id,
                "refused",
                &path,
                crate::access::AccessMode::Read,
                refusal.code.as_str(),
                &ids,
            );
            AccessPrepareResult::Refused {
                code: refusal.code.as_str().to_string(),
                message: refusal.message.clone(),
                model_result: crate::access::refusal_result(&refusal),
            }
        }
    })
}

/// Issue a grant the user approved. The path is vetted again here, so a
/// grant can only cover what the prompt showed.
#[allow(clippy::too_many_arguments)]
#[cfg_attr(feature = "tauri", tauri::command)]
pub async fn access_grant(
    data_folder: String,
    session_id: String,
    path: String,
    access_mode: Option<String>,
    reason: Option<String>,
    persistent: Option<bool>,
    ttl_secs: Option<u64>,
    scope: Option<WorkspaceScope>,
    audit: Option<crate::access::AuditIds>,
) -> Result<crate::access::AccessGrant, AgentToolsError> {
    let env = access_env(&data_folder, &session_id, scope).await?;
    let mode = crate::access::AccessMode::parse(access_mode.as_deref())
        .map_err(|r| AgentToolsError::from(r.message))?;
    crate::access::grant_as(
        Path::new(&data_folder),
        &env,
        &session_id,
        &path,
        mode,
        reason.as_deref().unwrap_or(""),
        persistent.unwrap_or(false),
        ttl_secs,
        &audit.unwrap_or_default(),
    )
    .map_err(|r| AgentToolsError::from(r.message))
}

/// Record that the user declined, or that the prompt was withdrawn.
#[cfg_attr(feature = "tauri", tauri::command)]
pub fn access_record_decision(
    data_folder: String,
    session_id: String,
    path: String,
    access_mode: Option<String>,
    decision: String,
    audit: Option<crate::access::AuditIds>,
) {
    let mode = crate::access::AccessMode::parse(access_mode.as_deref())
        .unwrap_or(crate::access::AccessMode::Read);
    let event = if decision == "cancelled" { "cancelled" } else { "denied" };
    crate::access::audit_event_as(
        Path::new(&data_folder),
        &session_id,
        event,
        &path,
        mode,
        "by user",
        &audit.unwrap_or_default(),
    );
}

/// Withdraw one access grant, session or kept.
#[cfg_attr(feature = "tauri", tauri::command)]
pub fn access_revoke(data_folder: String, grant_id: String) -> bool {
    crate::access::revoke(Path::new(&data_folder), &grant_id)
}

/// Withdraw every session access grant a session holds.
#[cfg_attr(feature = "tauri", tauri::command)]
pub fn access_revoke_session(data_folder: String, session_id: String) -> usize {
    crate::access::revoke_session(Path::new(&data_folder), &session_id)
}

/// Grants in force: for one session, or every grant when `session_id` is absent.
#[cfg_attr(feature = "tauri", tauri::command)]
pub fn access_list(
    data_folder: String,
    session_id: Option<String>,
) -> Vec<crate::access::AccessGrant> {
    let now = crate::access::now_secs();
    match session_id {
        Some(s) => crate::access::list(Path::new(&data_folder), &s, now),
        None => crate::access::list_all(Path::new(&data_folder), now),
    }
}

/// Delete a Cowork session's sandbox, with its scratch.
#[cfg_attr(feature = "tauri", tauri::command)]
pub async fn session_workspace_delete(
    data_folder: String,
    session_id: String,
) -> Result<(), AgentToolsError> {
    workspace::remove_session_workspace(Path::new(&data_folder), &session_id)
        .await
        .map_err(Into::into)
}

/// Collect session sandboxes whose sessions no longer exist.
///
/// Deliberately separate from the thread sweep: the two id spaces are
/// independent, so handing either one the other's keep list would delete live
/// work. `keep` being empty is a no-op, not a full wipe.
#[cfg_attr(feature = "tauri", tauri::command)]
pub async fn session_workspace_sweep(
    data_folder: String,
    keep: Vec<String>,
) -> Result<usize, AgentToolsError> {
    workspace::sweep_session_workspaces(Path::new(&data_folder), &keep)
        .await
        .map_err(Into::into)
}

/// Strip credentials out of text before the renderer persists it. AH-045.
///
/// The renderer writes tool output into the session transcript, and that
/// transcript is a file on disk that outlives the run, gets exported, and gets
/// pasted into bug reports. Anything a tool printed -- a `curl -v` trace, an
/// error quoting an `Authorization` header, a config file it read back -- lands
/// there verbatim unless something takes the credential out first.
///
/// It lives here rather than in TypeScript on purpose. A second implementation
/// of the matching rules is a second thing to keep correct, and the two would
/// drift the first time either was extended -- so the renderer asks the same
/// code the audit log, the activity record and the prompt snapshot already use.
///
/// Infallible by construction: pure string work, no I/O. That matters, because
/// a caller that has to handle a redaction failure will eventually handle it by
/// persisting the unredacted text.
#[tauri::command]
pub async fn secrets_redact(text: String) -> String {
    crate::secrets::redact_secrets(&text)
}

/// Every discovered skill with its description, including empty stubs so the
/// user can see and edit them.
#[tauri::command]
pub async fn skill_list(
    data_folder: String,
    project: Option<String>,
) -> Result<Vec<SkillMeta>, AgentToolsError> {
    Ok(skills::list_meta(&resolve_store(
        &data_folder,
        project.as_deref(),
    )))
}

/// Raw `SKILL.md` text, frontmatter included, for the editor.
#[tauri::command]
pub async fn skill_read(
    data_folder: String,
    project: Option<String>,
    name: String,
) -> Result<String, AgentToolsError> {
    skills::read_raw(&resolve_store(&data_folder, project.as_deref()), &name).map_err(Into::into)
}

/// Create or overwrite a skill. Parent directories are created as needed.
#[tauri::command]
pub async fn skill_write(
    data_folder: String,
    project: Option<String>,
    name: String,
    content: String,
) -> Result<(), AgentToolsError> {
    skills::write(
        &resolve_store(&data_folder, project.as_deref()),
        &name,
        &content,
    )
    .map_err(Into::into)
}

/// Delete a skill in either form. Idempotent: a missing skill is Ok.
#[tauri::command]
pub async fn skill_delete(
    data_folder: String,
    project: Option<String>,
    name: String,
) -> Result<(), AgentToolsError> {
    skills::delete(&resolve_store(&data_folder, project.as_deref()), &name).map_err(Into::into)
}

/// Memory note names (stems), sorted.
#[tauri::command]
pub async fn memory_list(
    data_folder: String,
    project: Option<String>,
) -> Result<Vec<String>, AgentToolsError> {
    Ok(memory::list(&resolve_store(&data_folder, project.as_deref())).await)
}

#[tauri::command]
pub async fn memory_read(
    data_folder: String,
    project: Option<String>,
    name: String,
) -> Result<String, AgentToolsError> {
    memory::read(&resolve_store(&data_folder, project.as_deref()), &name)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn memory_write(
    data_folder: String,
    project: Option<String>,
    name: String,
    content: String,
) -> Result<(), AgentToolsError> {
    memory::write(
        &resolve_store(&data_folder, project.as_deref()),
        &name,
        &content,
    )
    .await
    .map(|_| ())
    .map_err(Into::into)
}

/// Delete a memory note. Idempotent: a missing note is Ok.
#[tauri::command]
pub async fn memory_delete(
    data_folder: String,
    project: Option<String>,
    name: String,
) -> Result<(), AgentToolsError> {
    memory::delete(&resolve_store(&data_folder, project.as_deref()), &name)
        .await
        .map_err(Into::into)
}

/// OpenAI-shaped function schemas for every built-in tool. The frontend picks
/// which subset to advertise; `schema.rs` stays the single source of truth so
/// the schemas are never re-typed in TypeScript.
#[tauri::command]
pub fn tool_schemas() -> Vec<serde_json::Value> {
    crate::breadcrumb::note("tool_schemas");
    schema::builtin_tool_schemas()
}

/// The `bash` tool runs a real shell, but on a host where no POSIX shell can
/// start inside the sandbox (every Windows AppContainer: the MSYS2 runtime Git
/// Bash needs cannot initialise there) the command is handed to Windows
/// PowerShell instead. The model does not know that and writes bash syntax --
/// `cp a b && echo done` -- which Windows PowerShell 5.1 rejects at parse time
/// (`&&` is not a statement separator), so the call fails and the follow-up that
/// depended on it fails too. Telling the model the real shell, in the tool's own
/// description, is what stops it: append a short PowerShell note to `bash`.
fn note_non_posix_shell(mut value: serde_json::Value) -> serde_json::Value {
    const NOTE: &str = " On this machine no POSIX shell is available \
        inside the sandbox, so commands run in Windows PowerShell, not bash. \
        Write PowerShell, not bash syntax: sequence commands with `;` -- Windows \
        PowerShell 5.1 does not accept `&&` or `||`; use cmdlets or their aliases \
        (cp/Copy-Item, mv/Move-Item, rm/Remove-Item, cat/Get-Content, \
        ls/Get-ChildItem, New-Item); and write Windows paths with backslashes. \
        Discard output with `2>$null` or `| Out-Null` -- cmd's `2>nul`/`>nul` is \
        refused here, because in PowerShell `nul` is a file name. To read a file, \
        prefer the `read` tool over `cat`. Inside this sandbox a Node process cannot \
        start child processes with piped output (it hangs): run tests with \
        `node --test --test-isolation=none <files>` or `node <file>`, and do not \
        repeat a command that timed out.";
    if let Some(function) = value.get_mut("function").and_then(|f| f.as_object_mut()) {
        if let Some(updated) = function
            .get("description")
            .and_then(|d| d.as_str())
            .map(|s| format!("{s}{NOTE}"))
        {
            function.insert("description".into(), serde_json::Value::String(updated));
        }
    }
    value
}

/// Whether this machine can confine a shell, and with what.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxStatus {
    /// Backend name for display: `bubblewrap`, `seatbelt`, `appcontainer`, `none`.
    pub backend: String,
    pub enforces: bool,
}

/// Report the sandbox backend so the frontend can decide whether to advertise
/// `bash` at all. Offering a tool that `execute_tool` will always refuse wastes a
/// model turn and reads as a bug, so the tool list is built from this.
#[tauri::command]
pub async fn sandbox_status() -> Result<SandboxStatus, AgentToolsError> {
    // The first call probes bubblewrap in a subprocess. Cached afterwards, but
    // keep even that one call off the async runtime's thread.
    let backend = tokio::task::spawn_blocking(jail::backend)
        .await
        .map_err(|e| AgentToolsError::from(format!("sandbox probe failed: {e}")))?;
    Ok(SandboxStatus {
        backend: backend.as_str().to_string(),
        enforces: backend.enforces(),
    })
}

/// Which common toolchain programs the confined shell can run, and which are
/// installed on the host but cannot run in the sandbox. `None` where this is
/// not known (any backend but AppContainer). Worked out from `PATH` and folder
/// ACLs without starting the sandbox, once per app session; a readiness retry
/// asks again.
#[tauri::command]
pub async fn sandbox_toolchains(
) -> Result<Option<crate::tools::host_tools::ToolchainReport>, AgentToolsError> {
    tokio::task::spawn_blocking(crate::tools::host_tools::probe_toolchains)
        .await
        .map_err(|e| AgentToolsError::from(format!("toolchain probe failed: {e}")))
}

/// Toolchain folders the user let the Windows sandbox use.
#[tauri::command]
pub async fn sandbox_toolchain_grants(
) -> Result<Vec<crate::tools::toolchain_grants::ToolchainGrant>, AgentToolsError> {
    Ok(crate::tools::toolchain_grants::list())
}

/// Let the sandbox run `program`, a toolchain the probe reports as installed
/// but unrunnable: adds an inheritable read+execute entry for `ALL APPLICATION
/// PACKAGES` on that program's install folder only, and records it.
#[tauri::command]
pub async fn sandbox_toolchain_grant(
    program: String,
) -> Result<crate::tools::toolchain_grants::ToolchainGrant, AgentToolsError> {
    tokio::task::spawn_blocking(move || crate::tools::toolchain_grants::grant(&program))
        .await
        .map_err(|e| AgentToolsError::from(format!("toolchain grant failed: {e}")))?
        .map_err(AgentToolsError::from)
}

/// Take back a grant made by `sandbox_toolchain_grant`: removes exactly the
/// entry it added, and the record.
#[tauri::command]
pub async fn sandbox_toolchain_revoke(folder: String) -> Result<(), AgentToolsError> {
    tokio::task::spawn_blocking(move || {
        crate::tools::toolchain_grants::revoke(std::path::Path::new(&folder))
    })
    .await
    .map_err(|e| AgentToolsError::from(format!("toolchain revoke failed: {e}")))?
    .map_err(AgentToolsError::from)
}

/// What a session can do right now, component by component.
///
/// The tool list, the run preflight and the Environment readiness card all read
/// this one report, so they cannot disagree about whether a shell works. The
/// renderer supplies the facts only its own stores hold -- whether a provider
/// answered, what context window was resolved, which MCP servers connected --
/// and `readiness` decides what those facts mean; it will not accept a claim
/// about a component the backend probes itself.
///
/// `project_root` is optional because a session with no folder attached is a
/// normal state with a real answer, not a missing argument.
#[tauri::command]
pub async fn environment_readiness(
    project_root: Option<String>,
    reported: Option<Vec<readiness::ComponentReport>>,
) -> Result<readiness::EnvironmentReadiness, AgentToolsError> {
    let root = project_root.map(PathBuf::from);
    // The shell probe starts a process; keep it off the async runtime's threads.
    let mut report = tokio::task::spawn_blocking(move || readiness::current(root.as_deref()))
        .await
        .map_err(|e| AgentToolsError::from(format!("readiness probe failed: {e}")))?;
    if let Some(reported) = reported {
        readiness::merge_reported(&mut report, reported);
    }
    Ok(report)
}

/// Re-probe one component, or every backend-owned component when `component` is
/// absent.
///
/// One component at a time by default, because the timestamps beside the other
/// rows would otherwise start lying about when they were last checked.
#[tauri::command]
pub async fn environment_readiness_retry(
    project_root: Option<String>,
    component: Option<readiness::Component>,
    reported: Option<Vec<readiness::ComponentReport>>,
) -> Result<readiness::EnvironmentReadiness, AgentToolsError> {
    // The user asked to look again; programs may have been installed since.
    crate::tools::host_tools::reset_toolchain_probe();
    let root = project_root.map(PathBuf::from);
    let mut report = tokio::task::spawn_blocking(move || match component {
        Some(component) => readiness::retry(root.as_deref(), component),
        None => readiness::retry_all(root.as_deref()),
    })
    .await
    .map_err(|e| AgentToolsError::from(format!("readiness probe failed: {e}")))?;
    if let Some(reported) = reported {
        readiness::merge_reported(&mut report, reported);
    }
    Ok(report)
}

/// Which built-in tools this environment allows, and why the others are held
/// back.
///
/// The one place the advertised tool list is decided. Returning the omissions
/// alongside the schemas is deliberate: a tool that vanished with no
/// explanation is indistinguishable from a bug, and the reason is what the
/// activity log and the readiness card both render.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvertisedTools {
    pub schemas: Vec<serde_json::Value>,
    pub omitted: Vec<OmittedTool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmittedTool {
    pub name: String,
    pub component: readiness::Component,
    pub reason: readiness::Reason,
    pub message: String,
}

/// OpenAI-shaped function schemas for the tools this environment can actually
/// run, plus the ones it cannot and why.
///
/// Replaces advertising every built-in and letting execution refuse: a tool the
/// model calls and cannot use costs a turn and reads as a defect.
#[tauri::command]
pub async fn advertised_tool_schemas(
    project_root: Option<String>,
    reported: Option<Vec<readiness::ComponentReport>>,
    // Which surface is asking. The session-messaging tools are offered only to
    // `session` (Cowork); omitted, as every pre-existing caller does, it is
    // `thread`, which never sees them.
    scope: Option<WorkspaceScope>,
) -> Result<AdvertisedTools, AgentToolsError> {
    crate::breadcrumb::note("advertised_tool_schemas");
    let report = environment_readiness(project_root, reported).await?;
    let session_scope = matches!(scope.unwrap_or_default(), WorkspaceScope::Session);
    // A shell that runs but is not POSIX (Windows PowerShell/cmd) grants
    // `shell.any` without `shell.posix`. When that is the case, `bash`'s
    // description is amended to tell the model which shell it is really using.
    let caps = report.capabilities();
    let non_posix_shell = caps.contains(readiness::capability::SHELL_ANY)
        && !caps.contains(readiness::capability::SHELL_POSIX);
    let mut schemas = Vec::new();
    let mut omitted = Vec::new();
    for value in schema::builtin_tool_schemas() {
        let Some(name) = value
            .get("function")
            .and_then(|f| f.get("name"))
            .and_then(|n| n.as_str())
        else {
            continue;
        };
        // Not an environment shortfall, so not reported as omitted: a chat
        // thread simply is not a messaging participant.
        if !crate::tools::advertised_in_scope(name, session_scope) {
            continue;
        }
        // The desktop advertises the browser tools from its web layer, behind
        // the Settings switch and only where a pane exists; this list is for
        // surfaces that run these tools themselves.
        if crate::tools::is_browser_tool(name) {
            continue;
        }
        match readiness::tool_availability(&report, name) {
            readiness::ToolAvailability::Available => schemas.push(if name == "bash" && non_posix_shell {
                note_non_posix_shell(value.clone())
            } else {
                value.clone()
            }),
            readiness::ToolAvailability::Unavailable {
                component,
                reason,
                message,
            } => omitted.push(OmittedTool {
                name: name.to_string(),
                component,
                reason,
                message,
            }),
        }
    }
    Ok(AdvertisedTools { schemas, omitted })
}

/// One fragment of a tool's live output.
///
/// `seq` is monotonic per call so the receiver can assert ordering and notice
/// the truncation below; `callId` says which tool call it belongs to, which a
/// backgrounded `bash` needs because it keeps streaming after the tool returned.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolOutputChunk {
    pub seq: u64,
    pub call_id: Option<String>,
    pub text: String,
}

/// Live output past this point is dropped from the stream, not from the result.
///
/// A `yes`-style command would otherwise flood the webview with IPC messages
/// faster than it can render them. The full text still reaches the caller in
/// `ToolResult`, and in the spill file when it overflows that.
const MAX_STREAMED_BYTES: usize = 2 * 1024 * 1024;

/// Which sandbox namespace an id belongs to.
///
/// Chat threads and Cowork sessions have independent id spaces and independent
/// sweeps, so the caller has to say which one it means; guessing would let one
/// surface's cleanup delete the other's work.
#[derive(Debug, Clone, Copy, Default, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceScope {
    #[default]
    Thread,
    Session,
}

impl WorkspaceScope {
    /// The workspace's path, without creating it.
    fn path(self, data_folder: &Path, id: &str) -> Result<PathBuf, String> {
        match self {
            Self::Thread => workspace::thread_workspace(data_folder, id),
            Self::Session => workspace::session_workspace(data_folder, id),
        }
    }

    async fn ensure(self, data_folder: &Path, id: &str) -> Result<PathBuf, String> {
        match self {
            Self::Thread => workspace::ensure_thread_workspace(data_folder, id).await,
            Self::Session => workspace::ensure_session_workspace(data_folder, id).await,
        }
    }
}

/// Execute one built-in tool.
///
/// The gate decides, not the caller. `write` and `edit` resolve to `Prompt` and
/// are refused here regardless of what the frontend asks for, until a permission
/// round-trip exists; a read that escapes the project root prompts too. `bash`
/// runs only under an enforcing sandbox (see the module docs).
#[tauri::command]
// `read_only_project` is a folder the user attached read-only. It is validated
// here rather than trusted: an unusable one is an error, never a silent drop,
// or the agent would work against a folder it believes is attached and is not.
#[allow(clippy::too_many_arguments)]
pub async fn execute_tool(
    data_folder: String,
    thread_id: String,
    project: Option<String>,
    name: String,
    args: serde_json::Value,
    enabled_skills: Option<Vec<String>>,
    allow_network: Option<bool>,
    read_only_project: Option<String>,
    write_grant: Option<String>,
    scope: Option<WorkspaceScope>,
    call_id: Option<String>,
    undo_run: Option<String>,
    // Who is making this call (AH-110): the subject spelling of the agent
    // (`agent`, `agent:<name>`, `role:<name>`) plus a display label and, for a
    // subagent, its parent. Journaled with every file the call changes, so a
    // change can always name the agent that made it. `None` records the change
    // without an actor, which reads as unknown rather than as anyone.
    actor: Option<ActorInput>,
    // The session's additional attached folders, each readable exactly like
    // `read_only_project` and validated the same way.
    extra_projects: Option<Vec<String>>,
    // Whether the renderer asked the user before sending this call, or a mode
    // or grant allowed it. `prompted`, `bypass` and `secret` widen the gate,
    // so they count only with `approval_token` minted for this exact call.
    approval: Option<ApprovalSource>,
    approval_token: Option<String>,
) -> Result<ToolResult, AgentToolsError> {
    crate::breadcrumb::note(&format!("execute_tool {name}"));
    let approval = crate::approval_tokens::verify(
        approval_token.as_deref(),
        &thread_id,
        call_id.as_deref(),
        &name,
        &args,
        approval,
    )?;
    let request = ToolCallRequest {
        data_folder,
        thread_id,
        project,
        name,
        args,
        enabled_skills,
        allow_network,
        read_only_project,
        write_grant,
        scope,
        call_id,
        undo_run,
        actor,
        extra_projects,
    };
    execute_tool_inner(request, None, false, approval).await
}

/// `execute_tool`, plus a channel that receives the tool's output as it is
/// produced. A separate command rather than an optional argument because
/// `tauri::ipc::Channel` is a `CommandArg`, not a `Deserialize`, so it cannot be
/// wrapped in `Option`.
#[cfg(feature = "tauri")]
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn execute_tool_streaming(
    data_folder: String,
    thread_id: String,
    project: Option<String>,
    name: String,
    args: serde_json::Value,
    enabled_skills: Option<Vec<String>>,
    allow_network: Option<bool>,
    read_only_project: Option<String>,
    write_grant: Option<String>,
    scope: Option<WorkspaceScope>,
    call_id: Option<String>,
    undo_run: Option<String>,
    // Who is making this call (AH-110): the subject spelling of the agent
    // (`agent`, `agent:<name>`, `role:<name>`) plus a display label and, for a
    // subagent, its parent. Journaled with every file the call changes, so a
    // change can always name the agent that made it. `None` records the change
    // without an actor, which reads as unknown rather than as anyone.
    actor: Option<ActorInput>,
    extra_projects: Option<Vec<String>>,
    approval: Option<ApprovalSource>,
    approval_token: Option<String>,
    on_output: tauri::ipc::Channel<ToolOutputChunk>,
) -> Result<ToolResult, AgentToolsError> {
    crate::breadcrumb::note(&format!("execute_tool_streaming {name}"));
    let approval = crate::approval_tokens::verify(
        approval_token.as_deref(),
        &thread_id,
        call_id.as_deref(),
        &name,
        &args,
        approval,
    )?;
    let sink = output_sink(on_output, call_id.clone());
    let request = ToolCallRequest {
        data_folder,
        thread_id,
        project,
        name,
        args,
        enabled_skills,
        allow_network,
        read_only_project,
        write_grant,
        scope,
        call_id,
        undo_run,
        actor,
        extra_projects,
    };
    execute_tool_inner(request, Some(sink), false, approval).await
}

/// Run a `bash` call again outside the sandbox, after the user approved it.
///
/// `retry` is the id a failed call's [`ToolResult::unsandboxed_retry`]
/// carried; it names that exact call (command, folder, grants) and is valid
/// once, in the session it was issued to. The renderer asks the user before
/// calling this, and nothing else can reach it: the model only ever calls
/// `execute_tool`, and the id is never in the text a model reads.
#[cfg(feature = "tauri")]
#[tauri::command]
pub async fn execute_tool_unsandboxed_retry(
    thread_id: String,
    retry: String,
) -> Result<ToolResult, AgentToolsError> {
    let Some(call) = retry_offers().redeem(&retry, &thread_id) else {
        return Err(AgentToolsError::from(
            "this unsandboxed retry is no longer available (already used, expired, or \
             issued to another session)"
                .to_string(),
        ));
    };
    execute_tool_inner(call, None, true, None).await
}

/// Mint a one-shot token for `approval` on this exact call (O02-024). The
/// execute commands accept `prompted`, `bypass` and `secret` only with a token
/// bound to the same session, call id, tool name, arguments and approval; it is
/// consumed on use and expires after a short while.
#[cfg_attr(feature = "tauri", tauri::command)]
pub fn approval_mint(
    thread_id: String,
    call_id: Option<String>,
    name: String,
    args: serde_json::Value,
    approval: ApprovalSource,
) -> String {
    crate::approval_tokens::tokens().mint(crate::approval_tokens::Binding::new(
        &thread_id,
        call_id.as_deref(),
        &name,
        &args,
        approval,
    ))
}

/// Drop an unsandboxed-retry offer the user declined, so the id cannot be
/// redeemed later.
#[cfg(feature = "tauri")]
#[tauri::command]
pub async fn execute_tool_unsandboxed_withdraw(thread_id: String, retry: String) {
    retry_offers().withdraw(&retry, &thread_id);
}

async fn execute_tool_inner(
    request: ToolCallRequest,
    sink: Option<crate::tools::OutputSink>,
    // True only for a call the user approved to run outside the sandbox,
    // redeemed through `execute_tool_unsandboxed_retry`.
    unsandboxed: bool,
    approval: Option<ApprovalSource>,
) -> Result<ToolResult, AgentToolsError> {
    // Kept before anything consumes the arguments, in case this call ends in
    // the one failure the user can be offered an unsandboxed retry for.
    let retry_call = request.retry_copy(unsandboxed);
    let ToolCallRequest {
        data_folder,
        thread_id,
        project,
        name,
        args,
        enabled_skills,
        allow_network,
        read_only_project,
        // An opaque grant id from `direct_edit_authorize`, naming a folder the
        // user confirmed for this session. Not a path: a path arriving here
        // could be anything the caller chose, whereas an id only resolves to
        // the folder the grant was issued for, and only in the session it was
        // issued to. `None` is every run that has not been authorized, which
        // is the unchanged sandbox-only behaviour.
        write_grant,
        scope,
        call_id,
        // The run this call belongs to. Given, the files a `write` or `edit`
        // changes are journaled against it so the turn can be undone (AH-202).
        undo_run,
        // Who is making this call (AH-110): the subject spelling of the agent
        // (`agent`, `agent:<name>`, `role:<name>`) plus a display label and,
        // for a subagent, its parent. Journaled with every file the call
        // changes, so a change can always name the agent that made it. `None`
        // records the change without an actor, which reads as unknown rather
        // than as anyone.
        actor,
        extra_projects,
    } = request;
    // Refused before the tool runs, not after it has changed a file: a call
    // that cannot say who it is acting for must not leave a change that will
    // later be attributed to someone.
    let actor = actor
        .map(|a| {
            crate::undo::Actor::new(
                &a.id,
                a.label.as_deref().unwrap_or_default(),
                a.parent.as_deref(),
                a.invocation.as_deref(),
                a.task.as_deref(),
            )
        })
        .transpose()
        .map_err(|e| AgentToolsError::from(e.message()))?;
    // Created here rather than trusted to exist: `escapes_project` canonicalizes
    // the sandbox root and treats a missing one as an escape, so every tool call
    // would be refused if the thread's first tool call arrived before any UI
    // surface had ensured it.
    let scope = scope.unwrap_or_default();
    let root = scope.ensure(Path::new(&data_folder), &thread_id).await?;
    let scratch = workspace::ensure_scratch_dir(&thread_id).await?;
    let store = resolve_store(&data_folder, project.as_deref());
    // Plural from the outset so attaching a second folder later is not another
    // signature change.
    let mut read_roots: Vec<PathBuf> = match read_only_project.as_deref() {
        Some(path) => vec![workspace::validate_read_root(
            Path::new(path),
            &root,
            Some(Path::new(&data_folder)),
        )?],
        None => Vec::new(),
    };
    // The session's other attached folders: readable like the primary, after it.
    for path in extra_projects.iter().flatten() {
        let validated =
            workspace::validate_read_root(Path::new(path), &root, Some(Path::new(&data_folder)))?;
        if !read_roots.contains(&validated) {
            read_roots.push(validated);
        }
    }
    // Resolved against this thread, so a grant issued to another session — or
    // one already revoked — authorizes nothing and the run simply writes to its
    // own workspace. Validation happened when the grant was issued; what
    // matters here is that it is still live and still ours. The grant covers
    // the primary folder first and then the session's extra folders.
    let write_roots: Vec<PathBuf> = write_grant
        .as_deref()
        .map(|id| crate::grants::resolve_all(id, &thread_id))
        .unwrap_or_default();
    // Folders the user granted through `request_access`, re-resolved now so a
    // grant whose folder has since become a link elsewhere no longer applies.
    let (access_read, access_write) = crate::access::active_roots(
        Path::new(&data_folder),
        &thread_id,
        crate::access::now_secs(),
    );
    // The attached folder the user let this run edit: where a bare relative
    // file path should land, ahead of any `request_access` grants appended below.
    // None when the grant leaves the primary read-only: its first root is then
    // an extra folder, which bare relative paths must not silently target.
    let edit_folder = write_grant
        .as_deref()
        .filter(|id| crate::grants::main_writable(id, &thread_id))
        .and_then(|_| write_roots.first().cloned());
    // The folder whose `agent.toml` governs this run: the attached project, or
    // the folder the run may edit when nothing was attached read-only.
    let policy_root: Option<PathBuf> = read_only_project.as_deref().map(PathBuf::from).or_else(|| edit_folder.clone());
    let mut write_roots = write_roots;
    for root in access_write {
        if !write_roots.contains(&root) {
            write_roots.push(root);
        }
    }
    // A folder the run may write is one it may read: the new worktree a call
    // made beside the project joins the write roots only, and the model could
    // write a file there that it was then refused permission to read back.
    for root in &write_roots {
        if !read_roots.contains(root) {
            read_roots.push(root.clone());
        }
    }
    for root in access_read {
        if !read_roots.contains(&root) {
            read_roots.push(root);
        }
    }
    let grants = SessionGrants::default().with_write_roots(write_roots.clone());
    // A run whose shell works in its managed worktree resolves the file tools'
    // relative paths there too, before the gate sees them: otherwise
    // `write check.py` lands in the workspace and `python check.py` looks for
    // it in the worktree.
    let mut args = args;
    let tool = lookup(&name)
        .ok_or_else(|| AgentToolsError::from(format!("unknown built-in tool '{name}'")))?;
    // `/C:\x` and `file:///C:/x` are drive paths on Windows: rewrite them
    // before rebasing (which would treat them as relative) and before the gate.
    crate::tools::path_repair::normalize_drive_args(&name, tool.path_args, &mut args);
    // A run with direct edit access to a folder resolves them there as well:
    // "create some files" with no absolute path belongs in the folder the user
    // attached for editing, not the scratch workspace.
    let rebase_base = rebase_base_for(Path::new(&data_folder), &write_roots, edit_folder);
    if let Some(base) = rebase_base {
        handlers::rebase_relative_paths(&name, &mut args, &base);
    }

    // Transcript audit #5: `"C:	mp"` in JSON arrives as `C:<TAB>mp`. Put the
    // backslash back when that names something real, before the gate judges
    // the path; otherwise say what happened instead of "does not exist".
    crate::tools::path_repair::repair_args_on_disk(&name, tool.path_args, &mut args, &root, Some(&scratch))
        .map_err(|e| AgentToolsError::from(format!("tool '{name}' was refused: {e}")))?;

    // The project's own policy, read from its `agent.toml` rather than assumed.
    // AH-007/AH-036/AH-037/AH-042: this call site used to build
    // `ToolPermissions::default()` -- allow everything -- so a repository that
    // denied a tool or a path was obeyed by the CLI and ignored by the
    // desktop. Read here, at the gate, because a policy passed in from the
    // renderer is one the caller can choose not to send.
    let policy = crate::policy::load(policy_root.as_deref(), allow_network);
    let permissions = policy.permissions.clone();
    // Widen the read roots by any absolute directories the project's own allow
    // rules make readable (e.g. `allow = ["read(C:/data/**)"]`), so a policy
    // that opts into reading a host location does not then prompt on every read
    // there. Each is validated like the attached project root; one that fails
    // validation is skipped rather than failing the call, and deny rules still
    // win at the gate.
    for dir in permissions.sandbox_read_dirs() {
        if let Ok(validated) =
            workspace::validate_read_root(&dir, &root, Some(Path::new(&data_folder)))
        {
            if !read_roots.contains(&validated) {
                read_roots.push(validated);
            }
        }
    }
    // Installed skills and plugins are readable by the file tools, read-only:
    // their bundled files are otherwise unreachable, since the data folder they
    // sit in cannot be granted through `request_access`. Kept out of
    // `read_roots` itself: that list's first entry is taken as the attached
    // project, and it is what the shell is given to mount.
    let mut gate_roots = read_roots.clone();
    for dir in skills::readable_skill_roots(&store, None) {
        if !gate_roots.contains(&dir) {
            gate_roots.push(dir);
        }
    }
    let decision = gate::resolve_decision(
        tool,
        &args,
        &root,
        Some(&scratch),
        &gate_roots,
        &permissions,
        &grants,
        true,
        &policy.network,
        &crate::subject::Subject::MainAgent,
    );

    // AH-049: every decision is recorded before it is acted on, so a refusal
    // that returns early below is still in the log. Recording never changes
    // the decision -- `append` swallows its own failures.
    let no_ask_rule = permissions
        .asks_call(&name, &[], &crate::subject::Subject::MainAgent)
        .is_none();
    let renderer_approved_git =
        matches!(decision, Decision::Prompt(PromptKind::Ask)) && name == "git" && no_ask_rule;
    // F03-005: the verdict is known before the record is written, so the log
    // never says "approved" for a call the match below then refuses.
    let backend_enforces = jail::backend().enforces();
    let mut refusal = match &decision {
        Decision::Prompt(kind)
            if !prompt_is_honoured(*kind, &name, approval, no_ask_rule, backend_enforces) =>
        {
            Some(Refusal::Prompt)
        }
        _ => None,
    };
    // A bash call that will run in a project folder directly, outside the
    // sandbox, is an unsandboxed run: it needs the same user approval a
    // redeemed retry has. Only an answer a person (or Bypass mode) gave counts.
    let direct_folder = if name == "bash" && !unsandboxed {
        handlers::direct_edit_shell_start(&write_roots, Path::new(&data_folder))
    } else {
        None
    };
    if refusal.is_none()
        && direct_folder.is_some()
        && !matches!(approval, Some(ApprovalSource::Prompted | ApprovalSource::Bypass))
    {
        refusal = Some(Refusal::DirectEdit);
    }
    record_permission_decision(
        Path::new(&data_folder),
        &thread_id,
        tool,
        &args,
        &root,
        &decision,
        &DecisionContext {
            run: undo_run.as_deref(),
            call: call_id.as_deref(),
            project: read_only_project.as_deref(),
            renderer_approved_git,
            unsandboxed,
            approval,
            sandbox_enforces: matches!(decision, Decision::Prompt(PromptKind::Exec))
                && backend_enforces,
            refusal,
            direct_edit: direct_folder.is_some(),
        },
    );
    if refusal == Some(Refusal::DirectEdit) {
        return Err(
            "tool 'bash' needs user approval (Exec): it would run directly in a project folder \
             outside the sandbox, and none was recorded for this call"
                .to_string()
                .into(),
        );
    }

    match decision {
        Decision::Allow => {}
        Decision::HardDeny(gate::DenyReason::GitInternals) => {
            return Err(format!(
                "tool '{name}' was refused: it would change a repository's .git folder (hooks, config), which Git runs outside the sandbox. Use the `git` tool for repository changes."
            )
            .into());
        }
        Decision::HardDeny(gate::DenyReason::Hidden) => {
            return Err(hidden_state_msg(&name).into());
        }
        Decision::HardDeny(gate::DenyReason::Policy) => {
            return Err(match &policy.load_error {
                Some(why) => format!("tool '{name}' is denied by policy: {why}"),
                None => format!("tool '{name}' is denied by policy"),
            }
            .into());
        }
        // Say which of the two it was. "No network" and "not that host" call
        // for different things from the user, and one message for both sends
        // them to change the wrong setting.
        Decision::HardDeny(gate::DenyReason::NetworkOff) => {
            return Err(format!(
                "tool '{name}' was refused: this run has no network access. \
                 Nothing was sent. Work from what is already in the project, or \
                 ask the user to enable network access for it.{}",
                policy
                    .load_error
                    .as_ref()
                    .map(|why| format!(" ({why})"))
                    .unwrap_or_default()
            )
            .into());
        }
        Decision::HardDeny(gate::DenyReason::Domain(host)) => {
            return Err(format!(
                "tool '{name}' was refused: {host} is not a destination this \
                 project allows. Nothing was sent. Do not try another spelling \
                 of the same host."
            )
            .into());
        }
        // The name, never the contents: the point of refusing is that they do
        // not reach the transcript.
        Decision::HardDeny(gate::DenyReason::SecretFile(file)) => {
            return Err(format!(
                "tool '{name}' was refused: {file} looks like it holds \
                 credentials, and nothing has granted access to it by name. It \
                 was not read. Ask the user before going near it."
            )
            .into());
        }
        // The argument could not be read, so nothing can vouch for it. Say
        // which one: told only "refused", a model retries the same call.
        Decision::HardDeny(gate::DenyReason::Resource) => {
            return Err(format!(
                "tool '{name}' was refused: its arguments could not be resolved to a \
                 file, command or destination, so no permission rule could be applied \
                 to it. Re-issue the call with explicit, well-formed arguments."
            )
            .into());
        }
        // A destructive git operation needs a rule that names it. A blanket
        // `allow = ["bash"]` is permission to run commands, not permission to
        // discard uncommitted work.
        Decision::HardDeny(gate::DenyReason::DestructiveGit(op)) => {
            return Err(format!(
                "tool '{name}' was refused: this is a destructive git operation \
                 ({}), which can lose work that was never committed or rewrite \
                 history others have. It needs a rule that names it, such as \
                 `allow = [\"bash(git:{})\"]`.",
                op.as_str(),
                op.as_str()
            )
            .into());
        }
        // An exec prompt asks the user to vouch for a command that could reach
        // anything. Under an enforcing sandbox it cannot: writes stay in the
        // thread workspace and $HOME is unreadable, so the containment the prompt
        // was protecting is already guaranteed. The gate itself is left alone,
        // because the CLI agent *does* want to prompt here.
        // The interactive browser acts on a page of the user's own app, which
        // the ephemeral-workspace reasoning below does not cover: the question
        // is the renderer's to put to the user, and this surface refuses a
        // call it did not vouch for. `open` and `evaluate` are asked every
        // time, so only an answer a person gave counts for them; acting needs
        // the renderer's approval record (a prompt, or a mode that allows it).
        // A project `ask` rule is the renderer's blind spot, so it still refuses.
        // Every arm the renderer's own record can satisfy is decided by
        // `prompt_is_honoured`, the same function the audit record used.
        Decision::Prompt(kind)
            if prompt_is_honoured(kind, &name, approval, no_ask_rule, backend_enforces) => {}
        Decision::Prompt(PromptKind::Write) if name == "browser" && approval.is_none() => {
            return Err(
                "tool 'browser' needs user approval before it acts on a page, and none was recorded for this call"
                    .to_string()
                    .into(),
            );
        }
        // Same reasoning for writes, from the other direction. `root` here is
        // always `ensure_thread_workspace`, never a real project: an ephemeral
        // directory deleted with the conversation, which `escapes_project`
        // confines and whose sibling -- not child -- is the permanent store. So
        // no durable user data is in range for the prompt to protect, and
        // refusing here while `bash` may already write the same files would be a
        // control a sibling tool bypasses.
        //
        // A write that *escapes* the sandbox (absolute or `..`) is different:
        // it can reach host files (rc files, ssh keys, LaunchAgents, the store)
        // that the ephemeral-root reasoning does not cover. It is gated as
        // `WriteEscape` and refused here outright, since this surface has no
        // prompt round-trip to approve it.
        // The message matters as much as the refusal: told only "refused", a
        // model retries the same write until the step budget runs out.
        Decision::Prompt(PromptKind::WriteEscape) => {
            return Err(match read_roots.first() {
                Some(attached) => format!(
                    "tool '{name}' cannot write outside the agent workspace yet. The attached \
                     folder {} is mounted read-only. Call request_access with access_mode \
                     \"write\", the narrowest path you must change and a one-sentence reason: \
                     the user decides, and on a grant you retry this call. If it is denied, \
                     copy the file into the workspace and edit it there.",
                    attached.display()
                ),
                None => format!(
                    "tool '{name}' tried to write outside the agent workspace and was refused. \
                     Call request_access with access_mode \"write\", the narrowest path you \
                     must change and a one-sentence reason: the user decides, and on a grant \
                     you retry this call."
                ),
            }
            .into());
        }
        // Reading outside the workspace is what `request_access` exists for:
        // say so, or the model concludes the file is unreachable.
        Decision::Prompt(PromptKind::ReadEscape) => {
            return Err(read_escape_message(&name, &args, &root, &read_roots).into());
        }
        // A `git` call that writes to a remote or can lose work. The renderer
        // puts every one of these to the user, naming the command, remote and
        // branch, before it calls this (web-app `gitTool.ts`), the same way it
        // answers for `write` above. A project `ask` rule is different: the
        // renderer does not know about it, so that one is still refused here.
        Decision::Prompt(kind) => {
            return Err(format!(
                "tool '{name}' needs user approval ({kind:?}) and is not available yet"
            )
            .into());
        }
    }

    let enabled = enabled_skills.unwrap_or_default();
    // The attached folder is the project, for skills as for policy: its own
    // skills and its enabled plugins' skills are offered to the skill tools,
    // with `[skills].enabled` and `[plugins].disabled` read from its agent.toml
    // here rather than trusted from the renderer. Only when no explicit
    // `project` store was named, which would already be that project's store.
    let skill_project: Option<PathBuf> = match project.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => None,
        _ => read_roots.first().map(|r| workspace::project_store(r)),
    };
    let mut ctx = ToolContext::new(&root, &store, &enabled)
        // The desktop shows a browser screenshot beside the transcript and
        // sends the model a small one.
        .with_compact_images()
        // The toggle, clamped by the project's `agent.toml` and the machine's
        // policy: either one can turn the shell's network off.
        .with_network(policy.network.allowed && allow_network.unwrap_or(false))
        .with_confined_writes(true)
        .with_mask_root(Path::new(&data_folder))
        .with_scratch_root(&scratch)
        .with_read_roots(&read_roots)
        .with_write_roots(&write_roots)
        // The thread is the conversation: its background commands are its own.
        .with_job_owner(&thread_id)
        // ... and survive the app that started them, as a record (AH-101).
        .with_job_record_to(Path::new(&data_folder))
        .with_skill_project(skill_project.as_deref())
        // Programs the project says open NUL themselves (`[tools].nul_programs`).
        .with_nul_programs(&policy.nul_programs);
    if let Some(id) = call_id.as_deref() {
        ctx = ctx.with_call_id(id);
    }
    ctx = ctx.with_credential_override(matches!(
        approval,
        Some(ApprovalSource::Bypass | ApprovalSource::Secret)
    ));
    // AH-174: the run a command's CPU and memory are kept against.
    if let Some(run) = undo_run.as_deref() {
        ctx = ctx.with_measured_run(run);
    }
    if let Some(sink) = sink {
        ctx = ctx.with_output_sink(sink);
    }
    if unsandboxed {
        ctx = ctx.with_unsandboxed_retry();
    } else if let Some(folder) = direct_folder {
        // Edit access to a project folder means the shell works in it, as the
        // user's own terminal would. The Windows sandbox cannot even enter such
        // a folder, so the command runs there directly instead of failing.
        // Approval was checked above (it is an unsandboxed run).
        ctx = ctx.with_direct_edit_shell(folder);
    }
    // A Cowork session is a conversation with a stable id and a messaging
    // identity; bind both so `memory_propose` attributes to it and the mailbox
    // tools know who is calling. A chat thread gets neither, so the mailbox
    // tools refuse there even if called by name.
    // A token under the session's scope, so a session-wide stop reaches a
    // `wait_for_reply` that would otherwise sit out its timeout.
    let session_token = matches!(scope, WorkspaceScope::Session).then(|| {
        crate::lifecycle::register(crate::lifecycle::Token::new(crate::lifecycle::Scope::new(
            thread_id.clone(),
            "",
            call_id.clone().unwrap_or_default(),
        )))
    });
    if let Some(registered) = session_token.as_ref() {
        ctx = ctx
            .in_session(Some(&thread_id), false)
            .with_mailbox(Path::new(&data_folder))
            .with_cancel(registered.token().clone());
    }
    // AH-202: the exact bytes a file-changing tool found and left, taken at
    // the path the handler itself resolves -- so the journal can only ever
    // name a file this call actually wrote.
    let journaled = match (undo_run.as_deref(), name.as_str()) {
        (Some(run), "write" | "edit") => args
            .get("path")
            .and_then(|v| v.as_str())
            .map(|raw| crate::tools::sandbox::resolve_path(&root, Some(&scratch), raw))
            .map(|target| {
                let before = std::fs::read(&target).ok();
                (run.to_string(), target, before)
            }),
        _ => None,
    };
    let ((content, diff, images), read_ok) =
        handlers::with_read_success(handlers::execute_builtin_with_diff(tool, &args, &ctx)).await;
    // Transcript audit #12: a refusal of the arguments shows the call it
    // expected, not only the word that was wrong.
    let content = crate::tools::call_shape::explain(&name, &args, content);
    // AH-009: what the call was is decided once, by classification. A shell
    // command that exited non-zero is a tool failure even though it said so in
    // its own words rather than in the tool protocol's. A `read` that
    // succeeded on a file whose text starts with "ERROR" is not one
    // (Jozkah/jan#62).
    let read_succeeded = read_ok.is_some_and(|ok| content.starts_with(&ok));
    let failure = if read_succeeded {
        None
    } else {
        crate::harness_error::classify_tool(&name, &content)
    }
    .or_else(|| {
        (name == "bash" && handlers::bash_result_failed(&content)).then(|| {
            crate::harness_error::HarnessError::new(
                crate::harness_error::ErrorKind::ToolFailed,
                "the command exited with a failure status",
            )
            .at(crate::harness_error::Stage::Tool)
        })
    });
    let is_error = failure.is_some();
    if let (Some((run, target, before)), false) = (journaled, is_error) {
        let after = std::fs::read(&target).ok();
        if let Err(e) = crate::undo::record(
            Path::new(&data_folder),
            &thread_id,
            &run,
            &target,
            before.as_deref(),
            after.as_deref(),
            actor.as_ref(),
        ) {
            // The change stands; only its undo is unavailable, and that is
            // said where someone debugging it will look.
            eprintln!("undo journal: could not record {}: {e}", target.display());
        }
    }
    let resources = match (undo_run.as_deref(), call_id.as_deref()) {
        (Some(run), Some(call)) => crate::resources::take_call(run, call),
        _ => None,
    };
    let unsandboxed_retry = retry_call
        .filter(|_| {
            crate::unsandboxed_retry::qualifies(&name, !unsandboxed, is_error, ctx.null_refusal.is_set())
        })
        .map(|call| retry_offers().offer(&thread_id, call));
    Ok(ToolResult {
        content,
        diff,
        is_error,
        error: failure.as_ref().map(crate::harness_error::HarnessError::to_wire),
        resources,
        unsandboxed_retry,
        images: images.unwrap_or_default(),
    })
}

/// Whether a batch hook may have the network: the project's policy and the
/// caller's setting must both allow it.
fn batch_hook_network(project: Option<&Path>, allow_network: Option<bool>) -> bool {
    let policy = crate::policy::load(project, allow_network);
    policy.network.allowed && allow_network.unwrap_or(false)
}

/// Fire the `post-tool-batch` hooks for a turn whose tool calls the renderer
/// has run one at a time through [`execute_tool`].
///
/// The Rust agent loop fires the event itself; the chat runs its own tool loop
/// in the renderer, which is the only place that knows a turn's calls are all
/// answered. It says so here. Observe-only and detached exactly as in the loop
/// (see `hooks::fire_post_tool_batch`): this returns at once, and a hook that
/// fails, hangs or is malformed cannot reach the chat or its tool results.
#[cfg_attr(feature = "tauri", tauri::command)]
pub async fn fire_post_tool_batch(
    data_folder: String,
    thread_id: String,
    tool_names: Vec<String>,
    allow_network: Option<bool>,
    scope: Option<WorkspaceScope>,
    // `main` (default) or `subagent`: told to the hook as `FLINT_HOOK_AGENT`.
    agent: Option<String>,
    // The project whose `agent.toml` bounds the hooks' network, as for
    // `execute_tool`. Without it only the machine policy applies.
    read_only_project: Option<String>,
) -> Result<(), AgentToolsError> {
    if tool_names.is_empty() {
        return Ok(());
    }
    // Only the path: a chat that never ran a tool has no workspace, and one
    // without a hooks file in it has nothing to fire. `fire_post_tool_batch`
    // returns at once for that, so this must not create the folder.
    let root = scope
        .unwrap_or_default()
        .path(Path::new(&data_folder), &thread_id)?;
    let network = batch_hook_network(read_only_project.as_deref().map(Path::new), allow_network);
    // Same confinement the thread's `execute_tool` calls get: sandboxed, with
    // the Flint data folder masked.
    let _ = crate::hooks::fire_post_tool_batch_as(
        &root,
        tool_names,
        agent.as_deref().unwrap_or("main"),
        network,
        false,
        true,
        Some(Path::new(&data_folder)),
    );
    Ok(())
}

/// What the commands a run started used, taken as the run ends (AH-174).
/// `None` for a run that started no command. Forgotten once taken.
#[cfg_attr(feature = "tauri", tauri::command)]
pub async fn tool_resources_finish_run(run: String) -> Option<crate::resources::RunResources> {
    crate::resources::finish_run(&run)
}

/// One turn's journaled file changes, as the UI lists them. AH-202.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoTurnSummary {
    pub run: String,
    pub at: String,
    pub state: crate::undo::TurnState,
    pub paths: Vec<String>,
    /// Every distinct agent whose change this turn holds (AH-110), in the
    /// order they first changed something.
    pub actors: Vec<crate::undo::Actor>,
    /// One entry per file, so a turn several agents wrote into says which
    /// agent left which file. `actor` is absent for a record written before
    /// provenance existed.
    pub changes: Vec<UndoChangeSummary>,
}

/// Who a caller says is making a tool call (AH-110).
///
/// Deliberately a claim, not a capability: it decides what a change is
/// attributed to, never what the call may do. The permission gate keeps its
/// own subject, so a caller cannot widen its authority by naming a different
/// agent here.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorInput {
    /// `agent`, `agent:<name>` or `role:<name>`.
    pub id: String,
    /// What to show. Falls back to a description of the id.
    #[serde(default)]
    pub label: Option<String>,
    /// The agent that dispatched this one, in the same spelling.
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub invocation: Option<String>,
    #[serde(default)]
    pub task: Option<String>,
}

/// One changed file and who changed it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoChangeSummary {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor: Option<crate::undo::Actor>,
}

/// The folder a relative file-tool path resolves against: the managed
/// worktree the shell works in, else the attached folder the run may edit.
/// Shared by the executed call and the previews so all three agree.
fn rebase_base_for(
    data_folder: &Path,
    write_roots: &[PathBuf],
    edit_folder: Option<PathBuf>,
) -> Option<PathBuf> {
    handlers::working_folder(write_roots, data_folder)
        .or_else(|| edit_folder.filter(|f| f.is_dir()))
}

/// Rewrite `args` of a previewed `write`/`edit` the way [`execute_tool`] does
/// before it judges the call: relative `path` rebased onto the worktree or
/// edit folder the grant gives, then on-disk path repair. None when repair
/// refuses the path (the call will be refused anyway).
fn normalise_preview_args(
    data_folder: &str,
    session_id: &str,
    write_grant: Option<&str>,
    name: &str,
    path_args: &[&'static str],
    root: &Path,
    scratch: &Path,
    args: &serde_json::Value,
) -> Option<serde_json::Value> {
    let mut args = args.clone();
    let grant_roots: Vec<PathBuf> = write_grant
        .map(|id| crate::grants::resolve_all(id, session_id))
        .unwrap_or_default();
    let edit_folder = write_grant
        .filter(|id| crate::grants::main_writable(id, session_id))
        .and_then(|_| grant_roots.first().cloned());
    let mut write_roots = grant_roots;
    let (_, access_write) = crate::access::active_roots(
        Path::new(data_folder),
        session_id,
        crate::access::now_secs(),
    );
    for r in access_write {
        if !write_roots.contains(&r) {
            write_roots.push(r);
        }
    }
    crate::tools::path_repair::normalize_drive_args(name, path_args, &mut args);
    if let Some(base) = rebase_base_for(Path::new(data_folder), &write_roots, edit_folder) {
        handlers::rebase_relative_paths(name, &mut args, &base);
    }
    crate::tools::path_repair::repair_args_on_disk(name, path_args, &mut args, root, Some(scratch)).ok()?;
    Some(args)
}

/// The roots this session may write *now*: its own workspace, its scratch,
/// and whatever a live grant resolves to. Undo and redo are held to these, so
/// a grant withdrawn since the turn ran withdraws its undo too.
async fn writable_roots_now(
    data_folder: &str,
    session_id: &str,
    write_grant: Option<&str>,
    scope: Option<WorkspaceScope>,
) -> Result<Vec<PathBuf>, AgentToolsError> {
    let root = scope
        .unwrap_or_default()
        .ensure(Path::new(data_folder), session_id)
        .await?;
    let mut roots = vec![root, workspace::scratch_dir(session_id)];
    if let Some(id) = write_grant {
        roots.extend(crate::grants::resolve_all(id, session_id));
    }
    Ok(roots)
}

/// The turns of a session whose file changes can be undone or redone.
#[cfg_attr(feature = "tauri", tauri::command)]
pub fn undo_journal(data_folder: String, session_id: String) -> Vec<UndoTurnSummary> {
    crate::undo::load(Path::new(&data_folder), &session_id)
        .turns
        .into_iter()
        .map(|t| UndoTurnSummary {
            run: t.run.clone(),
            at: t.at.clone(),
            state: t.state,
            paths: t.files.iter().map(|f| f.path.clone()).collect(),
            actors: t.actors(),
            changes: t
                .files
                .iter()
                .map(|f| UndoChangeSummary {
                    path: f.path.clone(),
                    actor: f.actor.clone(),
                })
                .collect(),
        })
        .collect()
}

/// Undo the file changes one turn made. All of them, or none.
#[cfg_attr(feature = "tauri", tauri::command)]
pub async fn undo_turn(
    data_folder: String,
    session_id: String,
    run: String,
    write_grant: Option<String>,
    scope: Option<WorkspaceScope>,
) -> Result<crate::undo::UndoReport, AgentToolsError> {
    let roots =
        writable_roots_now(&data_folder, &session_id, write_grant.as_deref(), scope).await?;
    crate::undo::undo(Path::new(&data_folder), &session_id, &run, &roots)
        .map_err(|e| AgentToolsError::from(e.message()))
}

/// Redo the file changes of a turn that was undone. All of them, or none.
#[cfg_attr(feature = "tauri", tauri::command)]
pub async fn redo_turn(
    data_folder: String,
    session_id: String,
    run: String,
    write_grant: Option<String>,
    scope: Option<WorkspaceScope>,
) -> Result<crate::undo::UndoReport, AgentToolsError> {
    let roots =
        writable_roots_now(&data_folder, &session_id, write_grant.as_deref(), scope).await?;
    crate::undo::redo(Path::new(&data_folder), &session_id, &run, &roots)
        .map_err(|e| AgentToolsError::from(e.message()))
}

/// What a `write` or `edit` call would change, as the diff its approval prompt
/// shows. AH-146: the change is seen before it is allowed, not only after.
///
/// Computed by the same `preview_diff` the executed call reports, against the
/// same path resolution, so what is approved is what lands. Nothing is written.
///
/// Read only where the call could write: the session's workspace, its scratch
/// folder and a live grant. Anywhere else -- including through a symlink out
/// of them -- there is no preview. That call will be refused anyway, and a
/// preview must not become a way to read a file no tool may read.
#[cfg_attr(feature = "tauri", tauri::command)]
pub async fn preview_change(
    data_folder: String,
    session_id: String,
    name: String,
    args: serde_json::Value,
    write_grant: Option<String>,
    scope: Option<WorkspaceScope>,
) -> Result<Option<String>, AgentToolsError> {
    let Some(t) =
        previewable_target(&data_folder, &session_id, &name, &args, write_grant.as_deref(), scope).await?
    else {
        return Ok(None);
    };
    Ok(handlers::preview_diff(t.tool, &t.args, &t.ctx()).await)
}

/// The resolved target a `write`/`edit` preview reads: the tool, its args
/// after the executed call's rebase and repair, and the roots a [`ToolContext`]
/// is built from.
struct PreviewTarget {
    tool: &'static crate::tools::BuiltinTool,
    args: serde_json::Value,
    root: PathBuf,
    scratch: PathBuf,
    store: PathBuf,
}

impl PreviewTarget {
    fn ctx(&self) -> ToolContext<'_> {
        ToolContext::new(&self.root, &self.store, &[]).with_scratch_root(&self.scratch)
    }
}

/// Shared prologue of [`preview_change`] and [`check_write_secrets`]. `None`
/// when the call is not previewable: another tool, no path, or a target
/// outside every root the call could write.
async fn previewable_target(
    data_folder: &str,
    session_id: &str,
    name: &str,
    args: &serde_json::Value,
    write_grant: Option<&str>,
    scope: Option<WorkspaceScope>,
) -> Result<Option<PreviewTarget>, AgentToolsError> {
    if name != "write" && name != "edit" {
        return Ok(None);
    }
    let Some(tool) = lookup(name) else {
        return Ok(None);
    };
    if args.get("path").and_then(|v| v.as_str()).is_none() {
        return Ok(None);
    }
    let roots = writable_roots_now(data_folder, session_id, write_grant, scope).await?;
    let root = roots[0].clone();
    let scratch = workspace::ensure_scratch_dir(session_id).await?;
    // Same rebase and repair the executed call gets, so a relative path lands
    // in the granted folder the call will really write to.
    let Some(args) = normalise_preview_args(
        data_folder,
        session_id,
        write_grant,
        name,
        tool.path_args,
        &root,
        &scratch,
        args,
    ) else {
        return Ok(None);
    };
    let Some(raw) = args.get("path").and_then(|v| v.as_str()) else {
        return Ok(None);
    };
    let target = crate::tools::sandbox::resolve_path(&root, Some(&scratch), raw);
    // Canonical when it exists, so a link is judged by where it leads.
    let judged = crate::tools::sandbox::canonicalize_lenient(&target).unwrap_or_else(|_| target.clone());
    if !crate::undo::within(&judged, &roots) {
        return Ok(None);
    }
    let store = resolve_store(data_folder, None);
    Ok(Some(PreviewTarget { tool, args, root, scratch, store }))
}

/// One flagged line of a change a `write`/`edit` would make, for the
/// secret-write approval card. Carries where it is and a masked snippet, never
/// the value.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretWriteFinding {
    pub file: String,
    pub line: usize,
    pub rule: String,
    pub snippet: String,
}

/// What the credential scan finds in the change this `write`/`edit` would make,
/// so the renderer can put it to the user as an answerable card before the
/// call runs. Read-only; same reach as [`preview_change`] (only where the call
/// could write), and empty for any other tool.
#[cfg_attr(feature = "tauri", tauri::command)]
pub async fn check_write_secrets(
    data_folder: String,
    session_id: String,
    name: String,
    args: serde_json::Value,
    write_grant: Option<String>,
    scope: Option<WorkspaceScope>,
) -> Result<Vec<SecretWriteFinding>, AgentToolsError> {
    let Some(t) =
        previewable_target(&data_folder, &session_id, &name, &args, write_grant.as_deref(), scope).await?
    else {
        return Ok(Vec::new());
    };
    Ok(handlers::secret_findings(t.tool, &t.args, &t.ctx())
        .await
        .into_iter()
        .map(|f| SecretWriteFinding {
            file: f.file,
            line: f.line,
            rule: f.kind.as_str().to_string(),
            snippet: f.hint,
        })
        .collect())
}

/// Build the live-output sink.
///
/// `OutputSink` is `Fn`, not `FnMut`, so the sequence counter and the byte
/// budget live in atomics. The channel is `Clone + Send + Sync + 'static`, which
/// is what lets a detached background job keep reporting after the call that
/// created the sink has returned.
#[cfg(feature = "tauri")]
fn output_sink(
    channel: tauri::ipc::Channel<ToolOutputChunk>,
    call_id: Option<String>,
) -> crate::tools::OutputSink {
    budgeted_sink(call_id, move |chunk| channel.send(chunk).is_ok())
}

/// The sink's numbering and byte budget, around `send` (which says whether the
/// chunk was delivered). Shared by the channel sink and its tests (O03-022).
#[cfg_attr(not(feature = "tauri"), allow(dead_code))]
fn budgeted_sink<F>(call_id: Option<String>, send: F) -> crate::tools::OutputSink
where
    F: Fn(ToolOutputChunk) -> bool + Send + Sync + 'static,
{
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use std::sync::Arc;

    let seq = Arc::new(AtomicU64::new(0));
    let sent = Arc::new(AtomicUsize::new(0));
    let stopped = Arc::new(AtomicBool::new(false));
    Arc::new(move |text: String| {
        if stopped.load(Ordering::Acquire) {
            return;
        }
        let total = sent.fetch_add(text.len(), Ordering::Relaxed) + text.len();
        // One honest final chunk rather than silently going quiet: only the
        // call that flips `stopped` sends it, so racing calls send one marker.
        let payload = if total > MAX_STREAMED_BYTES {
            if stopped.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
                return;
            }
            "\n[output truncated in the live view]\n".to_string()
        } else {
            text
        };
        let chunk = ToolOutputChunk {
            seq: seq.fetch_add(1, Ordering::Relaxed),
            call_id: call_id.clone(),
            text: payload,
        };
        // A send error means the webview is gone; stop rather than keep trying
        // for the lifetime of a backgrounded job.
        if !send(chunk) {
            stopped.store(true, Ordering::Release);
        }
    })
}

mod mailbox;
pub use mailbox::*;

/// Write one audit record per resource this call touches.
///
/// Split out so the production gate call above stays readable, and so the
/// mapping from `Decision` to `Outcome` is in one place rather than repeated
/// across the match arms that follow it.
/// What joins a decision record to the rest of the log: the run and call it
/// belongs to (they were always passed in and never written, so every record
/// had empty `run`/`call`), the project it acts on, and what the renderer did
/// before calling.
#[derive(Debug, Clone, Copy, Default)]
struct DecisionContext<'a> {
    run: Option<&'a str>,
    call: Option<&'a str>,
    /// The attached project folder; the session workspace when there is none.
    project: Option<&'a str>,
    /// A `git` call the renderer has already put to the user and had allowed
    /// (web-app `coworkDispatch.ts` asks before every remote or destructive
    /// call, then calls this). No project `ask` rule applies to it.
    renderer_approved_git: bool,
    /// The user approved running this call outside the sandbox.
    unsandboxed: bool,
    /// An `Exec` prompt the enforcing sandbox makes unnecessary.
    sandbox_enforces: bool,
    /// How the renderer allowed this call before sending it, when it says.
    approval: Option<ApprovalSource>,
    /// Set when this call is refused right after the record is written.
    refusal: Option<Refusal>,
    /// The shell will run directly in a project folder, outside the sandbox.
    direct_edit: bool,
}

/// Why a call is refused after its decision is recorded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Refusal {
    /// A prompt this surface cannot satisfy (escape, missing approval).
    Prompt,
    /// A direct-edit-folder shell run with no user approval.
    DirectEdit,
}

/// Whether the match in `execute_tool_inner` lets a `Prompt` decision through.
/// Kept as one function so the audit record and the gate cannot disagree.
fn prompt_is_honoured(
    kind: PromptKind,
    name: &str,
    approval: Option<ApprovalSource>,
    no_ask_rule: bool,
    backend_enforces: bool,
) -> bool {
    let answered = matches!(approval, Some(ApprovalSource::Prompted | ApprovalSource::Bypass));
    match kind {
        PromptKind::Ask if name == "browser" && answered && no_ask_rule => true,
        PromptKind::Ask if crate::tools::is_always_ask(name) && answered && no_ask_rule => true,
        PromptKind::Ask => name == "git" && no_ask_rule,
        PromptKind::Write => !(name == "browser" && approval.is_none()),
        PromptKind::Exec => backend_enforces,
        PromptKind::WriteEscape | PromptKind::ReadEscape | PromptKind::Secret => false,
    }
}

/// The outcome to record for `decision`, given what already happened before
/// this call reached the backend. A `Prompt` is written only for a question
/// that is still open: recording "prompt" for a push the user had already
/// allowed (session 8411d403) read as an unanswered request.
fn recorded_outcome(
    decision: &Decision,
    cx: &DecisionContext<'_>,
) -> Option<(crate::audit::Outcome, String)> {
    use crate::audit::Outcome;
    match cx.refusal {
        Some(Refusal::Prompt) => {
            if let Decision::Prompt(kind) = decision {
                return Some((
                    Outcome::Deny,
                    format!("refused: needs user approval ({kind:?}) and none was valid"),
                ));
            }
        }
        Some(Refusal::DirectEdit) => {
            return Some((
                Outcome::Deny,
                "refused: direct edit folder run outside the sandbox without approval".to_string(),
            ));
        }
        None => {}
    }
    if cx.direct_edit && cx.approval.is_some() && matches!(decision, Decision::Prompt(PromptKind::Exec)) {
        return Some((
            Outcome::Granted,
            "ran outside the sandbox (direct edit folder)".to_string(),
        ));
    }
    match decision {
        Decision::Prompt(PromptKind::Ask) if cx.renderer_approved_git => {
            Some((Outcome::Granted, "approved in the prompt".to_string()))
        }
        Decision::Prompt(PromptKind::Exec) if cx.unsandboxed => Some((
            Outcome::Granted,
            "approved to run outside the sandbox".to_string(),
        )),
        Decision::Prompt(PromptKind::Exec) if cx.sandbox_enforces => {
            Some((Outcome::Allow, "confined by the sandbox".to_string()))
        }
        // The renderer answered this prompt before sending the call: say
        // whether the user was actually asked, instead of "prompt:Write".
        Decision::Prompt(_) => match cx.approval? {
            ApprovalSource::Prompted => {
                Some((Outcome::Granted, "approved in the prompt".to_string()))
            }
            ApprovalSource::Auto => Some((
                Outcome::Allow,
                "allowed without asking (mode or standing grant)".to_string(),
            )),
            ApprovalSource::Bypass => Some((
                Outcome::Allow,
                "auto-approved (Bypass): allowed without asking (bypass permissions mode)".to_string(),
            )),
            ApprovalSource::Secret => Some((
                Outcome::Granted,
                "approved in the prompt: write anyway (the credential check was answered for this one write)"
                    .to_string(),
            )),
        },
        _ => None,
    }
}

fn record_permission_decision(
    data_folder: &Path,
    thread_id: &str,
    tool: &crate::tools::BuiltinTool,
    args: &serde_json::Value,
    root: &Path,
    decision: &Decision,
    cx: &DecisionContext<'_>,
) {
    use crate::audit::{self, Outcome, PermissionRecord};
    use crate::tools::Capability;

    let (outcome, reason) = if let Some(known) = recorded_outcome(decision, cx) {
        known
    } else {
        match decision {
        Decision::Allow => (Outcome::Allow, String::new()),
        Decision::HardDeny(gate::DenyReason::Policy) => (Outcome::Deny, "policy".to_string()),
        Decision::HardDeny(gate::DenyReason::Hidden) => {
            (Outcome::Deny, "hidden-agent-state".to_string())
        }
        Decision::HardDeny(gate::DenyReason::GitInternals) => {
            (Outcome::Deny, "git-internals".to_string())
        }
        Decision::HardDeny(gate::DenyReason::Resource) => {
            (Outcome::Deny, "unresolvable-resource".to_string())
        }
        Decision::HardDeny(gate::DenyReason::DestructiveGit(op)) => {
            (Outcome::Deny, format!("destructive-git:{}", op.as_str()))
        }
        Decision::HardDeny(gate::DenyReason::NetworkOff) => {
            (Outcome::Deny, "network-off".to_string())
        }
        // The host, not the URL: a query string is where a token would be.
        Decision::HardDeny(gate::DenyReason::Domain(host)) => {
            (Outcome::Deny, format!("domain:{host}"))
        }
        // The file name only. Its contents are the thing being protected.
        Decision::HardDeny(gate::DenyReason::SecretFile(name)) => {
            (Outcome::Deny, format!("secret-file:{name}"))
        }
        // A prompt is a request that has not been answered yet; the answer is
        // recorded separately when it arrives.
        Decision::Prompt(kind) => (Outcome::Prompt, format!("prompt:{kind:?}")),
        }
    };

    let git_plan = (tool.name == "git")
        .then(|| crate::tools::git_tool::plan_from_args(args).ok())
        .flatten();
    let git_read = git_plan
        .as_ref()
        .is_some_and(|plan| plan.class == crate::tools::git_tool::GitClass::Read);
    let project = cx
        .project
        .map(str::to_string)
        .unwrap_or_else(|| root.to_string_lossy().into_owned());
    let stamp = |r: PermissionRecord| {
        r.with_project(project.clone())
            .with_agent("main")
            .with_run(cx.run.unwrap_or_default())
            .with_call(cx.call.unwrap_or_default())
    };
    let capability = match tool.capability {
        // `git status` is a read however the tool is declared: the audit said
        // "write" for every one, the same call the gate let through unasked.
        _ if git_read => "read",
        Capability::Read => "read",
        Capability::Write => "write",
        Capability::Exec => "exec",
        Capability::Net => "net",
    };

    // A git call's resource is the command line it runs, so `git push ...`
    // and the `git remote get-url` asked before it are told apart; the bare
    // tool name made both read "git".
    let resources = match &git_plan {
        Some(plan) => vec![crate::resource::Resource::command(&plan.display())],
        None => crate::resource::Resource::for_builtin(
            tool.name,
            tool.path_args,
            tool.capability == Capability::Net,
            args,
            Some(root),
        ),
    };
    let at = audit::now();
    // A call with no resolvable resource still gets a record: "nothing was
    // recorded" and "nothing was touched" must not look the same.
    if resources.is_empty() {
        let placeholder = crate::resource::Resource::Unknown {
            tool: tool.name.to_string(),
            why: "call names no resource".into(),
        };
        audit::append(
            data_folder,
            &stamp(PermissionRecord::new(
                at,
                thread_id,
                tool.name,
                capability,
                &placeholder,
                outcome,
                reason,
            )),
        );
        return;
    }
    for resource in &resources {
        audit::append(
            data_folder,
            &stamp(PermissionRecord::new(
                at.clone(),
                thread_id,
                tool.name,
                capability,
                resource,
                outcome,
                reason.clone(),
            )),
        );
    }
}

#[tauri::command]
pub async fn project_list_dir(
    data_folder: String,
    root: String,
    rel: String,
) -> Result<crate::project_browse::ProjectListing, AgentToolsError> {
    let canonical = workspace::validate_browse_root(Path::new(&root), Path::new(&data_folder))?;
    tokio::task::spawn_blocking(move || {
        crate::project_browse::list_dir(&canonical.to_string_lossy(), &rel)
    })
    .await
    .map_err(|e| AgentToolsError::from(e.to_string()))?
    .map_err(AgentToolsError::from)
}

/// Read one file of the attached read-only project for display in the code
/// viewer. Verbatim content, no model-facing truncation footer; size caps and
/// binary/sensitive refusal happen in `project_browse`.
#[tauri::command]
pub async fn project_read_file(
    data_folder: String,
    root: String,
    rel: String,
    allow_sensitive: Option<bool>,
) -> Result<crate::project_browse::ProjectFile, AgentToolsError> {
    let canonical = workspace::validate_browse_root(Path::new(&root), Path::new(&data_folder))?;
    tokio::task::spawn_blocking(move || {
        crate::project_browse::read_file(
            &canonical.to_string_lossy(),
            &rel,
            allow_sensitive.unwrap_or(false),
        )
    })
    .await
    .map_err(|e| AgentToolsError::from(e.to_string()))?
    .map_err(AgentToolsError::from)
}

/// Survey the attached folder for a starting `FLINT.md`. AH-209.
///
/// Reads only inside the folder, through the same confined listing and reader
/// as the Code panel; runs nothing; bounded, and says what it did not read.
#[tauri::command]
pub async fn project_survey(
    data_folder: String,
    root: String,
) -> Result<crate::project_init::Survey, AgentToolsError> {
    let workspace_root = workspace::permanent_store(Path::new(&data_folder));
    let canonical = workspace::validate_read_root(
        Path::new(&root),
        &workspace_root,
        Some(Path::new(&data_folder)),
    )?;
    tokio::task::spawn_blocking(move || {
        crate::project_init::survey(&canonical.to_string_lossy())
    })
    .await
    .map_err(|e| AgentToolsError::from(e.to_string()))?
    .map_err(AgentToolsError::from)
}

/// Write the description the user accepted as the folder's `FLINT.md`. AH-209.
///
/// The only write the initialization assistant makes, made because the user
/// accepted this text. The folder is validated the way a read of it is, so the
/// Jan data folder and anything overlapping the workspace are refused; an
/// existing `FLINT.md` is replaced only when `overwrite` says so.
#[tauri::command]
pub async fn project_init_accept(
    data_folder: String,
    root: String,
    content: String,
    overwrite: Option<bool>,
) -> Result<String, AgentToolsError> {
    let workspace_root = workspace::permanent_store(Path::new(&data_folder));
    let canonical = workspace::validate_read_root(
        Path::new(&root),
        &workspace_root,
        Some(Path::new(&data_folder)),
    )?;
    tokio::task::spawn_blocking(move || {
        crate::project_init::accept(&canonical, &content, overwrite.unwrap_or(false))
            .map(|p| p.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| AgentToolsError::from(e.to_string()))?
    .map_err(AgentToolsError::from)
}

/// The background shell commands one conversation started, newest first.
///
/// Read-only and non-consuming: a caller polling this can never take the
/// output the agent is waiting to collect with `bash {"job_id": ...}`.
/// `session` is the conversation (the `thread_id` its tool calls ran under);
/// another conversation's jobs are not listed.
#[tauri::command]
pub fn bash_jobs_list(session: String) -> Vec<crate::tools::handlers::BashJobStatus> {
    crate::tools::handlers::list_bash_jobs(Some(&session))
}

/// Kill one backgrounded shell command and every process it spawned.
///
/// The job entry survives the kill, so the agent's own
/// `bash {"job_id": ...}` collection still returns whatever the command
/// printed before it died rather than failing with an unknown id. The reported
/// outcome distinguishes a kill from "already finished" and "no such job", so a
/// UI never claims to have stopped something it did not.
///
/// Confined to `session`: another conversation's job reports `unknown`, the
/// same as no job, so an id cannot be used to probe for work elsewhere.
#[tauri::command]
pub fn bash_job_kill(job_id: String, session: String) -> crate::tools::handlers::BashJobKill {
    crate::tools::handlers::kill_bash_job(&job_id, Some(&session))
}

/// The most recent permission decisions the gate recorded, newest first.
///
/// Read-only: it reads `<data folder>/audit/permissions.jsonl` and nothing
/// else, returns at most `audit::RECENT_MAX` records, and redacts resource and
/// reason again on the way out. A missing log is an empty list, not an error.
#[tauri::command]
pub async fn permission_audit_recent(
    data_folder: String,
    limit: Option<usize>,
) -> Result<Vec<crate::audit::PermissionRecord>, AgentToolsError> {
    if data_folder.trim().is_empty() {
        return Err("no data folder to read the permission history from"
            .to_string()
            .into());
    }
    Ok(crate::audit::recent(
        Path::new(&data_folder),
        limit.unwrap_or(50),
    ))
}

/// The refusal for a read outside every root. It names the path that was
/// tried and the folders that are allowed, so a model that mistyped a long
/// path (one character off in an id) can see it and retry, instead of
/// concluding the file is unreachable.
fn read_escape_message(
    name: &str,
    args: &serde_json::Value,
    root: &Path,
    read_roots: &[PathBuf],
) -> String {
    let tried = ["path", "file_path", "dir", "directory", "cwd"]
        .iter()
        .find_map(|k| args.get(*k).and_then(|v| v.as_str()))
        .map(|p| format!(" ({p})"))
        .unwrap_or_default();
    let mut allowed: Vec<String> = read_roots.iter().map(|r| r.display().to_string()).collect();
    allowed.push(root.display().to_string());
    format!(
        "tool '{name}' was refused: that path{tried} is outside the workspace and every \
         folder the user has granted. Allowed folders: {}. First check the path for a \
         typo. Call request_access with the narrowest required path and explain why \
         access is needed, then retry this call. (Skill files are the \
         exception: read one with skill_read and its `file` argument; request_access \
         cannot grant Flint's own data folder.)",
        allowed.join(", ")
    )
}

#[cfg(test)]
mod tests;

