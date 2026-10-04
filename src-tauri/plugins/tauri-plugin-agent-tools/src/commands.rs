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
}

/// Everything `execute_tool_inner` needs to run a call again, kept by an
/// unsandboxed-retry offer. The command is the one that failed, not one the
/// renderer names at redemption time.
#[derive(Clone)]
struct RetryCall {
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

fn retry_offers() -> &'static crate::unsandboxed_retry::Offers<RetryCall> {
    static OFFERS: std::sync::OnceLock<crate::unsandboxed_retry::Offers<RetryCall>> =
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
) -> Result<String, AgentToolsError> {
    // The session's own workspace, which the folder must not overlap.
    let workspace =
        workspace::ensure_session_workspace(Path::new(&data_folder), &session_id).await?;
    Ok(crate::grants::authorize_with_extras(
        &session_id,
        &folder,
        &extra_folders.unwrap_or_default(),
        &workspace,
        Path::new(&data_folder),
    )?)
}

/// Withdraw one grant. Succeeds whether or not it was still live.
#[cfg_attr(feature = "tauri", tauri::command)]
pub fn direct_edit_revoke(grant_id: String) -> bool {
    crate::grants::revoke(&grant_id)
}

/// Withdraw every grant a session holds — detaching, switching, deleting.
#[cfg_attr(feature = "tauri", tauri::command)]
pub fn direct_edit_revoke_session(session_id: String) -> usize {
    crate::grants::revoke_session(&session_id)
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
        prefer the `read` tool over `cat`.";
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
    // or grant allowed it. Only recorded; it never widens what the gate allows.
    approval: Option<ApprovalSource>,
) -> Result<ToolResult, AgentToolsError> {
    execute_tool_inner(
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
        None,
        false,
        approval,
    )
    .await
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
    on_output: tauri::ipc::Channel<ToolOutputChunk>,
) -> Result<ToolResult, AgentToolsError> {
    let sink = output_sink(on_output, call_id.clone());
    execute_tool_inner(
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
        Some(sink),
        false,
        approval,
    )
    .await
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
    execute_tool_inner(
        call.data_folder,
        call.thread_id,
        call.project,
        call.name,
        call.args,
        call.enabled_skills,
        call.allow_network,
        call.read_only_project,
        call.write_grant,
        call.scope,
        call.call_id,
        call.undo_run,
        call.actor,
        call.extra_projects,
        None,
        true,
        None,
    )
    .await
}

/// Drop an unsandboxed-retry offer the user declined, so the id cannot be
/// redeemed later.
#[cfg(feature = "tauri")]
#[tauri::command]
pub async fn execute_tool_unsandboxed_withdraw(thread_id: String, retry: String) {
    retry_offers().withdraw(&retry, &thread_id);
}

#[allow(clippy::too_many_arguments)]
async fn execute_tool_inner(
    data_folder: String,
    thread_id: String,
    project: Option<String>,
    name: String,
    args: serde_json::Value,
    enabled_skills: Option<Vec<String>>,
    allow_network: Option<bool>,
    read_only_project: Option<String>,
    // An opaque grant id from `direct_edit_authorize`, naming a folder the user
    // confirmed for this session. Not a path: a path arriving here could be
    // anything the caller chose, whereas an id only resolves to the folder the
    // grant was issued for, and only in the session it was issued to. `None` is
    // every run that has not been authorized, which is the unchanged
    // sandbox-only behaviour.
    write_grant: Option<String>,
    scope: Option<WorkspaceScope>,
    call_id: Option<String>,
    // The run this call belongs to. Given, the files a `write` or `edit`
    // changes are journaled against it so the turn can be undone (AH-202).
    undo_run: Option<String>,
    // Who is making this call (AH-110): the subject spelling of the agent
    // (`agent`, `agent:<name>`, `role:<name>`) plus a display label and, for a
    // subagent, its parent. Journaled with every file the call changes, so a
    // change can always name the agent that made it. `None` records the change
    // without an actor, which reads as unknown rather than as anyone.
    actor: Option<ActorInput>,
    extra_projects: Option<Vec<String>>,
    sink: Option<crate::tools::OutputSink>,
    // True only for a call the user approved to run outside the sandbox,
    // redeemed through `execute_tool_unsandboxed_retry`.
    unsandboxed: bool,
    approval: Option<ApprovalSource>,
) -> Result<ToolResult, AgentToolsError> {
    // Kept before anything consumes the arguments, in case this call ends in
    // the one failure the user can be offered an unsandboxed retry for.
    let retry_call = (!unsandboxed && name == "bash").then(|| RetryCall {
        data_folder: data_folder.clone(),
        thread_id: thread_id.clone(),
        project: project.clone(),
        name: name.clone(),
        args: args.clone(),
        enabled_skills: enabled_skills.clone(),
        allow_network,
        read_only_project: read_only_project.clone(),
        write_grant: write_grant.clone(),
        scope,
        call_id: call_id.clone(),
        undo_run: undo_run.clone(),
        actor: actor.clone(),
        extra_projects: extra_projects.clone(),
    });
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
    let mut write_roots = write_roots;
    for root in access_write {
        if !write_roots.contains(&root) {
            write_roots.push(root);
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
    if let Some(base) = handlers::working_folder(&write_roots, Path::new(&data_folder)) {
        handlers::rebase_relative_paths(&name, &mut args, &base);
    }

    let tool = lookup(&name)
        .ok_or_else(|| AgentToolsError::from(format!("unknown built-in tool '{name}'")))?;

    // Transcript audit #5: `"C:	mp"` in JSON arrives as `C:<TAB>mp`. Put the
    // backslash back when that names something real, before the gate judges
    // the path; otherwise say what happened instead of "does not exist".
    let mut args = args;
    crate::tools::path_repair::repair_args_on_disk(&name, tool.path_args, &mut args, &root, Some(&scratch))
        .map_err(|e| AgentToolsError::from(format!("tool '{name}' was refused: {e}")))?;

    // The project's own policy, read from its `agent.toml` rather than assumed.
    // AH-007/AH-036/AH-037/AH-042: this call site used to build
    // `ToolPermissions::default()` -- allow everything -- so a repository that
    // denied a tool or a path was obeyed by the CLI and ignored by the
    // desktop. Read here, at the gate, because a policy passed in from the
    // renderer is one the caller can choose not to send.
    let policy = crate::policy::load(read_only_project.as_deref().map(Path::new), allow_network);
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
    let renderer_approved_git = matches!(decision, Decision::Prompt(PromptKind::Ask))
        && name == "git"
        && permissions
            .asks_call(&name, &[], &crate::subject::Subject::MainAgent)
            .is_none();
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
                && jail::backend().enforces(),
        },
    );

    match decision {
        Decision::Allow => {}
        Decision::HardDeny(gate::DenyReason::GitInternals) => {
            return Err(format!(
                "tool '{name}' was refused: it would change a repository's .git folder (hooks, config), which Git runs outside the sandbox. Use the `git` tool for repository changes."
            )
            .into());
        }
        Decision::HardDeny(gate::DenyReason::Hidden) => {
            return Err(format!(
                "tool '{name}' is denied: {} is the agent's own state directory and is hidden",
                crate::tools::sandbox::JAN_DIR
            )
            .into());
        }
        Decision::HardDeny(gate::DenyReason::Policy) => {
            return Err(format!("tool '{name}' is denied by policy").into());
        }
        // Say which of the two it was. "No network" and "not that host" call
        // for different things from the user, and one message for both sends
        // them to change the wrong setting.
        Decision::HardDeny(gate::DenyReason::NetworkOff) => {
            return Err(format!(
                "tool '{name}' was refused: this run has no network access. \
                 Nothing was sent. Work from what is already in the project, or \
                 ask the user to enable network access for it."
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
        Decision::Prompt(PromptKind::Ask)
            if name == "browser"
                && approval == Some(ApprovalSource::Prompted)
                && permissions
                    .asks_call(&name, &[], &crate::subject::Subject::MainAgent)
                    .is_none() => {}
        Decision::Prompt(PromptKind::Write) if name == "browser" && approval.is_none() => {
            return Err(
                "tool 'browser' needs user approval before it acts on a page, and none was recorded for this call"
                    .to_string()
                    .into(),
            );
        }
        Decision::Prompt(PromptKind::Exec) if jail::backend().enforces() => {}
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
        Decision::Prompt(PromptKind::Write) => {}
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
            return Err(format!(
                "tool '{name}' was refused: that path is outside the workspace and every \
                 folder the user has granted. Call request_access with the narrowest \
                 required path and explain why access is needed, then retry this call. \
                 (Skill files are the exception: read one with skill_read and its `file` \
                 argument; request_access cannot grant Flint's own data folder.)"
            )
            .into());
        }
        // A `git` call that writes to a remote or can lose work. The renderer
        // puts every one of these to the user, naming the command, remote and
        // branch, before it calls this (web-app `gitTool.ts`), the same way it
        // answers for `write` above. A project `ask` rule is different: the
        // renderer does not know about it, so that one is still refused here.
        Decision::Prompt(PromptKind::Ask)
            if name == "git"
                && permissions
                    .asks_call(&name, &[], &crate::subject::Subject::MainAgent)
                    .is_none() => {}
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
    // AH-174: the run a command's CPU and memory are kept against.
    if let Some(run) = undo_run.as_deref() {
        ctx = ctx.with_measured_run(run);
    }
    if let Some(sink) = sink {
        ctx = ctx.with_output_sink(sink);
    }
    if unsandboxed {
        ctx = ctx.with_unsandboxed_retry();
    } else if name == "bash" {
        // Edit access to a project folder means the shell works in it, as the
        // user's own terminal would. The Windows sandbox cannot even enter such
        // a folder, so the command runs there directly instead of failing.
        if let Some(folder) =
            handlers::direct_edit_shell_start(&write_roots, Path::new(&data_folder))
        {
            ctx = ctx.with_direct_edit_shell(folder);
        }
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
        .filter(|_| crate::unsandboxed_retry::qualifies(&name, !unsandboxed, is_error, &content))
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
    let policy = crate::policy::load(None, allow_network);
    let network = policy.network.allowed && allow_network.unwrap_or(false);
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
    if name != "write" && name != "edit" {
        return Ok(None);
    }
    let Some(tool) = lookup(&name) else {
        return Ok(None);
    };
    let Some(raw) = args.get("path").and_then(|v| v.as_str()) else {
        return Ok(None);
    };
    let roots =
        writable_roots_now(&data_folder, &session_id, write_grant.as_deref(), scope).await?;
    let root = roots[0].clone();
    let scratch = workspace::ensure_scratch_dir(&session_id).await?;
    let target = crate::tools::sandbox::resolve_path(&root, Some(&scratch), raw);
    // Canonical when it exists, so a link is judged by where it leads.
    let judged = target.canonicalize().unwrap_or_else(|_| target.clone());
    if !crate::undo::within(&judged, &roots) {
        return Ok(None);
    }
    let store = resolve_store(&data_folder, None);
    let ctx = ToolContext::new(&root, &store, &[]).with_scratch_root(&scratch);
    Ok(handlers::preview_diff(tool, &args, &ctx).await)
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
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use std::sync::Arc;

    let seq = Arc::new(AtomicU64::new(0));
    let sent = Arc::new(AtomicUsize::new(0));
    let stopped = Arc::new(AtomicBool::new(false));
    Arc::new(move |text: String| {
        if stopped.load(Ordering::Relaxed) {
            return;
        }
        let total = sent.fetch_add(text.len(), Ordering::Relaxed) + text.len();
        // One honest final chunk rather than silently going quiet.
        let payload = if total > MAX_STREAMED_BYTES {
            stopped.store(true, Ordering::Relaxed);
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
        if channel.send(chunk).is_err() {
            stopped.store(true, Ordering::Relaxed);
        }
    })
}

// ---------------------------------------------------------------------------
// Session messaging (docs/SESSION_MESSAGING.md)
// ---------------------------------------------------------------------------

use crate::session_mailbox::{
    MailEnvelope, Mailbox, MailboxError, SendReceipt, SessionRecord, SessionSummary,
};

/// Upsert a Cowork session in the mailbox registry. The project is recomputed
/// from `folder`, read-only. `accepts_messages` is the session's opt-out
/// switch; omitted, a known session keeps its setting.
#[tauri::command]
pub async fn mailbox_session_register(
    data_folder: String,
    session_id: String,
    display_name: String,
    folder: Option<String>,
    accepts_messages: Option<bool>,
) -> Result<SessionRecord, MailboxError> {
    Mailbox::open(Path::new(&data_folder)).register_with(
        &session_id,
        &display_name,
        folder.as_deref(),
        accepts_messages,
    )
}

/// Send a session's final answer back as the reply to a message its run
/// handled, unless it already replied. `None` when there was nothing to send.
#[tauri::command]
pub async fn mailbox_auto_reply(
    data_folder: String,
    from_session_id: String,
    reply_to: String,
    text: String,
) -> Result<Option<SendReceipt>, MailboxError> {
    Mailbox::open(Path::new(&data_folder)).auto_reply(&from_session_id, &reply_to, &text)
}

/// A run started (`running: true`) or ended.
#[tauri::command]
pub async fn mailbox_session_status(
    data_folder: String,
    session_id: String,
    running: bool,
    run_id: Option<String>,
) -> Result<(), MailboxError> {
    Mailbox::open(Path::new(&data_folder)).set_status(&session_id, running, run_id.as_deref())
}

/// Keep a running session's status fresh.
#[tauri::command]
pub async fn mailbox_session_heartbeat(
    data_folder: String,
    session_id: String,
    run_id: String,
) -> Result<(), MailboxError> {
    Mailbox::open(Path::new(&data_folder)).heartbeat(&session_id, &run_id)
}

/// A running session stopped on, or resumed from, a tool-approval prompt.
#[tauri::command]
pub async fn mailbox_session_waiting(
    data_folder: String,
    session_id: String,
    run_id: Option<String>,
    waiting: bool,
) -> Result<(), MailboxError> {
    Mailbox::open(Path::new(&data_folder)).set_waiting_approval(
        &session_id,
        run_id.as_deref(),
        waiting,
    )
}

/// Mark a session deleted; mail to it is refused from then on.
#[tauri::command]
pub async fn mailbox_session_remove(
    data_folder: String,
    session_id: String,
) -> Result<(), MailboxError> {
    Mailbox::open(Path::new(&data_folder)).remove(&session_id)
}

/// Clear a session's deleted mark and register it: the restore path of an
/// archived Cowork session (also recovers ones archived by older builds).
#[tauri::command]
pub async fn mailbox_session_revive(
    data_folder: String,
    session_id: String,
    display_name: String,
    folder: Option<String>,
) -> Result<SessionRecord, MailboxError> {
    Mailbox::open(Path::new(&data_folder)).revive(&session_id, &display_name, folder.as_deref())
}

/// Queued envelopes become `delivered` and are returned oldest first.
#[tauri::command]
pub async fn mailbox_take_for_delivery(
    data_folder: String,
    session_id: String,
) -> Result<Vec<MailEnvelope>, MailboxError> {
    Mailbox::open(Path::new(&data_folder)).take_for_delivery(&session_id)
}

/// Queued and delivered (unread) envelopes, without changing their state.
#[tauri::command]
pub async fn mailbox_pending(
    data_folder: String,
    session_id: String,
) -> Result<Vec<MailEnvelope>, MailboxError> {
    Mailbox::open(Path::new(&data_folder)).pending(&session_id)
}

/// Mark envelopes read. Returns how many changed.
#[tauri::command]
pub async fn mailbox_mark_read(
    data_folder: String,
    session_id: String,
    message_ids: Vec<String>,
) -> Result<usize, MailboxError> {
    Mailbox::open(Path::new(&data_folder)).mark_read(&session_id, &message_ids)
}

/// Claim envelopes at the moment they are delivered into the conversation:
/// not-yet-read ids become `read` and are returned; ids already read (a tool
/// consumed them) are left out and must not be delivered.
#[tauri::command]
pub async fn mailbox_claim(
    data_folder: String,
    session_id: String,
    message_ids: Vec<String>,
) -> Result<Vec<String>, MailboxError> {
    Mailbox::open(Path::new(&data_folder)).claim(&session_id, &message_ids)
}

/// The UI Reply action: `origin: "user"`, same limits as an agent's send.
#[tauri::command]
pub async fn mailbox_reply(
    data_folder: String,
    from_session_id: String,
    reply_to: String,
    text: String,
) -> Result<SendReceipt, MailboxError> {
    Mailbox::open(Path::new(&data_folder)).reply(&from_session_id, &reply_to, &text)
}

/// The sessions `session_id` may message, as the `list_sessions` tool sees them.
#[tauri::command]
pub async fn mailbox_list_sessions(
    data_folder: String,
    session_id: String,
) -> Result<Vec<SessionSummary>, MailboxError> {
    Mailbox::open(Path::new(&data_folder)).list_sessions(&session_id)
}

/// The user of `session_id` approved one `stop_session` call. Recorded in
/// memory for that call id, target and reason; the tool refuses without it.
/// Only the renderer's approval prompt calls this: no tool reaches it.
#[tauri::command]
pub async fn mailbox_stop_approve(
    data_folder: String,
    session_id: String,
    call_id: String,
    target_session_id: String,
    reason: String,
) -> Result<(), MailboxError> {
    Mailbox::open(Path::new(&data_folder)).approve_stop(
        &session_id,
        &call_id,
        &target_session_id,
        &reason,
    )
}

/// A stop request addressed to `session_id` that may be applied now, or
/// `null` (unknown, not addressed to it, resolved, or stale).
#[tauri::command]
pub async fn mailbox_stop_pending(
    data_folder: String,
    session_id: String,
    request_id: String,
) -> Result<Option<crate::session_mailbox::StopRequest>, MailboxError> {
    Mailbox::open(Path::new(&data_folder)).pending_stop(&session_id, &request_id)
}

/// The target's renderer reports whether it stopped the named run.
#[tauri::command]
pub async fn mailbox_stop_resolve(
    data_folder: String,
    session_id: String,
    request_id: String,
    applied: bool,
    run_id: Option<String>,
) -> Result<crate::session_mailbox::StopRequest, MailboxError> {
    Mailbox::open(Path::new(&data_folder)).resolve_stop(
        &session_id,
        &request_id,
        applied,
        run_id.as_deref(),
    )
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    #[test]
    fn tool_result_serializes_images_camel_case_and_omits_when_empty() {
        let mut r = ToolResult {
            content: "Read image a.png (image/png, 3 bytes)".into(),
            diff: None,
            is_error: false,
            error: None,
            resources: None,
            unsandboxed_retry: None,
            images: vec![crate::tools::ImageContentPart {
                data_url: "data:image/png;base64,QUJD".into(),
                name: "a.png".into(),
            }],
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["images"][0]["dataUrl"], "data:image/png;base64,QUJD");
        assert_eq!(v["images"][0]["name"], "a.png");
        r.images.clear();
        let v = serde_json::to_value(&r).unwrap();
        assert!(v.get("images").is_none());
    }

    #[test]
    fn note_non_posix_shell_amends_only_the_description() {
        let bash = json!({
            "type": "function",
            "function": { "name": "bash", "description": "Run a shell command." }
        });
        let noted = note_non_posix_shell(bash);
        let desc = noted["function"]["description"].as_str().unwrap();
        assert!(desc.starts_with("Run a shell command."));
        assert!(desc.contains("Windows PowerShell"));
        assert!(desc.contains("does not accept `&&`"));
        assert!(desc.contains("`2>$null`"));
        // The name is untouched; only the description grows.
        assert_eq!(noted["function"]["name"], "bash");
    }

    /// Session 8411d403's audit: a push the user had allowed was written as
    /// an open "prompt", with empty run and call ids, under the tool name
    /// "git" -- the same text as the `git remote get-url` asked before it.
    #[test]
    fn a_decision_record_carries_its_run_call_project_and_answer() {
        let data = unique_data_folder();
        std::fs::create_dir_all(&data).unwrap();
        let tool = lookup("git").unwrap();
        let args = json!({"args": ["push", "-u", "origin", "fix/x"]});
        let root = data.join("ws");
        record_permission_decision(
            &data,
            "s1",
            tool,
            &args,
            &root,
            &Decision::Prompt(PromptKind::Ask),
            &DecisionContext {
                run: Some("run-1"),
                call: Some("call-1"),
                project: Some(r"C:\repo"),
                renderer_approved_git: true,
                ..Default::default()
            },
        );
        let bash = lookup("bash").unwrap();
        record_permission_decision(
            &data,
            "s1",
            bash,
            &json!({"command": "go build ./..."}),
            &root,
            &Decision::Prompt(PromptKind::Exec),
            &DecisionContext { unsandboxed: true, ..Default::default() },
        );
        let all = crate::audit::read_all(&data);
        assert_eq!(all.len(), 2, "{all:?}");
        let push = &all[0];
        assert_eq!(push.run, "run-1");
        assert_eq!(push.call, "call-1");
        assert_eq!(push.project, r"C:\repo");
        assert_eq!(push.agent, "main");
        assert_eq!(push.capability, "write");
        assert_eq!(push.decision, crate::audit::Outcome::Granted);
        assert!(push.resource.contains("git push -u origin fix/x"), "{}", push.resource);
        let retry = &all[1];
        assert_eq!(retry.decision, crate::audit::Outcome::Granted);
        assert!(retry.reason.contains("outside the sandbox"), "{}", retry.reason);
        assert_eq!(retry.project, root.to_string_lossy(), "no attached folder: the workspace");
        let _ = std::fs::remove_dir_all(&data);
    }

    /// An edit the renderer already allowed was logged as "prompt:Write". The
    /// record now says whether the user was asked or a mode allowed it; with
    /// no source given it stays an open prompt.
    #[test]
    fn a_renderer_allowed_write_records_whether_the_user_was_asked() {
        let data = unique_data_folder();
        std::fs::create_dir_all(&data).unwrap();
        let root = data.join("ws");
        let write = lookup("write").unwrap();
        let args = json!({"path": "a.txt", "content": "x"});
        for approval in [Some(ApprovalSource::Prompted), Some(ApprovalSource::Auto), None] {
            record_permission_decision(
                &data,
                "s1",
                write,
                &args,
                &root,
                &Decision::Prompt(PromptKind::Write),
                &DecisionContext { approval, ..Default::default() },
            );
        }
        let all = crate::audit::read_all(&data);
        assert_eq!(all.len(), 3, "{all:?}");
        assert_eq!(all[0].decision, crate::audit::Outcome::Granted);
        assert_eq!(all[0].reason, "approved in the prompt");
        assert_eq!(all[1].decision, crate::audit::Outcome::Allow);
        assert!(all[1].reason.contains("without asking"), "{}", all[1].reason);
        assert_eq!(all[2].decision, crate::audit::Outcome::Prompt);
        assert_eq!(all[2].reason, "prompt:Write");
        let _ = std::fs::remove_dir_all(&data);
    }

    /// The output sink test's shared ledger: what was sent, tagged with call id.
    type Seen = Arc<Mutex<Vec<(u64, Option<String>, String)>>>;

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// A temp dir standing in for the Jan data folder.
    fn unique_data_folder() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("jan_cmd_test_{}_{}", std::process::id(), n))
    }

    /// A folder that is *not* under the host temp dir. On Linux an absolute
    /// `/tmp/...` path is remapped into the session scratch, which would route
    /// an attached-folder test through the wrong branch entirely.
    fn repo_outside_tmp(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("attach-tests")
            .join(format!("{tag}_{}_{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).expect("create test repo");
        dir
    }

    const T1: &str = "thread-one";

    /// A thread id no other test uses. The session scratch is keyed by thread
    /// id, so tests sharing one share a scratch -- and a test that deletes its
    /// thread deletes the scratch another test is about to run bash in. The
    /// scratch goes when the returned session is dropped at the end of the test.
    fn unique_thread(tag: &str) -> workspace::TestSession {
        workspace::TestSession::new(format!(
            "{tag}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ))
    }

    #[test]
    fn default_store_is_permanent_and_outside_any_sandbox() {
        let store = resolve_store("/data", None);
        assert_eq!(store, Path::new("/data/agent-workspace"));
        // The sandbox lives under threads/, so no relative path from inside one
        // reaches the store without escaping it.
        let sandbox = workspace::thread_workspace(Path::new("/data"), T1).unwrap();
        assert!(!workspace::store_dir(&store, "memory").starts_with(&sandbox));
    }

    #[test]
    fn explicit_project_uses_its_co_located_store() {
        assert_eq!(
            resolve_store("/data", Some("/repo")),
            Path::new("/repo/.jan/agent")
        );
        // Blank is treated as absent, not as the filesystem root.
        assert_eq!(
            resolve_store("/data", Some("   ")),
            Path::new("/data/agent-workspace")
        );
    }

    #[test]
    fn error_strips_the_tool_protocol_prefix() {
        let e = AgentToolsError::from("ERROR: invalid name '..'".to_string());
        assert_eq!(e.message, "invalid name '..'");
        let e = AgentToolsError::from("plain message".to_string());
        assert_eq!(e.message, "plain message");
    }

    /// Writes land in the thread's ephemeral sandbox and are allowed there. This
    /// pins the containment that makes that safe: the file appears where it was
    /// asked for, and nowhere else.
    /// AH-110: a call that names who it is acting for has its changes
    /// journaled under that agent; one that names something that is not an
    /// agent is refused before the tool runs, so no change is left to be
    /// attributed later.
    #[tokio::test]
    async fn a_tool_call_journals_its_agent_and_refuses_an_identity_that_is_not_one() {
        let data = unique_data_folder();
        let df = data.to_string_lossy().to_string();
        let t1 = "s-actor";
        let actor = |id: &str, label: &str| {
            Some(ActorInput {
                id: id.into(),
                label: Some(label.into()),
                parent: None,
                invocation: Some("inv-1".into()),
                task: None,
            })
        };

        let out = execute_tool(
            df.clone(),
            t1.into(),
            None,
            "write".into(),
            json!({"path": "by-main.txt", "content": "hello"}),
            None,
            None,
            None,
            None,
            None,
            None,
            Some("run-1".into()),
            actor("agent", ""),
            None,
            None,
        )
        .await
        .expect("the write runs");
        assert!(!out.is_error, "{}", out.content);

        let out = execute_tool(
            df.clone(),
            t1.into(),
            None,
            "write".into(),
            json!({"path": "by-child.txt", "content": "hello"}),
            None,
            None,
            None,
            None,
            None,
            None,
            Some("run-1".into()),
            actor("agent:explorer", "Explorer"),
            None,
            None,
        )
        .await
        .expect("the write runs");
        assert!(!out.is_error, "{}", out.content);

        let turns = undo_journal(df.clone(), t1.into());
        let turn = turns.iter().find(|t| t.run == "run-1").expect("the turn");
        assert_eq!(turn.actors.len(), 2, "{:?}", turn.actors);
        let of = |name: &str| {
            turn.changes
                .iter()
                .find(|c| c.path.ends_with(name))
                .and_then(|c| c.actor.clone())
                .unwrap_or_else(|| panic!("no actor for {name}"))
        };
        assert_eq!(of("by-main.txt").kind, crate::undo::ActorKind::Primary);
        assert_eq!(of("by-main.txt").label, "the primary agent");
        let child = of("by-child.txt");
        assert_eq!((child.id.as_str(), child.label.as_str()), ("agent:explorer", "Explorer"));
        assert_eq!(child.invocation.as_deref(), Some("inv-1"));

        // Not an agent: refused, and nothing written.
        let err = execute_tool(
            df.clone(),
            t1.into(),
            None,
            "write".into(),
            json!({"path": "forged.txt", "content": "hello"}),
            None,
            None,
            None,
            None,
            None,
            None,
            Some("run-1".into()),
            actor("session:s-actor", "The user"),
            None,
            None,
        )
        .await
        .expect_err("an identity that is not an agent is refused");
        assert!(format!("{err:?}").contains("does not name an agent"), "{err:?}");
        let sandbox = workspace::thread_workspace(&data, t1).unwrap();
        assert!(!sandbox.join("forged.txt").exists(), "a refused call wrote a file");
        let turns = undo_journal(df, t1.into());
        assert!(
            turns.iter().all(|t| t.changes.iter().all(|c| !c.path.ends_with("forged.txt"))),
            "a refused call reached the journal"
        );
        let _ = std::fs::remove_dir_all(&data);
    }

    #[tokio::test]
    async fn writes_are_allowed_inside_the_ephemeral_sandbox() {
        let t1: &str = &unique_thread("writes_are_allowed_inside_the_ephemeral_sandbox");
        let data = unique_data_folder();
        let df = data.to_string_lossy().to_string();

        let out = execute_tool(
            df.clone(),
            t1.into(),
            None,
            "write".into(),
            json!({"path": "a.txt", "content": "hello"}),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .expect("a write inside the sandbox is allowed");
        assert!(!out.is_error, "got: {}", out.content);

        let sandbox = workspace::thread_workspace(&data, t1).unwrap();
        assert_eq!(
            std::fs::read_to_string(sandbox.join("a.txt")).ok(),
            Some("hello".to_string())
        );
        let _ = std::fs::remove_dir_all(&data);
    }

    /// AH-146: an approval prompt sees the change before it is allowed. The
    /// preview is the diff the call would make, nothing is written, and a path
    /// outside where the call could write has no preview at all -- so the
    /// preview cannot be used to read a file no tool may read.
    #[tokio::test]
    async fn a_change_is_previewed_before_it_is_allowed_and_only_where_it_could_land() {
        let data = unique_data_folder();
        let df = data.to_string_lossy().to_string();
        let sandbox = workspace::thread_workspace(&data, T1).unwrap();
        std::fs::create_dir_all(&sandbox).unwrap();
        std::fs::write(sandbox.join("a.txt"), "old line\n").unwrap();

        let shown = preview_change(
            df.clone(),
            T1.into(),
            "write".into(),
            json!({"path": "a.txt", "content": "new line\n"}),
            None,
            None,
        )
        .await
        .expect("answered")
        .expect("a diff for a change inside the workspace");
        assert!(shown.contains("overwrote") && shown.contains("new line"), "{shown}");
        assert_eq!(
            std::fs::read_to_string(sandbox.join("a.txt")).unwrap(),
            "old line\n",
            "a preview must not write"
        );

        let edit = preview_change(
            df.clone(),
            T1.into(),
            "edit".into(),
            json!({"path": "a.txt", "edits": [{"old_string": "old line", "new_string": "edited"}]}),
            None,
            None,
        )
        .await
        .expect("answered")
        .expect("a diff for an edit");
        assert!(edit.contains("-") && edit.contains("edited"), "{edit}");

        // Outside every root this session may write: no preview.
        let outside = data.join("outside-secret.txt");
        std::fs::write(&outside, "SECRET\n").unwrap();
        for path in [outside.to_string_lossy().to_string(), "../../../outside-secret.txt".into()] {
            let none = preview_change(
                df.clone(),
                T1.into(),
                "edit".into(),
                json!({"path": path, "edits": [{"old_string": "SECRET", "new_string": "x"}]}),
                None,
                None,
            )
            .await
            .expect("answered");
            assert!(none.is_none(), "previewed {path} outside the workspace: {none:?}");
        }
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "SECRET\n");

        // Only file-changing tools have one.
        let read = preview_change(
            df.clone(),
            T1.into(),
            "read".into(),
            json!({"path": "a.txt"}),
            None,
            None,
        )
        .await
        .expect("answered");
        assert!(read.is_none());
        let _ = std::fs::remove_dir_all(&data);
    }

    /// AH-202 through the real command: a write made for a run is journaled at
    /// the path the handler wrote, undoing the turn removes it, and redoing it
    /// brings it back. A write with no run is not journaled.
    #[tokio::test]
    async fn a_turns_write_can_be_undone_and_redone_through_the_commands() {
        let data = unique_data_folder();
        let df = data.to_string_lossy().to_string();
        let sandbox = workspace::thread_workspace(&data, T1).unwrap();

        let out = execute_tool(
            df.clone(),
            T1.into(),
            None,
            "write".into(),
            json!({"path": "a.txt", "content": "from the turn"}),
            None,
            None,
            None,
            None,
            None,
            None,
            Some("run-1".into()),
            None,
            None,
            None,
        )
        .await
        .expect("allowed");
        assert!(!out.is_error, "got: {}", out.content);
        let journal = undo_journal(df.clone(), T1.into());
        assert_eq!(journal.len(), 1);
        assert_eq!(journal[0].run, "run-1");

        undo_turn(df.clone(), T1.into(), "run-1".into(), None, None)
            .await
            .expect("a clean undo");
        assert!(!sandbox.join("a.txt").exists(), "undo removed the created file");
        redo_turn(df.clone(), T1.into(), "run-1".into(), None, None)
            .await
            .expect("a clean redo");
        assert_eq!(
            std::fs::read_to_string(sandbox.join("a.txt")).ok(),
            Some("from the turn".to_string())
        );

        // The user edits it; undoing now is refused and names the file.
        std::fs::write(sandbox.join("a.txt"), "the user's").unwrap();
        let err = undo_turn(df.clone(), T1.into(), "run-1".into(), None, None)
            .await
            .expect_err("a changed file refuses the undo");
        assert!(err.message.contains("a.txt"), "{}", err.message);
        assert_eq!(
            std::fs::read_to_string(sandbox.join("a.txt")).ok(),
            Some("the user's".to_string())
        );

        // Without a run there is nothing to undo from.
        execute_tool(
            df.clone(),
            T1.into(),
            None,
            "write".into(),
            json!({"path": "b.txt", "content": "unowned"}),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .expect("allowed");
        assert_eq!(undo_journal(df.clone(), T1.into()).len(), 1);
        let _ = std::fs::remove_dir_all(&data);
    }

    /// `edit` returns a display-only diff. It must reach the caller (the UI needs
    /// it) while staying out of `content`, which is what the model sees.
    #[tokio::test]
    async fn edit_returns_a_diff_for_display_only() {
        let t1: &str = &unique_thread("edit_returns_a_diff_for_display_only");
        let data = unique_data_folder();
        let df = data.to_string_lossy().to_string();
        let sandbox = workspace::ensure_thread_workspace(&data, t1).await.unwrap();
        std::fs::write(sandbox.join("a.txt"), b"before").unwrap();

        let out = execute_tool(
            df.clone(),
            t1.into(),
            None,
            "edit".into(),
            json!({"path": "a.txt", "edits": [{"old_string": "before", "new_string": "after"}]}),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert!(!out.is_error, "got: {}", out.content);
        let diff = out.diff.expect("edit must report a diff");
        assert!(
            diff.contains("after"),
            "diff should show the change: {diff}"
        );
        assert!(
            !out.content.contains(&diff),
            "the diff must not be duplicated into model-facing content"
        );
        let _ = std::fs::remove_dir_all(&data);
    }

    /// The gate still decides: a read that escapes the sandbox is a `Prompt` and
    /// stays refused, so allowing writes did not open the door generally.
    #[tokio::test]
    async fn escaping_reads_are_still_refused() {
        let t1: &str = &unique_thread("escaping_reads_are_still_refused");
        let data = unique_data_folder();
        let df = data.to_string_lossy().to_string();

        let err = execute_tool(
            df.clone(),
            t1.into(),
            None,
            "read".into(),
            json!({"path": "../../../etc/hostname"}),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .expect_err("an escaping read must be refused");
        assert!(
            err.message.contains("is outside the workspace and every folder the user has granted"),
            "unexpected error {}",
            err.message
        );
        let _ = std::fs::remove_dir_all(&data);
    }

    /// A write that escapes the sandbox (absolute or `..`) must be refused on
    /// the desktop surface, just like an escaping read -- it could reach host
    /// files. The session scratch is the exception: it is the agent's own area,
    /// spelled `/tmp/...` where it is bound over the sandbox's `/tmp` and by its
    /// real path where nothing is mounted there.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn escaping_writes_are_refused() {
        let t_scratch: &str = &unique_thread("escaping_writes_are_refused");
        let data = unique_data_folder();
        let df = data.to_string_lossy().to_string();

        for path in ["../escape.txt", "/etc/hosts", "/home/akarshan/.bashrc"] {
            let err = execute_tool(
                df.clone(),
                t_scratch.into(),
                None,
                "write".into(),
                json!({"path": path, "content": "x"}),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            None,
            )
            .await
            .expect_err("an escaping write must be refused");
            assert!(
                err.message.contains("outside the agent workspace"),
                "unexpected error {}",
                err.message
            );
        }

        // A scratch write is not a host escape and succeeds, under whichever
        // spelling reaches the scratch on this platform. The scratch outlives the
        // test process, so the name is per-run: a leftover file would answer
        // "No change" instead of "Created".
        // The sweep test collects every scratch in the shared temp dir; without
        // this it can delete ours between the write and the assertion.
        let scratch = crate::workspace::ensure_scratch_dir(t_scratch)
            .await
            .unwrap();
        let name = format!("jan_cmd_scratch_{}.txt", std::process::id());
        let (requested, expected) = if cfg!(target_os = "linux") {
            let p = format!("/tmp/{name}");
            (p.clone(), p)
        } else {
            let p = scratch.join(&name).to_string_lossy().into_owned();
            (p.clone(), p)
        };
        let res = execute_tool(
            df.clone(),
            t_scratch.into(),
            None,
            "write".into(),
            json!({"path": requested, "content": "x"}),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .expect("a scratch write is the session scratch and must succeed");
        assert!(
            res.content.starts_with(&format!("Created {expected}")),
            "got: {}",
            res.content
        );
        let _ = std::fs::remove_file(scratch.join(&name));

        // An in-sandbox write still succeeds, so we didn't over-tighten.
        let res = execute_tool(
            df.clone(),
            t_scratch.into(),
            None,
            "write".into(),
            json!({"path": "ok.txt", "content": "x"}),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .expect("an in-workspace write must succeed");
        assert_eq!(res.content, "Created ok.txt (1 bytes)");
        let _ = std::fs::remove_dir_all(&data);
    }

    /// The status the frontend gates on must agree with what execution actually
    /// does, or the tool list and the executor disagree about whether bash works.
    #[tokio::test]
    async fn sandbox_status_matches_the_backend_execution_uses() {
        let status = sandbox_status().await.unwrap();
        assert_eq!(status.enforces, jail::backend().enforces());
        assert_eq!(status.backend, jail::backend().as_str());
        assert_ne!(status.backend, "", "a backend always has a name");
        assert_eq!(status.enforces, status.backend != "none");
    }

    /// `bash` availability tracks the sandbox, in both directions: it runs when
    /// the OS can confine it and is refused when it cannot. Asserting both arms
    /// keeps the fallback honest on hosts (and CI images) with no backend.
    #[tokio::test]
    async fn bash_runs_only_when_the_sandbox_can_enforce() {
        let t1: &str = &unique_thread("bash_runs_only_when_the_sandbox_can_enforce");
        let data = unique_data_folder();
        let df = data.to_string_lossy().to_string();

        let result = execute_tool(
            df.clone(),
            t1.into(),
            None,
            "bash".into(),
            json!({"command": "echo hi"}),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;

        if jail::backend().enforces() {
            let out = result.expect("sandboxed bash should run");
            assert!(!out.is_error, "got: {}", out.content);
            assert!(out.content.contains("hi"), "got: {}", out.content);
        } else {
            let out = result.expect("the refusal is a tool result, not an IPC error");
            assert!(out.is_error);
            assert!(
                out.content.contains("no OS sandbox"),
                "the model must be told why, got: {}",
                out.content
            );
        }
        let _ = std::fs::remove_dir_all(&data);
    }

    /// Windows, end to end: under "Edit this folder" the sandboxed shell writes
    /// the authorized folder and its extra folders and not the one beside
    /// them; under Review only it reads an attached folder and cannot write
    /// it; once the grant is revoked the shell cannot write the folder again.
    #[cfg(windows)]
    #[tokio::test]
    async fn the_windows_shell_edits_only_authorized_folders() {
        if jail::backend() != jail::Backend::AppContainer {
            eprintln!("skipping: AppContainer is not available here");
            return;
        }
        let sid: &str = &unique_thread("windows_edit_folder");
        let data = unique_data_folder();
        let df = data.to_string_lossy().to_string();
        let repo = repo_outside_tmp("ac-edit");
        let extra = repo_outside_tmp("ac-extra");
        let sibling = repo_outside_tmp("ac-sibling");
        std::fs::write(sibling.join("notes.txt"), b"sibling notes").unwrap();
        let fwd = |p: &Path| p.to_string_lossy().replace('\\', "/");
        let bash = |command: String, project: Option<String>, grant: Option<String>| {
            execute_tool(
                df.clone(),
                sid.into(),
                None,
                "bash".into(),
                json!({ "command": command }),
                None,
                None,
                project,
                grant,
                Some(WorkspaceScope::Session),
                None,
                None,
                None,
                None,
            None,
            )
        };

        let grant = direct_edit_authorize(
            df.clone(),
            sid.into(),
            repo.to_string_lossy().into(),
            Some(vec![extra.to_string_lossy().into()]),
        )
        .await
        .expect("the folder is authorized");
        for (dir, name) in [(&repo, "in-repo.txt"), (&extra, "in-extra.txt"), (&sibling, "in-sibling.txt")] {
            let _ = bash(
                format!("echo edited > \"{}/{name}\"", fwd(dir)),
                Some(repo.to_string_lossy().into()),
                Some(grant.clone()),
            )
            .await;
        }
        assert!(repo.join("in-repo.txt").exists(), "the authorized folder was not writable");
        assert!(extra.join("in-extra.txt").exists(), "the extra folder was not writable");
        assert!(!sibling.join("in-sibling.txt").exists(), "a folder beside them was written");

        // Review only: the sibling attached, no grant.
        direct_edit_revoke(grant);
        let out = bash(
            format!("cat \"{}/notes.txt\"", fwd(&sibling)),
            Some(sibling.to_string_lossy().into()),
            None,
        )
        .await
        .expect("runs");
        assert!(out.content.contains("sibling notes"), "the attached folder was not readable: {}", out.content);
        let _ = bash(
            format!("echo x > \"{}/review.txt\"", fwd(&sibling)),
            Some(sibling.to_string_lossy().into()),
            None,
        )
        .await;
        assert!(!sibling.join("review.txt").exists(), "Review only wrote the attached folder");
        let _ = bash(
            format!("echo x > \"{}/after-revoke.txt\"", fwd(&repo)),
            Some(repo.to_string_lossy().into()),
            None,
        )
        .await;
        assert!(!repo.join("after-revoke.txt").exists(), "the revoked folder stayed writable");

        for dir in [&repo, &extra, &sibling] {
            let _ = std::fs::remove_dir_all(dir);
        }
        let _ = std::fs::remove_dir_all(&data);
    }

    /// The network flag has to survive the whole IPC -> ToolContext -> jail path.
    /// Only the closed direction is asserted: opening it would make the test
    /// depend on the host actually having connectivity.
    #[tokio::test]
    async fn bash_has_no_network_unless_the_caller_asks() {
        let t1: &str = &unique_thread("bash_has_no_network_unless_the_caller_asks");
        if !jail::backend().enforces() {
            eprintln!("skipping: no sandbox backend on this host");
            return;
        }
        let data = unique_data_folder();
        let df = data.to_string_lossy().to_string();
        // The probe has to be written for the shell `execute_tool` will pick,
        // so the flavour is asked of the same policy that call builds: this
        // thread's own workspace and scratch. It used to ask about the shared
        // host temp dir, a different policy whose answer need not match.
        let workspace = crate::workspace::ensure_thread_workspace(&data, t1)
            .await
            .unwrap();
        let scratch = crate::workspace::ensure_scratch_dir(t1).await.unwrap();
        let command = network_probe(&workspace, &scratch);

        let out = execute_tool(
            df.clone(),
            t1.into(),
            None,
            "bash".into(),
            // A connection attempt written for whichever shell will actually
            // run it. `/dev/tcp` is a bash builtin, and on a host whose
            // sandboxed shell is PowerShell -- which on Windows is every host,
            // because the MSYS2 runtime Git Bash needs cannot start inside an
            // AppContainer -- it is a parse error, so the test failed on
            // syntax rather than on whether the network was reachable.
            json!({ "command": command }),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert!(!out.content.contains("connected"), "got: {}", out.content);
        assert!(
            out.content.contains("Network access is disabled"),
            "a network refusal must explain itself, got: {}",
            out.content
        );
        let _ = std::fs::remove_dir_all(&data);
        let _ = crate::workspace::remove_scratch_dir(t1).await;
    }

    /// Try to open a TCP connection, in the language the sandboxed shell speaks.
    ///
    /// Success prints `connected`; the assertion is that it never does.
    fn network_probe(workspace: &Path, scratch: &Path) -> String {
        use crate::tools::{jail, proc::ShellFlavor};
        let policy = jail::Policy::new(workspace, false).with_scratch_root(scratch);
        match jail::select_shell(&policy)
            .ok()
            .map(|s| s.report.cfg.flavor)
        {
            Some(ShellFlavor::PowerShell) => {
                // No `catch`: the refusal has to reach stderr for Jan to
                // recognise it and explain itself. Swallowing it leaves a bare
                // `[exit 1]`, which is exactly the unexplained failure the
                // hint exists to prevent.
                "$c = New-Object Net.Sockets.TcpClient('1.1.1.1', 53); if ($c.Connected) { 'connected' }"
                    .to_string()
            }
            Some(ShellFlavor::Cmd) => {
                // `cmd` has no socket primitive; the closest stock probe.
                "ping -n 1 -w 1000 1.1.1.1 && echo connected".to_string()
            }
            _ => "exec 3<>/dev/tcp/1.1.1.1/53 && echo connected".to_string(),
        }
    }

    /// The sandbox is created by `execute_tool` itself. Without that, the very
    /// first tool call of a thread would be refused: `escapes_project`
    /// canonicalizes the root and a missing root reads as an escape.
    #[tokio::test]
    async fn first_tool_call_creates_the_sandbox() {
        let t1: &str = &unique_thread("first_tool_call_creates_the_sandbox");
        let data = unique_data_folder();
        let df = data.to_string_lossy().to_string();

        let out = execute_tool(
            df.clone(),
            t1.into(),
            None,
            "ls".into(),
            json!({}),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert!(!out.is_error, "got: {}", out.content);
        assert!(workspace::thread_workspace(&data, t1).unwrap().is_dir());
        let _ = std::fs::remove_dir_all(&data);
    }

    #[tokio::test]
    async fn allowed_read_runs_in_the_thread_sandbox() {
        let t1: &str = &unique_thread("allowed_read_runs_in_the_thread_sandbox");
        let data = unique_data_folder();
        let df = data.to_string_lossy().to_string();
        let sandbox = PathBuf::from(thread_workspace_path(df.clone(), t1.into()).await.unwrap());
        std::fs::write(sandbox.join("a.txt"), b"hello").unwrap();

        let out = execute_tool(
            df.clone(),
            t1.into(),
            None,
            "read".to_string(),
            json!({"path": "a.txt"}),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert!(out.content.contains("hello"), "got: {}", out.content);
        assert!(!out.is_error);
        let _ = std::fs::remove_dir_all(&data);
    }

    /// Thread isolation: each conversation gets its own sandbox, and neither a
    /// relative climb-out nor a sibling-thread absolute path reaches the other's
    /// scratch files. `/tmp` is the agent's own (per-thread) scratch, so a read
    /// of `/tmp` from a different thread resolves to that thread's empty scratch.
    #[tokio::test]
    async fn one_thread_cannot_read_another_threads_files() {
        let data = unique_data_folder();
        let df = data.to_string_lossy().to_string();
        // Thread ids unique to this test rather than the ids shared across the
        // module: a scratch is keyed on the session id alone and lives in the
        // host temp dir, so it is global state even though each test gets its
        // own data folder, and any test deleting that thread's workspace also
        // removes its scratch (see `remove_thread_workspace`).
        let (t1, t2) = ("isolation-thread-one", "isolation-thread-two");
        let one = PathBuf::from(thread_workspace_path(df.clone(), t1.into()).await.unwrap());
        thread_workspace_path(df.clone(), t2.into()).await.unwrap();
        std::fs::write(one.join("secret.txt"), b"classified").unwrap();

        // A relative climb-out reaches the sibling thread's workspace and is an
        // escape, so it must prompt (and is refused on this surface).
        let err = execute_tool(
            df.clone(),
            t2.into(),
            None,
            "read".into(),
            json!({"path": "../isolation-thread-one/secret.txt"}),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .expect_err("a relative climb-out to a sibling thread must be refused");
        assert!(
            err.message.contains("is outside the workspace and every folder the user has granted"),
            "unexpected: {}",
            err.message
        );

        // `/tmp` is the per-thread scratch on Linux, where the bash sandbox binds
        // it. Elsewhere it stays an ordinary host path outside every root this
        // session may reach. Both are the same property from t2's side — it
        // cannot read what t1 wrote — but they refuse differently: Linux serves
        // an empty scratch and reports a missing file, while macOS and Windows
        // refuse the path outright as a read escape. The assertion is therefore
        // on the secret never arriving, not on which refusal was used.
        let one_scratch = crate::workspace::ensure_scratch_dir(t1).await.unwrap();
        std::fs::write(one_scratch.join("secret.txt"), b"classified").unwrap();
        // Which spelling actually probes the isolation differs by platform.
        // On Linux `/tmp` *is* the per-session scratch, so t2 asking for
        // `/tmp/secret.txt` asks for its own empty one. Elsewhere there is no
        // bind, and `/tmp` is refused as an escape whatever it holds — which
        // would pass whether or not the sessions were isolated. So off Linux
        // the test names t1's real scratch: correct code refuses it as an
        // escape, and code that let sessions share a scratch would hand it
        // over.
        #[cfg(target_os = "linux")]
        let target = "/tmp/secret.txt".to_string();
        #[cfg(not(target_os = "linux"))]
        let target = one_scratch
            .join("secret.txt")
            .to_string_lossy()
            .into_owned();

        let refusal = match execute_tool(
            df.clone(),
            t2.into(),
            None,
            "read".into(),
            json!({"path": target}),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        {
            Ok(out) => {
                assert!(
                    out.is_error,
                    "t2 must not read t1's scratch, got: {}",
                    out.content
                );
                out.content
            }
            Err(e) => e.message,
        };
        assert!(
            !refusal.contains("classified"),
            "t1's scratch leaked to t2: {refusal}"
        );
        let _ = std::fs::remove_dir_all(&data);
        let _ = crate::workspace::remove_scratch_dir(t1).await;
        let _ = crate::workspace::remove_scratch_dir(t2).await;
    }

    /// Memory is permanent: wiping a thread's sandbox leaves it untouched, and a
    /// note written under one thread is readable from the next.
    #[tokio::test]
    async fn memory_outlives_the_thread_that_wrote_it() {
        let t2: &str = &unique_thread("memory_outlives_the_thread_that_wrote_it-two");
        let t1: &str = &unique_thread("memory_outlives_the_thread_that_wrote_it");
        let data = unique_data_folder();
        let df = data.to_string_lossy().to_string();

        let out = execute_tool(
            df.clone(),
            t1.into(),
            None,
            "memory_write".into(),
            json!({"name": "prefs", "content": "user likes tabs"}),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert!(!out.is_error, "got: {}", out.content);

        thread_workspace_delete(df.clone(), t1.into())
            .await
            .unwrap();
        assert!(!workspace::thread_workspace(&data, t1).unwrap().exists());

        let out = execute_tool(
            df.clone(),
            t2.into(),
            None,
            "memory_read".into(),
            json!({"name": "prefs"}),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(out.content, "user likes tabs");
        let _ = std::fs::remove_dir_all(&data);
    }

    /// Memory lives outside the sandbox, so the general filesystem tools cannot
    /// reach it even by climbing out -- no extra rule, just `escapes_project`.
    #[tokio::test]
    async fn filesystem_tools_cannot_reach_memory() {
        let t1: &str = &unique_thread("filesystem_tools_cannot_reach_memory");
        let data = unique_data_folder();
        let df = data.to_string_lossy().to_string();
        memory_write(df.clone(), None, "prefs".into(), "secret".into())
            .await
            .unwrap();
        thread_workspace_path(df.clone(), t1.into()).await.unwrap();

        // A relative climb out of the thread sandbox toward the store is an
        // escape and must be refused.
        let err = execute_tool(
            df.clone(),
            t1.into(),
            None,
            "read".into(),
            json!({"path": "../../memory/prefs.md"}),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .expect_err("memory must be unreachable from the sandbox");
        assert!(
            err.message.contains("is outside the workspace and every folder the user has granted"),
            "unexpected: {}",
            err.message
        );
        let _ = std::fs::remove_dir_all(&data);
    }

    /// A sweep clears leftover sandboxes without touching the store.
    #[tokio::test]
    async fn sweep_keeps_live_threads_and_the_store() {
        let t2: &str = &unique_thread("sweep_keeps_live_threads_and_the_store-two");
        let t1: &str = &unique_thread("sweep_keeps_live_threads_and_the_store");
        let data = unique_data_folder();
        let df = data.to_string_lossy().to_string();
        memory_write(df.clone(), None, "prefs".into(), "keep me".into())
            .await
            .unwrap();
        thread_workspace_path(df.clone(), t1.into()).await.unwrap();
        thread_workspace_path(df.clone(), t2.into()).await.unwrap();

        let removed = thread_workspace_sweep(df.clone(), vec![t1.to_string()])
            .await
            .unwrap();
        assert_eq!(removed, 1);
        assert!(workspace::thread_workspace(&data, t1).unwrap().is_dir());
        assert!(!workspace::thread_workspace(&data, t2).unwrap().exists());
        assert_eq!(
            memory_read(df.clone(), None, "prefs".into()).await.unwrap(),
            "keep me"
        );
        let _ = std::fs::remove_dir_all(&data);
    }

    #[tokio::test]
    async fn a_traversing_thread_id_is_rejected() {
        let data = unique_data_folder();
        let df = data.to_string_lossy().to_string();
        for bad in ["../../..", "a/b", ""] {
            assert!(
                thread_workspace_path(df.clone(), bad.into()).await.is_err(),
                "expected {bad:?} to be rejected"
            );
            assert!(
                execute_tool(
                    df.clone(),
                    bad.into(),
                    None,
                    "ls".into(),
                    json!({}),
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
            None,
                )
                .await
                .is_err(),
                "expected {bad:?} to be rejected by execute_tool"
            );
        }
        let _ = std::fs::remove_dir_all(&data);
    }

    #[tokio::test]
    async fn agent_config_surface_is_hard_denied() {
        let t1: &str = &unique_thread("agent_config_surface_is_hard_denied");
        let data = unique_data_folder();
        let df = data.to_string_lossy().to_string();
        thread_workspace_path(df.clone(), t1.into()).await.unwrap();

        let err = execute_tool(
            df.clone(),
            t1.into(),
            None,
            "read".to_string(),
            json!({"path": ".jan/agent/agent.toml"}),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .expect_err("agent config must be hard-denied");
        assert!(
            err.message.contains("is hidden"),
            "unexpected: {}",
            err.message
        );
        let _ = std::fs::remove_dir_all(&data);
    }

    #[tokio::test]
    async fn unknown_tool_is_rejected() {
        let t1: &str = &unique_thread("unknown_tool_is_rejected");
        let data = unique_data_folder();
        let df = data.to_string_lossy().to_string();
        let err = execute_tool(
            df,
            t1.into(),
            None,
            "rm_rf".to_string(),
            json!({}),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .expect_err("unknown tool");
        assert!(err.message.contains("unknown built-in tool"));
        let _ = std::fs::remove_dir_all(&data);
    }

    #[tokio::test]
    async fn memory_crud_roundtrip_in_the_permanent_store() {
        let data = unique_data_folder();
        let df = data.to_string_lossy().to_string();
        workspace_path(df.clone()).await.unwrap();

        assert!(memory_list(df.clone(), None).await.unwrap().is_empty());
        memory_write(df.clone(), None, "prefs".into(), "body".into())
            .await
            .unwrap();
        assert_eq!(memory_list(df.clone(), None).await.unwrap(), vec!["prefs"]);
        assert_eq!(
            memory_read(df.clone(), None, "prefs".into()).await.unwrap(),
            "body"
        );
        memory_delete(df.clone(), None, "prefs".into())
            .await
            .unwrap();
        assert!(memory_list(df.clone(), None).await.unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&data);
    }

    #[tokio::test]
    async fn skill_crud_roundtrip_in_the_permanent_store() {
        let data = unique_data_folder();
        let df = data.to_string_lossy().to_string();
        workspace_path(df.clone()).await.unwrap();

        skill_write(
            df.clone(),
            None,
            "deploy".into(),
            "---\ndescription: d\n---\nbody".into(),
        )
        .await
        .unwrap();
        let listed = skill_list(df.clone(), None).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "deploy");
        assert_eq!(listed[0].description, "d");
        assert!(skill_read(df.clone(), None, "deploy".into())
            .await
            .unwrap()
            .contains("body"));
        skill_delete(df.clone(), None, "deploy".into())
            .await
            .unwrap();
        assert!(skill_list(df.clone(), None).await.unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&data);
    }

    /// A skill written by the model under one thread is loadable from the next,
    /// same as memory.
    #[tokio::test]
    async fn skills_written_by_a_tool_outlive_the_thread() {
        let t2: &str = &unique_thread("skills_written_by_a_tool_outlive_the_thread-two");
        let t1: &str = &unique_thread("skills_written_by_a_tool_outlive_the_thread");
        let data = unique_data_folder();
        let df = data.to_string_lossy().to_string();

        execute_tool(
            df.clone(),
            t1.into(),
            None,
            "skill_write".into(),
            json!({"name": "deploy", "content": "---\ndescription: d\n---\nrun it"}),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        thread_workspace_delete(df.clone(), t1.into())
            .await
            .unwrap();

        let out = execute_tool(
            df.clone(),
            t2.into(),
            None,
            "skill_read".into(),
            json!({"name": "deploy"}),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(out.content, "run it");
        let _ = std::fs::remove_dir_all(&data);
    }
    // ---- read-only attached folder, end to end ------------------------------

    /// The contract the workspace UI promises: the agent reads your folder and
    /// writes only into its own sandbox.
    #[tokio::test]
    async fn an_attached_folder_is_readable_and_unwritable() {
        let thread: &str = &unique_thread("an_attached_folder_is_readable_and_unwritable");
        let data = unique_data_folder();
        let df = data.to_string_lossy().to_string();
        let repo = repo_outside_tmp("rw");
        std::fs::write(repo.join("main.rs"), b"fn main() {}").unwrap();
        let attached = Some(repo.to_string_lossy().to_string());

        let read = execute_tool(
            df.clone(),
            thread.into(),
            None,
            "read".into(),
            json!({"path": repo.join("main.rs").to_string_lossy()}),
            None,
            None,
            attached.clone(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert!(!read.is_error, "{}", read.content);
        assert!(read.content.contains("fn main"), "{}", read.content);

        let write = execute_tool(
            df.clone(),
            thread.into(),
            None,
            "write".into(),
            json!({"path": repo.join("evil.txt").to_string_lossy(), "content": "x"}),
            None,
            None,
            attached,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        let err = write.expect_err("a write into the attached folder must be refused");
        // The wording matters: told only "refused", a model retries until the
        // step budget runs out.
        let msg = format!("{err:?}");
        assert!(msg.contains("read-only"), "{msg}");
        assert!(msg.contains("copy the file into the workspace"), "{msg}");
        assert!(!repo.join("evil.txt").exists(), "nothing was written");

        let _ = std::fs::remove_dir_all(&data);
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// A session's extra attached folders are readable exactly like the
    /// primary: without them a read there is refused, with them it succeeds.
    #[tokio::test]
    async fn an_extra_attached_folder_is_readable_like_the_primary() {
        let thread: &str = &unique_thread("an_extra_attached_folder");
        let data = unique_data_folder();
        let df = data.to_string_lossy().to_string();
        let primary = repo_outside_tmp("extra-primary");
        let extra = repo_outside_tmp("extra-second");
        std::fs::write(extra.join("notes.md"), b"second folder").unwrap();
        let call = |extras: Option<Vec<String>>| {
            execute_tool(
                df.clone(),
                thread.into(),
                None,
                "read".into(),
                json!({"path": extra.join("notes.md").to_string_lossy()}),
                None,
                None,
                Some(primary.to_string_lossy().to_string()),
                None,
                None,
                None,
                None,
                None,
                extras,
            None,
            )
        };

        assert!(call(None).await.is_err(), "outside every attached folder");
        let out = call(Some(vec![extra.to_string_lossy().to_string()]))
            .await
            .expect("the extra folder is attached");
        assert!(out.content.contains("second folder"), "{}", out.content);

        let _ = std::fs::remove_dir_all(&primary);
        let _ = std::fs::remove_dir_all(&extra);
    }

    /// The whole `request_access` round trip at the tool boundary: a read
    /// outside the workspace is refused with advice to ask, the user grants
    /// the folder, the very same call then succeeds -- and a write there is
    /// still refused, because the grant was read-only. Revoking ends it.
    #[tokio::test]
    async fn a_granted_folder_becomes_readable_for_the_retried_call_only() {
        let thread: &str = &unique_thread("a_granted_folder_becomes_readable");
        let data = unique_data_folder();
        let df = data.to_string_lossy().to_string();
        let repo = repo_outside_tmp("access");
        std::fs::write(repo.join("notes.md"), b"remember the milk").unwrap();
        let call = |name: &str, args: serde_json::Value| {
            execute_tool(
                df.clone(),
                thread.into(),
                None,
                name.into(),
                args,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            None,
            )
        };
        let read_args = json!({"path": repo.join("notes.md").to_string_lossy()});

        let refused = call("read", read_args.clone()).await.expect_err("outside the workspace");
        let msg = format!("{refused:?}");
        assert!(msg.contains("Call request_access"), "{msg}");

        let prepared = access_prepare(
            df.clone(),
            thread.into(),
            repo.to_string_lossy().to_string(),
            Some("read".into()),
            Some("read the notes".into()),
            None,
            None,
        )
        .await
        .unwrap();
        let display = match prepared {
            AccessPrepareResult::Ok { prepared } => prepared.display,
            AccessPrepareResult::Refused { message, .. } => panic!("refused: {message}"),
        };
        let grant = access_grant(
            df.clone(),
            thread.into(),
            display,
            Some("read".into()),
            Some("read the notes".into()),
            None,
            None,
            None,
            Some(crate::access::AuditIds {
                run: Some("run-7".into()),
                call: Some("call-7".into()),
                agent: Some("main".into()),
                project: Some(repo.to_string_lossy().to_string()),
            }),
        )
        .await
        .unwrap();
        // The grant's audit record says who asked, like every other decision.
        let granted = crate::audit::read_all(&data)
            .into_iter()
            .find(|r| r.tool == "request_access" && r.decision == crate::audit::Outcome::Granted)
            .expect("the grant was recorded");
        assert_eq!(
            (granted.run.as_str(), granted.call.as_str(), granted.agent.as_str()),
            ("run-7", "call-7", "main")
        );
        assert_eq!(granted.project, repo.to_string_lossy());

        let ok = call("read", read_args.clone()).await.unwrap();
        assert!(!ok.is_error, "{}", ok.content);
        assert!(ok.content.contains("remember the milk"), "{}", ok.content);

        let write = call(
            "write",
            json!({"path": repo.join("evil.txt").to_string_lossy(), "content": "x"}),
        )
        .await;
        assert!(write.is_err(), "a read grant must not allow writes");
        assert!(!repo.join("evil.txt").exists());

        // Another conversation does not inherit a session grant.
        let other_thread: &str = &unique_thread("other-thread");
        let other = execute_tool(
            df.clone(),
            other_thread.into(),
            None,
            "read".into(),
            read_args.clone(),
            None, None, None, None, None, None, None, None,
            None,
            None,
        )
        .await;
        assert!(other.is_err(), "grant leaked to another session");

        assert!(access_revoke(df.clone(), grant.id));
        assert!(call("read", read_args).await.is_err(), "revoked grant still applied");

        let _ = std::fs::remove_dir_all(&data);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn access_prepare_refuses_the_home_directory_without_prompting() {
        let thread: &str = &unique_thread("access_prepare_refuses_home");
        let data = unique_data_folder();
        let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap();
        let out = access_prepare(
            data.to_string_lossy().to_string(),
            thread.into(),
            home,
            None,
            Some("look around".into()),
            None,
            None,
        )
        .await
        .unwrap();
        match out {
            AccessPrepareResult::Refused { code, model_result, .. } => {
                assert_eq!(code, "home_directory");
                assert!(model_result.contains("Do not repeat"));
            }
            AccessPrepareResult::Ok { .. } => panic!("the home directory was offered"),
        }
        let _ = std::fs::remove_dir_all(&data);
    }

    /// Without an attached folder nothing outside the sandbox is readable, so
    /// the mount is genuinely opt-in.
    #[tokio::test]
    async fn without_an_attachment_the_same_read_is_refused() {
        let thread: &str = &unique_thread("without_an_attachment_the_same_read_is_refused");
        let data = unique_data_folder();
        let df = data.to_string_lossy().to_string();
        let repo = repo_outside_tmp("noattach");
        std::fs::write(repo.join("main.rs"), b"fn main() {}").unwrap();

        let out = execute_tool(
            df.clone(),
            thread.into(),
            None,
            "read".into(),
            json!({"path": repo.join("main.rs").to_string_lossy()}),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(out.is_err() || out.unwrap().is_error);

        let _ = std::fs::remove_dir_all(&data);
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// An unusable attachment is an error, never a silent drop: otherwise the
    /// agent works against a folder it believes is attached and is not.
    #[tokio::test]
    async fn an_overlapping_attachment_is_rejected_not_ignored() {
        let thread: &str = &unique_thread("an_overlapping_attachment_is_rejected_not_ignored");
        let data = unique_data_folder();
        let df = data.to_string_lossy().to_string();
        let inside = workspace::ensure_thread_workspace(&data, thread)
            .await
            .unwrap()
            .join("nested");
        std::fs::create_dir_all(&inside).unwrap();

        let out = execute_tool(
            df.clone(),
            thread.into(),
            None,
            "ls".into(),
            json!({}),
            None,
            None,
            Some(inside.to_string_lossy().to_string()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        let err = out.expect_err("a root inside the workspace must be refused");
        assert!(format!("{err:?}").contains("overlaps"), "{err:?}");

        let _ = std::fs::remove_dir_all(&data);
    }
    // ---- live output streaming ---------------------------------------------

    /// The sink builder is exercised directly: a real `Channel` needs a webview,
    /// and what matters here is the ordering, correlation and the byte budget.
    #[test]
    fn the_output_sink_numbers_chunks_and_tags_them_with_the_call() {
        let seen: Seen = Arc::new(Mutex::new(Vec::new()));
        let sink = test_sink(seen.clone(), Some("call-7".into()));

        sink("one".into());
        sink("two".into());

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0].0, 0);
        assert_eq!(seen[1].0, 1, "seq is monotonic so a gap is detectable");
        assert_eq!(seen[0].1.as_deref(), Some("call-7"));
        assert_eq!(seen[1].2, "two");
    }

    /// A `yes`-style command would otherwise flood the webview. The stream stops
    /// with one honest marker; the full text still reaches the caller in the
    /// tool result.
    #[test]
    fn the_output_sink_stops_at_the_byte_cap_and_says_so() {
        let seen: Seen = Arc::new(Mutex::new(Vec::new()));
        let sink = test_sink(seen.clone(), None);

        sink("x".repeat(MAX_STREAMED_BYTES + 1));
        sink("more".into());
        sink("even more".into());

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1, "nothing is sent after the cap");
        assert!(seen[0].2.contains("truncated"), "{}", seen[0].2);
    }

    /// Mirrors `output_sink`'s accounting without a `Channel`, which cannot be
    /// constructed outside a webview.
    fn test_sink(seen: Seen, call_id: Option<String>) -> crate::tools::OutputSink {
        use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
        use std::sync::Arc;
        let seq = Arc::new(AtomicU64::new(0));
        let sent = Arc::new(AtomicUsize::new(0));
        let stopped = Arc::new(AtomicBool::new(false));
        Arc::new(move |text: String| {
            if stopped.load(Ordering::Relaxed) {
                return;
            }
            let total = sent.fetch_add(text.len(), Ordering::Relaxed) + text.len();
            let payload = if total > MAX_STREAMED_BYTES {
                stopped.store(true, Ordering::Relaxed);
                "\n[output truncated in the live view]\n".to_string()
            } else {
                text
            };
            seen.lock().unwrap().push((
                seq.fetch_add(1, Ordering::Relaxed),
                call_id.clone(),
                payload,
            ));
        })
    }
    /// A plain chat (thread scope, no Cowork session, no write grant) reads
    /// the folders it attached: the first as `read_only_project`, the rest as
    /// `extra_projects`. It cannot write to them, and without them the same
    /// read is refused.
    #[tokio::test]
    async fn a_chat_thread_reads_its_attached_folders_read_only() {
        let data = unique_data_folder();
        let df = data.to_string_lossy().to_string();
        let outside = unique_data_folder();
        let a = outside.join("a");
        let b = outside.join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("one.txt"), "from a").unwrap();
        std::fs::write(b.join("two.txt"), "from b").unwrap();
        let a_str = a.to_string_lossy().to_string();
        let b_str = b.to_string_lossy().to_string();
        let call = |name: &str, args: serde_json::Value, attached: bool| {
            execute_tool(
                df.clone(),
                "chat-thread".into(),
                None,
                name.into(),
                args,
                None,
                None,
                attached.then(|| a_str.clone()),
                None,
                Some(WorkspaceScope::Thread),
                None,
                None,
                None,
                attached.then(|| vec![b_str.clone()]),
            None,
            )
        };

        let read_a = json!({"path": a.join("one.txt").to_string_lossy()});
        let out = call("read", read_a.clone(), true).await.expect("read a");
        assert!(!out.is_error, "{}", out.content);
        assert!(out.content.contains("from a"), "{}", out.content);

        let read_b = json!({"path": b.join("two.txt").to_string_lossy()});
        let out = call("read", read_b, true).await.expect("read b");
        assert!(!out.is_error, "{}", out.content);
        assert!(out.content.contains("from b"), "{}", out.content);

        // Read-only: no write grant, so a write there is refused.
        let write = json!({"path": a.join("new.txt").to_string_lossy(), "content": "x"});
        let out = call("write", write, true).await;
        assert!(out.map(|r| r.is_error).unwrap_or(true));
        assert!(!a.join("new.txt").exists());

        // Without the attachment, the same read is refused.
        let out = call("read", read_a, false).await;
        assert!(out.map(|r| r.is_error).unwrap_or(true));

        let _ = std::fs::remove_dir_all(&data);
        let _ = std::fs::remove_dir_all(&outside);
    }
}
