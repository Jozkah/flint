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

/// One notice per action; the live view's frames are counted apart.
fn activity_for(key: &str) -> Vec<Activity> {
    ACTIVITY.lock().unwrap().iter().filter(|a| a.run_id == key && a.kind != "frame").cloned().collect()
}

fn frames_for(key: &str) -> Vec<Activity> {
    ACTIVITY.lock().unwrap().iter().filter(|a| a.run_id == key && a.kind == "frame").cloned().collect()
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
                    "/tabs" => ("200 OK", "Content-Type: text/html\r\n", "<html><head><title>Tabs page</title></head><body><a href=\"/next\" target=\"_blank\">Open elsewhere</a></body></html>".into()),
                    "/upload" => ("200 OK", "Content-Type: text/html\r\n", "<html><head><title>Upload page</title></head><body><label>Resume <input type=\"file\" id=\"f\"></label><button id=\"b\">Not a file</button><div id=\"out\"></div><script>document.getElementById('f').onchange=()=>{const f=document.getElementById('f').files[0];document.getElementById('out').textContent='picked '+f.name+' '+f.size}</script></body></html>".into()),
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
    // A ref is `[e12]`, or `[t2e12]` in a later tab.
    let start = line.rfind(|c| c == '[').unwrap() + 1;
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
    let png = shot.image.expect("a screenshot returns a PNG");
    assert_eq!(shot.image_mime, "image/png");
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
    let small = el.image.expect("element png");
    let full = session::run(&c, &json!({ "action": "screenshot", "fullPage": true })).await;
    let big = full.image.expect("full-page png");
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


#[tokio::test]
async fn tabs_open_list_switch_and_close_and_refs_belong_to_their_tab() {
    if !browser_or_skip("tabs") {
        return;
    }
    let _g = GATE.lock().await;
    let app = serve();
    let c = caller("tabs");
    act(&c, json!({ "action": "open", "url": app.url("/") })).await;
    let snap1 = act(&c, json!({ "action": "snapshot" })).await;
    let greet1 = ref_of(&snap1, "button \"Greet\"");
    assert!(!snap1.contains("tab: "), "one tab says nothing about tabs: {snap1}");

    let new = act(&c, json!({ "action": "tab", "op": "new", "url": app.url("/next") })).await;
    assert!(new.contains("Opened tab t2") && new.contains("title: Next"), "{new}");
    let snap2 = act(&c, json!({ "action": "snapshot" })).await;
    assert!(snap2.contains("tab: t2 of 2 open"), "{snap2}");
    let home = ref_of(&snap2, "link \"Home\"");
    assert!(home.starts_with("t2e"), "a second tab's refs name it: {home}");
    // A ref from the first tab is refused here and says why.
    let wrong = act(&c, json!({ "action": "click", "ref": greet1 })).await;
    assert!(wrong.contains("belongs to tab t1") && wrong.contains("active tab is t2"), "{wrong}");

    let list = act(&c, json!({ "action": "tab" })).await;
    assert!(list.contains("2 tab(s)") && list.contains("* t2") && list.contains("- t1") && list.contains("Demo shop"), "{list}");

    let back = act(&c, json!({ "action": "tab", "op": "switch", "tab_id": "t1" })).await;
    assert!(back.contains("Switched to tab t1") && back.contains("title: Demo shop"), "{back}");
    let ok = act(&c, json!({ "action": "click", "ref": greet1 })).await;
    assert!(ok.contains("Clicked button \"Greet\""), "the first tab's ref works in the first tab: {ok}");
    assert!(act(&c, json!({ "action": "tab", "op": "switch", "tab_id": "t9" })).await.contains("there is no tab t9"));
    assert!(act(&c, json!({ "action": "tab", "op": "switch", "tab_id": "two" })).await.contains("not a tab id"));

    // A tab off the origin is refused before it is made.
    let off = act(&c, json!({ "action": "tab", "op": "new", "url": "https://example.com/" })).await;
    assert!(off.starts_with("ERROR:") && off.contains("outside the origins"), "{off}");

    let closed = act(&c, json!({ "action": "tab", "op": "close", "tab_id": "t2" })).await;
    assert!(closed.contains("Closed tab t2") && closed.contains("active tab is t1"), "{closed}");
    let only = act(&c, json!({ "action": "tab", "op": "close" })).await;
    assert!(only.contains("only tab"), "{only}");
    act(&c, json!({ "action": "close" })).await;
}

#[tokio::test]
async fn windows_the_page_opens_are_closed_unless_the_run_opts_into_popups() {
    if !browser_or_skip("popups") {
        return;
    }
    let _g = GATE.lock().await;
    let app = serve();
    let c = caller("popups");
    act(&c, json!({ "action": "open", "url": app.url("/tabs") })).await;
    let snap = act(&c, json!({ "action": "snapshot" })).await;
    let link = ref_of(&snap, "link \"Open elsewhere\"");
    let r = act(&c, json!({ "action": "click", "ref": link })).await;
    assert!(r.contains("closed (popups are off)"), "{r}");
    assert!(act(&c, json!({ "action": "tab" })).await.contains("1 tab(s)"));

    // Opting in keeps the window as a confined tab.
    act(&c, json!({ "action": "open", "url": app.url("/tabs"), "popups": true })).await;
    let snap = act(&c, json!({ "action": "snapshot" })).await;
    let link = ref_of(&snap, "link \"Open elsewhere\"");
    act(&c, json!({ "action": "click", "ref": link })).await;
    wait_until("the popup to become a tab", 10, || false || true).await;
    let mut listing = String::new();
    for _ in 0..40 {
        listing = act(&c, json!({ "action": "tab" })).await;
        if listing.contains("2 tab(s)") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    assert!(listing.contains("2 tab(s)") && listing.contains("t2"), "{listing}");
    let consoled = act(&c, json!({ "action": "console", "all": true })).await;
    assert!(consoled.contains("new tab"), "{consoled}");
    act(&c, json!({ "action": "tab", "op": "switch", "tab_id": "t2" })).await;
    let s2 = act(&c, json!({ "action": "snapshot" })).await;
    assert!(s2.contains("Next page"), "{s2}");
    // The popup tab is confined like any other: an off-origin fetch is blocked.
    let leak = act(&c, json!({ "action": "evaluate", "expression": "fetch('http://example.com/').then(() => 'reached', () => 'blocked')" })).await;
    assert!(leak.contains("blocked") && !leak.contains("reached"), "{leak}");
    act(&c, json!({ "action": "close" })).await;
}

#[tokio::test]
async fn upload_attaches_a_file_from_the_working_folder_and_refuses_everything_else() {
    if !browser_or_skip("upload") {
        return;
    }
    let _g = GATE.lock().await;
    let app = serve();
    let base = std::env::temp_dir().join(format!("flint-upload-{}", std::process::id()));
    let work = base.join("work");
    let outside = base.join("outside");
    std::fs::create_dir_all(work.join(".jan")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(work.join("resume.txt"), b"hello upload").unwrap();
    std::fs::write(work.join(".jan").join("secret.txt"), b"state").unwrap();
    std::fs::write(outside.join("host.txt"), b"host file").unwrap();
    let store = base.join("store");
    std::fs::create_dir_all(&store).unwrap();
    let enabled: Vec<String> = vec![];
    let tool = crate::tools::lookup("browser").unwrap();
    let call = |n: u32| crate::lifecycle::Token::new(Scope::new("sess-u", "run-u", format!("c{n}")));
    let run_call = |n: u32, args: Value| {
        let (work, store, enabled) = (work.clone(), store.clone(), enabled.clone());
        async move {
            let ctx = crate::tools::ToolContext::new(&work, &store, &enabled).with_cancel(call(n));
            crate::tools::handlers::execute_builtin(tool, &args, &ctx).await.0
        }
    };

    run_call(1, json!({ "action": "open", "url": app.url("/upload") })).await;
    let snap = run_call(2, json!({ "action": "snapshot" })).await;
    let file = ref_of(&snap, "filebutton \"Resume\"");
    let button = ref_of(&snap, "button \"Not a file\"");

    let ok = run_call(3, json!({ "action": "upload", "ref": file, "path": "resume.txt" })).await;
    assert!(ok.contains("Attached resume.txt (12 bytes)"), "{ok}");
    let after = run_call(4, json!({ "action": "snapshot" })).await;
    assert!(after.contains("text: picked resume.txt 12"), "the page saw the file: {after}");

    // Everything else is refused, and nothing is attached.
    let host = outside.join("host.txt").to_string_lossy().into_owned();
    for (path, why) in [
        (host.as_str(), "outside your working folder"),
        ("../outside/host.txt", "outside your working folder"),
        (".jan/secret.txt", "state directory"),
        ("missing.txt", "no such file"),
        (".", "not a regular file"),
    ] {
        let r = run_call(5, json!({ "action": "upload", "ref": file, "path": path })).await;
        assert!(r.starts_with("ERROR") && r.contains(why), "{path}: {r}");
    }
    let nofile = run_call(6, json!({ "action": "upload", "ref": button, "path": "resume.txt" })).await;
    assert!(nofile.contains("not a file input"), "{nofile}");
    // The model cannot smuggle a path past the check through another argument.
    let direct = session::run(&caller("u-direct"), &json!({ "action": "upload", "ref": "e1", "path": host })).await;
    assert!(direct.text.contains("No browser page is open") || direct.text.contains("needs a `path`"), "{}", direct.text);
    run_call(7, json!({ "action": "close" })).await;
    let _ = std::fs::remove_dir_all(&base);
}

#[tokio::test]
async fn a_compact_screenshot_is_a_bounded_jpeg_and_the_default_stays_a_png() {
    if !browser_or_skip("compact-image") {
        return;
    }
    let _g = GATE.lock().await;
    let app = serve();
    let c = caller("compact");
    act(&c, json!({ "action": "open", "url": app.url("/") })).await;
    let opts = session::Options { upload: None, compact_image: true };
    let small = session::run_with(&c, &json!({ "action": "screenshot" }), &opts).await;
    let jpeg = small.image.expect("a compact screenshot");
    assert_eq!(small.image_mime, "image/jpeg");
    assert_eq!(&jpeg[..3], b"\xff\xd8\xff", "a JPEG");
    assert!(jpeg.len() <= session::MAX_COMPACT_IMAGE_BYTES, "{}", jpeg.len());
    let full = session::run_with(&c, &json!({ "action": "screenshot", "fullPage": true }), &opts).await;
    assert!(full.image.is_some_and(|b| b.len() <= session::MAX_COMPACT_IMAGE_BYTES));
    let plain = session::run(&c, &json!({ "action": "screenshot" })).await;
    assert_eq!(plain.image_mime, "image/png");
    // Looking at a page returns no image at all.
    let snap = session::run_with(&c, &json!({ "action": "snapshot" }), &opts).await;
    assert!(snap.image.is_none() && snap.image_mime.is_empty());
    act(&c, json!({ "action": "close" })).await;
}

#[tokio::test]
async fn a_watching_panel_gets_a_throttled_live_view_and_a_closed_one_gets_none() {
    if !browser_or_skip("live-view") {
        return;
    }
    let _g = GATE.lock().await;
    install_sink();
    let app = serve();
    let c = caller("live");
    let frames = || frames_for("live");
    // A page that keeps changing, so the browser keeps producing frames.
    session::set_activity_watched(true);
    act(&c, json!({ "action": "open", "url": app.url("/") })).await;
    act(&c, json!({ "action": "evaluate", "expression": "setInterval(() => { document.title = 'tick ' + Date.now(); document.body.style.background = '#' + (Date.now() % 4096).toString(16).padStart(3, '0') }, 30), 1" })).await;
    wait_until("live frames", 15, || frames().len() >= 3).await;
    let first = frames();
    for f in &first {
        let s = f.screenshot.as_deref().unwrap_or_default();
        assert!(s.starts_with("data:image/jpeg;base64,") && s.len() <= session::MAX_FRAME_CHARS + 30, "{}", s.len());
        assert_eq!(f.session_id, "sess-live");
    }
    // Throttled: over the time it took, never more than four a second (plus one).
    tokio::time::sleep(Duration::from_millis(2000)).await;
    let n = frames().len();
    assert!(n <= 4 * 12 + 1, "{n} frames");
    // Nobody watching: the browser is told to stop and no more frames arrive.
    session::set_activity_watched(false);
    tokio::time::sleep(Duration::from_millis(700)).await;
    let after_stop = frames().len();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(frames().len(), after_stop, "frames kept coming with no panel watching");
    // A panel that appears later gets the view of the browser already open. It
    // asks from a plain thread, as the desktop's synchronous command does.
    std::thread::spawn(|| session::set_activity_watched(true)).join().unwrap();
    wait_until("frames again", 15, || frames().len() > after_stop).await;
    // Tabs are listed in the notices once there is more than one.
    act(&c, json!({ "action": "tab", "op": "new", "url": app.url("/next") })).await;
    wait_until("a notice listing two tabs", 10, || activity_for("live").iter().any(|a| a.tabs.len() == 2)).await;
    let listed = activity_for("live").into_iter().rev().find(|a| a.tabs.len() == 2).unwrap();
    assert!(listed.tabs.iter().any(|t| t.id == "t2" && t.active), "{:?}", listed.tabs);
    act(&c, json!({ "action": "close" })).await;
    session::set_activity_watched(true);
}

#[tokio::test]
async fn closing_by_conversation_id_ends_a_desktop_style_session() {
    if !browser_or_skip("close-for") {
        return;
    }
    let _g = GATE.lock().await;
    let app = serve();
    // The desktop keys a browser by its thread: no run id, the thread as session.
    let c = Caller { key: "thread-9".into(), session: "thread-9".into(), run: String::new() };
    act(&c, json!({ "action": "open", "url": app.url("/") })).await;
    assert!(session::is_open("thread-9"));
    assert_eq!(session::close_for("some-other-thread"), 0);
    assert!(session::is_open("thread-9"), "another conversation's close does not reach it");
    assert_eq!(session::close_for("thread-9"), 1);
    assert!(!session::is_open("thread-9"));
    wait_until("no browser process left", 15, || browser_processes_using("flint-browser-") == 0).await;
}
