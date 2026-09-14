//! `stop_session`: one Cowork session asking the app to stop another session's
//! run (docs/SESSION_MESSAGING.md, "Stopping another session").
//!
//! A message can only *ask* a peer to stop. This is the one agent-reachable
//! control that actually stops a run, so it is fenced on every side:
//!
//! - the user of the calling session approves each call, and the approval is
//!   recorded here by the renderer (`approve_stop`) against the call id, the
//!   target and the reason -- the tool refuses without it, so a model cannot
//!   reach the stop by calling the tool around the prompt;
//! - the caller must be a registered, running session with a project, and the
//!   target must be another live, running session in the same project;
//! - the request names the target's current run id, and is applied only while
//!   that run is still the one in flight, so it can never stop a newer run;
//! - rate limited per sender and per sender/target pair, from persisted data.
//!
//! The stop itself is performed by the renderer, through the same cancellation
//! path as the user's Stop button, after it has re-read the request here
//! (`pending_stop`); it reports back with `resolve_stop`.

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::{
    check_session_id, code, lock, valid_id, write_json_atomically, MailboxError, Mailbox, Result,
    SessionStatus,
};

/// Longest stop reason, in characters.
pub const MAX_STOP_REASON_CHARS: usize = 500;
/// Per sender: at most this many stop requests per rolling window.
pub const STOP_RATE_LIMIT: usize = 3;
/// Per sender->target pair: at most this many per rolling window.
pub const STOP_PAIR_LIMIT: usize = 2;
pub const STOP_RATE_WINDOW_MS: i64 = 10 * 60_000;
/// A request not applied within this long is ignored as stale.
pub const STOP_REQUEST_TTL_MS: i64 = 60_000;
/// How long a recorded user approval stays usable.
pub const STOP_APPROVAL_TTL_MS: i64 = 120_000;
/// How long the tool waits for the target's renderer to act on the request.
pub const STOP_WAIT: Duration = Duration::from_secs(15);
/// Records older than this are dropped when the file is next written.
const STOP_RETENTION_MS: i64 = 7 * 24 * 3_600_000;

/// Emitted with `(targetSessionId, requestId)` after a request is recorded.
pub const STOP_REQUESTED_EVENT: &str = "agent-session-stop-requested";

pub mod stop_code {
    pub const INVALID_REASON: &str = "invalid_reason";
    pub const TARGET_NOT_RUNNING: &str = "target_not_running";
    pub const CALLER_NOT_RUNNING: &str = "caller_not_running";
    pub const APPROVAL_REQUIRED: &str = "approval_required";
    pub const UNKNOWN_STOP_REQUEST: &str = "unknown_stop_request";
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopStatus {
    Requested,
    Applied,
    IgnoredStale,
}

impl StopStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            StopStatus::Requested => "requested",
            StopStatus::Applied => "applied",
            StopStatus::IgnoredStale => "ignored_stale",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopParty {
    pub session_id: String,
    pub display_name: String,
}

/// One durable stop request, `<data>/mailbox/stops.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopRequest {
    pub v: u8,
    pub id: String,
    pub from: StopParty,
    pub to: StopParty,
    pub project: String,
    /// Scrubbed. Untrusted text written by the calling agent.
    pub reason: String,
    /// The target's run when the request was made. Only that run is stopped.
    pub target_run_id: String,
    pub created_at: i64,
    pub status: StopStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<i64>,
}

type StopEmitter = Box<dyn Fn(&str, &str) + Send + Sync>;
static STOP_EMITTER: OnceLock<StopEmitter> = OnceLock::new();

/// Install the listener called as `(targetSessionId, requestId)` after a stop
/// request is recorded. The desktop plugin emits [`STOP_REQUESTED_EVENT`].
pub fn set_stop_emitter(emit: impl Fn(&str, &str) + Send + Sync + 'static) {
    let _ = STOP_EMITTER.set(Box::new(emit));
}

fn notify_stop(session_id: &str, request_id: &str) {
    if let Some(emit) = STOP_EMITTER.get() {
        emit(session_id, request_id);
    }
}

/// A user's approval of one `stop_session` call, as the renderer recorded it.
#[derive(Debug, Clone)]
struct Approval {
    root: std::path::PathBuf,
    session_id: String,
    call_id: String,
    target: String,
    reason: String,
    at: i64,
}

/// In memory on purpose: an approval is for a call in flight, and must not
/// survive the process that showed the prompt.
static APPROVALS: Mutex<Vec<Approval>> = Mutex::new(Vec::new());

fn approvals() -> std::sync::MutexGuard<'static, Vec<Approval>> {
    APPROVALS.lock().unwrap_or_else(|p| p.into_inner())
}

fn check_reason(reason: &str) -> Result<()> {
    if reason.trim().is_empty() || reason.chars().count() > MAX_STOP_REASON_CHARS {
        return Err(MailboxError::new(
            stop_code::INVALID_REASON,
            format!("reason must be 1..={MAX_STOP_REASON_CHARS} characters and not blank"),
        ));
    }
    Ok(())
}

fn new_stop_id(now: i64) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    format!(
        "stop-{:x}-{:x}-{:x}",
        now,
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

/// The same answer for "no such session" and "a session in another project",
/// so a refusal never tells a caller that a session exists elsewhere.
fn not_in_project() -> MailboxError {
    MailboxError::new(
        code::UNKNOWN_SESSION,
        "no session with that id in this project",
    )
}

impl Mailbox {
    fn stops_path(&self) -> std::path::PathBuf {
        self.root.join("stops.json")
    }

    /// A damaged file fails closed, like the registry: rate limits and
    /// outcomes live in it.
    pub(super) fn read_stops(&self) -> Result<BTreeMap<String, StopRequest>> {
        match std::fs::read(self.stops_path()) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| MailboxError::io("stop requests are unreadable", e)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(e) => Err(MailboxError::io("read stop requests", e)),
        }
    }

    fn write_stops(&self, stops: &mut BTreeMap<String, StopRequest>) -> Result<()> {
        let now = self.now();
        stops.retain(|_, r| now - r.created_at < STOP_RETENTION_MS);
        write_json_atomically(&self.stops_path(), stops)
    }

    /// Record the user's approval of one `stop_session` call. Called by the
    /// renderer after the prompt in the calling session was answered yes.
    pub fn approve_stop(
        &self,
        session_id: &str,
        call_id: &str,
        target: &str,
        reason: &str,
    ) -> Result<()> {
        check_session_id(session_id)?;
        check_reason(reason)?;
        if call_id.trim().is_empty() || call_id.len() > 256 {
            return Err(MailboxError::new(
                code::INVALID_ARGUMENTS,
                "an approval needs the tool call id",
            ));
        }
        if !valid_id(target) {
            return Err(not_in_project());
        }
        let now = self.now();
        let mut held = approvals();
        // Only this mailbox's entries are pruned, against this mailbox's clock.
        held.retain(|a| {
            a.root != self.root
                || (now - a.at < STOP_APPROVAL_TTL_MS
                    && !(a.session_id == session_id && a.call_id == call_id))
        });
        held.push(Approval {
            root: self.root.clone(),
            session_id: session_id.to_string(),
            call_id: call_id.to_string(),
            target: target.to_string(),
            reason: reason.to_string(),
            at: now,
        });
        Ok(())
    }

    /// Consume the approval for exactly this call, target and reason.
    fn take_approval(&self, session_id: &str, call_id: &str, target: &str, reason: &str) -> bool {
        let now = self.now();
        let mut held = approvals();
        let found = held.iter().position(|a| {
            a.root == self.root
                && a.session_id == session_id
                && a.call_id == call_id
                && a.target == target
                && a.reason == reason
                && now - a.at < STOP_APPROVAL_TTL_MS
        });
        match found {
            Some(i) => {
                held.remove(i);
                true
            }
            None => false,
        }
    }

    /// Record a request to stop `to_id`'s current run, on behalf of `from_id`
    /// whose user approved call `call_id`. Every rule is checked here, under
    /// the mailbox lock, against persisted data.
    pub fn request_stop(
        &self,
        from_id: &str,
        to_id: &str,
        reason: &str,
        call_id: &str,
    ) -> Result<StopRequest> {
        let request = {
            let _guard = lock();
            let registry = self.read_registry()?;
            let (caller, project) = self.caller(&registry, from_id)?;
            if self.status_of(caller) != SessionStatus::Running {
                return Err(MailboxError::new(
                    stop_code::CALLER_NOT_RUNNING,
                    "only a session that is running can ask to stop another session",
                ));
            }
            check_reason(reason)?;
            if !valid_id(to_id) {
                return Err(not_in_project());
            }
            if to_id == from_id {
                return Err(MailboxError::new(
                    code::SELF_TARGET,
                    "a session cannot stop itself with this tool",
                ));
            }
            let target = registry.get(to_id).ok_or_else(not_in_project)?;
            if target.project.as_deref() != Some(project.as_str()) {
                return Err(not_in_project());
            }
            if target.deleted {
                return Err(MailboxError::new(
                    code::SESSION_DELETED,
                    "that session was deleted",
                ));
            }
            let target_run = match (self.status_of(target), target.run_id.as_deref()) {
                (SessionStatus::Running, Some(run)) if !run.is_empty() => run.to_string(),
                _ => {
                    return Err(MailboxError::new(
                        stop_code::TARGET_NOT_RUNNING,
                        "that session is not running, so there is nothing to stop",
                    ))
                }
            };

            let now = self.now();
            let mut stops = self.read_stops()?;
            let recent: Vec<&StopRequest> = stops
                .values()
                .filter(|r| r.from.session_id == from_id && r.created_at > now - STOP_RATE_WINDOW_MS)
                .collect();
            if recent.len() >= STOP_RATE_LIMIT {
                return Err(MailboxError::new(
                    code::RATE_LIMITED,
                    format!("at most {STOP_RATE_LIMIT} stop requests per 10 minutes"),
                ));
            }
            if recent.iter().filter(|r| r.to.session_id == to_id).count() >= STOP_PAIR_LIMIT {
                return Err(MailboxError::new(
                    code::PAIR_LIMIT_EXCEEDED,
                    format!("at most {STOP_PAIR_LIMIT} stop requests per 10 minutes to the same session"),
                ));
            }
            // Last, so a refused call never spends the user's approval.
            if !self.take_approval(from_id, call_id, to_id, reason) {
                return Err(MailboxError::new(
                    stop_code::APPROVAL_REQUIRED,
                    "stopping another session needs the user's approval for this call",
                ));
            }

            let request = StopRequest {
                v: 1,
                id: new_stop_id(now),
                from: StopParty {
                    session_id: from_id.to_string(),
                    display_name: caller.display_name.clone(),
                },
                to: StopParty {
                    session_id: to_id.to_string(),
                    display_name: target.display_name.clone(),
                },
                project,
                reason: crate::harness_error::scrub(reason),
                target_run_id: target_run,
                created_at: now,
                status: StopStatus::Requested,
                resolved_at: None,
            };
            stops.insert(request.id.clone(), request.clone());
            self.write_stops(&mut stops)?;
            request
        };
        notify_stop(&request.to.session_id, &request.id);
        Ok(request)
    }

    /// A request the target's renderer may act on now, or `None`.
    ///
    /// `None` for an id that is not addressed to `session_id` (a forged or
    /// misrouted event), one already resolved, and one that went stale: too
    /// old, or the target's recorded run is no longer the one it names. A
    /// stale request is marked `ignored_stale` here.
    pub fn pending_stop(&self, session_id: &str, request_id: &str) -> Result<Option<StopRequest>> {
        check_session_id(session_id)?;
        let _guard = lock();
        let mut stops = self.read_stops()?;
        let Some(request) = stops.get(request_id).cloned() else {
            return Ok(None);
        };
        if request.to.session_id != session_id || request.status != StopStatus::Requested {
            return Ok(None);
        }
        let now = self.now();
        let registry = self.read_registry()?;
        let still_that_run = registry.get(session_id).is_some_and(|r| {
            !r.deleted
                && self.status_of(r) == SessionStatus::Running
                && r.run_id.as_deref() == Some(request.target_run_id.as_str())
        });
        if now - request.created_at >= STOP_REQUEST_TTL_MS || !still_that_run {
            if let Some(r) = stops.get_mut(request_id) {
                r.status = StopStatus::IgnoredStale;
                r.resolved_at = Some(now);
            }
            self.write_stops(&mut stops)?;
            return Ok(None);
        }
        Ok(Some(request))
    }

    /// The target's renderer reports what it did. `applied` counts only when
    /// `run_id` is the run the request named; anything else is recorded as
    /// `ignored_stale`. Resolving twice returns the first outcome.
    pub fn resolve_stop(
        &self,
        session_id: &str,
        request_id: &str,
        applied: bool,
        run_id: Option<&str>,
    ) -> Result<StopRequest> {
        check_session_id(session_id)?;
        let _guard = lock();
        let mut stops = self.read_stops()?;
        let unknown = || {
            MailboxError::new(
                stop_code::UNKNOWN_STOP_REQUEST,
                "no stop request with that id for this session",
            )
        };
        let request = stops.get_mut(request_id).ok_or_else(unknown)?;
        if request.to.session_id != session_id {
            return Err(unknown());
        }
        if request.status != StopStatus::Requested {
            return Ok(request.clone());
        }
        let now = self.now();
        let matches_run = run_id == Some(request.target_run_id.as_str());
        request.status = if applied && matches_run {
            StopStatus::Applied
        } else {
            StopStatus::IgnoredStale
        };
        request.resolved_at = Some(now);
        let out = request.clone();
        self.write_stops(&mut stops)?;
        Ok(out)
    }

    /// One request, read without changing it.
    pub fn stop_request(&self, request_id: &str) -> Result<Option<StopRequest>> {
        Ok(self.read_stops()?.get(request_id).cloned())
    }

    /// Wait until the request is resolved, `timeout` passes, or `cancel`
    /// stops. Returns the record as it then stands.
    pub async fn wait_stop_outcome(
        &self,
        request_id: &str,
        timeout: Duration,
        cancel: Option<crate::lifecycle::Token>,
    ) -> Result<StopRequest> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let current = self.stop_request(request_id)?.ok_or_else(|| {
                MailboxError::new(stop_code::UNKNOWN_STOP_REQUEST, "the stop request vanished")
            })?;
            if current.status != StopStatus::Requested {
                return Ok(current);
            }
            if cancel.as_ref().is_some_and(|t| t.is_stopped()) {
                return Ok(current);
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return Ok(current);
            }
            tokio::time::sleep(super::WAIT_POLL.min(deadline - now)).await;
        }
    }
}

/// The `stop_session` tool body. The caller has already checked there is a
/// session and a mailbox root.
pub(super) async fn run_stop_tool(
    mailbox: &Mailbox,
    session_id: &str,
    args: &serde_json::Value,
    ctx: &crate::tools::ToolContext<'_>,
) -> Result<serde_json::Value> {
    let (Some(target), Some(reason)) = (
        args.get("session_id").and_then(|v| v.as_str()),
        args.get("reason").and_then(|v| v.as_str()),
    ) else {
        return Err(MailboxError::new(
            code::INVALID_ARGUMENTS,
            "stop_session needs string `session_id` and `reason`",
        ));
    };
    let Some(call_id) = ctx.call_id else {
        return Err(MailboxError::new(
            stop_code::APPROVAL_REQUIRED,
            "stopping another session needs the user's approval for this call",
        ));
    };
    let request = mailbox.request_stop(session_id, target, reason, call_id)?;
    let cancel = ctx.cancel.clone().or_else(crate::lifecycle::current);
    let outcome = mailbox
        .wait_stop_outcome(&request.id, STOP_WAIT, cancel)
        .await?;
    let note = match outcome.status {
        StopStatus::Applied => {
            "That session's run was stopped. Its transcript records that this session stopped it and why."
        }
        StopStatus::IgnoredStale => {
            "Nothing was stopped: the run this request named had already ended or been replaced."
        }
        StopStatus::Requested => {
            "The request was recorded but not acted on yet. It is ignored if it is not applied within a minute."
        }
    };
    Ok(serde_json::json!({
        "request_id": outcome.id,
        "target": { "session_id": outcome.to.session_id, "display_name": outcome.to.display_name },
        "status": outcome.status.as_str(),
        "note": note,
    }))
}
