//! Which MCP servers the user has agreed to run tools from. AH-041.
//!
//! The policy keys on the **server**, never on a tool name. A tool name is
//! chosen by the server that publishes it, so it is not an identity: a second
//! server can publish `fetch` too, and `call_tool` with no `server_name` picks
//! whichever server answers the search first. Trusting `fetch` would therefore
//! be trusting whoever got there first.
//!
//! A server *name* is not an identity either. It is a label the user can reuse,
//! and a grant recorded against a name alone would carry over to whatever is
//! configured under that name next -- a different executable, a different
//! endpoint. So a grant is recorded against the name **and** the definition's
//! fingerprint ([`crate::mcp_identity`]), and only permits a call while both
//! still match.
//!
//! Two kinds of authorization, deliberately different:
//!
//! * **Trust**, granted per server, persisted, and surviving a restart. This is
//!   the "always allow this server" answer, and it is kept here rather than in
//!   renderer state so that what the backend enforces and what the user was
//!   shown cannot drift apart.
//! * **A ticket**, minted for one server, one tool, one definition and one
//!   call. Single use, short lived, and never written to disk, so an "allow
//!   once" answer cannot silently become a standing permission.
//!
//! # Lifecycle
//!
//! | Event | Trust grant | OAuth tokens | Why |
//! |---|---|---|---|
//! | Turn off (`active = false`) | kept | kept | same definition; its tools are simply unavailable |
//! | Clear authorization | kept | removed | signing out is not withdrawing approval of the program |
//! | Delete | revoked (audited) | removed | a new server under the same name starts with nothing |
//! | Rename | revoked under the old name (audited) | removed under the old name | grants never move to a name the user did not approve; tokens are cleared rather than migrated because a rename is also the moment the endpoint may change |
//! | Security-relevant edit (command, args, url, cwd, env/header names, transport, confinement) | stops permitting; invalidated on the next call (audited) | untouched (OAuth already refuses tokens issued for another URL) | the approval was for a different program |
//! | Re-adding a similarly named server | nothing inherited | nothing inherited | follows from delete |
//!
//! Delete and rename are driven by the settings surface through
//! `mcp_forget_server`; this module only records them. Audit history is a
//! separate append-only file and is never pruned by any of the above.
//!
//! # Storage
//!
//! `<data>/mcp-trust.json`, schema 2:
//! `{ schema_version: 2, trusted: [{name, fingerprint, granted_at}],
//!    invalidated: [{name, reason, at, fingerprint?}] }`.
//!
//! A schema 1 file held bare names. Those carry no fingerprint, so there is no
//! way to know which definition the user approved; they are **not** carried
//! over as active trust. Each is listed under `invalidated` with reason
//! `schema-v1` (and audited) so the settings page can say the approval needs
//! renewing instead of silently forgetting it. An unreadable file trusts
//! nothing.
//!
//! What this does *not* claim: the renderer is still the thing that asks the
//! user, and it can mint a ticket whenever it likes. The gate stops a server
//! from being trusted without a recorded decision, stops a tool name from
//! standing in for a server identity, and stops a name from standing in for a
//! definition. It is not a defence against the renderer itself.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::audit::{self, Outcome, PermissionRecord};
use crate::mcp_identity::short;
use crate::resource::Resource;

/// How long a single-use ticket stays valid.
///
/// Long enough for a slow tool call to start, short enough that a ticket left
/// over from an abandoned turn is not still lying around for the next one.
const TICKET_TTL: Duration = Duration::from_secs(300);

const FILE_NAME: &str = "mcp-trust.json";

/// Current on-disk schema.
pub const SCHEMA_VERSION: u32 = 2;

/// Why an approval stopped applying without the user revoking it.
pub mod invalidation {
    /// A schema 1 grant: a name with no fingerprint.
    pub const SCHEMA_V1: &str = "schema-v1";
    /// The definition's fingerprint no longer matches the one approved.
    pub const CONFIGURATION_CHANGED: &str = "configuration-changed";
}

/// One standing grant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrustGrant {
    pub name: String,
    pub fingerprint: String,
    /// RFC 3339, UTC.
    pub granted_at: String,
}

/// An approval that no longer applies and needs renewing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Invalidated {
    pub name: String,
    /// One of [`invalidation`].
    pub reason: String,
    /// RFC 3339, UTC.
    pub at: String,
    /// The fingerprint the approval was for, when there was one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct Stored {
    schema_version: u32,
    #[serde(default)]
    trusted: Vec<TrustGrant>,
    #[serde(default)]
    invalidated: Vec<Invalidated>,
}

/// Why a grant was withdrawn, for the audit record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevokeReason {
    /// The user revoked it from settings.
    User,
    /// The server was deleted.
    Deleted,
    /// The server was renamed; grants do not follow a rename.
    Renamed,
}

impl RevokeReason {
    pub fn as_str(self) -> &'static str {
        match self {
            RevokeReason::User => "revoked by user",
            RevokeReason::Deleted => "server deleted",
            RevokeReason::Renamed => "server renamed",
        }
    }

    /// Parse the wire form used by `mcp_forget_server`.
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "user" => Some(RevokeReason::User),
            "deleted" => Some(RevokeReason::Deleted),
            "renamed" => Some(RevokeReason::Renamed),
            _ => None,
        }
    }
}

struct Ticket {
    server: String,
    tool: String,
    fingerprint: String,
    issued_at: SystemTime,
}

fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(State::default()))
}

#[derive(Default)]
struct State {
    /// `None` until the file has been read, so a failed read is retried rather
    /// than remembered as "nothing is trusted".
    loaded_from: Option<PathBuf>,
    stored: Stored,
    tickets: HashMap<String, Ticket>,
    sequence: u64,
}

fn path_for(data_folder: &Path) -> PathBuf {
    data_folder.join(FILE_NAME)
}

/// Record one trust decision. A witness only: never fails the caller.
fn record(data_folder: &Path, server: &str, tool: &str, decision: Outcome, reason: String) {
    let resource = Resource::McpTool {
        server: server.to_string(),
        tool: tool.to_string(),
    };
    audit::append(
        data_folder,
        &PermissionRecord::new(audit::now(), "desktop", tool, "mcp", &resource, decision, reason)
            .with_agent("mcp-trust")
            .with_rule("mcp-trust"),
    );
}

/// Parse whatever is on disk into the current schema.
///
/// Returns the stored state and the names a schema 1 file held, which the
/// caller invalidates, persists and audits.
fn parse(text: &str) -> Option<(Stored, Vec<String>)> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let version = value
        .get("schema_version")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(1);
    if version >= 2 {
        let mut stored: Stored = serde_json::from_value(value).ok()?;
        stored.schema_version = SCHEMA_VERSION;
        return Some((stored, Vec::new()));
    }
    let legacy: Vec<String> = value
        .get("trusted")
        .and_then(serde_json::Value::as_array)
        .map(|names| {
            names
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();
    Some((
        Stored {
            schema_version: SCHEMA_VERSION,
            trusted: Vec::new(),
            invalidated: Vec::new(),
        },
        legacy,
    ))
}

impl State {
    /// Read the file once per data folder. A missing or unreadable file means
    /// nothing is trusted yet, which is the safe answer and the correct one for
    /// a fresh install.
    fn ensure_loaded(&mut self, data_folder: &Path) {
        let path = path_for(data_folder);
        if self.loaded_from.as_deref() == Some(path.as_path()) {
            return;
        }
        let parsed = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| parse(&text));
        // A file that is there and cannot be read still holds the user's
        // grants. Starting from nothing is the safe answer, but the next
        // decision would save over it (Jozkah/jan#267), so it is moved aside,
        // whole, for the user or a later version to recover.
        if parsed.is_none() && path.exists() {
            let aside = path.with_extension(format!("json.corrupt-{}", audit::now().replace(':', "-")));
            match std::fs::rename(&path, &aside) {
                Ok(()) => eprintln!(
                    "mcp trust: {} could not be read; kept as {} and starting with nothing trusted",
                    path.display(),
                    aside.display()
                ),
                Err(e) => eprintln!("mcp trust: {} could not be read or kept aside: {e}", path.display()),
            }
        }
        self.loaded_from = Some(path);
        let Some((stored, legacy)) = parsed else {
            self.stored = Stored {
                schema_version: SCHEMA_VERSION,
                ..Stored::default()
            };
            return;
        };
        self.stored = stored;
        if legacy.is_empty() {
            return;
        }
        // Explicit invalidation: a name with no fingerprint cannot say which
        // program was approved, so it grants nothing. Recorded so the user is
        // told the approval needs renewing rather than finding it gone.
        let at = audit::now();
        for name in &legacy {
            if !self.stored.invalidated.iter().any(|i| &i.name == name) {
                self.stored.invalidated.push(Invalidated {
                    name: name.clone(),
                    reason: invalidation::SCHEMA_V1.to_string(),
                    at: at.clone(),
                    fingerprint: None,
                });
            }
            record(
                data_folder,
                name,
                "*",
                Outcome::Expired,
                "invalidated: trust recorded before server fingerprints; approval needs renewing"
                    .to_string(),
            );
        }
        if let Err(e) = self.save(data_folder) {
            eprintln!("mcp trust: could not persist the schema 2 migration: {e}");
        }
    }

    fn save(&self, data_folder: &Path) -> Result<(), String> {
        let path = path_for(data_folder);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let body = serde_json::to_string_pretty(&self.stored).map_err(|e| e.to_string())?;
        // Written beside the target and renamed, so a crash mid-write leaves
        // the previous list rather than a truncated one.
        let temp = path.with_extension(format!("json.tmp-{}", std::process::id()));
        std::fs::write(&temp, body.as_bytes()).map_err(|e| e.to_string())?;
        std::fs::rename(&temp, &path).map_err(|e| e.to_string())
    }

    fn grant_for(&self, server: &str) -> Option<&TrustGrant> {
        self.stored.trusted.iter().find(|g| g.name == server)
    }
}

/// Every standing grant, for the settings surface.
pub fn trusted(data_folder: &Path) -> Vec<TrustGrant> {
    let mut state = state().lock().expect("mcp trust");
    state.ensure_loaded(data_folder);
    state.stored.trusted.clone()
}

/// Approvals that stopped applying and need renewing, for the settings surface.
pub fn invalidated(data_folder: &Path) -> Vec<Invalidated> {
    let mut state = state().lock().expect("mcp trust");
    state.ensure_loaded(data_folder);
    state.stored.invalidated.clone()
}

/// Whether `server`, as currently defined by `fingerprint`, is trusted.
pub fn is_trusted(data_folder: &Path, server: &str, fingerprint: &str) -> bool {
    let mut state = state().lock().expect("mcp trust");
    state.ensure_loaded(data_folder);
    state
        .grant_for(server)
        .is_some_and(|g| g.fingerprint == fingerprint)
}

/// Record that the user trusts this server as currently defined.
///
/// Idempotent for the same fingerprint. A grant for a different fingerprint
/// is replaced: the user has just approved the definition they were shown.
pub fn trust(data_folder: &Path, server: &str, fingerprint: &str) -> Result<(), String> {
    if server.trim().is_empty() {
        return Err("a server name is required to trust one".to_string());
    }
    if fingerprint.trim().is_empty() {
        return Err(format!(
            "cannot trust MCP server '{server}' without knowing its configuration"
        ));
    }
    let mut state = state().lock().expect("mcp trust");
    state.ensure_loaded(data_folder);
    if state
        .grant_for(server)
        .is_some_and(|g| g.fingerprint == fingerprint)
    {
        return Ok(());
    }
    state.stored.trusted.retain(|g| g.name != server);
    state.stored.invalidated.retain(|i| i.name != server);
    state.stored.trusted.push(TrustGrant {
        name: server.to_string(),
        fingerprint: fingerprint.to_string(),
        granted_at: audit::now(),
    });
    state.save(data_folder)?;
    record(
        data_folder,
        server,
        "*",
        Outcome::Granted,
        format!("trusted; fingerprint {}", short(fingerprint)),
    );
    Ok(())
}

/// Withdraw trust, and forget any pending "needs renewing" notice for the
/// name. Takes effect on the next call, not retroactively: a tool already
/// running is the caller's to cancel.
///
/// Returns whether a live grant was removed. Audited only when one was.
pub fn revoke(data_folder: &Path, server: &str, reason: RevokeReason) -> Result<bool, String> {
    let mut state = state().lock().expect("mcp trust");
    state.ensure_loaded(data_folder);
    let before_trusted = state.stored.trusted.len();
    let before_invalidated = state.stored.invalidated.len();
    let removed = state.grant_for(server).cloned();
    state.stored.trusted.retain(|g| g.name != server);
    state.stored.invalidated.retain(|i| i.name != server);
    if state.stored.trusted.len() != before_trusted
        || state.stored.invalidated.len() != before_invalidated
    {
        state.save(data_folder)?;
    }
    if let Some(grant) = &removed {
        record(
            data_folder,
            server,
            "*",
            Outcome::Revoked,
            format!("{}; fingerprint {}", reason.as_str(), short(&grant.fingerprint)),
        );
    }
    Ok(removed.is_some())
}

/// Authorize exactly one call to one tool on one server as currently defined.
///
/// `current` is the fingerprint of the definition the backend would call.
/// `expected`, when given, is the fingerprint the renderer showed the user; a
/// mismatch means the definition changed between the question and the answer,
/// and no ticket is issued.
///
/// The ticket is process-local and never persisted: an "allow once" answer that
/// survived a restart would be a standing permission the user never gave.
pub fn allow_once(
    data_folder: &Path,
    server: &str,
    tool: &str,
    current: &str,
    expected: Option<&str>,
) -> Result<String, String> {
    if let Some(expected) = expected {
        if expected != current {
            record(
                data_folder,
                server,
                tool,
                Outcome::Deny,
                format!(
                    "allow-once rejected: configuration changed since approval (approved {}, now {})",
                    short(expected),
                    short(current)
                ),
            );
            return Err(Refusal::ConfigurationChanged {
                server: server.to_string(),
            }
            .message());
        }
    }
    let mut state = state().lock().expect("mcp trust");
    state.sequence += 1;
    let id = format!(
        "mcp-{}-{}-{}",
        std::process::id(),
        state.sequence,
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    // Expired tickets are dropped here rather than on a timer: this is the only
    // place the map grows, so it is the only place it needs pruning.
    let now = SystemTime::now();
    state.tickets.retain(|_, ticket| {
        now.duration_since(ticket.issued_at)
            .map(|age| age < TICKET_TTL)
            .unwrap_or(false)
    });
    state.tickets.insert(
        id.clone(),
        Ticket {
            server: server.to_string(),
            tool: tool.to_string(),
            fingerprint: current.to_string(),
            issued_at: now,
        },
    );
    drop(state);
    record(
        data_folder,
        server,
        tool,
        Outcome::Granted,
        format!("allow-once issued; fingerprint {}", short(current)),
    );
    Ok(id)
}

/// Why a call was refused, in words the caller can act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// The server is not trusted and no ticket was presented.
    NotTrusted { server: String },
    /// The server was trusted, but its definition changed since, so that
    /// approval no longer applies.
    ConfigurationChanged { server: String },
    /// A ticket was presented that does not authorize this call.
    ///
    /// Deliberately one variant for "unknown", "expired", "already used" and
    /// "issued for something else": telling a caller which of those it was
    /// tells it how to search for a ticket that would work.
    TicketRejected { server: String },
}

impl Refusal {
    pub fn message(&self) -> String {
        match self {
            Refusal::NotTrusted { server } => format!(
                "MCP server '{server}' is not trusted for this call. Ask the user to allow it \
                 before calling its tools; nothing was sent to the server."
            ),
            Refusal::ConfigurationChanged { server } => format!(
                "MCP server '{server}' changed its configuration since it was approved, so that \
                 approval no longer applies. Ask the user to allow it again; nothing was sent to \
                 the server."
            ),
            Refusal::TicketRejected { server } => format!(
                "the authorization for this call to '{server}' was not valid. Ask the user \
                 again; nothing was sent to the server."
            ),
        }
    }
}

/// May this call go ahead?
///
/// `server` is the server the tool was actually found on, resolved by the
/// caller -- never the name a request asked for. `current` is the fingerprint
/// of the definition that server is running; `None` when the caller could not
/// determine it, which permits nothing a grant or ticket would, because an
/// unidentifiable definition is not one anybody approved.
pub fn permits(
    data_folder: &Path,
    server: &str,
    tool: &str,
    current: Option<&str>,
    ticket: Option<&str>,
) -> Result<(), Refusal> {
    let mut state = state().lock().expect("mcp trust");
    state.ensure_loaded(data_folder);

    let mut changed = false;
    if let Some(grant) = state.grant_for(server).cloned() {
        if current == Some(grant.fingerprint.as_str()) {
            return Ok(());
        }
        if current.is_some() {
            // The definition changed under the grant. Invalidated rather than
            // merely skipped, so changing it back later does not silently
            // restore an approval, and so the user can be told why.
            changed = true;
            state.stored.trusted.retain(|g| g.name != server);
            state.stored.invalidated.retain(|i| i.name != server);
            state.stored.invalidated.push(Invalidated {
                name: server.to_string(),
                reason: invalidation::CONFIGURATION_CHANGED.to_string(),
                at: audit::now(),
                fingerprint: Some(grant.fingerprint.clone()),
            });
            if let Err(e) = state.save(data_folder) {
                eprintln!("mcp trust: could not persist an invalidated grant: {e}");
            }
            record(
                data_folder,
                server,
                "*",
                Outcome::Expired,
                format!(
                    "invalidated: configuration changed since approval (approved {}, now {})",
                    short(&grant.fingerprint),
                    short(current.unwrap_or_default())
                ),
            );
        }
    }

    let Some(id) = ticket else {
        drop(state);
        let refusal = if changed {
            Refusal::ConfigurationChanged {
                server: server.to_string(),
            }
        } else {
            Refusal::NotTrusted {
                server: server.to_string(),
            }
        };
        record(
            data_folder,
            server,
            tool,
            Outcome::Deny,
            if changed {
                "call refused: approval was for a different configuration".to_string()
            } else {
                "call refused: server not trusted and no one-time permission".to_string()
            },
        );
        return Err(refusal);
    };
    // Removed whether or not it matches: a ticket presented for the wrong call
    // has been spent as far as this process is concerned, so it cannot be
    // retried against a different server until one that matches is found.
    let found = state.tickets.remove(id);
    drop(state);
    let valid = found.is_some_and(|found| {
        let fresh = SystemTime::now()
            .duration_since(found.issued_at)
            .map(|age| age < TICKET_TTL)
            .unwrap_or(false);
        fresh
            && found.server == server
            && found.tool == tool
            && current == Some(found.fingerprint.as_str())
    });
    if valid {
        Ok(())
    } else {
        record(
            data_folder,
            server,
            tool,
            Outcome::Deny,
            "allow-once rejected: ticket unknown, used, expired, or issued for another call"
                .to_string(),
        );
        Err(Refusal::TicketRejected {
            server: server.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp_identity::fingerprint;
    use serde_json::json;

    /// Serializes the tests in this module: they share one process-wide cache
    /// and ticket map, and a test that reloads another's folder mid-way would
    /// read the wrong grants.
    fn lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    fn root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "jan-mcp-trust-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("root");
        state().lock().expect("mcp trust").loaded_from = None;
        dir
    }

    fn restart() {
        state().lock().expect("mcp trust").loaded_from = None;
    }

    fn files_v1() -> String {
        fingerprint(&json!({ "command": "npx", "args": ["files-mcp"] }))
    }

    fn files_v2() -> String {
        fingerprint(&json!({ "command": "npx", "args": ["other-mcp"] }))
    }

    fn audit_reasons(dir: &Path) -> Vec<(Outcome, String, String)> {
        audit::read_all(dir)
            .into_iter()
            .map(|r| (r.decision, r.resource, r.reason))
            .collect()
    }

    #[test]
    fn nothing_is_trusted_until_someone_says_so() {
        let _g = lock();
        let dir = root("empty");
        let fp = files_v1();
        assert!(!is_trusted(&dir, "files", &fp));
        assert_eq!(
            permits(&dir, "files", "read", Some(&fp), None),
            Err(Refusal::NotTrusted {
                server: "files".to_string()
            })
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_trusted_server_may_call_its_tools() {
        let _g = lock();
        let dir = root("trusted");
        let fp = files_v1();
        trust(&dir, "files", &fp).expect("trust");
        assert!(permits(&dir, "files", "read", Some(&fp), None).is_ok());
        assert!(permits(&dir, "files", "write", Some(&fp), None).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn trusting_one_server_does_not_trust_another_offering_the_same_tool_name() {
        let _g = lock();
        let dir = root("samename");
        let fp = files_v1();
        trust(&dir, "files", &fp).expect("trust");
        assert!(permits(&dir, "files", "fetch", Some(&fp), None).is_ok());
        assert_eq!(
            permits(&dir, "impostor", "fetch", Some(&fp), None),
            Err(Refusal::NotTrusted {
                server: "impostor".to_string()
            })
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The definition changed under the grant: a different executable is not
    /// the program the user approved.
    #[test]
    fn a_fingerprint_mismatch_is_refused_and_invalidates_the_grant() {
        let _g = lock();
        let dir = root("mismatch");
        trust(&dir, "files", &files_v1()).expect("trust");
        assert_eq!(
            permits(&dir, "files", "read", Some(&files_v2()), None),
            Err(Refusal::ConfigurationChanged {
                server: "files".to_string()
            })
        );
        // Invalidated, not merely skipped: changing it back does not restore it.
        assert!(!is_trusted(&dir, "files", &files_v1()));
        assert!(permits(&dir, "files", "read", Some(&files_v1()), None).is_err());
        let notice = invalidated(&dir);
        assert_eq!(notice.len(), 1);
        assert_eq!(notice[0].reason, invalidation::CONFIGURATION_CHANGED);
        assert_eq!(notice[0].fingerprint.as_deref(), Some(files_v1().as_str()));
        // And it survives a restart.
        restart();
        assert_eq!(invalidated(&dir).len(), 1);
        assert!(audit_reasons(&dir)
            .iter()
            .any(|(o, _, r)| *o == Outcome::Expired && r.contains("configuration changed")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unknown_current_definition_permits_nothing() {
        let _g = lock();
        let dir = root("unknown");
        let fp = files_v1();
        trust(&dir, "files", &fp).expect("trust");
        assert!(permits(&dir, "files", "read", None, None).is_err());
        let ticket = allow_once(&dir, "files", "read", &fp, None).expect("ticket");
        assert!(permits(&dir, "files", "read", None, Some(&ticket)).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A rename keeps the definition (same fingerprint) but not the name, and
    /// the grant is keyed by both.
    #[test]
    fn a_renamed_server_is_not_permitted_by_the_old_grant() {
        let _g = lock();
        let dir = root("rename");
        let fp = files_v1();
        trust(&dir, "files", &fp).expect("trust");
        assert_eq!(
            permits(&dir, "files-renamed", "read", Some(&fp), None),
            Err(Refusal::NotTrusted {
                server: "files-renamed".to_string()
            })
        );
        assert!(revoke(&dir, "files", RevokeReason::Renamed).expect("revoke"));
        assert!(permits(&dir, "files", "read", Some(&fp), None).is_err());
        assert!(audit_reasons(&dir)
            .iter()
            .any(|(o, _, r)| *o == Outcome::Revoked && r.contains("server renamed")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Deleting and re-adding a server with the same name and even the same
    /// definition starts from nothing.
    #[test]
    fn delete_revokes_and_a_recreated_server_inherits_nothing() {
        let _g = lock();
        let dir = root("delete");
        let fp = files_v1();
        trust(&dir, "files", &fp).expect("trust");
        assert!(revoke(&dir, "files", RevokeReason::Deleted).expect("revoke"));
        restart();
        assert!(trusted(&dir).is_empty());
        assert_eq!(
            permits(&dir, "files", "read", Some(&fp), None),
            Err(Refusal::NotTrusted {
                server: "files".to_string()
            })
        );
        // Revoking nothing is not audited as a revocation.
        assert!(!revoke(&dir, "files", RevokeReason::Deleted).expect("revoke"));
        let revocations = audit_reasons(&dir)
            .into_iter()
            .filter(|(o, _, _)| *o == Outcome::Revoked)
            .count();
        assert_eq!(revocations, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_ticket_authorizes_exactly_one_call() {
        let _g = lock();
        let dir = root("ticket");
        let fp = files_v1();
        let ticket = allow_once(&dir, "files", "read", &fp, None).expect("ticket");
        assert!(permits(&dir, "files", "read", Some(&fp), Some(&ticket)).is_ok());
        assert_eq!(
            permits(&dir, "files", "read", Some(&fp), Some(&ticket)),
            Err(Refusal::TicketRejected {
                server: "files".to_string()
            })
        );
        let reasons = audit_reasons(&dir);
        assert!(reasons
            .iter()
            .any(|(o, _, r)| *o == Outcome::Granted && r.contains("allow-once issued")));
        assert!(reasons
            .iter()
            .any(|(o, _, r)| *o == Outcome::Deny && r.contains("allow-once rejected")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_ticket_does_not_travel_to_another_server_or_another_tool() {
        let _g = lock();
        let dir = root("ticketscope");
        let fp = files_v1();
        let ticket = allow_once(&dir, "files", "read", &fp, None).expect("ticket");
        assert!(permits(&dir, "other", "read", Some(&fp), Some(&ticket)).is_err());

        let ticket = allow_once(&dir, "files", "read", &fp, None).expect("ticket");
        assert!(permits(&dir, "files", "write", Some(&fp), Some(&ticket)).is_err());

        let ticket = allow_once(&dir, "files", "read", &fp, None).expect("ticket");
        assert!(permits(&dir, "files", "read", Some(&files_v2()), Some(&ticket)).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_ticket_is_not_issued_for_a_definition_the_user_was_not_shown() {
        let _g = lock();
        let dir = root("ticketexpected");
        let err = allow_once(&dir, "files", "read", &files_v2(), Some(&files_v1()))
            .expect_err("mismatch");
        assert!(err.contains("changed its configuration"), "{err}");
        assert!(audit_reasons(&dir)
            .iter()
            .any(|(o, _, r)| *o == Outcome::Deny && r.contains("allow-once rejected")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_invented_ticket_authorizes_nothing() {
        let _g = lock();
        let dir = root("invented");
        assert_eq!(
            permits(
                &dir,
                "files",
                "read",
                Some(&files_v1()),
                Some("mcp-not-a-real-ticket")
            ),
            Err(Refusal::TicketRejected {
                server: "files".to_string()
            })
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Jozkah/jan#267: a trust file that cannot be parsed is not treated as
    /// empty and then overwritten: it is kept aside, whole, before the next
    /// decision writes a fresh one.
    #[test]
    fn an_unreadable_trust_file_is_kept_not_overwritten() {
        let _g = lock();
        let dir = root("corrupt");
        std::fs::create_dir_all(path_for(&dir).parent().unwrap()).unwrap();
        let original = "{ this is not json but held real grants";
        std::fs::write(path_for(&dir), original).unwrap();
        trust(&dir, "files", &files_v1()).expect("trust");
        let kept: Vec<_> = std::fs::read_dir(path_for(&dir).parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".corrupt-"))
            .collect();
        assert_eq!(kept.len(), 1, "the unreadable file was not kept aside");
        assert_eq!(std::fs::read_to_string(kept[0].path()).unwrap(), original);
        assert!(is_trusted(&dir, "files", &files_v1()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_ticket_is_never_written_to_disk() {
        let _g = lock();
        let dir = root("nopersist");
        allow_once(&dir, "files", "read", &files_v1(), None).expect("ticket");
        let text = std::fs::read_to_string(path_for(&dir)).unwrap_or_default();
        assert!(!text.contains("files"), "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn trust_survives_a_restart() {
        let _g = lock();
        let dir = root("restart");
        let fp = files_v1();
        trust(&dir, "files", &fp).expect("trust");
        restart();
        assert!(is_trusted(&dir, "files", &fp));
        let on_disk: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path_for(&dir)).unwrap()).unwrap();
        assert_eq!(on_disk["schema_version"], 2);
        assert_eq!(on_disk["trusted"][0]["name"], "files");
        assert_eq!(on_disk["trusted"][0]["fingerprint"], fp.as_str());
        assert!(on_disk["trusted"][0]["granted_at"].is_string());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn revoking_takes_effect_on_the_next_call() {
        let _g = lock();
        let dir = root("revoke");
        let fp = files_v1();
        trust(&dir, "files", &fp).expect("trust");
        revoke(&dir, "files", RevokeReason::User).expect("revoke");
        assert!(permits(&dir, "files", "read", Some(&fp), None).is_err());
        restart();
        assert!(!is_trusted(&dir, "files", &fp), "and it stays revoked");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn trusting_twice_records_one_entry_and_a_new_definition_replaces_it() {
        let _g = lock();
        let dir = root("idempotent");
        trust(&dir, "files", &files_v1()).expect("trust");
        trust(&dir, "files", &files_v1()).expect("trust again");
        assert_eq!(trusted(&dir).len(), 1);
        trust(&dir, "files", &files_v2()).expect("renewed");
        let grants = trusted(&dir);
        assert_eq!(grants.len(), 1);
        assert_eq!(grants[0].fingerprint, files_v2());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn renewing_clears_the_needs_renewing_notice() {
        let _g = lock();
        let dir = root("renew");
        trust(&dir, "files", &files_v1()).expect("trust");
        let _ = permits(&dir, "files", "read", Some(&files_v2()), None);
        assert_eq!(invalidated(&dir).len(), 1);
        trust(&dir, "files", &files_v2()).expect("renew");
        assert!(invalidated(&dir).is_empty());
        assert!(permits(&dir, "files", "read", Some(&files_v2()), None).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreadable_trust_file_trusts_nothing() {
        let _g = lock();
        let dir = root("corrupt");
        std::fs::write(path_for(&dir), "{ this is not json").expect("write");
        restart();
        assert!(trusted(&dir).is_empty());
        assert!(permits(&dir, "files", "read", Some(&files_v1()), None).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A schema 1 name says nothing about which program was approved, so it
    /// must not survive as trust -- and must not vanish unexplained either.
    #[test]
    fn a_schema_1_file_is_explicitly_invalidated_not_carried_over() {
        let _g = lock();
        let dir = root("v1");
        std::fs::write(
            path_for(&dir),
            r#"{ "schema_version": 1, "trusted": ["files", "github"] }"#,
        )
        .expect("write");
        restart();
        assert!(trusted(&dir).is_empty());
        assert!(permits(&dir, "files", "read", Some(&files_v1()), None).is_err());
        let notice = invalidated(&dir);
        let names: Vec<&str> = notice.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, vec!["files", "github"]);
        assert!(notice
            .iter()
            .all(|i| i.reason == invalidation::SCHEMA_V1 && i.fingerprint.is_none()));

        // Persisted as schema 2, so the migration does not repeat.
        let on_disk: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path_for(&dir)).unwrap()).unwrap();
        assert_eq!(on_disk["schema_version"], 2);
        assert_eq!(on_disk["trusted"], json!([]));
        restart();
        assert_eq!(invalidated(&dir).len(), 2);
        let expired = audit_reasons(&dir)
            .into_iter()
            .filter(|(o, _, _)| *o == Outcome::Expired)
            .count();
        assert_eq!(expired, 2, "audited once per name, not once per load");

        // Renewing one clears its notice only.
        trust(&dir, "files", &files_v1()).expect("renew");
        let names: Vec<String> = invalidated(&dir).into_iter().map(|i| i.name).collect();
        assert_eq!(names, vec!["github".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_with_no_version_is_treated_as_schema_1() {
        let _g = lock();
        let dir = root("noversion");
        std::fs::write(path_for(&dir), r#"{ "trusted": ["files"] }"#).expect("write");
        restart();
        assert!(trusted(&dir).is_empty());
        assert_eq!(invalidated(&dir)[0].reason, invalidation::SCHEMA_V1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn audit_history_survives_revocation() {
        let _g = lock();
        let dir = root("history");
        trust(&dir, "files", &files_v1()).expect("trust");
        revoke(&dir, "files", RevokeReason::Deleted).expect("revoke");
        let reasons = audit_reasons(&dir);
        assert!(reasons.iter().any(|(o, res, _)| *o == Outcome::Granted && res == "files/*"));
        assert!(reasons.iter().any(|(o, _, _)| *o == Outcome::Revoked));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
