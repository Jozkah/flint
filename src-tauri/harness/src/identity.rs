//! Run identity (AHD-003).
//!
//! Before this module the harness minted three unrelated identifiers -- a
//! `thread_id`, a `session_id` used only to key a scratch directory, and a
//! subagent `run_id` -- and nothing correlated them. Every capability that has
//! to join records across surfaces (replay, audit export, per-agent provenance,
//! cost attribution) needs one identifier that reaches all of them.
//!
//! [`RunIdentity`] is that identifier. It is cheap to clone, stable for the life
//! of a run, and carries the parentage needed to reconstruct an agent tree.

use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{ErrorKind, HarnessError};

/// Ids are `<prefix>_<time><counter>` in lowercase base-36.
///
/// This avoids a `uuid` dependency in a crate every surface links, and yields
/// ids that sort by creation time, which makes an event log readable by eye.
/// Uniqueness comes from the process-wide counter; the timestamp only orders.
fn mint(prefix: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{}{}", base36(millis), base36(count))
}

fn base36(mut value: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).expect("base36 digits are ASCII")
}

/// Declares an id newtype: opaque, orderable, serialized as a bare string.
macro_rules! id_type {
    ($name:ident, $prefix:literal, $doc:literal) => {
        #[doc = $doc]
        #[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// The prefix every id of this kind carries.
            pub const PREFIX: &'static str = $prefix;

            /// Mints a fresh id.
            pub fn new() -> Self {
                Self(mint($prefix))
            }

            /// Adopts an existing id, rejecting one that is empty or wrongly prefixed.
            ///
            /// Ids arrive from disk and from other processes, so this is a real
            /// parsing boundary rather than a formality.
            pub fn parse(raw: impl Into<String>) -> Result<Self, HarnessError> {
                let raw = raw.into();
                let expected = concat!($prefix, "_");
                if !raw.starts_with(expected) || raw.len() <= expected.len() {
                    return Err(HarnessError::new(
                        ErrorKind::InvalidInput,
                        format!("expected an id of the form `{expected}...`, got {raw:?}"),
                    ));
                }
                Ok(Self(raw))
            }

            /// The id as it is written to disk and to the wire.
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

id_type!(RunId, "run", "One top-level orchestration. The correlation key for everything else.");
id_type!(ThreadId, "thr", "A conversation that outlives any single run.");
id_type!(SessionId, "ses", "One process-scoped attachment to a thread; keys ephemeral scratch state.");
id_type!(AgentId, "agt", "One agent within a run: the root agent or a subagent.");

/// The identity every event, record and audit line carries.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunIdentity {
    pub run: RunId,
    pub thread: ThreadId,
    pub session: SessionId,
    pub agent: AgentId,
    /// The agent that spawned this one. `None` for the root agent of a run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_agent: Option<AgentId>,
    /// Distance from the root agent. Bounds recursive spawning (`AH-113`).
    #[serde(default)]
    pub depth: u16,
}

impl RunIdentity {
    /// Starts a new run on an existing thread.
    pub fn root(thread: ThreadId, session: SessionId) -> Self {
        Self {
            run: RunId::new(),
            thread,
            session,
            agent: AgentId::new(),
            parent_agent: None,
            depth: 0,
        }
    }

    /// Derives a child agent's identity.
    ///
    /// Run, thread and session are inherited unchanged -- that inheritance is
    /// what makes a subagent's events join to its parent's run -- while the
    /// agent id is fresh and the depth increases.
    pub fn child(&self) -> Self {
        Self {
            run: self.run.clone(),
            thread: self.thread.clone(),
            session: self.session.clone(),
            agent: AgentId::new(),
            parent_agent: Some(self.agent.clone()),
            depth: self.depth.saturating_add(1),
        }
    }

    /// Whether this is the run's root agent.
    pub fn is_root(&self) -> bool {
        self.parent_agent.is_none()
    }
}

impl fmt::Display for RunIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.run, self.agent)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_within_a_process() {
        let ids: std::collections::HashSet<_> = (0..1000).map(|_| RunId::new().to_string()).collect();
        assert_eq!(ids.len(), 1000);
    }

    #[test]
    fn ids_carry_their_prefix() {
        assert!(RunId::new().as_str().starts_with("run_"));
        assert!(ThreadId::new().as_str().starts_with("thr_"));
        assert!(SessionId::new().as_str().starts_with("ses_"));
        assert!(AgentId::new().as_str().starts_with("agt_"));
    }

    #[test]
    fn parse_accepts_a_well_formed_id() {
        let minted = RunId::new();
        assert_eq!(RunId::parse(minted.to_string()).unwrap(), minted);
    }

    #[test]
    fn parse_rejects_a_foreign_or_empty_id() {
        for bad in ["", "run", "run_", "thr_abc", "abc"] {
            let err = RunId::parse(bad).unwrap_err();
            assert_eq!(err.kind(), ErrorKind::InvalidInput, "accepted {bad:?}");
        }
    }

    #[test]
    fn a_child_inherits_the_run_and_deepens() {
        let root = RunIdentity::root(ThreadId::new(), SessionId::new());
        let child = root.child();
        let grandchild = child.child();

        assert_eq!(child.run, root.run);
        assert_eq!(child.thread, root.thread);
        assert_eq!(child.session, root.session);
        assert_ne!(child.agent, root.agent);
        assert_eq!(child.parent_agent.as_ref(), Some(&root.agent));
        assert_eq!(grandchild.depth, 2);
        assert!(root.is_root());
        assert!(!child.is_root());
    }

    #[test]
    fn identity_round_trips_through_json() {
        let identity = RunIdentity::root(ThreadId::new(), SessionId::new()).child();
        let json = serde_json::to_string(&identity).unwrap();
        assert_eq!(serde_json::from_str::<RunIdentity>(&json).unwrap(), identity);
    }

    #[test]
    fn a_root_identity_omits_the_absent_parent() {
        let json = serde_json::to_string(&RunIdentity::root(ThreadId::new(), SessionId::new())).unwrap();
        assert!(!json.contains("parent_agent"), "{json}");
    }

    #[test]
    fn base36_is_stable() {
        assert_eq!(base36(0), "0");
        assert_eq!(base36(35), "z");
        assert_eq!(base36(36), "10");
    }
}
