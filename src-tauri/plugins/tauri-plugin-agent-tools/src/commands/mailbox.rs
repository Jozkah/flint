//! Session messaging and shared-folder coordination commands (split from
//! `commands`; re-exported there so command paths are unchanged).

use super::*;

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
    access: Option<String>,
    isolated: Option<bool>,
    inbound: Option<String>,
) -> Result<SessionRecord, MailboxError> {
    let inbound = match inbound.as_deref() {
        None => None,
        Some(v) => Some(crate::session_mailbox::Inbound::parse(v).ok_or_else(|| {
            MailboxError::new("invalid_arguments", "inbound must be accept, hold or refuse")
        })?),
    };
    Mailbox::open(Path::new(&data_folder)).register_inbound(
        &session_id,
        &display_name,
        folder.as_deref(),
        accepts_messages,
        inbound,
        access.as_deref(),
        isolated,
    )
}

/// Messages waiting for `session_id`'s user to approve (`inbound: hold`),
/// oldest first. Held mail past its deadline is dropped first.
#[tauri::command]
pub async fn mailbox_held(
    data_folder: String,
    session_id: String,
) -> Result<Vec<MailEnvelope>, MailboxError> {
    Mailbox::open(Path::new(&data_folder))
        .held_messages(&session_id)
        .map(|all| all.into_iter().map(MailEnvelope::screened).collect())
}

/// The user approved a held message: it is delivered once. `false` when it
/// is no longer held. Only the renderer's Approve button calls this.
#[tauri::command]
pub async fn mailbox_held_approve(
    data_folder: String,
    session_id: String,
    message_id: String,
) -> Result<bool, MailboxError> {
    Mailbox::open(Path::new(&data_folder)).approve_held(&session_id, &message_id)
}

/// The user denied a held message: it is dropped.
#[tauri::command]
pub async fn mailbox_held_deny(
    data_folder: String,
    session_id: String,
    message_id: String,
) -> Result<bool, MailboxError> {
    Mailbox::open(Path::new(&data_folder)).deny_held(&session_id, &message_id)
}

// ---------------------------------------------------------------------------
// Shared-folder coordination
// (docs/superpowers/specs/2026-10-19-shared-folder-coordination-design.md)
// ---------------------------------------------------------------------------

use crate::shared_folder::{self, claims::Scope, isolation, view};

/// Who else is in this session's folder: the other live sessions (isolated
/// ones marked), the branch, this session's held writes and its active
/// "allow anyway" grants. `None` when the session has no folder.
#[tauri::command]
pub async fn shared_folder_peers(
    data_folder: String,
    session_id: String,
) -> Result<Option<view::SharedFolderView>, MailboxError> {
    let mailbox = Mailbox::open(Path::new(&data_folder));
    let table = shared_folder::table();
    Ok(view::view_for(&mailbox, &table, &session_id, shared_folder::now_ms()))
}

/// Every folder with two or more live sessions, for the sidebar mark.
#[tauri::command]
pub async fn shared_folder_overview(
    data_folder: String,
) -> Result<Vec<view::SharedFolderGroup>, MailboxError> {
    let mailbox = Mailbox::open(Path::new(&data_folder));
    let table = shared_folder::table();
    Ok(view::overview(&mailbox, &table, shared_folder::now_ms()))
}

/// Files a session changed in the last `window_secs` (default 600), newest
/// first, relative to its folder.
#[tauri::command]
pub async fn shared_folder_recent_edits(
    data_folder: String,
    session_id: String,
    window_secs: Option<u32>,
) -> Result<Vec<view::RecentFile>, MailboxError> {
    let mailbox = Mailbox::open(Path::new(&data_folder));
    let key = mailbox
        .session(&session_id)
        .and_then(|r| r.shared.folder_key)
        .unwrap_or_default();
    let window = i64::from(window_secs.unwrap_or(600).min(86_400)) * 1000;
    let now = shared_folder::now_ms();
    Ok(shared_folder::table()
        .recent_of(&session_id, window, now)
        .into_iter()
        .map(|e| view::RecentFile {
            path: shared_folder::path_key::relative_to(&key, &e.path),
            at: e.at,
        })
        .collect())
}

/// "Allow this session to edit anyway": lets `session_id` through file claims
/// (`edit`), the git guard (`git`) or both (`all`) for `minutes` (default 30,
/// at most 240; 0 withdraws). Returns the expiry in epoch ms, `None` when
/// withdrawn.
#[tauri::command]
pub async fn shared_folder_allow(
    data_folder: String,
    session_id: String,
    scope: String,
    minutes: Option<u32>,
) -> Result<Option<i64>, MailboxError> {
    let scope = Scope::parse(&scope).ok_or_else(|| {
        MailboxError::new("invalid_scope", "scope must be `edit`, `git` or `all`")
    })?;
    let mailbox = Mailbox::open(Path::new(&data_folder));
    let record = mailbox
        .session(&session_id)
        .ok_or_else(|| MailboxError::new("unknown_session", "this session is not registered"))?;
    let until = shared_folder::table().allow(
        &session_id,
        scope,
        minutes.unwrap_or(shared_folder::claims::DEFAULT_ALLOW_MINUTES),
        shared_folder::now_ms(),
    );
    shared_folder::announce(record.shared.folder_key, &session_id, "allow");
    Ok(until)
}

/// Should a session in `folder` start in its own worktree? The default for a
/// fork or a second session in a git folder that already has a live one.
/// `session_id` is the session being placed (not counted as another).
#[tauri::command]
pub async fn shared_folder_default_isolation(
    data_folder: String,
    folder: String,
    session_id: Option<String>,
    is_fork: Option<bool>,
    user_chose_shared: Option<bool>,
) -> Result<isolation::IsolationDecision, MailboxError> {
    Ok(isolation::decide_for_folder(
        &Mailbox::open(Path::new(&data_folder)),
        &folder,
        session_id.as_deref(),
        is_fork.unwrap_or(false),
        user_chose_shared.unwrap_or(false),
    ))
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

/// The session was archived (`true`) or restored (`false`). Archived
/// sessions get no mail and are left out of `list_sessions`.
#[tauri::command]
pub async fn mailbox_session_archive(
    data_folder: String,
    session_id: String,
    archived: bool,
) -> Result<(), MailboxError> {
    Mailbox::open(Path::new(&data_folder)).set_archived(&session_id, archived)
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
    Mailbox::open(Path::new(&data_folder))
        .take_for_delivery(&session_id)
        .map(|all| all.into_iter().map(MailEnvelope::screened).collect())
}

/// Queued and delivered (unread) envelopes, without changing their state.
#[tauri::command]
pub async fn mailbox_pending(
    data_folder: String,
    session_id: String,
) -> Result<Vec<MailEnvelope>, MailboxError> {
    Mailbox::open(Path::new(&data_folder))
        .pending(&session_id)
        .map(|all| all.into_iter().map(MailEnvelope::screened).collect())
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
    include_archived: Option<bool>,
) -> Result<Vec<SessionSummary>, MailboxError> {
    Mailbox::open(Path::new(&data_folder))
        .list_sessions_with(&session_id, include_archived.unwrap_or(false))
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
