//! One-shot offers to re-run a failed `bash` command outside the sandbox.
//!
//! On a Windows machine whose null device refuses AppContainers, a program that
//! opens NUL itself (go, git, some build tools) cannot run in the sandbox at
//! all. The machine's device ACL is deliberately left alone; instead the failed
//! call registers an offer here and hands the renderer an opaque id. The
//! renderer asks the user, and only an approved id is redeemed to run that
//! exact call again, unconfined.
//!
//! The id is the only authority. It never reaches the model (it travels on the
//! tool result, not in its text), it names the call it was issued for rather
//! than taking a command from the caller, it is valid for one redemption, only
//! in the session it was issued to, and only for a few minutes. Nothing is
//! persisted: a restart forgets every offer.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long an offer stays redeemable. Long enough for the user to read the
/// prompt; short enough that a stale one cannot be replayed later.
pub const OFFER_TTL: Duration = Duration::from_secs(15 * 60);

/// Does this failed, sandboxed `bash` output qualify for an unsandboxed retry?
///
/// Only the null-device refusal does: its note is appended by the bash handler
/// only when the backend is AppContainer and the machine's `\Device\Null`
/// refuses sandboxed processes, so this is the one failure the sandbox itself
/// guarantees.
pub fn qualifies(tool: &str, sandboxed: bool, is_error: bool, content: &str) -> bool {
    tool == "bash"
        && sandboxed
        && is_error
        && content.contains(crate::tools::jail::NULL_DEVICE_RETRY_TAG)
}

struct Offer<P> {
    session: String,
    issued: Instant,
    call: P,
}

/// A registry of outstanding offers. `P` is whatever the caller needs to run
/// the call again; the registry never looks inside it.
pub struct Offers<P> {
    inner: Mutex<HashMap<String, Offer<P>>>,
}

impl<P> Default for Offers<P> {
    fn default() -> Self {
        Self { inner: Mutex::new(HashMap::new()) }
    }
}

impl<P> Offers<P> {
    /// Register `call` for `session` and return the id that redeems it.
    pub fn offer(&self, session: &str, call: P) -> String {
        self.offer_at(session, call, Instant::now())
    }

    fn offer_at(&self, session: &str, call: P, now: Instant) -> String {
        let id = new_id();
        if let Ok(mut map) = self.inner.lock() {
            map.retain(|_, o| now.duration_since(o.issued) < OFFER_TTL);
            map.insert(id.clone(), Offer { session: session.to_string(), issued: now, call });
        }
        id
    }

    /// Take the call `id` names, if it was issued to `session` and has not
    /// expired. One redemption only: the offer is gone either way once looked
    /// up by its own session, so a refused or replayed id authorizes nothing.
    pub fn redeem(&self, id: &str, session: &str) -> Option<P> {
        self.redeem_at(id, session, Instant::now())
    }

    fn redeem_at(&self, id: &str, session: &str, now: Instant) -> Option<P> {
        let mut map = self.inner.lock().ok()?;
        // Another session's id is left in place: guessing it must not let a
        // caller cancel someone else's prompt either.
        if map.get(id)?.session != session {
            return None;
        }
        let offer = map.remove(id)?;
        (now.duration_since(offer.issued) < OFFER_TTL).then_some(offer.call)
    }

    /// Drop an offer the user declined, so it cannot be redeemed later.
    pub fn withdraw(&self, id: &str, session: &str) {
        let _ = self.redeem(id, session);
    }
}

/// Process-local and never shown to a model; unique, and not trivially
/// guessable, without a dependency.
fn new_id() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let mut h = RandomState::new().build_hasher();
    h.write_u64(n);
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    format!("nulretry-{n}-{:016x}", h.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::jail::NULL_DEVICE_REFUSED_HINT;

    #[test]
    fn only_a_sandboxed_bash_failure_with_the_null_device_note_qualifies() {
        let out = format!("open NUL: Access is denied.{NULL_DEVICE_REFUSED_HINT}");
        assert!(qualifies("bash", true, true, &out));
        assert!(!qualifies("bash", false, true, &out), "already unsandboxed");
        assert!(!qualifies("bash", true, false, &out), "did not fail");
        assert!(!qualifies("read", true, true, &out), "not a shell");
        assert!(!qualifies("bash", true, true, "open NUL: Access is denied."));
    }

    #[test]
    fn an_offer_redeems_once_in_its_own_session() {
        let offers = Offers::default();
        let id = offers.offer("s1", "go build");
        assert_eq!(offers.redeem(&id, "s2"), None, "another session");
        assert_eq!(offers.redeem(&id, "s1"), Some("go build"));
        assert_eq!(offers.redeem(&id, "s1"), None, "second redemption");
        assert_eq!(offers.redeem("nulretry-made-up", "s1"), None);
    }

    #[test]
    fn a_withdrawn_offer_cannot_be_redeemed() {
        let offers = Offers::default();
        let id = offers.offer("s1", 1);
        offers.withdraw(&id, "s1");
        assert_eq!(offers.redeem(&id, "s1"), None);
    }

    #[test]
    fn an_expired_offer_cannot_be_redeemed() {
        let offers = Offers::default();
        let start = Instant::now();
        let id = offers.offer_at("s1", 1, start);
        assert_eq!(offers.redeem_at(&id, "s1", start + OFFER_TTL), None);
    }

    #[test]
    fn ids_are_distinct() {
        let offers = Offers::default();
        assert_ne!(offers.offer("s", 1), offers.offer("s", 2));
    }
}
