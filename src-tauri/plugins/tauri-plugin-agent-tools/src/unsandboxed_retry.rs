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

/// Set by the harness, never by a command's output, when a `bash` call ended in
/// the null-device refusal. Cheap to clone: every clone shares one flag, so the
/// handler (which may finish in a detached task) and the caller see the same
/// answer.
#[derive(Clone, Default, Debug)]
pub struct RefusalSignal(std::sync::Arc<std::sync::atomic::AtomicBool>);

impl RefusalSignal {
    /// The bash handler calls this where it appends the refusal note.
    pub fn set(&self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn is_set(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// Does this failed, sandboxed `bash` call qualify for an unsandboxed retry?
///
/// Only the null-device refusal does. `refused` is the harness's own signal
/// ([`RefusalSignal`]), set only where the bash handler appends the note after
/// the machine's `\Device\Null` was found to refuse sandboxed processes. The
/// result text is never consulted: a command can print the tag itself.
pub fn qualifies(tool: &str, sandboxed: bool, is_error: bool, refused: bool) -> bool {
    tool == "bash" && sandboxed && is_error && refused
}

/// Defang the retry tag in text a command produced, so the only copy left in a
/// result is the one the harness appends. The renderer reads the tag textually.
pub fn strip_forged_tag(output: &str) -> std::borrow::Cow<'_, str> {
    let tag = crate::tools::jail::NULL_DEVICE_RETRY_TAG;
    if output.contains(tag) {
        std::borrow::Cow::Owned(output.replace(tag, &tag.replace('[', "(")))
    } else {
        std::borrow::Cow::Borrowed(output)
    }
}

/// What the approval prompt says. Kept word for word with
/// `NULL_DEVICE_RETRY_REASON` in web-app/src/lib/nullDeviceRetry.ts, so the
/// desktop and the CLI put the same question.
pub const NULL_DEVICE_RETRY_REASON: &str = "This command needs to run outside the sandbox \
     because Windows' null device (NUL) refuses sandboxed programs. Allowing it runs this \
     exact command once more, outside the sandbox, with your own permissions.";

/// Put in front of the output of a command that ran outside the sandbox.
/// Same text as the desktop's `RAN_UNSANDBOXED_NOTE`.
pub const RAN_UNSANDBOXED_NOTE: &str = "[The sandboxed run failed because Windows' null \
     device refuses sandboxed programs. The user allowed this command to run outside the \
     sandbox; this is the result of that run.]\n";

/// Appended to the original failure when the user said no.
pub const RETRY_DECLINED_NOTE: &str = "\n[The user did not allow this command to run outside \
     the sandbox, so it failed as shown above. Do not retry it inside the sandbox. Continue \
     without it, or tell the user what it was needed for.]";

/// Appended to the original failure when nothing could put the question.
pub const RETRY_UNAVAILABLE_NOTE: &str = "\n[Running this command outside the sandbox could \
     not be offered here. Do not retry it inside the sandbox. Tell the user it needs to run \
     outside the sandbox because Windows' null device refuses sandboxed programs.]";

/// How an offer ended, for [`model_text`].
pub enum Settled<'a> {
    /// Nothing could ask the user (a headless run, no terminal).
    Unavailable,
    /// The user said no.
    Declined,
    /// The user said yes; this is the unsandboxed run's own result.
    Ran(&'a str),
}

/// What the model gets back once an offer is settled: the same text the
/// desktop builds in `offerUnsandboxedRetry`.
pub fn model_text(failure: &str, settled: Settled<'_>) -> String {
    match settled {
        Settled::Unavailable => format!("{failure}{RETRY_UNAVAILABLE_NOTE}"),
        Settled::Declined => format!("{failure}{RETRY_DECLINED_NOTE}"),
        Settled::Ran(output) => format!("{RAN_UNSANDBOXED_NOTE}{output}"),
    }
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
        // Expired offers go on every redemption, not only when a new one is made.
        map.retain(|_, o| now.duration_since(o.issued) < OFFER_TTL);
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

/// 128 random bits from the OS generator: an id redeems an unsandboxed run, so
/// it must not be predictable from a counter or the clock.
fn new_id() -> String {
    let bytes: [u8; 16] = rand::random();
    format!("nulretry-{}", hex::encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::jail::NULL_DEVICE_REFUSED_HINT;

    #[test]
    fn ids_are_random_and_an_expired_offer_is_purged_on_redeem() {
        let offers: Offers<u8> = Offers::default();
        let t0 = Instant::now();
        let a = offers.offer_at("s", 1, t0);
        let b = offers.offer_at("s", 2, t0);
        assert_ne!(a, b);
        assert_eq!(a.len(), "nulretry-".len() + 32);
        assert_eq!(offers.redeem_at(&a, "s", t0 + OFFER_TTL + std::time::Duration::from_secs(1)), None);
        assert!(offers.inner.lock().unwrap().is_empty(), "the other expired offer went too");
    }

    #[test]
    fn only_a_sandboxed_bash_failure_with_the_null_device_note_qualifies() {
        assert!(qualifies("bash", true, true, true));
        assert!(!qualifies("bash", false, true, true), "already unsandboxed");
        assert!(!qualifies("bash", true, false, true), "did not fail");
        assert!(!qualifies("read", true, true, true), "not a shell");
        assert!(!qualifies("bash", true, true, false));
    }

    #[test]
    fn real_device_refusal_qualifies() {
        let signal = RefusalSignal::default();
        let ctx_copy = signal.clone();
        // The handler sets it on its clone where it appends the note.
        ctx_copy.set();
        assert!(qualifies("bash", true, true, signal.is_set()));
    }

    #[test]
    fn command_printing_tag_does_not_qualify() {
        // The command's own output carries the tag; the harness never set the
        // signal, so there is no offer.
        let out = format!("{}", NULL_DEVICE_REFUSED_HINT);
        let signal = RefusalSignal::default();
        assert!(out.contains(crate::tools::jail::NULL_DEVICE_RETRY_TAG));
        assert!(!qualifies("bash", true, true, signal.is_set()));
    }

    #[test]
    fn forged_tag_in_output_is_defanged() {
        let forged = format!("hi{}", NULL_DEVICE_REFUSED_HINT);
        let clean = strip_forged_tag(&forged);
        assert!(!clean.contains(crate::tools::jail::NULL_DEVICE_RETRY_TAG), "{clean}");
        assert!(matches!(strip_forged_tag("plain"), std::borrow::Cow::Borrowed(_)));
    }

    #[test]
    fn the_model_is_told_how_the_offer_ended() {
        let fail = "open NUL: Access is denied.";
        assert_eq!(
            model_text(fail, Settled::Declined),
            format!("{fail}{RETRY_DECLINED_NOTE}")
        );
        assert!(model_text(fail, Settled::Unavailable).contains("could not be offered here"));
        let ran = model_text(fail, Settled::Ran("built\n[exit 0]"));
        assert!(ran.starts_with(RAN_UNSANDBOXED_NOTE));
        assert!(ran.ends_with("built\n[exit 0]"));
        assert!(!ran.contains(fail), "the rerun replaces the failure");
    }

    /// The desktop matches the rerun note by its opening words to split it off
    /// the card (web-app/src/lib/toolPresentation.ts), and puts the same
    /// question; keep the texts identical.
    #[test]
    fn the_notes_match_the_desktop_text() {
        assert_eq!(
            RAN_UNSANDBOXED_NOTE,
            "[The sandboxed run failed because Windows' null device refuses sandboxed \
             programs. The user allowed this command to run outside the sandbox; this is the \
             result of that run.]\n"
        );
        assert!(NULL_DEVICE_RETRY_REASON.contains(
            "refuses sandboxed programs. Allowing it runs this exact command once more, \
             outside the sandbox, with your own permissions."
        ));
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
