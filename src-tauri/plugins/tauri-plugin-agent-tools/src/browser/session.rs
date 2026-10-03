//! The agent's interactive browser: one confined session per run, driven by the
//! `browser` tool across many calls.
//!
//! What it is: a separate, throwaway, Chromium-based browser (temporary
//! profile, dead proxy, only the loopback origins the run opened) that the
//! model reads as an outline with short refs and acts on with real mouse and
//! key events. Flint's own webview and profile are never involved.
//!
//! How it ends: `close`, the run ending (`close_run`), a stop (the session's
//! lifecycle token is registered under the run's scope, so a scope stop kills
//! the browser tree), 10 idle minutes, app exit (`close_all`), or the browser
//! dying. Every path kills the whole process tree and deletes the profile.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::process::Child;

use super::cdp::Cdp;
use super::confine::{display_url, local_origin, Origin, OriginPolicy};
use super::events::{self, clip, Mains, Observed};
use super::fence;
use super::keys;
use super::launch::{self, ProfileDir};
use super::outline::{self, Snapshot};
use crate::lifecycle::{Registered, Scope, Token};

/// A session idle this long is closed. `FLINT_BROWSER_IDLE_SECS` overrides it.
pub const IDLE_SECS: u64 = 600;
/// The largest screenshot returned to the model (matches the file screenshot tool).
pub const MAX_PNG_BYTES: usize = 4 * 1024 * 1024;
/// Longest `evaluate` expression, and longest value it returns.
pub const MAX_EXPRESSION_CHARS: usize = 4_000;
pub const MAX_EVALUATE_RESULT_CHARS: usize = 4_000;
/// Longest typed string in one `type` call.
pub const MAX_TYPE_CHARS: usize = 10_000;
/// Longest `wait`.
pub const MAX_WAIT_MS: u64 = 30_000;
const CALL_TIMEOUT: Duration = Duration::from_secs(15);
const RING_CAP: usize = 200;
/// Entries one action's result lists before pointing at `console`.
const HINT_ENTRIES: usize = 6;

/// Every action the tool takes.
pub const ACTIONS: &[&str] = &[
    "open", "snapshot", "click", "type", "press", "select", "scroll", "wait", "back", "reload",
    "screenshot", "console", "evaluate", "tab", "upload", "close",
];

/// The largest file `upload` attaches.
pub const MAX_UPLOAD_BYTES: u64 = 25 * 1024 * 1024;

// --- the activity mirror -------------------------------------------------------

/// What the user's preview panel is told about the agent's browser. A read-only
/// notice: nothing flows back, and the panel never loads the page itself.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    /// The conversation or session the run belongs to (the run id when none).
    pub session_id: String,
    pub run_id: String,
    /// `open`, `navigate`, `action`, `screenshot` or `closed`.
    pub kind: String,
    /// A short line: `click e12 "Save"`.
    pub action: String,
    pub url: String,
    pub title: String,
    /// A bounded JPEG as a data URL, when one was taken for this action.
    pub screenshot: Option<String>,
}

pub type ActivitySink = Arc<dyn Fn(Activity) + Send + Sync>;

static SINK: RwLock<Option<ActivitySink>> = RwLock::new(None);
/// Whether a panel is showing the browser. Notices (a few short strings) go out
/// regardless, so a panel can appear; without a viewer no screenshot is taken.
static WATCHED: AtomicBool = AtomicBool::new(false);

/// Install (or clear) the receiver of [`Activity`] notices. The desktop sets one
/// that emits a Tauri event; the headless CLI sets none and pays nothing.
pub fn set_activity_sink(sink: Option<ActivitySink>) {
    if let Ok(mut s) = SINK.write() {
        *s = sink;
    }
}

/// The preview panel opened (or closed): start (stop) producing notices.
pub fn set_activity_watched(watched: bool) {
    WATCHED.store(watched, Ordering::SeqCst);
}

fn activity_sink() -> Option<ActivitySink> {
    SINK.read().ok().and_then(|s| s.clone())
}

/// The mirror's screenshot is at most this many bytes of JPEG.
pub const MIRROR_MAX_BYTES: usize = 300 * 1024;
/// The mirror takes at most one screenshot in this long.
const MIRROR_THROTTLE: Duration = Duration::from_millis(1500);

// --- what the page did ---------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Error,
    Warning,
    Exception,
    Failed,
    Blocked,
    Popup,
    Download,
    Dialog,
}

impl Kind {
    fn label(self) -> &'static str {
        match self {
            Kind::Error => "console error",
            Kind::Warning => "console warning",
            Kind::Exception => "uncaught exception",
            Kind::Failed => "request failed",
            Kind::Blocked => "blocked",
            Kind::Popup => "new window",
            Kind::Download => "download",
            Kind::Dialog => "dialog",
        }
    }
}

#[derive(Debug, Clone)]
struct Entry {
    seq: u64,
    kind: Kind,
    text: String,
}

#[derive(Debug, Default)]
struct Ring {
    items: VecDeque<Entry>,
    next: u64,
}

impl Ring {
    fn push(&mut self, kind: Kind, text: String) {
        let seq = self.next;
        self.next += 1;
        if self.items.len() >= RING_CAP {
            self.items.pop_front();
        }
        self.items.push_back(Entry { seq, kind, text });
    }

    fn since(&self, seq: u64) -> Vec<Entry> {
        self.items.iter().filter(|e| e.seq >= seq).cloned().collect()
    }
}

#[derive(Debug, Default)]
struct Seen {
    ring: Ring,
    /// `console` reports what is newer than this.
    console_cursor: u64,
    url: String,
    doc_status: Option<u16>,
    dead: Option<String>,
    /// Whether a confirm/prompt dialog is accepted during the current action.
    accept_dialogs: bool,
    prompt_text: Option<String>,
    /// What the last snapshot called each ref, so an approval prompt can say
    /// what `e12` is rather than only its number.
    labels: HashMap<String, String>,
    /// A main-frame navigation was refused since this was last cleared.
    blocked_nav: Option<String>,
}

/// What the event sink should do besides recording.
#[derive(Debug, PartialEq)]
enum Reaction {
    Dialog { session: Option<String>, accept: bool, prompt: Option<String> },
}

fn plain(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '<' => '\u{2039}',
            '>' => '\u{203A}',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect()
}

fn apply(seen: &mut Seen, observed: Observed) -> Option<Reaction> {
    match observed {
        Observed::Blocked { url, resource_type, navigation } => {
            if navigation {
                seen.blocked_nav = Some(url.clone());
            }
            let what = if navigation { "page navigation".to_string() } else { resource_type.to_lowercase() };
            seen.ring.push(
                Kind::Blocked,
                format!("{what} to {url} refused: outside the origins this browser may load"),
            );
        }
        Observed::Console { level, text } => match level.as_str() {
            "error" | "assert" => seen.ring.push(Kind::Error, text),
            "warning" => seen.ring.push(Kind::Warning, text),
            _ => {}
        },
        Observed::Exception { text } => seen.ring.push(Kind::Exception, text),
        Observed::Log { level, text, url } => {
            let line = if url.is_empty() { text } else { format!("{text} ({url})") };
            match level.as_str() {
                "error" => seen.ring.push(Kind::Error, clip(&line)),
                "warning" => seen.ring.push(Kind::Warning, clip(&line)),
                _ => {}
            }
        }
        Observed::RequestFailed { method, url, status, reason } => {
            let line = match status {
                Some(_) => format!("{method} {url} -> {reason}"),
                None => format!("{method} {url} failed: {reason}"),
            };
            seen.ring.push(Kind::Failed, line);
        }
        Observed::Document { status, url } => {
            seen.doc_status = Some(status);
            seen.url = url;
        }
        Observed::Navigated { url } => seen.url = url,
        Observed::Dialog { session, kind, message, default_prompt } => {
            // An alert has no choice and a beforeunload must not trap the
            // page; a confirm or prompt is declined unless the action said to
            // accept it, because accepting is often the destructive answer.
            let accept = matches!(kind.as_str(), "alert" | "beforeunload") || seen.accept_dialogs;
            let prompt = (accept && kind == "prompt")
                .then(|| seen.prompt_text.clone().unwrap_or(default_prompt));
            let verdict = if accept {
                "accepted"
            } else {
                "dismissed (repeat the action with dialog \"accept\" to accept it)"
            };
            seen.ring.push(Kind::Dialog, format!("{kind} \"{}\" {verdict}", clip(&plain(&message))));
            return Some(Reaction::Dialog { session, accept, prompt });
        }
        Observed::Download { url, filename } => {
            seen.ring.push(Kind::Download, format!("{filename} from {url} was refused (this browser does not save files)"));
        }
        Observed::Popup { url } => {
            let to = if url.is_empty() || url == "about:blank" { "a new page".to_string() } else { url };
            seen.ring.push(
                Kind::Popup,
                format!("the page opened a new window for {to}; it was closed (popups are off). Use open to load it here, or open with popups true to keep new windows as tabs"),
            );
        }
        // Tabs coming and going are the session's to track (see `start`); the
        // ring only needs to say a window was kept.
        Observed::NewTab { url, .. } => {
            let to = if url.is_empty() || url == "about:blank" { "a new page".to_string() } else { url };
            seen.ring.push(Kind::Popup, format!("the page opened a new tab for {to}. Use the tab action to list or switch to it"));
        }
        Observed::PageGone { why, .. } => {
            seen.dead.get_or_insert(why);
        }
        Observed::BrowserExited => {
            seen.dead.get_or_insert_with(|| "The browser exited.".to_string());
        }
    }
    None
}

// --- the session -----------------------------------------------------------------

/// Everything that can end a session without waiting for its action lock.
struct Control {
    key: String,
    pid: u32,
    closed: AtomicBool,
    reason: Mutex<Option<String>>,
    last_used_ms: AtomicU64,
    child: Mutex<Option<Child>>,
    profile: Mutex<Option<ProfileDir>>,
    token: Token,
    registered: Mutex<Option<Registered>>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn idle_secs() -> u64 {
    std::env::var("FLINT_BROWSER_IDLE_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|s| *s > 0)
        .unwrap_or(IDLE_SECS)
}

impl Control {
    fn touch(&self) {
        self.last_used_ms.store(now_ms(), Ordering::Relaxed);
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    fn why(&self) -> String {
        self.reason.lock().ok().and_then(|r| r.clone()).unwrap_or_else(|| "closed".to_string())
    }

    /// Kill the browser and everything it started, once. Returns the profile
    /// still to delete (the caller decides how to wait for that).
    fn kill(&self, why: &str) -> Option<ProfileDir> {
        if self.closed.swap(true, Ordering::SeqCst) {
            return None;
        }
        if let Ok(mut r) = self.reason.lock() {
            *r = Some(why.to_string());
        }
        let _ = crate::tools::proc::kill_tree(self.pid);
        self.token.release(self.pid);
        if let Ok(mut c) = self.child.lock() {
            if let Some(mut child) = c.take() {
                let _ = child.start_kill();
            }
        }
        if let Ok(mut r) = self.registered.lock() {
            r.take();
        }
        if let Ok(mut map) = SESSIONS.lock() {
            if map.get(&self.key).is_some_and(|s| std::ptr::eq(&*s.ctl, self)) {
                map.remove(&self.key);
            }
        }
        self.profile.lock().ok().and_then(|mut p| p.take())
    }

    /// `kill`, then delete the profile in the background.
    fn kill_detached(&self, why: &str) {
        if let Some(mut profile) = self.kill(why) {
            std::thread::spawn(move || {
                profile.remove_blocking();
            });
        }
    }

    /// `kill`, then wait until the profile is gone. Whether it is.
    async fn kill_and_wait(&self, why: &str) -> bool {
        match self.kill(why) {
            Some(profile) => profile.remove().await,
            None => true,
        }
    }
}

/// One tab: its DevTools target and flat-mode session, and the prefix its refs carry.
#[derive(Debug, Clone)]
struct TabInfo {
    /// `t1`, `t2`, ... never reused in a session.
    id: String,
    target: String,
    session: String,
}

impl TabInfo {
    /// `""` for the first tab, so its refs stay `e12`; `t2` for the second, `t2e12`.
    fn prefix(&self) -> String {
        if self.id == "t1" { String::new() } else { self.id.clone() }
    }
}

#[derive(Debug, Default)]
struct Tabs {
    list: Vec<TabInfo>,
    active: String,
    next: u32,
}

impl Tabs {
    fn add(&mut self, target: &str, session: &str) -> TabInfo {
        self.next += 1;
        let tab = TabInfo { id: format!("t{}", self.next), target: target.to_string(), session: session.to_string() };
        self.list.push(tab.clone());
        tab
    }

    fn active_tab(&self) -> Option<TabInfo> {
        self.list.iter().find(|t| t.id == self.active).cloned()
    }

    fn find(&self, id: &str) -> Option<TabInfo> {
        self.list.iter().find(|t| t.id == id).cloned()
    }

    /// Drop the tab with this session; true when none is left. The active tab
    /// falls back to the most recent one.
    fn remove_session(&mut self, session: &str) -> bool {
        self.list.retain(|t| t.session != session);
        if !self.list.iter().any(|t| t.id == self.active) {
            self.active = self.list.last().map(|t| t.id.clone()).unwrap_or_default();
        }
        self.list.is_empty()
    }
}

struct Page {
    cdp: Cdp,
    tabs: Arc<Mutex<Tabs>>,
    mains: Mains,
    ctl: Arc<Control>,
    seen: Arc<Mutex<Seen>>,
}

pub struct Session {
    ctl: Arc<Control>,
    page: tokio::sync::Mutex<Page>,
    seen: Arc<Mutex<Seen>>,
    policy: OriginPolicy,
    mains: Mains,
    browser_name: String,
    caller: Caller,
    last_mirror: Mutex<Option<Instant>>,
    /// Notices go out in the order the actions happened, one at a time, because
    /// taking the picture for one must not let a later one overtake it.
    notices: tokio::sync::mpsc::UnboundedSender<Notice>,
}

struct Notice {
    activity: Activity,
    /// Take a picture for this notice from this tab first.
    shot: Option<(Cdp, String)>,
    sink: ActivitySink,
    ctl: Arc<Control>,
}

/// Deliver notices in order until the session is dropped.
fn spawn_notice_loop(mut rx: tokio::sync::mpsc::UnboundedReceiver<Notice>) {
    tokio::spawn(async move {
        while let Some(mut n) = rx.recv().await {
            if let Some((cdp, session)) = n.shot.take() {
                if !n.ctl.is_closed() {
                    n.activity.screenshot = mirror_shot(&cdp, &session).await;
                }
            }
            (n.sink)(n.activity);
        }
    });
}

/// Who is calling: the registry key (one session per run) and the scope the
/// session's lifecycle token is registered under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Caller {
    pub key: String,
    pub session: String,
    pub run: String,
}

impl Caller {
    pub fn scope(&self) -> Scope {
        Scope::new(self.session.clone(), self.run.clone(), "")
    }

    fn activity_session(&self) -> String {
        if self.session.is_empty() { self.key.clone() } else { self.session.clone() }
    }
}

static SESSIONS: LazyLock<Mutex<HashMap<String, Arc<Session>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn find(key: &str) -> Option<Arc<Session>> {
    SESSIONS.lock().ok().and_then(|m| m.get(key).cloned())
}

/// Whether this run has a live session.
pub fn is_open(key: &str) -> bool {
    find(key).is_some_and(|s| !s.ctl.is_closed())
}

/// What the run's last snapshot called `r`, for an approval prompt.
pub fn ref_label(key: &str, r: &str) -> Option<String> {
    let session = find(key)?;
    let seen = session.seen.lock().ok()?;
    seen.labels.get(r).cloned()
}

/// Make a session look idle for `by` (tests).
#[cfg(test)]
pub fn age_for_test(key: &str, by: Duration) {
    if let Some(s) = find(key) {
        s.ctl.last_used_ms.store(now_ms().saturating_sub(by.as_millis() as u64), Ordering::Relaxed);
    }
}

/// The sessions currently open (tests and diagnostics).
pub fn open_count() -> usize {
    SESSIONS.lock().map(|m| m.len()).unwrap_or(0)
}

/// End a run's session, if it has one: browser tree killed, profile deleted in
/// the background. For the loop to call when a run ends.
pub fn close_run(key: &str) {
    if let Some(s) = find(key) {
        s.ctl.kill_detached("the run ended");
        s.announce_closed("the run ended");
    }
}

/// End the browser of a conversation or session by its id (the desktop's run
/// end, thread switch, thread delete). Matches a session keyed by `id` or
/// opened under that session. Returns how many were closed.
pub fn close_for(id: &str) -> usize {
    if id.is_empty() {
        return 0;
    }
    let hits: Vec<Arc<Session>> = SESSIONS
        .lock()
        .map(|m| m.values().filter(|s| s.caller.key == id || s.caller.session == id).cloned().collect())
        .unwrap_or_default();
    for s in &hits {
        s.ctl.kill_detached("the conversation ended");
        s.announce_closed("the conversation ended");
    }
    hits.len()
}

/// End every session (app exit).
pub fn close_all() {
    let all: Vec<Arc<Session>> = SESSIONS.lock().map(|m| m.values().cloned().collect()).unwrap_or_default();
    for s in all {
        s.ctl.kill_detached("the app is closing");
    }
}

/// What the tool hands back: text, and an image for `screenshot` (a PNG, or a
/// small JPEG where the surface asked for compact images).
#[derive(Debug, Default)]
pub struct Reply {
    pub text: String,
    pub image: Option<Vec<u8>>,
    /// `image/png` or `image/jpeg`; empty when there is no image.
    pub image_mime: &'static str,
}

impl Reply {
    fn text(t: impl Into<String>) -> Self {
        Reply { text: t.into(), image: None, image_mime: "" }
    }
}

/// What the surface running the tool lets it do beyond the call's own arguments.
/// None of this comes from the model.
#[derive(Debug, Default, Clone)]
pub struct Options<'a> {
    /// The file an `upload` may attach: an absolute path the caller has already
    /// confined to the run's folders.
    pub upload: Option<&'a std::path::Path>,
    /// Return screenshots as a small JPEG instead of a PNG, for a surface that
    /// keeps the picture beside the transcript (the desktop).
    pub compact_image: bool,
}

/// The largest compact (JPEG) screenshot.
pub const MAX_COMPACT_IMAGE_BYTES: usize = 400 * 1024;

/// The result of one action before it is worded for the model.
struct Done {
    headline: String,
    /// `click e12 "Save"`, for the activity mirror.
    summary: String,
    /// Whether the page may have changed (mirror takes a fresh screenshot).
    mutated: bool,
    /// Report the page status block (url, title, what happened).
    status: bool,
    image: Option<Vec<u8>>,
    image_mime: &'static str,
    /// Pre-fenced body returned as is.
    body: Option<String>,
}

impl Done {
    fn new(headline: impl Into<String>, summary: impl Into<String>, mutated: bool) -> Self {
        Done { headline: headline.into(), summary: summary.into(), mutated, status: true, image: None, image_mime: "", body: None }
    }
}

fn err(msg: impl Into<String>) -> Reply {
    let m = msg.into();
    Reply::text(if m.starts_with("ERROR") { m } else { format!("ERROR: {m}") })
}

fn usage() -> String {
    format!("browser needs an `action`: one of {}.", ACTIONS.join(", "))
}

/// Run one `browser` action for `caller`. `upload` is refused here: it needs a
/// file the tool layer has checked (`run_with`).
pub async fn run(caller: &Caller, args: &Value) -> Reply {
    run_with(caller, args, &Options::default()).await
}

/// `run`, with what the surface allows: the file an `upload` may attach (never
/// taken from `args`, which the model writes) and the screenshot format.
pub async fn run_with(caller: &Caller, args: &Value, opts: &Options<'_>) -> Reply {
    let action = args.get("action").and_then(Value::as_str).unwrap_or("").trim().to_ascii_lowercase();
    match action.as_str() {
        "" => err(usage()),
        "open" => open(caller, args).await,
        "close" => close(caller).await,
        a if ACTIONS.contains(&a) => with_session(caller, a, args, opts).await,
        other => err(format!("unknown browser action \"{other}\". {}", usage())),
    }
}

const NO_PAGE: &str = "No browser page is open. Call browser with action \"open\" and a URL on this machine (for example http://localhost:5173/) first.";

async fn with_session(caller: &Caller, action: &str, args: &Value, opts: &Options<'_>) -> Reply {
    let Some(session) = find(&caller.key) else { return err(NO_PAGE) };
    if session.ctl.is_closed() {
        let why = session.ctl.why();
        return err(format!("The browser session ended ({why}). Call browser with action \"open\" to start a new one."));
    }
    session.ctl.touch();
    let page = session.page.lock().await;
    let mark = session.seen.lock().map(|s| s.ring.next).unwrap_or(0);
    if let Ok(mut s) = session.seen.lock() {
        s.accept_dialogs = args.get("dialog").and_then(Value::as_str) == Some("accept");
        s.prompt_text = args.get("dialog_text").and_then(Value::as_str).map(str::to_string);
    }
    let result = session.dispatch(&page, action, args, opts).await;
    session.ctl.touch();
    let reply = match result {
        Ok(done) => session.finish(&page, done, mark).await,
        Err(e) => {
            if session.ctl.is_closed() {
                err(format!("The browser session ended ({}). Call browser with action \"open\" to start a new one.", session.ctl.why()))
            } else {
                err(e)
            }
        }
    };
    drop(page);
    reply
}

// --- open / close -----------------------------------------------------------------

fn parse_origins(args: &Value) -> Result<(url::Url, OriginPolicy), String> {
    let raw = args.get("url").and_then(Value::as_str).ok_or("browser open needs a `url`.")?;
    let (url, origin) = local_origin(raw).map_err(|e| {
        format!(
            "browser only opens pages served from this machine (localhost, 127.0.0.1 or [::1]): {e}. \
             This is deliberate: the browser has no network beyond the app under test. To read an \
             outside page use web_fetch."
        )
    })?;
    let extra: Vec<String> = args
        .get("allow_origins")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let policy = OriginPolicy::new(origin, &extra).map_err(|e| format!("allow_origins refused: {e}"))?;
    Ok((url, policy))
}

async fn open(caller: &Caller, args: &Value) -> Reply {
    let (url, wanted) = match parse_origins(args) {
        Ok(v) => v,
        Err(e) => return err(e),
    };
    let popups = args.get("popups").and_then(Value::as_bool);
    // Reuse the run's session when it already allows everything asked for;
    // otherwise the browser is restarted, because its network confinement is
    // fixed when it starts.
    let mut restarted = false;
    if let Some(existing) = find(&caller.key) {
        if !existing.ctl.is_closed() {
            if wanted.allowed().iter().all(|o| existing.policy.allowed().contains(o)) {
                existing.ctl.touch();
                if let Some(p) = popups {
                    existing.mains.set_popups(p);
                }
                let page = existing.page.lock().await;
                let mark = existing.seen.lock().map(|s| s.ring.next).unwrap_or(0);
                let r = existing.navigate(&page, url.as_str()).await;
                return match r {
                    Ok(done) => existing.finish(&page, done, mark).await,
                    Err(e) => err(e),
                };
            }
            existing.ctl.kill_and_wait("restarted to allow another origin").await;
            restarted = true;
        }
    }
    // Everything this run already allowed stays allowed.
    let mut origins: Vec<String> = Vec::new();
    for o in wanted.allowed() {
        origins.push(o.serialize());
    }
    let Some(browser_path) = crate::browser_discovery::find_browser_path() else {
        return err(
            "No Chrome, Edge, Brave, Opera, Vivaldi, Arc or Chromium was found. Install one (any \
             Chromium-based browser works), choose its executable in Flint's settings, or set \
             FLINT_BROWSER_PATH to its full path. Flint does not download a browser.",
        );
    };
    for o in wanted.allowed() {
        if !launch::port_open(o).await {
            return err(format!(
                "Nothing is answering at {}. Start the app first (a dev server run in the background with bash, say), wait until it is up, then call open again.",
                o.serialize()
            ));
        }
    }
    let name = crate::browser_discovery::browser_name(&browser_path);
    let session = match start(caller, &browser_path.to_string_lossy(), name, wanted).await {
        Ok(s) => s,
        Err(e) => return err(e),
    };
    if let Some(p) = popups {
        session.mains.set_popups(p);
    }
    let page = session.page.lock().await;
    let mark = session.seen.lock().map(|s| s.ring.next).unwrap_or(0);
    match session.navigate(&page, url.as_str()).await {
        Ok(mut done) => {
            if restarted {
                done.headline.push_str(" The browser was restarted to allow the new origin, so earlier page state (cookies, logins) is gone.");
            }
            done.headline.push_str(&format!(" Allowed origins: {}.", origins.join(", ")));
            session.finish(&page, done, mark).await
        }
        Err(e) => {
            drop(page);
            session.ctl.kill_and_wait("open failed").await;
            err(e)
        }
    }
}

async fn start(
    caller: &Caller,
    browser_path: &str,
    browser_name: String,
    policy: OriginPolicy,
) -> Result<Arc<Session>, String> {
    let launch::Spawned { mut child, profile } = launch::spawn(browser_path, "flint-browser-", &policy)?;
    let pid = child.id().ok_or("the browser exited at once")?;
    // The session's token lives under the run's scope: stopping the run kills the browser.
    let token = Token::new(caller.scope());
    let registered = crate::lifecycle::register(token.clone());
    token.adopt(pid);
    let seen = Arc::new(Mutex::new(Seen::default()));
    let connected = async {
        let (cdp, events) = launch::connect(&mut child).await?;
        let (target, session) = launch::open_confined_tab(&cdp).await?;
        Ok::<_, String>((cdp, events, target, session))
    }
    .await;
    let (cdp, events, target, session_id) = match connected {
        Ok(v) => v,
        Err(e) => {
            let _ = crate::tools::proc::kill_tree(pid);
            token.release(pid);
            drop(registered);
            profile.remove().await;
            return Err(e);
        }
    };
    let ctl = Arc::new(Control {
        key: caller.key.clone(),
        pid,
        closed: AtomicBool::new(false),
        reason: Mutex::new(None),
        last_used_ms: AtomicU64::new(now_ms()),
        child: Mutex::new(Some(child)),
        profile: Mutex::new(Some(profile)),
        token,
        registered: Mutex::new(Some(registered)),
    });
    let mains = Mains::single(&session_id, &target);
    let tabs = Arc::new(Mutex::new(Tabs::default()));
    if let Ok(mut t) = tabs.lock() {
        let first = t.add(&target, &session_id);
        t.active = first.id;
    }
    let sink_seen = seen.clone();
    let sink_cdp = cdp.clone();
    let sink_tabs = tabs.clone();
    let sink_mains = mains.clone();
    let (newtab_tx, mut newtab_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    // A refused navigation leaves the page where it was (204), so the session carries on.
    events::spawn(cdp.clone(), events, policy.clone(), mains.clone(), events::NavigationBlock::Stay, move |observed| {
        match &observed {
            // A tab the page opened (popups on): confined and added by the task below.
            Observed::NewTab { target_id, .. } => {
                let _ = newtab_tx.send(target_id.clone());
            }
            // A tab went away. Only the last one ends the session.
            Observed::PageGone { session, why } => {
                sink_mains.remove_session(session);
                let none_left = sink_tabs.lock().map(|mut t| t.remove_session(session)).unwrap_or(true);
                if !none_left {
                    if let Ok(mut s) = sink_seen.lock() {
                        s.ring.push(Kind::Popup, format!("a tab closed: {why}"));
                    }
                    return;
                }
            }
            _ => {}
        }
        let reaction = sink_seen.lock().ok().and_then(|mut s| apply(&mut s, observed));
        if let Some(Reaction::Dialog { session, accept, prompt }) = reaction {
            let mut p = json!({ "accept": accept });
            if let Some(t) = prompt {
                p["promptText"] = json!(t);
            }
            sink_cdp.fire("Page.handleJavaScriptDialog", p, session.as_deref());
        }
    });
    // Confine and register each window the page opens while popups are on.
    {
        let (cdp, tabs, mains, seen) = (cdp.clone(), tabs.clone(), mains.clone(), seen.clone());
        tokio::spawn(async move {
            while let Some(target_id) = newtab_rx.recv().await {
                let attached = cdp.call("Target.attachToTarget", json!({ "targetId": target_id, "flatten": true }), None).await;
                let Some(session) = attached.ok().and_then(|a| a["sessionId"].as_str().map(str::to_string)) else { continue };
                mains.add(&session, &target_id);
                let id = tabs.lock().map(|mut t| t.add(&target_id, &session).id).unwrap_or_default();
                if launch::enable_tab(&cdp, &session).await.is_err() {
                    let _ = cdp.call("Target.closeTarget", json!({ "targetId": target_id }), None).await;
                    mains.remove_session(&session);
                    if let Ok(mut t) = tabs.lock() {
                        t.remove_session(&session);
                    }
                    continue;
                }
                if let Ok(mut s) = seen.lock() {
                    s.ring.push(Kind::Popup, format!("the page's new window is open as tab {id} (switch to it with the tab action)"));
                }
            }
        });
    }
    let setup = async {
        launch::enable_tab(&cdp, &session_id).await?;
        // Refuse downloads, and learn of any window the page opens (closed, or
        // kept as a confined tab when the run opted into popups).
        cdp.call("Browser.setDownloadBehavior", json!({ "behavior": "deny", "eventsEnabled": true }), None)
            .await
            .map_err(|e| format!("could not refuse downloads: {e}"))?;
        let _ = cdp.call("Target.setDiscoverTargets", json!({ "discover": true }), None).await;
        Ok::<_, String>(())
    };
    if let Err(e) = setup.await {
        ctl.kill_and_wait("setup failed").await;
        return Err(e);
    }
    let (notices_tx, notices_rx) = tokio::sync::mpsc::unbounded_channel();
    let session = Arc::new(Session {
        ctl: ctl.clone(),
        page: tokio::sync::Mutex::new(Page { cdp, tabs, mains: mains.clone(), ctl: ctl.clone(), seen: seen.clone() }),
        seen,
        policy,
        mains,
        browser_name,
        caller: caller.clone(),
        last_mirror: Mutex::new(None),
        notices: notices_tx,
    });
    spawn_notice_loop(notices_rx);
    // Killing the old one takes this lock too, so it happens after it is released.
    let replaced = SESSIONS.lock().ok().and_then(|mut map| map.insert(caller.key.clone(), session.clone()));
    if let Some(old) = replaced {
        old.ctl.kill_detached("replaced by a newer session");
    }
    spawn_watchdog(session.clone());
    Ok(session)
}

fn spawn_watchdog(session: Arc<Session>) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let ctl = &session.ctl;
            if ctl.is_closed() {
                return;
            }
            let why = if ctl.token.is_stopped() {
                Some("the run was stopped")
            } else if session.seen.lock().map(|s| s.dead.is_some()).unwrap_or(false) {
                Some("the browser closed")
            } else if now_ms().saturating_sub(ctl.last_used_ms.load(Ordering::Relaxed)) > idle_secs() * 1000 {
                Some("it was idle too long")
            } else {
                None
            };
            if let Some(why) = why {
                ctl.kill_and_wait(why).await;
                session.announce_closed(why);
                return;
            }
        }
    });
}

async fn close(caller: &Caller) -> Reply {
    let Some(session) = find(&caller.key) else {
        return Reply::text("No browser page was open. Nothing to close.");
    };
    let removed = session.ctl.kill_and_wait("closed by the agent").await;
    session.announce_closed("closed");
    Reply::text(if removed {
        "Browser closed. Its temporary profile was deleted."
    } else {
        "Browser closed. Its temporary profile could not be fully deleted yet and will be retried."
    })
}

// --- the actions ---------------------------------------------------------------------

impl Page {
    fn active(&self) -> Result<TabInfo, String> {
        self.tabs.lock().ok().and_then(|t| t.active_tab()).ok_or_else(|| "the browser has no open tab".to_string())
    }

    /// The DevTools session of the active tab.
    fn session(&self) -> String {
        self.active().map(|t| t.session).unwrap_or_default()
    }

    /// The `ref` argument, shaped like a ref and belonging to the active tab.
    fn ref_for(&self, args: &Value) -> Result<String, String> {
        let r = ref_arg(args)?;
        self.check_ref_tab(&r)?;
        Ok(r)
    }

    /// A ref must belong to the tab being driven: refs name their tab.
    fn check_ref_tab(&self, r: &str) -> Result<(), String> {
        let tab = self.active()?;
        match outline::ref_tab(r) {
            Some(t) if t == tab.id => Ok(()),
            Some(t) => Err(format!(
                "ref {r} belongs to tab {t}, but the active tab is {}. Switch with the tab action (op \"switch\"), then snapshot, or use a ref from this tab's snapshot.",
                tab.id
            )),
            None => Err(format!("\"{r}\" is not a ref.")),
        }
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        if self.ctl.is_closed() {
            return Err("the browser session ended".to_string());
        }
        let session = self.session();
        match tokio::time::timeout(CALL_TIMEOUT, self.cdp.call(method, params, Some(&session))).await {
            Ok(r) => r,
            Err(_) => Err(format!("{method} did not answer in time")),
        }
    }

    async fn eval(&self, expression: &str) -> Result<Value, String> {
        let r = self
            .call("Runtime.evaluate", json!({ "expression": expression, "returnByValue": true, "awaitPromise": false }))
            .await?;
        if let Some(ex) = r.get("exceptionDetails") {
            return Err(clip(&launch::exception_text(ex)));
        }
        Ok(r["result"]["value"].clone())
    }

    async fn helper(&self, method: &str, args: &[Value]) -> Result<Value, String> {
        let prefix = self.active()?.prefix();
        self.eval(&outline::call_expression(&prefix, method, args)).await
    }

    /// Wait for the document to finish loading, then a short settle for what it starts.
    async fn settle(&self, max: Duration) {
        tokio::time::sleep(Duration::from_millis(150)).await;
        let until = Instant::now() + max;
        loop {
            if let Ok(v) = self.eval("document.readyState").await {
                if v.as_str() == Some("complete") {
                    break;
                }
            }
            if Instant::now() >= until || self.ctl.is_closed() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    async fn meta(&self) -> (String, String) {
        match self.helper("meta", &[]).await {
            Ok(v) => (
                v["url"].as_str().unwrap_or_default().to_string(),
                v["title"].as_str().unwrap_or_default().to_string(),
            ),
            Err(_) => (self.seen.lock().map(|s| s.url.clone()).unwrap_or_default(), String::new()),
        }
    }

    async fn key(&self, spec: &keys::KeySpec) -> Result<(), String> {
        for ev in spec.events() {
            self.call("Input.dispatchKeyEvent", ev).await?;
        }
        Ok(())
    }
}

fn ref_arg(args: &Value) -> Result<String, String> {
    let r = args
        .get("ref")
        .and_then(Value::as_str)
        .map(str::trim)
        .ok_or("this action needs a `ref` from the latest snapshot (like \"e12\").")?;
    if !outline::is_ref(r) {
        return Err(format!("\"{}\" is not a ref. Refs look like e12 and come from snapshot.", plain(&clip(r))));
    }
    Ok(r.to_string())
}

/// The most tabs one session keeps open.
pub const MAX_TABS: usize = 8;

fn tab_id_arg(args: &Value) -> Result<String, String> {
    let id = args.get("tab_id").and_then(Value::as_str).map(str::trim).ok_or("this needs a `tab_id` like t2 (see tab op \"list\").")?;
    let ok = id.strip_prefix('t').is_some_and(|d| !d.is_empty() && d.len() <= 4 && d.bytes().all(|b| b.is_ascii_digit()));
    if !ok {
        return Err(format!("\"{}\" is not a tab id. Tab ids look like t2.", plain(&clip(id))));
    }
    Ok(id.to_string())
}

fn stale(v: &Value, r: &str) -> Result<(), String> {
    if v.get("stale").is_some() {
        return Err(outline::stale_message(r));
    }
    Ok(())
}

impl Session {
    async fn dispatch(&self, page: &Page, action: &str, args: &Value, opts: &Options<'_>) -> Result<Done, String> {
        match action {
            "tab" => self.tab(page, args).await,
            "upload" => self.upload(page, args, opts.upload).await,
            "snapshot" => self.snapshot(page, args).await,
            "click" => self.click(page, args).await,
            "type" => self.type_text(page, args).await,
            "press" => self.press(page, args).await,
            "select" => self.select(page, args).await,
            "scroll" => self.scroll(page, args).await,
            "wait" => self.wait(page, args).await,
            "back" => self.back(page).await,
            "reload" => self.reload(page).await,
            "screenshot" => self.screenshot(page, args, opts.compact_image).await,
            "console" => self.console(args),
            "evaluate" => self.evaluate(page, args).await,
            other => Err(format!("unknown browser action \"{other}\"")),
        }
    }

    async fn navigate(&self, page: &Page, url: &str) -> Result<Done, String> {
        if !self.policy.permits(url) {
            return Err(format!(
                "{} is outside the origins this browser may load ({}). Open it with allow_origins, or use web_fetch for an outside page.",
                display_url(url),
                self.policy.allowed().iter().map(Origin::serialize).collect::<Vec<_>>().join(", ")
            ));
        }
        if let Ok(mut s) = self.seen.lock() {
            s.doc_status = None;
            s.blocked_nav = None;
        }
        let r = page.call("Page.navigate", json!({ "url": url })).await?;
        if let Some(e) = r["errorText"].as_str().filter(|e| !e.is_empty()) {
            return Err(if e.contains("BLOCKED_BY_CLIENT") {
                format!("{} was refused: outside the origins this browser may load.", display_url(url))
            } else if e.contains("CONNECTION_REFUSED") {
                format!("navigation failed: {e}. The app at that address is not answering.")
            } else {
                format!("navigation failed: {e}")
            });
        }
        page.settle(Duration::from_secs(10)).await;
        if let Some(to) = self.seen.lock().ok().and_then(|mut s| s.blocked_nav.take()) {
            return Err(format!(
                "{} sent the browser to {to}, which is outside the origins it may load, so the navigation was refused and the page was left as it was.",
                display_url(url)
            ));
        }
        let status = self.seen.lock().ok().and_then(|s| s.doc_status);
        let mut headline = format!("Opened {}", display_url(url));
        if let Some(st) = status {
            headline.push_str(&format!(" (HTTP {st})"));
        }
        headline.push_str(&format!(" in {}.", self.browser_name));
        headline.push_str(" Call snapshot to see the page.");
        Ok(Done::new(headline, format!("open {}", display_url(url)), true))
    }

    async fn snapshot(&self, page: &Page, args: &Value) -> Result<Done, String> {
        let scope = match args.get("ref").and_then(Value::as_str) {
            Some(_) => Some(page.ref_for(args)?),
            None => None,
        };
        let v = page.helper("snapshot", &[json!(scope)]).await?;
        if let Some(r) = &scope {
            stale(&v, r)?;
        }
        let snap: Snapshot = serde_json::from_value(v).map_err(|e| format!("could not read the page: {e}"))?;
        if scope.is_none() {
            if let Ok(mut s) = self.seen.lock() {
                s.labels.clear();
            }
        }
        if let Ok(mut s) = self.seen.lock() {
            for n in &snap.nodes {
                if let Some(r) = &n.r#ref {
                    s.labels.insert(r.clone(), format!("{} \"{}\"", n.role, plain(&clip(&n.name))));
                }
            }
        }
        let mut text = outline::format(&snap);
        if let Ok(t) = page.tabs.lock() {
            if t.list.len() > 1 {
                text = format!("tab: {} of {} open (action tab lists and switches)\n{text}", t.active, t.list.len());
            }
        }
        let body = fence::fence("snapshot", &snap.url, &text, outline::MAX_OUTLINE_CHARS + 600);
        let mut done = Done::new("", "snapshot", false);
        done.status = false;
        done.body = Some(body);
        Ok(done)
    }

    async fn locate(&self, page: &Page, r: &str) -> Result<Value, String> {
        let loc = page.helper("locate", &[json!(r)]).await?;
        stale(&loc, r)?;
        if loc.get("hidden").is_some() {
            return Err(format!("{r} has no visible area (it is hidden or collapsed). Snapshot again, or open whatever reveals it first."));
        }
        if loc["disabled"].as_bool().unwrap_or(false) {
            return Err(format!("{r} is disabled, so it cannot be used."));
        }
        if let Some(c) = loc["covered"].as_str() {
            return Err(format!(
                "{r} is covered by another element ({}), so a click would land on that instead. Dismiss or scroll past it first, then snapshot again.",
                plain(&clip(c))
            ));
        }
        Ok(loc)
    }

    fn label(loc: &Value, r: &str) -> String {
        let name = plain(loc["name"].as_str().unwrap_or_default());
        let role = loc["role"].as_str().unwrap_or("element");
        if name.is_empty() { format!("{role} {r}") } else { format!("{role} \"{name}\" {r}") }
    }

    async fn click(&self, page: &Page, args: &Value) -> Result<Done, String> {
        let r = page.ref_for(args)?;
        let loc = self.locate(page, &r).await?;
        let (x, y) = (loc["x"].as_f64().unwrap_or(0.0), loc["y"].as_f64().unwrap_or(0.0));
        for kind in ["mouseMoved", "mousePressed", "mouseReleased"] {
            page.call(
                "Input.dispatchMouseEvent",
                json!({ "type": kind, "x": x, "y": y, "button": "left", "clickCount": 1 }),
            )
            .await?;
        }
        page.settle(Duration::from_secs(5)).await;
        let what = Self::label(&loc, &r);
        let mut d = Done::new(format!("Clicked {what}."), format!("click {r} {}", clip(&what)), true);
        d.headline.push(' ');
        d.headline.push_str("Refs may be stale if the page changed: snapshot again before the next ref.");
        Ok(d)
    }

    async fn type_text(&self, page: &Page, args: &Value) -> Result<Done, String> {
        let r = page.ref_for(args)?;
        let text = args.get("text").and_then(Value::as_str).ok_or("type needs `text`.")?;
        if text.chars().count() > MAX_TYPE_CHARS {
            return Err(format!("text is over {MAX_TYPE_CHARS} characters; type it in parts."));
        }
        let clear = args.get("clear").and_then(Value::as_bool).unwrap_or(true);
        let submit = args.get("submit").and_then(Value::as_bool).unwrap_or(false);
        let f = page.helper("focusField", &[json!(r), json!(clear), json!(text)]).await?;
        stale(&f, &r)?;
        if f.get("notField").is_some() {
            return Err(format!(
                "{r} is a {} and cannot take text. Use click for buttons and checkboxes, select for dropdowns.",
                f["role"].as_str().or(f["tag"].as_str()).unwrap_or("element")
            ));
        }
        if f.get("disabled").is_some() {
            return Err(format!("{r} is disabled or read-only, so it cannot take text."));
        }
        if f.get("done").is_none() && !text.is_empty() {
            page.call("Input.insertText", json!({ "text": text })).await?;
        }
        if submit {
            let enter = keys::parse("Enter").expect("Enter is a key");
            page.key(&enter).await?;
            page.settle(Duration::from_secs(5)).await;
        }
        // The text itself is never echoed: it may be a password.
        let n = text.chars().count();
        Ok(Done::new(
            format!("Typed {n} character(s) into {r}{}.", if submit { " and pressed Enter" } else { "" }),
            format!("type {r} ({n} chars{})", if submit { ", submit" } else { "" }),
            true,
        ))
    }

    async fn press(&self, page: &Page, args: &Value) -> Result<Done, String> {
        let key = args.get("key").and_then(Value::as_str).ok_or("press needs a `key` (Enter, Escape, Tab, ArrowDown, a, Control+A, ...).")?;
        let spec = keys::parse(key).ok_or_else(|| {
            format!("\"{}\" is not a key I know. Use Enter, Escape, Tab, Backspace, Delete, Arrow keys, Home, End, PageUp, PageDown, Space, a single character, or Control/Shift/Alt+key.", plain(&clip(key)))
        })?;
        if args.get("ref").is_some() {
            let r = page.ref_for(args)?;
            let f = page.helper("focus", &[json!(r)]).await?;
            stale(&f, &r)?;
        }
        page.key(&spec).await?;
        page.settle(Duration::from_secs(3)).await;
        Ok(Done::new(format!("Pressed {key}."), format!("press {key}"), true))
    }

    async fn select(&self, page: &Page, args: &Value) -> Result<Done, String> {
        let r = page.ref_for(args)?;
        let value = args.get("value").and_then(Value::as_str).ok_or("select needs a `value` (an option's value or visible text).")?;
        let v = page.helper("choose", &[json!(r), json!(value)]).await?;
        stale(&v, &r)?;
        if v.get("notSelect").is_some() {
            return Err(format!("{r} is not a dropdown (<select>). Use click, or type for a text field."));
        }
        if v.get("missing").is_some() {
            let opts: Vec<String> = v["options"].as_array().map(|a| a.iter().filter_map(|o| o.as_str().map(plain)).collect()).unwrap_or_default();
            return Err(format!("{r} has no option \"{}\". Its options: {}.", plain(&clip(value)), opts.join(" | ")));
        }
        if v.get("optionDisabled").is_some() {
            return Err("that option is disabled".to_string());
        }
        page.settle(Duration::from_secs(3)).await;
        let chosen = plain(v["chosen"].as_str().unwrap_or(value));
        Ok(Done::new(format!("Selected \"{chosen}\" in {r}."), format!("select {r} \"{chosen}\""), true))
    }

    async fn scroll(&self, page: &Page, args: &Value) -> Result<Done, String> {
        let pos = if args.get("ref").is_some() {
            let r = page.ref_for(args)?;
            let p = page.helper("scrollTo", &[json!(r)]).await?;
            stale(&p, &r)?;
            p
        } else {
            let dir = args.get("direction").and_then(Value::as_str).unwrap_or("down");
            let now = page.helper("pos", &[]).await?;
            let (vw, vh) = (now["vw"].as_i64().unwrap_or(1280), now["vh"].as_i64().unwrap_or(800));
            let amount = match args.get("amount") {
                Some(Value::Number(n)) => n.as_i64().unwrap_or(0).clamp(1, 20_000),
                Some(Value::String(s)) if s == "half" => vh / 2,
                Some(Value::String(s)) if s.trim().parse::<i64>().is_ok() => s.trim().parse::<i64>().unwrap().clamp(1, 20_000),
                _ => vh * 8 / 10,
            };
            let (dx, dy) = match dir {
                "up" => (0, -amount),
                "down" => (0, amount),
                "left" => (-(amount.min(vw)), 0),
                "right" => (amount.min(vw), 0),
                other => return Err(format!("direction \"{}\" is not up, down, left or right.", plain(&clip(other)))),
            };
            page.helper("scrollBy", &[json!(dx), json!(dy)]).await?
        };
        tokio::time::sleep(Duration::from_millis(200)).await;
        let (y, h, vh) = (pos["y"].as_i64().unwrap_or(0), pos["h"].as_i64().unwrap_or(0), pos["vh"].as_i64().unwrap_or(0));
        let at = if y <= 0 { "top" } else if y + vh >= h { "bottom" } else { "middle" };
        Ok(Done {
            headline: format!("Scrolled to {y}px of {h}px ({at} of the page). Snapshot again to see what is visible."),
            summary: "scroll".to_string(),
            mutated: false,
            status: false,
            image: None,
            image_mime: "",
            body: None,
        })
    }

    async fn wait(&self, page: &Page, args: &Value) -> Result<Done, String> {
        let timeout = args.get("timeout").and_then(Value::as_u64).unwrap_or(10_000).clamp(100, MAX_WAIT_MS);
        if let Some(text) = args.get("text").and_then(Value::as_str) {
            return self.wait_for(page, "hasText", json!(text), timeout, &format!("the text \"{}\"", plain(&clip(text)))).await;
        }
        if let Some(sel) = args.get("selector").and_then(Value::as_str) {
            return self.wait_for(page, "hasSelector", json!(sel), timeout, &format!("an element matching {}", plain(&clip(sel)))).await;
        }
        let ms = args.get("ms").and_then(Value::as_u64).ok_or("wait needs `text`, `selector` or `ms`.")?;
        let ms = ms.min(MAX_WAIT_MS);
        tokio::time::sleep(Duration::from_millis(ms)).await;
        Ok(Done::new(format!("Waited {ms} ms."), format!("wait {ms} ms"), true))
    }

    async fn wait_for(&self, page: &Page, method: &str, arg: Value, timeout_ms: u64, what: &str) -> Result<Done, String> {
        let until = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            if let Ok(v) = page.helper(method, std::slice::from_ref(&arg)).await {
                if let Some(bad) = v.get("bad").and_then(Value::as_str) {
                    return Err(format!("that is not a valid selector: {}", plain(&clip(bad))));
                }
                if v.as_bool() == Some(true) {
                    return Ok(Done::new(format!("Found {what}."), format!("wait for {what}"), true));
                }
            }
            if Instant::now() >= until {
                return Err(format!("timed out after {timeout_ms} ms waiting for {what}. Snapshot to see what the page shows."));
            }
            if page.ctl.is_closed() {
                return Err("the browser session ended".to_string());
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }

    async fn history(&self, page: &Page, delta: i64) -> Result<Value, String> {
        let h = page.call("Page.getNavigationHistory", json!({})).await?;
        let cur = h["currentIndex"].as_i64().unwrap_or(0);
        let want = cur + delta;
        let entries = h["entries"].as_array().cloned().unwrap_or_default();
        if want < 0 || want as usize >= entries.len() {
            return Err("there is no earlier page in this browser's history.".to_string());
        }
        Ok(entries[want as usize].clone())
    }

    async fn back(&self, page: &Page) -> Result<Done, String> {
        let entry = self.history(page, -1).await?;
        let url = entry["url"].as_str().unwrap_or_default();
        if !self.policy.permits(url) {
            return Err("the earlier page is not one this browser may load.".to_string());
        }
        page.call("Page.navigateToHistoryEntry", json!({ "entryId": entry["id"] })).await?;
        page.settle(Duration::from_secs(8)).await;
        Ok(Done::new("Went back.", "back", true))
    }

    async fn reload(&self, page: &Page) -> Result<Done, String> {
        page.call("Page.reload", json!({})).await?;
        page.settle(Duration::from_secs(8)).await;
        Ok(Done::new("Reloaded the page. Refs from before are gone: snapshot again.", "reload", true))
    }

    async fn screenshot(&self, page: &Page, args: &Value, compact: bool) -> Result<Done, String> {
        let full = args.get("fullPage").and_then(Value::as_bool).unwrap_or(false);
        let mut params = if compact { json!({ "format": "jpeg", "quality": 70 }) } else { json!({ "format": "png" }) };
        let mut what = "viewport".to_string();
        if args.get("ref").is_some() {
            let r = page.ref_for(args)?;
            let rect = page.helper("rectOf", &[json!(r)]).await?;
            stale(&rect, &r)?;
            if rect.get("hidden").is_some() {
                return Err(format!("{r} has no visible area to capture."));
            }
            params["clip"] = json!({ "x": rect["x"], "y": rect["y"], "width": rect["w"], "height": rect["h"], "scale": 1 });
            params["captureBeyondViewport"] = json!(true);
            what = format!("element {r}");
        } else if full {
            let m = page.call("Page.getLayoutMetrics", json!({})).await?;
            let w = m["cssContentSize"]["width"].as_f64().unwrap_or(1280.0).min(4096.0);
            let h = m["cssContentSize"]["height"].as_f64().unwrap_or(800.0).min(8000.0);
            params["clip"] = json!({ "x": 0, "y": 0, "width": w, "height": h, "scale": 1 });
            params["captureBeyondViewport"] = json!(true);
            what = format!("full page ({}x{})", w as i64, h as i64);
        }
        let mut r = page.call("Page.captureScreenshot", params.clone()).await?;
        let mut png = base64::engine::general_purpose::STANDARD
            .decode(r["data"].as_str().ok_or("the browser returned no image")?)
            .map_err(|e| format!("the browser returned a bad image: {e}"))?;
        // A compact picture that is still large is retried at a lower quality.
        if compact && png.len() > MAX_COMPACT_IMAGE_BYTES {
            params["quality"] = json!(40);
            r = page.call("Page.captureScreenshot", params).await?;
            png = base64::engine::general_purpose::STANDARD
                .decode(r["data"].as_str().ok_or("the browser returned no image")?)
                .map_err(|e| format!("the browser returned a bad image: {e}"))?;
        }
        if png.is_empty() {
            return Err("the browser produced an empty screenshot".to_string());
        }
        let cap = if compact { MAX_COMPACT_IMAGE_BYTES } else { MAX_PNG_BYTES };
        if png.len() > cap {
            return Err(format!(
                "screenshot is {} KiB, over the {}-KiB cap; capture the viewport or one element (ref) instead",
                png.len() / 1024,
                cap / 1024
            ));
        }
        let (url, _) = page.meta().await;
        let mut d = Done::new(format!("Screenshot of {} ({what}).", display_url(&url)), format!("screenshot ({what})"), true);
        d.status = false;
        d.image = Some(png);
        d.image_mime = if compact { "image/jpeg" } else { "image/png" };
        Ok(d)
    }

    fn console(&self, args: &Value) -> Result<Done, String> {
        let all = args.get("all").and_then(Value::as_bool).unwrap_or(false);
        let (entries, url) = {
            let mut s = self.seen.lock().map_err(|_| "console is unavailable")?;
            let from = if all { 0 } else { s.console_cursor };
            let e = s.ring.since(from);
            s.console_cursor = s.ring.next;
            (e, s.url.clone())
        };
        let text = if entries.is_empty() {
            "No new console errors, warnings, uncaught exceptions, failed or blocked requests.".to_string()
        } else {
            entries
                .iter()
                .map(|e| format!("- {}: {}", e.kind.label(), plain(&clip(&e.text))))
                .collect::<Vec<_>>()
                .join("\n")
        };
        let mut d = Done::new("", "console", false);
        d.status = false;
        d.body = Some(fence::fence("console", &url, &text, 5_000));
        Ok(d)
    }

    async fn evaluate(&self, page: &Page, args: &Value) -> Result<Done, String> {
        let expr = args.get("expression").and_then(Value::as_str).ok_or("evaluate needs an `expression`.")?;
        if expr.chars().count() > MAX_EXPRESSION_CHARS {
            return Err(format!("expression is over {MAX_EXPRESSION_CHARS} characters."));
        }
        let r = page
            .call(
                "Runtime.evaluate",
                json!({ "expression": expr, "returnByValue": true, "awaitPromise": true, "timeout": 8000, "userGesture": false }),
            )
            .await?;
        if let Some(ex) = r.get("exceptionDetails") {
            return Err(format!("the page script threw: {}", plain(&clip(&launch::exception_text(ex)))));
        }
        let res = &r["result"];
        let shown = match res.get("value") {
            Some(v) => serde_json::to_string(v).unwrap_or_default(),
            None => res["description"].as_str().or(res["type"].as_str()).unwrap_or("undefined").to_string(),
        };
        let total = shown.chars().count();
        let mut text: String = shown.chars().take(MAX_EVALUATE_RESULT_CHARS).collect();
        if total > MAX_EVALUATE_RESULT_CHARS {
            text.push_str(&format!("\n[result cut: {} more characters]", total - MAX_EVALUATE_RESULT_CHARS));
        }
        let (url, _) = page.meta().await;
        let mut d = Done::new("", format!("evaluate {}", clip(&plain(expr))), true);
        d.status = false;
        d.body = Some(fence::fence("evaluate", &url, &text, MAX_EVALUATE_RESULT_CHARS + 100));
        Ok(d)
    }

    // --- tabs --------------------------------------------------------------------------

    async fn tab(&self, page: &Page, args: &Value) -> Result<Done, String> {
        let op = args.get("op").and_then(Value::as_str).unwrap_or("list").trim().to_ascii_lowercase();
        match op.as_str() {
            "list" => self.tab_list(page).await,
            "new" => self.tab_new(page, args).await,
            "switch" => {
                let id = tab_id_arg(args)?;
                let tab = page.tabs.lock().ok().and_then(|t| t.find(&id)).ok_or_else(|| format!("there is no tab {id}. Use tab with op \"list\"."))?;
                if let Ok(mut t) = page.tabs.lock() {
                    t.active = tab.id.clone();
                }
                let _ = page.cdp.call("Target.activateTarget", json!({ "targetId": tab.target }), None).await;
                let mut d = Done::new(
                    format!("Switched to tab {}. Refs from other tabs do not work here: snapshot this tab.", tab.id),
                    format!("switch to tab {}", tab.id),
                    true,
                );
                d.headline.push_str("");
                Ok(d)
            }
            "close" => {
                let (id, session, target, remaining) = {
                    let t = page.tabs.lock().map_err(|_| "tabs are unavailable")?;
                    let id = match args.get("tab_id").and_then(Value::as_str) {
                        Some(_) => tab_id_arg(args)?,
                        None => t.active.clone(),
                    };
                    let tab = t.find(&id).ok_or_else(|| format!("there is no tab {id}. Use tab with op \"list\"."))?;
                    (id, tab.session, tab.target, t.list.len())
                };
                if remaining <= 1 {
                    return Err("that is the only tab. To end the browser use action close.".to_string());
                }
                page.mains.remove_session(&session);
                if let Ok(mut t) = page.tabs.lock() {
                    t.remove_session(&session);
                }
                let _ = page.cdp.call("Target.closeTarget", json!({ "targetId": target }), None).await;
                let now = page.tabs.lock().map(|t| t.active.clone()).unwrap_or_default();
                Ok(Done::new(format!("Closed tab {id}. The active tab is {now}."), format!("close tab {id}"), true))
            }
            other => Err(format!("tab op \"{}\" is not list, new, switch or close.", plain(&clip(other)))),
        }
    }

    async fn tab_list(&self, page: &Page) -> Result<Done, String> {
        let infos = page.cdp.call("Target.getTargets", json!({}), None).await?;
        let infos = infos["targetInfos"].as_array().cloned().unwrap_or_default();
        let (list, active) = {
            let t = page.tabs.lock().map_err(|_| "tabs are unavailable")?;
            (t.list.clone(), t.active.clone())
        };
        let mut lines = Vec::new();
        for tab in &list {
            let info = infos.iter().find(|i| i["targetId"].as_str() == Some(tab.target.as_str()));
            let url = info.and_then(|i| i["url"].as_str()).unwrap_or_default();
            let title = info.and_then(|i| i["title"].as_str()).unwrap_or_default();
            lines.push(format!(
                "{} {} \"{}\" {}",
                if tab.id == active { "*" } else { "-" },
                tab.id,
                clip(&plain(title)),
                display_url(url)
            ));
        }
        let mut d = Done::new("", "tabs", false);
        d.status = false;
        d.body = Some(fence::fence("tabs", "", &lines.join("\n"), 3_000));
        d.headline = format!("{} tab(s); * marks the active one.", list.len());
        Ok(d)
    }

    async fn tab_new(&self, page: &Page, args: &Value) -> Result<Done, String> {
        let url = args.get("url").and_then(Value::as_str).ok_or("tab new needs a `url`.")?;
        if !self.policy.permits(url) || !url.starts_with("http") {
            return Err(format!(
                "{} is outside the origins this browser may load ({}).",
                display_url(url),
                self.policy.allowed().iter().map(Origin::serialize).collect::<Vec<_>>().join(", ")
            ));
        }
        if page.tabs.lock().map(|t| t.list.len()).unwrap_or(0) >= MAX_TABS {
            return Err(format!("at most {MAX_TABS} tabs can be open. Close one with tab op \"close\"."));
        }
        page.mains.expect_own();
        let created = page.cdp.call("Target.createTarget", json!({ "url": "about:blank" }), None).await?;
        let target = created["targetId"].as_str().ok_or("the browser made no tab")?.to_string();
        let attached = page.cdp.call("Target.attachToTarget", json!({ "targetId": target, "flatten": true }), None).await?;
        let session = attached["sessionId"].as_str().ok_or("could not attach to the new tab")?.to_string();
        page.mains.add(&session, &target);
        let id = {
            let mut t = page.tabs.lock().map_err(|_| "tabs are unavailable")?;
            let tab = t.add(&target, &session);
            t.active = tab.id.clone();
            tab.id
        };
        if let Err(e) = launch::enable_tab(&page.cdp, &session).await {
            page.mains.remove_session(&session);
            if let Ok(mut t) = page.tabs.lock() {
                t.remove_session(&session);
            }
            let _ = page.cdp.call("Target.closeTarget", json!({ "targetId": target }), None).await;
            return Err(e);
        }
        let mut d = self.navigate(page, url).await.map_err(|e| format!("tab {id} was opened but: {e}"))?;
        d.headline = format!("Opened tab {id} (now active). {}", d.headline);
        Ok(d)
    }

    // --- upload --------------------------------------------------------------------------

    async fn upload(&self, page: &Page, args: &Value, file: Option<&std::path::Path>) -> Result<Done, String> {
        let r = page.ref_for(args)?;
        let file = file.ok_or("upload needs a `path` to a file inside your working folder.")?;
        let check = page.helper("fileCheck", &[json!(r)]).await?;
        stale(&check, &r)?;
        if check.get("notFile").is_some() {
            return Err(format!(
                "{r} is a {}, not a file input. Upload needs a ref whose snapshot role is filebutton (an <input type=file>). A file input hidden by the page does not appear in the snapshot.",
                check["role"].as_str().unwrap_or("element")
            ));
        }
        if check.get("disabled").is_some() {
            return Err(format!("{r} is disabled."));
        }
        let prefix = page.active()?.prefix();
        let found = page
            .call(
                "Runtime.evaluate",
                json!({ "expression": outline::call_expression(&prefix, "element", &[json!(r)]), "returnByValue": false }),
            )
            .await?;
        let object_id = found["result"]["objectId"].as_str().ok_or_else(|| outline::stale_message(&r))?.to_string();
        page.call("DOM.setFileInputFiles", json!({ "files": [file.to_string_lossy()], "objectId": object_id })).await?;
        page.settle(Duration::from_secs(3)).await;
        let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let size = std::fs::metadata(file).map(|m| m.len()).unwrap_or(0);
        Ok(Done::new(
            format!("Attached {} ({} bytes) to {r}. The page now holds the file; submit its form to send it.", plain(&clip(&name)), size),
            format!("upload {r} <- {}", clip(&plain(&name))),
            true,
        ))
    }

    // --- worded results ----------------------------------------------------------------

    /// The short result plus what the action did to the page.
    async fn finish(&self, page: &Page, done: Done, mark: u64) -> Reply {
        let mut text = done.headline.trim().to_string();
        if let Some(body) = &done.body {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(body);
        }
        let (mut url, mut title) = (String::new(), String::new());
        if done.status || done.mutated {
            let m = page.meta().await;
            url = m.0;
            title = m.1;
        }
        if done.status {
            let events = self.seen.lock().map(|s| s.ring.since(mark)).unwrap_or_default();
            let mut block = format!("now at: {}\ntitle: {}", clip(&plain(&url)), clip(&plain(&title)));
            for e in events.iter().take(HINT_ENTRIES) {
                block.push_str(&format!("\n- {}: {}", e.kind.label(), plain(&clip(&e.text))));
            }
            if events.len() > HINT_ENTRIES {
                block.push_str(&format!("\n- {} more (use the console action)", events.len() - HINT_ENTRIES));
            }
            text.push('\n');
            text.push_str(&fence::fence("status", &url, &block, 2_400));
        }
        self.announce(page, &done, &url, &title);
        Reply { text, image: done.image, image_mime: done.image_mime }
    }

    // --- the mirror ----------------------------------------------------------------------

    fn announce(&self, page: &Page, done: &Done, url: &str, title: &str) {
        let Some(sink) = activity_sink() else { return };
        let kind = if done.summary.starts_with("open") {
            "open"
        } else if done.summary.starts_with("screenshot") {
            "screenshot"
        } else {
            "action"
        };
        let want_shot = done.mutated && WATCHED.load(Ordering::SeqCst) && {
            let mut last = self.last_mirror.lock().ok();
            let due = last.as_ref().and_then(|l| l.as_ref()).map_or(true, |t| t.elapsed() >= MIRROR_THROTTLE);
            if due {
                if let Some(l) = last.as_mut() {
                    **l = Some(Instant::now());
                }
            }
            due
        };
        let activity = Activity {
            session_id: self.caller.activity_session(),
            run_id: self.caller.key.clone(),
            kind: kind.to_string(),
            action: clip(&plain(&done.summary)),
            url: display_url(url),
            title: clip(&plain(title)),
            screenshot: None,
        };
        let shot = want_shot.then(|| (page.cdp.clone(), page.session()));
        let _ = self.notices.send(Notice { activity, shot, sink, ctl: self.ctl.clone() });
    }

    fn announce_closed(&self, why: &str) {
        let Some(sink) = activity_sink() else { return };
        let activity = Activity {
            session_id: self.caller.activity_session(),
            run_id: self.caller.key.clone(),
            kind: "closed".to_string(),
            action: format!("closed: {why}"),
            url: String::new(),
            title: String::new(),
            screenshot: None,
        };
        let _ = self.notices.send(Notice { activity, shot: None, sink, ctl: self.ctl.clone() });
    }
}

/// A small JPEG of the page for the user's panel. Bounded, never fails the
/// caller: `None` for any problem.
async fn mirror_shot(cdp: &Cdp, session: &str) -> Option<String> {
    for quality in [60, 35] {
        let call = cdp.call(
            "Page.captureScreenshot",
            json!({ "format": "jpeg", "quality": quality }),
            Some(session),
        );
        let r = tokio::time::timeout(Duration::from_secs(3), call).await.ok()?.ok()?;
        let data = r["data"].as_str()?;
        // base64 length bounds the bytes: 4 chars carry 3 bytes.
        if data.len() / 4 * 3 <= MIRROR_MAX_BYTES {
            return Some(format!("data:image/jpeg;base64,{data}"));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dialog(kind: &str, msg: &str) -> Observed {
        Observed::Dialog { session: Some("s1".into()), kind: kind.into(), message: msg.into(), default_prompt: "dflt".into() }
    }

    #[test]
    fn an_alert_is_accepted_and_a_confirm_declined_unless_the_action_says_accept() {
        let mut s = Seen::default();
        assert_eq!(
            apply(&mut s, dialog("alert", "Saved")),
            Some(Reaction::Dialog { session: Some("s1".into()), accept: true, prompt: None })
        );
        assert_eq!(
            apply(&mut s, dialog("confirm", "Delete everything?")),
            Some(Reaction::Dialog { session: Some("s1".into()), accept: false, prompt: None })
        );
        s.accept_dialogs = true;
        assert_eq!(
            apply(&mut s, dialog("confirm", "Delete everything?")),
            Some(Reaction::Dialog { session: Some("s1".into()), accept: true, prompt: None })
        );
        s.prompt_text = Some("Ada".into());
        assert_eq!(
            apply(&mut s, dialog("prompt", "Name?")),
            Some(Reaction::Dialog { session: Some("s1".into()), accept: true, prompt: Some("Ada".into()) })
        );
        s.prompt_text = None;
        match apply(&mut s, dialog("prompt", "Name?")) {
            Some(Reaction::Dialog { prompt, .. }) => assert_eq!(prompt.as_deref(), Some("dflt")),
            other => panic!("{other:?}"),
        }
        let texts: Vec<_> = s.ring.since(0).iter().map(|e| e.text.clone()).collect();
        assert!(texts[0].contains("accepted"), "{texts:?}");
        assert!(texts[1].contains("dismissed") && texts[1].contains("dialog \"accept\""), "{texts:?}");
    }

    #[test]
    fn beforeunload_never_traps_the_page() {
        let mut s = Seen::default();
        match apply(&mut s, dialog("beforeunload", "")) {
            Some(Reaction::Dialog { accept, .. }) => assert!(accept),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_console_keeps_errors_and_warnings_and_not_chatter() {
        let mut s = Seen::default();
        for (l, t) in [("log", "hello"), ("info", "i"), ("warning", "careful"), ("error", "boom"), ("assert", "nope")] {
            apply(&mut s, Observed::Console { level: l.into(), text: t.into() });
        }
        let kinds: Vec<_> = s.ring.since(0).iter().map(|e| (e.kind, e.text.clone())).collect();
        assert_eq!(
            kinds,
            vec![(Kind::Warning, "careful".to_string()), (Kind::Error, "boom".to_string()), (Kind::Error, "nope".to_string())]
        );
    }

    #[test]
    fn blocked_requests_failed_requests_downloads_and_popups_are_reported() {
        let mut s = Seen::default();
        apply(&mut s, Observed::Blocked { url: "http://example.com/x".into(), resource_type: "Fetch".into(), navigation: false });
        apply(&mut s, Observed::Blocked { url: "http://example.com/".into(), resource_type: "Document".into(), navigation: true });
        apply(&mut s, Observed::RequestFailed { method: "GET".into(), url: "http://127.0.0.1/api".into(), status: Some(404), reason: "HTTP 404".into() });
        apply(&mut s, Observed::Download { url: "http://127.0.0.1/a.zip".into(), filename: "a.zip".into() });
        apply(&mut s, Observed::Popup { url: "about:blank".into() });
        let all = s.ring.since(0);
        assert!(all[0].text.contains("fetch to http://example.com/x refused"), "{:?}", all[0]);
        assert!(all[1].text.starts_with("page navigation to http://example.com/ refused"), "{:?}", all[1]);
        assert_eq!(all[2].text, "GET http://127.0.0.1/api -> HTTP 404");
        assert!(all[3].text.contains("a.zip") && all[3].text.contains("refused"), "{:?}", all[3]);
        assert!(all[4].text.contains("a new page") && all[4].text.contains("open"), "{:?}", all[4]);
    }

    #[test]
    fn the_ring_is_bounded_and_since_filters_by_sequence() {
        let mut r = Ring::default();
        for i in 0..(RING_CAP + 25) {
            r.push(Kind::Error, format!("e{i}"));
        }
        assert_eq!(r.items.len(), RING_CAP);
        assert_eq!(r.items.front().unwrap().text, "e25");
        let tail = r.since((RING_CAP + 20) as u64);
        assert_eq!(tail.len(), 5);
    }

    #[test]
    fn a_page_death_is_remembered() {
        let mut s = Seen::default();
        apply(&mut s, Observed::PageGone { session: "s1".into(), why: "The page crashed or was closed.".into() });
        apply(&mut s, Observed::BrowserExited);
        assert_eq!(s.dead.as_deref(), Some("The page crashed or was closed."));
    }

    #[test]
    fn a_non_local_url_is_refused_with_the_reason() {
        for url in ["https://example.com", "http://192.168.1.5:3000", "file:///etc/passwd", "http://user:pw@localhost:1/"] {
            let e = parse_origins(&json!({ "url": url })).unwrap_err();
            assert!(e.contains("only opens pages served from this machine"), "{url}: {e}");
            assert!(e.contains("web_fetch"), "{e}");
        }
        assert!(parse_origins(&json!({})).unwrap_err().contains("needs a `url`"));
        assert!(parse_origins(&json!({ "url": "http://localhost:5173/x" })).is_ok());
        let e = parse_origins(&json!({ "url": "http://localhost:5173", "allow_origins": ["https://api.example.com"] })).unwrap_err();
        assert!(e.contains("allow_origins refused"), "{e}");
        let (_, p) = parse_origins(&json!({ "url": "http://localhost:5173", "allow_origins": ["http://127.0.0.1:8787"] })).unwrap();
        assert!(p.permits("http://127.0.0.1:8787/api") && !p.permits("http://127.0.0.1:8788/"));
    }

    #[test]
    fn refs_must_have_the_ref_shape() {
        assert_eq!(ref_arg(&json!({ "ref": "e12" })).unwrap(), "e12");
        assert!(ref_arg(&json!({})).unwrap_err().contains("needs a `ref`"));
        assert!(ref_arg(&json!({ "ref": "Save" })).unwrap_err().contains("not a ref"));
        assert!(ref_arg(&json!({ "ref": "e12; alert(1)" })).is_err(), "a ref is never spliced into script unchecked");
    }

    #[test]
    fn a_stale_answer_becomes_the_snapshot_again_message() {
        assert!(stale(&json!({ "stale": true }), "e3").unwrap_err().contains("Call browser with action \"snapshot\""));
        assert!(stale(&json!({ "x": 1 }), "e3").is_ok());
    }

    #[tokio::test]
    async fn without_a_page_every_action_but_open_and_close_says_to_open_first() {
        let c = Caller { key: "unit-no-page".into(), session: String::new(), run: String::new() };
        for action in ["snapshot", "click", "type", "press", "select", "scroll", "wait", "back", "reload", "screenshot", "console", "evaluate"] {
            let r = run(&c, &json!({ "action": action })).await;
            assert!(r.text.starts_with("ERROR: No browser page is open"), "{action}: {}", r.text);
        }
        assert!(run(&c, &json!({ "action": "close" })).await.text.contains("Nothing to close"));
        let r = run(&c, &json!({})).await;
        assert!(r.text.contains("needs an `action`"), "{}", r.text);
        let r = run(&c, &json!({ "action": "teleport" })).await;
        assert!(r.text.contains("unknown browser action"), "{}", r.text);
    }

    #[tokio::test]
    async fn opening_a_remote_url_never_starts_a_browser() {
        let c = Caller { key: "unit-remote".into(), session: String::new(), run: String::new() };
        let r = run(&c, &json!({ "action": "open", "url": "https://example.com/" })).await;
        assert!(r.text.starts_with("ERROR: browser only opens pages served from this machine"), "{}", r.text);
        assert!(!is_open("unit-remote"));
    }

    #[test]
    fn plain_defangs_angle_brackets_and_controls() {
        assert_eq!(plain("a<b>\u{7}c"), "a\u{2039}b\u{203A} c");
    }
}
