//! The DevTools event loop both consumers run.
//!
//! It answers every paused request against the origin policy (the
//! confinement), confines frames and workers before they run, and turns what
//! the page does into [`Observed`] values for the consumer to record. What to
//! *do* about an observation (stop a run, auto-dismiss a dialog) is the
//! consumer's: the loop only decides what is allowed to load.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedReceiver;
use url::Url;

use super::cdp::{Cdp, Event};
use super::confine::{display_url, OriginPolicy};

/// Longest text kept from one console message or error.
pub const MAX_TEXT: usize = 500;

pub fn clip(text: &str) -> String {
    let t: String = text.chars().take(MAX_TEXT).collect();
    if text.chars().count() > MAX_TEXT {
        format!("{t}…")
    } else {
        t
    }
}

/// The tabs the browser works in: each one's DevTools session and main frame,
/// shared with the event loop so it knows which requests are a tab's own
/// navigation and which targets are tabs this session made.
#[derive(Clone, Default)]
pub struct Mains {
    tabs: Arc<Mutex<Vec<(String, String)>>>,
    popups: Arc<AtomicBool>,
    /// Tabs this session is about to create itself: their `targetCreated`
    /// is not a window the page opened.
    own: Arc<AtomicUsize>,
}

impl Mains {
    /// A browser with the one tab `(session, frame)`.
    pub fn single(session: &str, frame: &str) -> Self {
        let m = Mains::default();
        m.add(session, frame);
        m
    }

    pub fn add(&self, session: &str, frame: &str) {
        if let Ok(mut t) = self.tabs.lock() {
            if !t.iter().any(|(s, _)| s == session) {
                t.push((session.to_string(), frame.to_string()));
            }
        }
    }

    pub fn remove_session(&self, session: &str) {
        if let Ok(mut t) = self.tabs.lock() {
            t.retain(|(s, _)| s != session);
        }
    }

    pub fn contains(&self, session: Option<&str>, frame: Option<&str>) -> bool {
        match (session, frame) {
            (Some(s), Some(f)) => self.tabs.lock().map(|t| t.iter().any(|(ts, tf)| ts == s && tf == f)).unwrap_or(false),
            _ => false,
        }
    }

    pub fn has_frame(&self, frame: Option<&str>) -> bool {
        frame.is_some_and(|f| self.tabs.lock().map(|t| t.iter().any(|(_, tf)| tf == f)).unwrap_or(false))
    }

    pub fn has_session(&self, session: Option<&str>) -> bool {
        session.is_some_and(|s| self.tabs.lock().map(|t| t.iter().any(|(ts, _)| ts == s)).unwrap_or(false))
    }

    /// Whether windows the page opens are kept (confined) rather than closed.
    pub fn set_popups(&self, on: bool) {
        self.popups.store(on, Ordering::SeqCst);
    }

    pub fn popups(&self) -> bool {
        self.popups.load(Ordering::SeqCst)
    }

    /// A tab this session creates is on its way; its `targetCreated` is ours.
    pub fn expect_own(&self) {
        self.own.fetch_add(1, Ordering::SeqCst);
    }

    fn take_own(&self) -> bool {
        self.own
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_ok()
    }
}

/// Something the page or browser did.
#[derive(Debug, Clone, PartialEq)]
pub enum Observed {
    /// A request the policy refused. `navigation` is a main-frame document.
    Blocked { url: String, resource_type: String, navigation: bool },
    /// A `console.*` call; `level` is the console type (`error`, `warning`, ...).
    Console { level: String, text: String },
    /// An uncaught exception.
    Exception { text: String },
    /// A browser log entry (not one this policy caused, not a favicon).
    Log { level: String, text: String, url: String },
    /// The main frame's document answered.
    Document { status: u16, url: String },
    /// A request that came back with an HTTP error status or failed to load.
    RequestFailed { method: String, url: String, status: Option<u16>, reason: String },
    /// The main frame moved to `url` (any navigation, including same-document).
    Navigated { url: String },
    /// An alert, confirm, prompt or beforeunload dialog is open and waiting.
    Dialog { session: Option<String>, kind: String, message: String, default_prompt: String },
    /// A download started (and is refused).
    Download { url: String, filename: String },
    /// The page opened another tab or window and popups are off: it was closed.
    Popup { url: String },
    /// The page opened a window and popups are on: the consumer attaches to it
    /// (confining it) and adds it to the tabs.
    NewTab { target_id: String, url: String },
    /// A tab crashed or was closed.
    PageGone { session: String, why: String },
    /// The browser connection ended.
    BrowserExited,
}

/// What happens to a main-frame navigation the policy refuses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavigationBlock {
    /// The request fails (the page shows the browser's error page). A verify
    /// run stops at this anyway.
    Fail,
    /// The request is answered `204 No Content`, which a browser takes as
    /// "stay where you are": the page is left exactly as it was, so a session
    /// can carry on after a link to somewhere it may not go.
    Stay,
}

/// Run the loop until the browser connection ends. `sink` is called for every
/// observation, in order, from the loop's task: it must not block.
pub fn spawn(
    cdp: Cdp,
    mut events: UnboundedReceiver<Event>,
    policy: OriginPolicy,
    mains: Mains,
    navigation_block: NavigationBlock,
    mut sink: impl FnMut(Observed) + Send + 'static,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        // Requests we let through, to say what failed later: id -> (method, url).
        let mut inflight: std::collections::HashMap<String, (String, String)> = Default::default();
        while let Some(ev) = events.recv().await {
            let session = ev.session_id.as_deref();
            let p = &ev.params;
            match ev.method.as_str() {
                "Fetch.requestPaused" => {
                    let id = p["requestId"].as_str().unwrap_or_default();
                    let url = p["request"]["url"].as_str().unwrap_or_default();
                    if policy.permits(url) {
                        cdp.fire("Fetch.continueRequest", json!({ "requestId": id }), session);
                        continue;
                    }
                    let resource_type = p["resourceType"].as_str().unwrap_or("Other").to_string();
                    let navigation = resource_type == "Document"
                        && mains.contains(session, p["frameId"].as_str());
                    if navigation && navigation_block == NavigationBlock::Stay {
                        cdp.fire(
                            "Fetch.fulfillRequest",
                            json!({ "requestId": id, "responseCode": 204, "responseHeaders": [] }),
                            session,
                        );
                    } else {
                        cdp.fire(
                            "Fetch.failRequest",
                            json!({ "requestId": id, "errorReason": "BlockedByClient" }),
                            session,
                        );
                    }
                    sink(Observed::Blocked { url: display_url(url), resource_type, navigation });
                }
                // A frame or worker: confine it the same way before it runs.
                "Target.attachedToTarget" => {
                    if let Some(child) = p["sessionId"].as_str() {
                        cdp.fire("Fetch.enable", json!({ "patterns": [{ "urlPattern": "*" }] }), Some(child));
                        cdp.fire("Runtime.enable", json!({}), Some(child));
                        cdp.fire(
                            "Target.setAutoAttach",
                            json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true }),
                            Some(child),
                        );
                        cdp.fire("Runtime.runIfWaitingForDebugger", json!({}), Some(child));
                    }
                }
                "Runtime.consoleAPICalled" => {
                    sink(Observed::Console {
                        level: p["type"].as_str().unwrap_or_default().to_string(),
                        text: clip(&console_text(p)),
                    });
                }
                "Runtime.exceptionThrown" => {
                    let d = &p["exceptionDetails"];
                    let text = d["exception"]["description"]
                        .as_str()
                        .or(d["text"].as_str())
                        .unwrap_or("Uncaught exception");
                    sink(Observed::Exception { text: clip(text) });
                }
                "Log.entryAdded" => {
                    let e = &p["entry"];
                    let text = e["text"].as_str().unwrap_or_default();
                    // A request this policy blocked is reported as blocked, not
                    // as the page's own error; nor is the browser's own favicon
                    // request, which no page asked for.
                    let favicon = e["url"]
                        .as_str()
                        .and_then(|u| Url::parse(u).ok())
                        .is_some_and(|u| u.path() == "/favicon.ico");
                    if !text.contains("ERR_BLOCKED_BY_CLIENT") && !favicon {
                        sink(Observed::Log {
                            level: e["level"].as_str().unwrap_or_default().to_string(),
                            text: text.to_string(),
                            url: e["url"].as_str().map(display_url).unwrap_or_default(),
                        });
                    }
                }
                "Network.requestWillBeSent" => {
                    if let (Some(id), Some(url)) = (p["requestId"].as_str(), p["request"]["url"].as_str()) {
                        if inflight.len() > 512 {
                            inflight.clear();
                        }
                        inflight.insert(
                            id.to_string(),
                            (p["request"]["method"].as_str().unwrap_or("GET").to_string(), url.to_string()),
                        );
                    }
                }
                "Network.responseReceived" => {
                    let status = p["response"]["status"].as_u64().map(|n| n as u16);
                    if p["type"].as_str() == Some("Document") && mains.has_frame(p["frameId"].as_str()) {
                        sink(Observed::Document {
                            status: status.unwrap_or(0),
                            url: p["response"]["url"].as_str().map(display_url).unwrap_or_default(),
                        });
                    } else if let Some(s) = status.filter(|s| *s >= 400) {
                        let (method, url) = p["requestId"]
                            .as_str()
                            .and_then(|id| inflight.get(id).cloned())
                            .unwrap_or_else(|| ("GET".into(), p["response"]["url"].as_str().unwrap_or("").into()));
                        sink(Observed::RequestFailed {
                            method,
                            url: display_url(&url),
                            status: Some(s),
                            reason: format!("HTTP {s}"),
                        });
                    }
                }
                "Network.loadingFailed" => {
                    let reason = p["errorText"].as_str().unwrap_or("failed");
                    // Our own blocks are reported as `Blocked`; a cancelled
                    // load (navigated away) is not a failure.
                    if p["blockedReason"].is_null()
                        && !p["canceled"].as_bool().unwrap_or(false)
                        && !reason.contains("ERR_BLOCKED_BY_CLIENT")
                        && !reason.contains("ERR_ABORTED")
                    {
                        if let Some((method, url)) = p["requestId"].as_str().and_then(|id| inflight.get(id).cloned()) {
                            if !url.ends_with("/favicon.ico") {
                                sink(Observed::RequestFailed {
                                    method,
                                    url: display_url(&url),
                                    status: None,
                                    reason: reason.to_string(),
                                });
                            }
                        }
                    }
                }
                "Page.frameNavigated" | "Page.navigatedWithinDocument" if mains.has_session(session) => {
                    let (frame, url) = if ev.method == "Page.frameNavigated" {
                        (p["frame"]["id"].as_str(), p["frame"]["url"].as_str())
                    } else {
                        (p["frameId"].as_str(), p["url"].as_str())
                    };
                    if mains.has_frame(frame) {
                        if let Some(url) = url {
                            sink(Observed::Navigated { url: url.to_string() });
                        }
                    }
                }
                "Page.javascriptDialogOpening" => {
                    sink(Observed::Dialog {
                        session: ev.session_id.clone(),
                        kind: p["type"].as_str().unwrap_or("alert").to_string(),
                        message: clip(p["message"].as_str().unwrap_or_default()),
                        default_prompt: p["defaultPrompt"].as_str().unwrap_or_default().to_string(),
                    });
                }
                "Browser.downloadWillBegin" => {
                    sink(Observed::Download {
                        url: display_url(p["url"].as_str().unwrap_or_default()),
                        filename: clip(p["suggestedFilename"].as_str().unwrap_or_default()),
                    });
                }
                // Another tab or window: this browser works in one. It is
                // closed at once (its traffic is already confined by the dead
                // proxy) and reported with the address it was opened for.
                "Target.targetCreated" => {
                    let info = &p["targetInfo"];
                    if info["type"] == "page" && !mains.has_frame(info["targetId"].as_str()) && !mains.take_own() {
                        if mains.popups() {
                            sink(Observed::NewTab {
                                target_id: info["targetId"].as_str().unwrap_or_default().to_string(),
                                url: display_url(info["url"].as_str().unwrap_or_default()),
                            });
                        } else {
                            cdp.fire("Target.closeTarget", json!({ "targetId": info["targetId"] }), None);
                            sink(Observed::Popup { url: display_url(info["url"].as_str().unwrap_or_default()) });
                        }
                    }
                }
                "Inspector.detached" | "Inspector.targetCrashed" if mains.has_session(session) => {
                    sink(Observed::PageGone {
                        session: session.unwrap_or_default().to_string(),
                        why: "The page crashed or was closed.".to_string(),
                    });
                }
                "Target.detachedFromTarget" if mains.has_session(p["sessionId"].as_str()) => {
                    sink(Observed::PageGone {
                        session: p["sessionId"].as_str().unwrap_or_default().to_string(),
                        why: "The page was closed.".to_string(),
                    });
                }
                _ => {}
            }
        }
        sink(Observed::BrowserExited);
    })
}

fn console_text(params: &Value) -> String {
    let args = params.get("args").and_then(Value::as_array).cloned().unwrap_or_default();
    args.iter()
        .map(|a| {
            a.get("value")
                .map(|v| match v {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .or_else(|| a.get("description").and_then(Value::as_str).map(str::to_string))
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn console_text_joins_values_and_descriptions() {
        let p = json!({"args":[{"value":"boom"},{"value":3},{"description":"Error: x"}]});
        assert_eq!(console_text(&p), "boom 3 Error: x");
    }

    #[test]
    fn long_text_is_clipped_with_an_ellipsis() {
        let long = "x".repeat(MAX_TEXT + 10);
        let c = clip(&long);
        assert_eq!(c.chars().count(), MAX_TEXT + 1);
        assert!(c.ends_with('…'));
        assert_eq!(clip("short"), "short");
    }
}
