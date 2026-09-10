//! Which MCP servers the user has agreed to run tools from. AH-041.
//!
//! The policy keys on the **server**, never on a tool name. A tool name is
//! chosen by the server that publishes it, so it is not an identity: a second
//! server can publish `fetch` too, and `call_tool` with no `server_name` picks
//! whichever server answers the search first. Trusting `fetch` would therefore
//! be trusting whoever got there first. Trusting a server is a statement about
//! something the user actually chose -- they configured it, by name, with a
//! command line they wrote.
//!
//! Two kinds of authorization, deliberately different:
//!
//! * **Trust**, granted per server, persisted, and surviving a restart. This is
//!   the "always allow this server" answer, and it is kept here rather than in
//!   renderer state so that what the backend enforces and what the user was
//!   shown cannot drift apart.
//! * **A ticket**, minted for one server, one tool, one call. Single use, short
//!   lived, and never written to disk, so an "allow once" answer cannot
//!   silently become a standing permission.
//!
//! What this does *not* claim: the renderer is still the thing that asks the
//! user, and it can mint a ticket whenever it likes. The gate stops a server
//! from being trusted without a recorded decision, and stops a tool name from
//! standing in for a server identity. It is not a defence against the renderer
//! itself.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// How long a single-use ticket stays valid.
///
/// Long enough for a slow tool call to start, short enough that a ticket left
/// over from an abandoned turn is not still lying around for the next one.
const TICKET_TTL: Duration = Duration::from_secs(300);

const FILE_NAME: &str = "mcp-trust.json";

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct Stored {
    #[serde(default = "schema_version")]
    schema_version: u32,
    /// Server names the user chose to trust, in the order they were granted.
    #[serde(default)]
    trusted: Vec<String>,
}

fn schema_version() -> u32 {
    1
}

struct Ticket {
    server: String,
    tool: String,
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

impl State {
    /// Read the file once per data folder. A missing or unreadable file means
    /// nothing is trusted yet, which is the safe answer and the correct one for
    /// a fresh install.
    fn ensure_loaded(&mut self, data_folder: &Path) {
        let path = path_for(data_folder);
        if self.loaded_from.as_deref() == Some(path.as_path()) {
            return;
        }
        self.stored = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Stored>(&text).ok())
            .unwrap_or_default();
        self.loaded_from = Some(path);
    }

    fn save(&self, data_folder: &Path) -> Result<(), String> {
        let path = path_for(data_folder);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let body = serde_json::to_string_pretty(&self.stored).map_err(|e| e.to_string())?;
        // Written beside the target and renamed, so a crash mid-write leaves
        // the previous list rather than a truncated one. A truncated trust file
        // reads as "nothing is trusted", which would prompt for every server
        // the user had already answered for.
        let temp = path.with_extension(format!("json.tmp-{}", std::process::id()));
        std::fs::write(&temp, body.as_bytes()).map_err(|e| e.to_string())?;
        std::fs::rename(&temp, &path).map_err(|e| e.to_string())
    }
}

/// Every server the user has trusted, for the settings surface.
pub fn trusted(data_folder: &Path) -> Vec<String> {
    let mut state = state().lock().expect("mcp trust");
    state.ensure_loaded(data_folder);
    state.stored.trusted.clone()
}

pub fn is_trusted(data_folder: &Path, server: &str) -> bool {
    let mut state = state().lock().expect("mcp trust");
    state.ensure_loaded(data_folder);
    state.stored.trusted.iter().any(|s| s == server)
}

/// Record that the user trusts this server. Idempotent.
pub fn trust(data_folder: &Path, server: &str) -> Result<(), String> {
    if server.trim().is_empty() {
        return Err("a server name is required to trust one".to_string());
    }
    let mut state = state().lock().expect("mcp trust");
    state.ensure_loaded(data_folder);
    if !state.stored.trusted.iter().any(|s| s == server) {
        state.stored.trusted.push(server.to_string());
        state.save(data_folder)?;
    }
    Ok(())
}

/// Withdraw trust. Takes effect on the next call, not retroactively: a tool
/// already running is the caller's to cancel.
pub fn revoke(data_folder: &Path, server: &str) -> Result<(), String> {
    let mut state = state().lock().expect("mcp trust");
    state.ensure_loaded(data_folder);
    let before = state.stored.trusted.len();
    state.stored.trusted.retain(|s| s != server);
    if state.stored.trusted.len() != before {
        state.save(data_folder)?;
    }
    Ok(())
}

/// Authorize exactly one call to one tool on one server.
///
/// The ticket is process-local and never persisted: an "allow once" answer that
/// survived a restart would be a standing permission the user never gave.
pub fn allow_once(server: &str, tool: &str) -> String {
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
            issued_at: now,
        },
    );
    id
}

/// Why a call was refused, in words the caller can act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// The server is not trusted and no ticket was presented.
    NotTrusted { server: String },
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
/// caller -- never the name a request asked for. That distinction is the point
/// of the whole module: a request that names no server is answered by whichever
/// server happens to publish a matching tool name, and the decision has to be
/// about that server.
pub fn permits(
    data_folder: &Path,
    server: &str,
    tool: &str,
    ticket: Option<&str>,
) -> Result<(), Refusal> {
    let mut state = state().lock().expect("mcp trust");
    state.ensure_loaded(data_folder);
    if state.stored.trusted.iter().any(|s| s == server) {
        return Ok(());
    }
    let Some(id) = ticket else {
        return Err(Refusal::NotTrusted {
            server: server.to_string(),
        });
    };
    // Removed whether or not it matches: a ticket presented for the wrong call
    // has been spent as far as this process is concerned, so it cannot be
    // retried against a different server until one that matches is found.
    let Some(found) = state.tickets.remove(id) else {
        return Err(Refusal::TicketRejected {
            server: server.to_string(),
        });
    };
    let fresh = SystemTime::now()
        .duration_since(found.issued_at)
        .map(|age| age < TICKET_TTL)
        .unwrap_or(false);
    if fresh && found.server == server && found.tool == tool {
        Ok(())
    } else {
        Err(Refusal::TicketRejected {
            server: server.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        // Each test gets its own folder, and the cache keys on the folder, so
        // loading here keeps one test's grants out of another's.
        state().lock().expect("mcp trust").loaded_from = None;
        dir
    }

    #[test]
    fn nothing_is_trusted_until_someone_says_so() {
        let dir = root("empty");
        assert!(!is_trusted(&dir, "files"));
        assert_eq!(
            permits(&dir, "files", "read", None),
            Err(Refusal::NotTrusted {
                server: "files".to_string()
            })
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_trusted_server_may_call_its_tools() {
        let dir = root("trusted");
        trust(&dir, "files").expect("trust");
        assert!(permits(&dir, "files", "read", None).is_ok());
        assert!(permits(&dir, "files", "write", None).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The criterion this exists for: a tool name is chosen by whoever
    /// publishes it, so trusting one server must not let another server's
    /// identically-named tool through.
    #[test]
    fn trusting_one_server_does_not_trust_another_offering_the_same_tool_name() {
        let dir = root("samename");
        trust(&dir, "files").expect("trust");
        assert!(permits(&dir, "files", "fetch", None).is_ok());
        assert_eq!(
            permits(&dir, "impostor", "fetch", None),
            Err(Refusal::NotTrusted {
                server: "impostor".to_string()
            })
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_ticket_authorizes_exactly_one_call() {
        let dir = root("ticket");
        let ticket = allow_once("files", "read");
        assert!(permits(&dir, "files", "read", Some(&ticket)).is_ok());
        // And not a second one.
        assert_eq!(
            permits(&dir, "files", "read", Some(&ticket)),
            Err(Refusal::TicketRejected {
                server: "files".to_string()
            })
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_ticket_does_not_travel_to_another_server_or_another_tool() {
        let dir = root("ticketscope");
        let ticket = allow_once("files", "read");
        assert!(permits(&dir, "other", "read", Some(&ticket)).is_err());

        let ticket = allow_once("files", "read");
        assert!(permits(&dir, "files", "write", Some(&ticket)).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_invented_ticket_authorizes_nothing() {
        let dir = root("invented");
        assert_eq!(
            permits(&dir, "files", "read", Some("mcp-not-a-real-ticket")),
            Err(Refusal::TicketRejected {
                server: "files".to_string()
            })
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An "allow once" answer must not outlive the process. Persisting it would
    /// turn one answer into a standing permission.
    #[test]
    fn a_ticket_is_never_written_to_disk() {
        let dir = root("nopersist");
        allow_once("files", "read");
        let text = std::fs::read_to_string(path_for(&dir)).unwrap_or_default();
        assert!(!text.contains("files"), "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn trust_survives_a_restart() {
        let dir = root("restart");
        trust(&dir, "files").expect("trust");
        // A fresh process reads the file rather than the cache.
        state().lock().expect("mcp trust").loaded_from = None;
        assert!(is_trusted(&dir, "files"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn revoking_takes_effect_on_the_next_call() {
        let dir = root("revoke");
        trust(&dir, "files").expect("trust");
        revoke(&dir, "files").expect("revoke");
        assert!(permits(&dir, "files", "read", None).is_err());
        state().lock().expect("mcp trust").loaded_from = None;
        assert!(!is_trusted(&dir, "files"), "and it stays revoked");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn trusting_twice_records_one_entry() {
        let dir = root("idempotent");
        trust(&dir, "files").expect("trust");
        trust(&dir, "files").expect("trust again");
        assert_eq!(trusted(&dir), vec!["files".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreadable_trust_file_trusts_nothing() {
        let dir = root("corrupt");
        std::fs::write(path_for(&dir), "{ this is not json").expect("write");
        state().lock().expect("mcp trust").loaded_from = None;
        assert!(!is_trusted(&dir, "files"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
