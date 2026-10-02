//! The agent's browser: the model reads and drives the same built-in browser
//! pane the user sees (`core::web_preview`'s child webview), not a hidden
//! browser of its own.
//!
//! - `policy`: which hosts it may load (first visit asks; internal addresses
//!   never; project and machine domain lists honoured). Pure.
//! - `fence`: page text reaches the model only inside a nonce-delimited
//!   untrusted block, size-capped. Pure.
//! - `store`: saved domain rules, session grants, per-run action counters and
//!   the lease that makes the navigation handler enforce the policy.
//! - `script` + `agent.js`: the code injected into the page (DOM snapshot with
//!   node ids, text, click / type / press / select).
//! - `pane`: the Tauri commands that tie them to the webview.
//!
//! Page content can never be trusted, so nothing in the page is allowed to
//! decide anything: every decision above is made here, outside the page, and
//! re-made on each call from the URL the webview actually reports.

pub mod fence;
pub mod policy;
pub mod script;
pub mod shot;
pub mod step;
pub mod store;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod pane;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use url::Url;

/// The one pane the web side opens (`NATIVE_PREVIEW_ID = 'rail'`).
pub const PANE_LABEL: &str = "web-preview-rail";
/// Event to the main webview: open or navigate the pane to `{ url }`.
pub const EVENT_OPEN_PANE: &str = "browser-agent://open-pane";
/// Event to the main webview: `{ active, paused, host }`.
pub const EVENT_STATE: &str = "browser-agent://state";
/// Event to the main webview: a navigation the policy stopped, `{ url, reason }`.
pub const EVENT_BLOCKED: &str = "browser-agent://blocked";
/// Event to the main webview: a page tried to send the pane to a public site
/// nobody approved, `{ url, host }`. The web layer asks the user.
pub const EVENT_DOMAIN_REQUEST: &str = "browser-agent://domain-request";

pub static STORE: LazyLock<store::Store> = LazyLock::new(store::Store::default);

static LOAD_SEQ: AtomicU64 = AtomicU64::new(0);
static LOADING: AtomicBool = AtomicBool::new(false);

/// Called from the pane's page-load callback so a tool can wait for a load.
pub fn on_page_load(label: &str, started: bool) {
    if label != PANE_LABEL {
        return;
    }
    if started {
        LOAD_SEQ.fetch_add(1, Ordering::SeqCst);
    }
    LOADING.store(started, Ordering::SeqCst);
}

pub(crate) fn load_seq() -> u64 {
    LOAD_SEQ.load(Ordering::SeqCst)
}

pub(crate) fn loading() -> bool {
    LOADING.load(Ordering::SeqCst)
}

/// A load that never reported its end (the window was hidden) must not leave the
/// pane looking busy.
pub(crate) fn reset_loading() {
    LOADING.store(false, Ordering::SeqCst);
}

/// Release everything a tool call that timed out may have left behind: the
/// lease (so the pane is the user's again), the "loading" flag, and the
/// open-in-flight marker. A later call starts clean.
pub(crate) fn release_pane_state() {
    STORE.clear_lease();
    reset_loading();
    set_open_in_flight(false);
}

/// A navigation the policy stopped, for the tool call that was waiting on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockInfo {
    pub url: String,
    /// The real reason, in words.
    pub reason: String,
    /// Set when the hop was to a public site nobody has approved: the host to ask about.
    pub needs_approval: Option<String>,
}

static BLOCK_SEQ: AtomicU64 = AtomicU64::new(0);
static LAST_BLOCK: Mutex<Option<BlockInfo>> = Mutex::new(None);
static LAST_PROMPT: Mutex<Option<(String, Instant)>> = Mutex::new(None);
/// A tool call is opening a page and will itself report a blocked hop (and ask),
/// so the handler must not raise a second prompt for it.
static OPEN_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

pub(crate) fn block_seq() -> u64 {
    BLOCK_SEQ.load(Ordering::SeqCst)
}

pub(crate) fn last_block() -> Option<BlockInfo> {
    LAST_BLOCK.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

pub(crate) fn set_open_in_flight(on: bool) {
    OPEN_IN_FLIGHT.store(on, Ordering::SeqCst);
}

/// Called from the pane's navigation handler, which runs on the webview's own
/// thread: may `url` load in `label` right now? It must never wait. It reads an
/// immutable snapshot of the policy (`Store::nav_check`) and nothing else: no
/// store lock, no DNS (an address is judged as written; what a name resolves to
/// is checked by the tool calls), no webview call, no file.
///
/// While the agent holds the pane (it made a call in the last few minutes):
/// - an internal address, a denied or off-list domain, a file URL: refused;
/// - a public site nobody approved (a redirect or link out of the approved
///   site): stopped before anything is requested from it, and the user is asked;
/// - the approved site's own pages and subdomains, and sites with a rule or
///   grant: allowed.
/// Otherwise the pane behaves as it always has.
pub fn navigation_permitted(label: &str, url: &Url) -> bool {
    if label != PANE_LABEL || url.scheme() == "about" {
        return true;
    }
    let (reason, needs) = match STORE.nav_check(url) {
        store::NavCheck::NoLease | store::NavCheck::Verdict(policy::Hop::Allow) => return true,
        store::NavCheck::Verdict(policy::Hop::NeedsApproval { host }) => (
            format!("{host} has not been approved. A page on an approved site sent the browser there, so it was stopped before anything was requested"),
            Some(host),
        ),
        store::NavCheck::Verdict(policy::Hop::Refused(r)) => (r.message(), None),
        store::NavCheck::Busy => ("the browser policy was being updated; try again".to_string(), None),
    };
    // Remembered for the tool call waiting on this load. try_lock: the handler
    // never waits, and losing a note under contention only loses the wording.
    if let Ok(mut g) = LAST_BLOCK.try_lock() {
        *g = Some(BlockInfo { url: url.to_string(), reason, needs_approval: needs });
    }
    BLOCK_SEQ.fetch_add(1, Ordering::SeqCst);
    log::warn!("agent browser blocked navigation to {}", redact(url));
    false
}

/// The URL as logged: no query string (it may carry what a hostile page wanted out).
fn redact(url: &Url) -> String {
    let mut u = url.clone();
    u.set_query(None);
    u.set_fragment(None);
    u.to_string()
}

/// Tell the user a hop was stopped, and for an unapproved public site ask about
/// it. Called right after `navigation_permitted` said no, from the handler, so
/// it only spawns: the events are sent from the async runtime, never from the
/// webview's thread.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn report_block<R: tauri::Runtime>(app: &tauri::AppHandle<R>, url: &Url) {
    let Some(info) = last_block().filter(|b| b.url == url.as_str()) else {
        return;
    };
    let ask = info
        .needs_approval
        .clone()
        .filter(|_| !OPEN_IN_FLIGHT.load(Ordering::SeqCst))
        .filter(|host| {
            // One prompt per host every few seconds: a page that keeps retrying
            // must not bury the user in dialogs.
            match LAST_PROMPT.try_lock() {
                Ok(mut g) => {
                    let recent = g.as_ref().is_some_and(|(h, at)| h == host && at.elapsed() < Duration::from_secs(5));
                    if !recent {
                        *g = Some((host.clone(), Instant::now()));
                    }
                    !recent
                }
                Err(_) => false,
            }
        });
    let app = app.clone();
    let shown = redact(url);
    let full = info.url.clone();
    tauri::async_runtime::spawn(async move {
        use tauri::{Emitter, EventTarget};
        let _ = app.emit_to(
            EventTarget::webview("main"),
            EVENT_BLOCKED,
            serde_json::json!({ "url": shown, "reason": info.reason }),
        );
        if let Some(host) = ask {
            let _ = app.emit_to(
                EventTarget::webview("main"),
                EVENT_DOMAIN_REQUEST,
                serde_json::json!({ "url": full, "host": host }),
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    /// These tests share the global store and its lease.
    static SERIAL: Mutex<()> = Mutex::new(());

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    /// The pane's entry point is the one the freeze went through. It must come
    /// back at once while another thread is inside the store.
    #[test]
    fn the_navigation_entry_point_does_not_wait_for_the_store() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        STORE.set_lease(&policy::NetworkPolicy::open(), false, true);
        STORE.add_visit("approved-site.test");
        let (tx, rx) = mpsc::channel();
        let (held_tx, held_rx) = mpsc::channel::<()>();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        // Another thread sits inside the store (as a settings command would).
        let holder = std::thread::spawn(move || {
            STORE.with_inputs(true, &policy::NetworkPolicy::open(), false, |_| {
                let _ = held_tx.send(());
                let _ = release_rx.recv_timeout(Duration::from_secs(5));
            });
        });
        held_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let caller = std::thread::spawn(move || {
            let a = navigation_permitted(PANE_LABEL, &u("https://docs.approved-site.test/x"));
            let b = navigation_permitted(PANE_LABEL, &u("https://collector.evil.test/c?d=SECRET"));
            let c = navigation_permitted(PANE_LABEL, &u("http://169.254.169.254/latest/"));
            let _ = tx.send((a, b, c));
        });
        let got = rx.recv_timeout(Duration::from_secs(3)).expect("navigation_permitted waited on the store");
        assert_eq!(got, (true, false, false));
        let _ = release_tx.send(());
        holder.join().unwrap();
        caller.join().unwrap();
        STORE.clear_lease();
    }

    #[test]
    fn a_blocked_hop_is_remembered_with_its_real_reason() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        STORE.set_lease(&policy::NetworkPolicy::open(), false, true);
        STORE.add_visit("approved-site.test");
        let before = block_seq();
        assert!(!navigation_permitted(PANE_LABEL, &u("http://169.254.169.254/latest/meta-data/")));
        assert!(block_seq() > before);
        let b = last_block().unwrap();
        assert!(b.url.starts_with("http://169.254.169.254"));
        assert!(b.reason.contains("cloud metadata"), "{}", b.reason);
        assert!(!b.reason.contains("only http and https"), "{}", b.reason);
        assert_eq!(b.needs_approval, None);

        assert!(!navigation_permitted(PANE_LABEL, &u("https://elsewhere.test/")));
        assert_eq!(last_block().unwrap().needs_approval.as_deref(), Some("elsewhere.test"));
        STORE.clear_lease();
    }

    #[test]
    fn a_timed_out_call_leaves_no_lease_loading_or_in_flight_state() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        STORE.set_lease(&policy::NetworkPolicy::open(), false, true);
        STORE.add_visit("approved-site.test");
        on_page_load(PANE_LABEL, true); // a load started and never finished
        set_open_in_flight(true);
        assert!(loading());
        assert!(STORE.lease().is_some());

        release_pane_state();

        assert!(!loading(), "no leaked loading flag");
        assert!(!OPEN_IN_FLIGHT.load(Ordering::SeqCst), "no leaked in-flight marker");
        assert!(STORE.lease().is_none(), "the pane is the user's again");
        // The pane is not restricted any more...
        assert_eq!(STORE.nav_check(&u("https://anything.test/")), store::NavCheck::NoLease);
        assert!(navigation_permitted(PANE_LABEL, &u("https://anything.test/")));
        // ...and a later call (the window restored) takes the lease again.
        STORE.set_lease(&policy::NetworkPolicy::open(), false, true);
        assert!(STORE.lease().is_some());
        STORE.clear_lease();
    }

    #[test]
    fn other_panes_and_blank_pages_are_never_judged() {
        assert!(navigation_permitted("web-preview-other", &u("http://169.254.169.254/")));
        assert!(navigation_permitted(PANE_LABEL, &u("about:blank")));
    }

    #[test]
    fn the_logged_url_has_no_query() {
        assert_eq!(redact(&u("https://a.test/p?token=SECRET#frag")), "https://a.test/p");
    }
}
