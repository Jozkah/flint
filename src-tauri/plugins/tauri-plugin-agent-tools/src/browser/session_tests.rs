//! End-to-end tests for the `browser` session against a REAL installed
//! Chromium-based browser and a tiny local HTTP app.
//!
//! They print `RAN` (with the browser used) when they execute and an explicit
//! `SKIPPED` only when no browser is installed, so a green run on a machine
//! with a browser is never vacuous. Run with `--nocapture` to see which.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Once};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::session::{self, Activity, Caller};
use crate::lifecycle::{Scope, StopReason};

/// One browser at a time: these start real processes.
static GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static ACTIVITY: Mutex<Vec<Activity>> = Mutex::new(Vec::new());
static SINK_ONCE: Once = Once::new();

fn install_sink() {
    SINK_ONCE.call_once(|| {
        session::set_activity_sink(Some(Arc::new(|a: Activity| {
            if let Ok(mut v) = ACTIVITY.lock() {
                v.push(a);
            }
        })));
        session::set_activity_watched(true);
    });
}

fn activity_for(key: &str) -> Vec<Activity> {
    ACTIVITY.lock().unwrap().iter().filter(|a| a.run_id == key).cloned().collect()
}

struct App {
    port: u16,
    stop: Arc<AtomicBool>,
}

impl Drop for App {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl App {
    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }
}

const HOME: &str = r#"<html><head><title>Demo shop</title></head><body>
<h1>Shop</h1>
<label>Your name <input id="name" placeholder="Name"></label>
<button id="go" onclick="document.getElementById('out').textContent='Hello '+document.getElementById('name').value">Greet</button>
<div id="out"></div>
<a href="/next">Next page</a>
<a href="http://example.com/landing">Off site</a>
<button onclick="console.error('boom-error')">Boom</button>
<button onclick="alert('Saved!'); document.getElementById('out').textContent='alerted'">Alert</button>
<button onclick="document.getElementById('out').textContent = confirm('Delete everything?') ? 'deleted' : 'kept'">Delete</button>
<button onclick="window.open('/next')">Popup</button>
<a href="/file.zip">Download</a>
<button onclick="fetch('/api/missing')">Fetch missing</button>
<select id="color" aria-label="Colour"><option value="r">Red</option><option value="g">Green</option></select>
<div style="height:3000px">tall</div><p id="bottom">The bottom</p>
<script>console.error('startup-error')</script></body></html>"#;

/// A tiny app: a form, buttons for a console error, an alert, a confirm and a
/// popup, a link off the origin, a file download and a 404 fetch.
fn serve() -> App {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    std::thread::spawn(move || {
        while !flag.load(Ordering::SeqCst) {
            let Ok((mut s, _)) = listener.accept() else {
                std::thread::sleep(Duration::from_millis(15));
                continue;
            };
            std::thread::spawn(move || {
                let _ = s.set_nonblocking(false);
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                let (status, extra, body): (&str, &str, String) = match path.as_str() {
                    "/" => ("200 OK", "Content-Type: text/html\r\n", HOME.to_string()),
                    "/next" => ("200 OK", "Content-Type: text/html\r\n", "<html><head><title>Next</title></head><body><h1>Next page</h1><a href=\"/\">Home</a></body></html>".into()),
                    "/file.zip" => ("200 OK", "Content-Type: application/zip\r\nContent-Disposition: attachment; filename=\"a.zip\"\r\n", "PK".into()),
                    _ => ("404 Not Found", "Content-Type: text/plain\r\n", "nope".into()),
                };
                let _ = write!(
                    s,
                    "HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            });
        }
    });
    App { port, stop }
}

fn browser_or_skip(test: &str) -> bool {
    match crate::browser_discovery::find_browser_path() {
        Some(p) => {
            println!("RAN {test}: driving {}", p.display());
            true
        }
        None => {
            println!("SKIPPED {test}: no Chromium-based browser installed (set FLINT_BROWSER_PATH)");
            false
        }
    }
}

fn caller(key: &str) -> Caller {
    Caller { key: key.to_string(), session: format!("sess-{key}"), run: key.to_string() }
}

async fn act(c: &Caller, args: Value) -> String {
    session::run(c, &args).await.text
}

/// The ref of the first outline line containing `needle`.
fn ref_of(outline: &str, needle: &str) -> String {
    let line = outline
        .lines()
        .find(|l| l.contains(needle) && l.contains('['))
        .unwrap_or_else(|| panic!("no line with {needle:?} in:\n{outline}"));
    let start = line.rfind("[e").unwrap() + 1;
    let end = line[start..].find(']').unwrap() + start;
    line[start..end].to_string()
}

fn browser_processes_using(marker: &str) -> usize {
    #[cfg(windows)]
    {
        // The marker is split in the script so this very command line cannot match itself.
        let (head, tail) = marker.split_at(marker.len() / 2);
        let script = format!(
            "(Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -like ('*--user-data-dir=*{head}' + '{tail}*') }} | Measure-Object).Count"
        );
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output();
        out.ok().and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok()).unwrap_or(0)
    }
    #[cfg(not(windows))]
    {
        let out = std::process::Command::new("pgrep").args(["-fc", marker]).output();
        out.ok().and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok()).unwrap_or(0)
    }
}

async fn wait_until(what: &str, secs: u64, mut ok: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(secs);
    while !ok() {
        assert!(Instant::now() < until, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test]
async fn a_model_style_sequence_works_end_to_end_and_leaves_nothing_behind() {
    if !browser_or_skip("sequence") {
        return;
    }
    let _g = GATE.lock().await;
    install_sink();
    let app = serve();
    let c = caller("seq");
    let temp_before: Vec<_> = std::fs::read_dir(std::env::temp_dir())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with("flint-browser-"))
        .map(|e| e.path())
        .collect();

    let opened = act(&c, json!({ "action": "open", "url": app.url("/") })).await;
    assert!(opened.contains("Opened http://127.0.0.1:") && opened.contains("(HTTP 200)"), "{opened}");
    assert!(opened.contains("Call snapshot"), "{opened}");
    assert!(opened.contains("untrusted_web_content"), "page-derived status is fenced: {opened}");
    assert!(session::is_open("seq"));

    let snap = act(&c, json!({ "action": "snapshot" })).await;
    assert!(snap.contains("title: Demo shop"), "{snap}");
    assert!(snap.contains("heading[1] \"Shop\""), "{snap}");
    assert!(snap.contains("textbox \"Your name\""), "{snap}");
    assert!(snap.contains("button \"Greet\""), "{snap}");
    assert!(snap.contains("link \"Next page\"") && snap.contains("-> /next"), "{snap}");
    assert!(snap.contains("combobox \"Colour\"") && snap.contains("options: Red | Green"), "{snap}");
    assert!(snap.chars().count() < 7_500, "{} chars", snap.chars().count());
    let name = ref_of(&snap, "textbox \"Your name\"");
    let greet = ref_of(&snap, "button \"Greet\"");

    let typed = act(&c, json!({ "action": "type", "ref": name, "text": "Ada" })).await;
    assert!(typed.contains("Typed 3 character(s)") && !typed.contains("Ada"), "typed text is never echoed: {typed}");
    let clicked = act(&c, json!({ "action": "click", "ref": greet })).await;
    assert!(clicked.contains("Clicked button \"Greet\""), "{clicked}");

    let after = act(&c, json!({ "action": "snapshot" })).await;
    assert!(after.contains("text: Hello Ada"), "{after}");
    assert!(after.contains("value=\"Ada\""), "{after}");

    let shot = session::run(&c, &json!({ "action": "screenshot" })).await;
    let png = shot.png.expect("a screenshot returns a PNG");
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    assert!(png.len() < session::MAX_PNG_BYTES);
    assert!(shot.text.starts_with("Screenshot of http://127.0.0.1:"), "{}", shot.text);

    let console = act(&c, json!({ "action": "console" })).await;
    assert!(console.contains("startup-error"), "{console}");
    let again = act(&c, json!({ "action": "console" })).await;
    assert!(again.contains("No new console"), "console reports what is new: {again}");

    // The mirror: one notice per action, bounded, then a closing one.
    wait_until("eight notices (one per action)", 10, || activity_for("seq").len() >= 8).await;
    assert_eq!(activity_for("seq").len(), 8, "one notice per action, nothing more");

    let profile_marker = "flint-browser-";
    let closed = act(&c, json!({ "action": "close" })).await;
    assert!(closed.contains("Browser closed") && closed.contains("profile was deleted"), "{closed}");
    assert!(!session::is_open("seq"));
    let dir_left = std::fs::read_dir(std::env::temp_dir())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with(profile_marker))
        .filter(|p| !temp_before.contains(p))
        .count();
    assert_eq!(dir_left, 0, "a temporary profile was left behind");
    wait_until("the browser processes to be gone", 10, || browser_processes_using("flint-browser-") == 0).await;
    wait_until("the closing notice", 10, || activity_for("seq").iter().any(|a| a.kind == "closed")).await;
    let notices = activity_for("seq");
    assert_eq!(notices.last().map(|a| a.kind.as_str()), Some("closed"));
    // The cap on what the panel is sent.
    for n in &notices {
        if let Some(s) = &n.screenshot {
            assert!(s.starts_with("data:image/jpeg;base64,") && s.len() < 420_000, "{}", s.len());
        }
    }
    drop(app);
}

#[tokio::test]
async fn a_ref_from_before_a_navigation_is_stale_and_says_to_snapshot_again() {
    if !browser_or_skip("stale-ref") {
        return;
    }
    let _g = GATE.lock().await;
    let app = serve();
    let c = caller("stale");
    act(&c, json!({ "action": "open", "url": app.url("/") })).await;
    let snap = act(&c, json!({ "action": "snapshot" })).await;
    let greet = ref_of(&snap, "button \"Greet\"");
    let link = ref_of(&snap, "link \"Next page\"");
    let moved = act(&c, json!({ "action": "click", "ref": link })).await;
    assert!(moved.contains("/next") && moved.contains("title: Next"), "an action reports the new address: {moved}");
    let stale = act(&c, json!({ "action": "click", "ref": greet })).await;
    assert!(stale.starts_with("ERROR: ref ") && stale.contains("not on the current page") && stale.contains("snapshot"), "{stale}");
    let bad = act(&c, json!({ "action": "click", "ref": "e99999" })).await;
    assert!(bad.contains("not on the current page"), "{bad}");
    let shaped = act(&c, json!({ "action": "click", "ref": "Greet" })).await;
    assert!(shaped.contains("not a ref"), "{shaped}");
    // Back works, and the old refs are gone after it too.
    let back = act(&c, json!({ "action": "back" })).await;
    assert!(back.contains("Went back") && back.contains("now at: http://127.0.0.1:"), "{back}");
    let snap2 = act(&c, json!({ "action": "snapshot" })).await;
    assert!(snap2.contains("title: Demo shop"), "{snap2}");
    let reloaded = act(&c, json!({ "action": "reload" })).await;
    assert!(reloaded.contains("Reloaded"), "{reloaded}");
    act(&c, json!({ "action": "close" })).await;
}

#[tokio::test]
async fn an_off_origin_link_is_blocked_and_reported_and_the_session_lives() {
    if !browser_or_skip("off-origin") {
        return;
    }
    let _g = GATE.lock().await;
    let app = serve();
    let c = caller("offorigin");
    act(&c, json!({ "action": "open", "url": app.url("/") })).await;
    let snap = act(&c, json!({ "action": "snapshot" })).await;
    let off = ref_of(&snap, "link \"Off site\"");
    let r = act(&c, json!({ "action": "click", "ref": off })).await;
    assert!(r.contains("refused") && r.contains("example.com"), "{r}");
    assert!(r.contains("now at: http://127.0.0.1:") && r.contains("title: Demo shop"), "the page stayed where it was: {r}");
    assert!(session::is_open("offorigin"));
    // Opening an outside address directly is refused before any navigation.
    let direct = act(&c, json!({ "action": "open", "url": "https://example.com/" })).await;
    assert!(direct.starts_with("ERROR: browser only opens pages served from this machine"), "{direct}");
    // And the session still works.
    let still = act(&c, json!({ "action": "snapshot" })).await;
    assert!(still.contains("title: Demo shop"), "{still}");
    let c2 = act(&c, json!({ "action": "console", "all": true })).await;
    assert!(c2.contains("blocked") && c2.contains("example.com"), "{c2}");
    act(&c, json!({ "action": "close" })).await;
}

#[tokio::test]
async fn dialogs_popups_downloads_and_failed_requests_are_reported() {
    if !browser_or_skip("dialogs") {
        return;
    }
    let _g = GATE.lock().await;
    let app = serve();
    let c = caller("dialogs");
    act(&c, json!({ "action": "open", "url": app.url("/") })).await;
    let snap = act(&c, json!({ "action": "snapshot" })).await;

    let alert = act(&c, json!({ "action": "click", "ref": ref_of(&snap, "button \"Alert\"") })).await;
    assert!(alert.contains("dialog: alert \"Saved!\" accepted"), "{alert}");

    let kept = act(&c, json!({ "action": "click", "ref": ref_of(&snap, "button \"Delete\"") })).await;
    assert!(kept.contains("confirm \"Delete everything?\" dismissed"), "confirm is dismissed by default: {kept}");
    let s2 = act(&c, json!({ "action": "snapshot" })).await;
    assert!(s2.contains("text: kept"), "{s2}");
    let deleted = act(&c, json!({ "action": "click", "ref": ref_of(&s2, "button \"Delete\""), "dialog": "accept" })).await;
    assert!(deleted.contains("accepted"), "{deleted}");
    let s3 = act(&c, json!({ "action": "snapshot" })).await;
    assert!(s3.contains("text: deleted"), "{s3}");

    let popup = act(&c, json!({ "action": "click", "ref": ref_of(&s3, "button \"Popup\"") })).await;
    assert!(popup.contains("new window") && popup.contains("closed"), "{popup}");
    assert!(popup.contains("now at: http://127.0.0.1:") && popup.contains("title: Demo shop"), "the main tab did not move: {popup}");

    let dl = act(&c, json!({ "action": "click", "ref": ref_of(&s3, "link \"Download\"") })).await;
    assert!(dl.contains("download") && dl.contains("a.zip") && dl.contains("refused"), "{dl}");

    let miss = act(&c, json!({ "action": "click", "ref": ref_of(&s3, "button \"Fetch missing\"") })).await;
    assert!(miss.contains("request failed") && miss.contains("HTTP 404"), "{miss}");
    act(&c, json!({ "action": "close" })).await;
}

#[tokio::test]
async fn select_press_scroll_wait_and_evaluate_work() {
    if !browser_or_skip("select-press-scroll") {
        return;
    }
    let _g = GATE.lock().await;
    let app = serve();
    let c = caller("misc");
    act(&c, json!({ "action": "open", "url": app.url("/") })).await;
    let snap = act(&c, json!({ "action": "snapshot" })).await;
    let colour = ref_of(&snap, "combobox \"Colour\"");
    let bad = act(&c, json!({ "action": "select", "ref": colour, "value": "Purple" })).await;
    assert!(bad.contains("no option \"Purple\"") && bad.contains("Red | Green"), "{bad}");
    let ok = act(&c, json!({ "action": "select", "ref": colour, "value": "Green" })).await;
    assert!(ok.contains("Selected \"Green\""), "{ok}");
    let name = ref_of(&snap, "textbox \"Your name\"");
    let wrong = act(&c, json!({ "action": "type", "ref": ref_of(&snap, "button \"Greet\""), "text": "x" })).await;
    assert!(wrong.contains("cannot take text"), "{wrong}");
    act(&c, json!({ "action": "type", "ref": name, "text": "Bob" })).await;
    let pressed = act(&c, json!({ "action": "press", "key": "Control+A" })).await;
    assert!(pressed.contains("Pressed Control+A"), "{pressed}");
    assert!(act(&c, json!({ "action": "press", "key": "Hyper+Q" })).await.contains("not a key I know"));

    let scrolled = act(&c, json!({ "action": "scroll", "direction": "down", "amount": "2000" })).await;
    assert!(scrolled.contains("Scrolled to") && !scrolled.contains("Scrolled to 0px"), "{scrolled}");
    let found = act(&c, json!({ "action": "wait", "text": "The bottom", "timeout": 3000 })).await;
    assert!(found.contains("Found the text"), "{found}");
    let timed_out = act(&c, json!({ "action": "wait", "text": "never appears", "timeout": 400 })).await;
    assert!(timed_out.starts_with("ERROR: timed out"), "{timed_out}");
    let sel = act(&c, json!({ "action": "wait", "selector": "#out", "timeout": 2000 })).await;
    assert!(sel.contains("Found an element matching #out"), "{sel}");
    let ms = act(&c, json!({ "action": "wait", "ms": 120 })).await;
    assert!(ms.contains("Waited 120 ms"), "{ms}");

    let v = act(&c, json!({ "action": "evaluate", "expression": "({ title: document.title, n: 1 + 1 })" })).await;
    assert!(v.contains("{\"n\":2,\"title\":\"Demo shop\"}") || v.contains("{\"title\":\"Demo shop\",\"n\":2}"), "{v}");
    assert!(v.contains("untrusted_web_content"), "{v}");
    let big = act(&c, json!({ "action": "evaluate", "expression": "'x'.repeat(10000)" })).await;
    assert!(big.contains("result cut"), "{big}");
    let threw = act(&c, json!({ "action": "evaluate", "expression": "nope.nope" })).await;
    assert!(threw.starts_with("ERROR: the page script threw"), "{threw}");
    // Page script cannot reach outside: a fetch off the origin is blocked.
    let leak = act(&c, json!({ "action": "evaluate", "expression": "fetch('http://example.com/').then(() => 'reached', () => 'blocked')" })).await;
    assert!(leak.contains("blocked") && !leak.contains("reached"), "{leak}");
    act(&c, json!({ "action": "close" })).await;
}

#[tokio::test]
async fn a_screenshot_of_one_element_and_a_full_page_are_bounded_pngs() {
    if !browser_or_skip("screenshots") {
        return;
    }
    let _g = GATE.lock().await;
    let app = serve();
    let c = caller("shots");
    act(&c, json!({ "action": "open", "url": app.url("/") })).await;
    let snap = act(&c, json!({ "action": "snapshot" })).await;
    let el = session::run(&c, &json!({ "action": "screenshot", "ref": ref_of(&snap, "button \"Greet\"") })).await;
    let small = el.png.expect("element png");
    let full = session::run(&c, &json!({ "action": "screenshot", "fullPage": true })).await;
    let big = full.png.expect("full-page png");
    assert!(big.len() > small.len(), "{} vs {}", big.len(), small.len());
    assert!(full.text.contains("full page"), "{}", full.text);
    act(&c, json!({ "action": "close" })).await;
}

#[tokio::test]
async fn the_mirror_gets_one_bounded_notice_per_action_and_none_without_a_sink() {
    if !browser_or_skip("mirror") {
        return;
    }
    let _g = GATE.lock().await;
    install_sink();
    let app = serve();
    let c = caller("mirror");
    act(&c, json!({ "action": "open", "url": app.url("/") })).await;
    let snap = act(&c, json!({ "action": "snapshot" })).await;
    act(&c, json!({ "action": "click", "ref": ref_of(&snap, "link \"Next page\"") })).await;
    act(&c, json!({ "action": "console" })).await;
    // Notices are sent from a task; wait for them.
    wait_until("four notices", 10, || activity_for("mirror").len() >= 4).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let n = activity_for("mirror");
    assert_eq!(n.len(), 4, "exactly one per action: {:?}", n.iter().map(|a| (&a.kind, &a.action)).collect::<Vec<_>>());
    assert_eq!(n[0].kind, "open");
    assert!(n[0].url.starts_with("http://127.0.0.1:") && n[0].title == "Demo shop", "{:?}", n[0]);
    assert!(n[0].screenshot.is_some(), "an open takes the first picture");
    assert!(n[2].action.starts_with("click e") && n[2].action.contains("Next page"), "{:?}", n[2]);
    assert!(n[2].url.ends_with("/next"), "{:?}", n[2]);
    assert_eq!(n[2].session_id, "sess-mirror");
    assert!(n[1].screenshot.is_none() && n[3].screenshot.is_none(), "looking takes no picture");
    for a in &n {
        let size = serde_json::to_string(a).unwrap().len();
        assert!(size < 420_000, "{size}");
    }
    act(&c, json!({ "action": "close" })).await;
    wait_until("the closed notice", 5, || activity_for("mirror").iter().any(|a| a.kind == "closed")).await;
}

#[tokio::test]
async fn a_second_origin_restarts_the_browser_to_widen_confinement() {
    if !browser_or_skip("second-origin") {
        return;
    }
    let _g = GATE.lock().await;
    let a = serve();
    let b = serve();
    let c = caller("two");
    act(&c, json!({ "action": "open", "url": a.url("/") })).await;
    // Without allow_origins the second app's page cannot be loaded as a subresource, but
    // opening it as a page widens the policy by restarting.
    let r = act(&c, json!({ "action": "open", "url": b.url("/next") })).await;
    assert!(r.contains("restarted to allow the new origin"), "{r}");
    assert!(r.contains(&format!("127.0.0.1:{}", b.port)), "{r}");
    let r = act(&c, json!({ "action": "open", "url": b.url("/") })).await;
    assert!(!r.contains("restarted"), "same origin navigates in place: {r}");
    act(&c, json!({ "action": "close" })).await;
}

#[tokio::test]
async fn nothing_answering_is_explained_before_a_browser_starts() {
    if !browser_or_skip("nothing-listening") {
        return;
    }
    let _g = GATE.lock().await;
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let c = caller("nothing");
    let r = act(&c, json!({ "action": "open", "url": format!("http://127.0.0.1:{port}/") })).await;
    assert!(r.contains("Nothing is answering") && r.contains("Start the app"), "{r}");
    assert!(!session::is_open("nothing"));
}

#[tokio::test]
async fn ending_a_run_stopping_it_going_idle_and_closing_all_tear_the_browser_down() {
    if !browser_or_skip("teardown") {
        return;
    }
    let _g = GATE.lock().await;
    let app = serve();
    let profiles = || -> std::collections::BTreeSet<std::path::PathBuf> {
        std::fs::read_dir(std::env::temp_dir())
            .map(|d| {
                d.filter_map(|e| e.ok())
                    .map(|e| e.path())
                    .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with("flint-browser-"))
                    .collect()
            })
            .unwrap_or_default()
    };
    let before = profiles();

    // 1. The run ends.
    let c1 = caller("td-run");
    act(&c1, json!({ "action": "open", "url": app.url("/") })).await;
    assert!(session::is_open("td-run"));
    session::close_run("td-run");
    assert!(!session::is_open("td-run"));
    let r = act(&c1, json!({ "action": "snapshot" })).await;
    assert!(r.contains("No browser page is open"), "{r}");

    // 2. The run is cancelled: a scope stop kills the tree and the watchdog
    //    removes the profile.
    let c2 = caller("td-stop");
    act(&c2, json!({ "action": "open", "url": app.url("/") })).await;
    let stopped = crate::lifecycle::stop_scope(&Scope::new("sess-td-stop", "td-stop", ""), StopReason::Cancelled);
    assert!(stopped >= 1, "the session's token is registered under the run's scope");
    wait_until("the stopped session to be reaped", 15, || !session::is_open("td-stop")).await;

    // 3. A stop aimed at one tool call does not end the run's browser.
    let c3 = caller("td-call");
    act(&c3, json!({ "action": "open", "url": app.url("/") })).await;
    crate::lifecycle::stop_scope(&Scope::new("sess-td-call", "td-call", "some-call"), StopReason::Cancelled);
    assert!(session::is_open("td-call"));

    // 4. Idle too long.
    session::age_for_test("td-call", Duration::from_secs(session::IDLE_SECS + 60));
    wait_until("the idle session to be closed", 15, || !session::is_open("td-call")).await;

    // 5. App exit.
    let c5 = caller("td-all");
    act(&c5, json!({ "action": "open", "url": app.url("/") })).await;
    session::close_all();
    assert!(!session::is_open("td-all"));

    wait_until("every browser process to be gone", 15, || browser_processes_using("flint-browser-") == 0).await;
    wait_until("every profile directory this test made to be gone", 15, || profiles().is_subset(&before)).await;
}

/// The same sequence, through the tool dispatcher a run really uses
/// (`execute_builtin`: hooks, deadline, cancellation token, image parts), and
/// then a cancellation of the run while the browser is open.
#[tokio::test]
async fn the_dispatcher_runs_a_sequence_returns_an_image_and_a_cancelled_run_tears_down() {
    if !browser_or_skip("dispatcher") {
        return;
    }
    let _g = GATE.lock().await;
    let app = serve();
    let dir = std::env::temp_dir().join(format!("flint-dispatch-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let store = dir.join("store");
    std::fs::create_dir_all(&store).unwrap();
    let enabled: Vec<String> = vec![];
    let tool = crate::tools::lookup("browser").expect("browser is registered");
    // One call's token under the run's scope, as the loop makes it.
    let call = |n: u32| crate::lifecycle::Token::new(Scope::new("sess-d", "run-d", format!("call-{n}")));
    let run_call = |n: u32, args: Value| {
        let (dir, store, enabled) = (dir.clone(), store.clone(), enabled.clone());
        async move {
            let ctx = crate::tools::ToolContext::new(&dir, &store, &enabled).with_cancel(call(n));
            crate::tools::handlers::execute_builtin(tool, &args, &ctx).await
        }
    };

    let (opened, _) = run_call(1, json!({ "action": "open", "url": app.url("/") })).await;
    assert!(opened.contains("Opened http://127.0.0.1:"), "{opened}");
    assert!(session::is_open("run-d"), "the session is keyed by the run, not the call");
    let (snap, _) = run_call(2, json!({ "action": "snapshot" })).await;
    let name = ref_of(&snap, "textbox \"Your name\"");
    let greet = ref_of(&snap, "button \"Greet\"");
    run_call(3, json!({ "action": "type", "ref": name, "text": "Grace" })).await;
    run_call(4, json!({ "action": "click", "ref": greet })).await;
    let (after, _) = run_call(5, json!({ "action": "snapshot" })).await;
    assert!(after.contains("text: Hello Grace"), "{after}");
    let (text, images) = run_call(6, json!({ "action": "screenshot" })).await;
    assert!(text.starts_with("Screenshot of"), "{text}");
    let images = images.expect("the screenshot travels as an image part");
    assert_eq!(images.len(), 1);
    assert!(images[0].data_url.starts_with("data:image/png;base64,"));
    let (console, _) = run_call(7, json!({ "action": "console" })).await;
    assert!(console.contains("startup-error"), "{console}");

    // Cancelling the run (not one call) tears the browser down.
    let stopped = crate::lifecycle::stop_scope(&Scope::new("sess-d", "run-d", ""), StopReason::Cancelled);
    assert!(stopped >= 1);
    wait_until("the cancelled run's browser to go", 15, || !session::is_open("run-d")).await;
    let (after_cancel, _) = run_call(8, json!({ "action": "snapshot" })).await;
    assert!(after_cancel.contains("No browser page is open"), "{after_cancel}");
    wait_until("no browser process left", 15, || browser_processes_using("flint-browser-") == 0).await;
    let _ = std::fs::remove_dir_all(&dir);
}
