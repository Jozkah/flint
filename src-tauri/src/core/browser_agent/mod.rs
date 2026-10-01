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
pub mod store;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod pane;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::LazyLock;

use url::Url;

/// The one pane the web side opens (`NATIVE_PREVIEW_ID = 'rail'`).
pub const PANE_LABEL: &str = "web-preview-rail";
/// Event to the main webview: open or navigate the pane to `{ url }`.
pub const EVENT_OPEN_PANE: &str = "browser-agent://open-pane";
/// Event to the main webview: `{ active, paused, host }`.
pub const EVENT_STATE: &str = "browser-agent://state";
/// Event to the main webview: a navigation the policy stopped, `{ url, reason }`.
pub const EVENT_BLOCKED: &str = "browser-agent://blocked";

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

/// Called from the pane's navigation handler: may `url` load in `label` right
/// now? While the agent holds the pane (it made a call in the last few
/// minutes) a hop the policy refuses outright -- a redirect to an internal
/// address, a denied domain, a file URL -- is stopped; otherwise the pane
/// behaves as it always has.
pub fn navigation_permitted(label: &str, url: &Url) -> bool {
    if label != PANE_LABEL || url.scheme() == "about" {
        return true;
    }
    let Some(lease) = STORE.lease() else {
        return true;
    };
    let ok = STORE.with_inputs(lease.enabled, &lease.network, lease.unattended, |i| policy::hop_allowed(url, i));
    if !ok {
        log::warn!("agent browser blocked navigation to {url}");
    }
    ok
}

/// The reason a hop was refused, for the notice the user sees.
pub fn navigation_refusal(url: &Url) -> String {
    let Some(lease) = STORE.lease() else {
        return String::new();
    };
    STORE.with_inputs(lease.enabled, &lease.network, lease.unattended, |i| match policy::decide(url, i) {
        policy::Decision::Deny(r) => r.message(),
        _ => String::new(),
    })
}
