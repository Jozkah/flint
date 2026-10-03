//! One verification run: launch, confine, drive, collect, clean up.
//!
//! The run ends -- browser killed, profile deleted -- on whichever comes
//! first: the last step, a failed step, cancellation, the run's deadline, the
//! browser exiting, the app server no longer answering, or a main-frame
//! navigation off the allowed origin.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::process::Child;
use tokio::sync::watch;
use url::Url;

use super::cdp::Cdp;
use super::events::{self, Observed};
use super::launch;
use super::*;

const MAX_CONSOLE: usize = 50;
const MAX_BLOCKED: usize = 50;
const MAX_SCREENSHOTS: usize = 5;

/// What the event loop saw, shared with the step driver.
#[derive(Default)]
struct Seen {
    console: Vec<ConsoleEntry>,
    blocked: Vec<BlockedRequest>,
    document_status: Option<u16>,
    final_url: Option<String>,
    /// Why the run must stop now, if it must.
    stop: Option<String>,
}

fn clip(text: &str) -> String {
    events::clip(text)
}

/// Record what the shared event loop reports the way a verify run keeps it:
/// console errors (not warnings or logs), blocked requests, the document's
/// status, and a stop reason for an off-origin navigation or a gone page.
fn record(seen: &Arc<Mutex<Seen>>, observed: Observed) {
    let Ok(mut s) = seen.lock() else { return };
    match observed {
        Observed::Blocked { url, resource_type, navigation } => {
            if s.blocked.len() < MAX_BLOCKED {
                s.blocked.push(BlockedRequest { url: url.clone(), resource_type, navigation });
            }
            if navigation && s.stop.is_none() {
                s.stop = Some(format!(
                    "The page tried to navigate to {url}, outside the allowed origin; the run was stopped."
                ));
            }
        }
        Observed::Console { level, text } => {
            if (level == "error" || level == "assert") && s.console.len() < MAX_CONSOLE {
                s.console.push(ConsoleEntry { kind: "error".into(), text });
            }
        }
        Observed::Exception { text } => {
            if s.console.len() < MAX_CONSOLE {
                s.console.push(ConsoleEntry { kind: "exception".into(), text });
            }
        }
        Observed::Log { level, text, url } => {
            if level == "error" && s.console.len() < MAX_CONSOLE {
                let line = if url.is_empty() { text } else { format!("{text} ({url})") };
                s.console.push(ConsoleEntry { kind: "log".into(), text: clip(&line) });
            }
        }
        Observed::Document { status, url } => {
            s.document_status = Some(status);
            s.final_url = Some(url);
        }
        Observed::PageGone(why) => {
            s.stop.get_or_insert(why);
        }
        Observed::BrowserExited => {
            s.stop.get_or_insert_with(|| "The browser exited.".to_string());
        }
        // A verify run neither answers dialogs nor tracks tabs.
        _ => {}
    }
}

/// Why the run must stop, checked between and during steps.
struct Guard {
    cancel: watch::Receiver<bool>,
    deadline: Instant,
    seen: Arc<Mutex<Seen>>,
    app_down: Arc<Mutex<Option<String>>>,
}

enum Halt {
    Cancelled,
    Stopped(String),
}

impl Guard {
    fn check(&self) -> Result<(), Halt> {
        if *self.cancel.borrow() {
            return Err(Halt::Cancelled);
        }
        if let Some(why) = self.seen.lock().ok().and_then(|s| s.stop.clone()) {
            return Err(Halt::Stopped(why));
        }
        if let Some(why) = self.app_down.lock().ok().and_then(|s| s.clone()) {
            return Err(Halt::Stopped(why));
        }
        if Instant::now() >= self.deadline {
            return Err(Halt::Stopped("The run reached its time limit.".to_string()));
        }
        Ok(())
    }

    async fn sleep(&self, ms: u64) -> Result<(), Halt> {
        let until = Instant::now() + Duration::from_millis(ms);
        while Instant::now() < until {
            self.check()?;
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        self.check()
    }
}

struct Page<'a> {
    cdp: &'a Cdp,
    session: &'a str,
    guard: &'a Guard,
}

enum StepError {
    Halt(Halt),
    Failed(String),
}

impl From<Halt> for StepError {
    fn from(h: Halt) -> Self {
        StepError::Halt(h)
    }
}

impl Page<'_> {
    async fn call(&self, method: &str, params: Value) -> Result<Value, StepError> {
        self.guard.check()?;
        match tokio::time::timeout(
            Duration::from_millis(STEP_TIMEOUT_MS),
            self.cdp.call(method, params, Some(self.session)),
        )
        .await
        {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) => {
                // A closed browser is the guard's to report, with its reason.
                self.guard.check()?;
                Err(StepError::Failed(e))
            }
            Err(_) => Err(StepError::Failed(format!("{method} did not answer in time"))),
        }
    }

    async fn eval(&self, expression: &str) -> Result<Value, StepError> {
        let r = self
            .call(
                "Runtime.evaluate",
                json!({ "expression": expression, "returnByValue": true, "awaitPromise": true }),
            )
            .await?;
        if let Some(ex) = r.get("exceptionDetails") {
            return Err(StepError::Failed(clip(
                ex["exception"]["description"].as_str().or(ex["text"].as_str()).unwrap_or("script error"),
            )));
        }
        Ok(r["result"]["value"].clone())
    }

    /// Until the document has loaded, then a short settle for what it starts.
    async fn wait_ready(&self, until: Instant) -> Result<(), StepError> {
        loop {
            if let Ok(v) = self.eval("document.readyState").await {
                if v.as_str() == Some("complete") {
                    break;
                }
            }
            if Instant::now() >= until {
                return Err(StepError::Failed("the page did not finish loading".into()));
            }
            self.guard.sleep(100).await?;
        }
        self.guard.sleep(300).await?;
        Ok(())
    }

    /// Poll a finder script until it returns an object, or time runs out.
    async fn find(&self, script: &str, until: Instant) -> Result<Value, StepError> {
        loop {
            let v = self.eval(script).await?;
            if v.is_object() {
                return Ok(v);
            }
            if Instant::now() >= until {
                return Ok(Value::Null);
            }
            self.guard.sleep(150).await?;
        }
    }

    async fn screenshot(&self) -> Result<String, StepError> {
        let r = self
            .call("Page.captureScreenshot", json!({ "format": "png", "captureBeyondViewport": false }))
            .await?;
        r["data"].as_str().map(str::to_string).ok_or(StepError::Failed("no image".into()))
    }
}

fn finder_click(target: &str) -> String {
    let t = serde_json::to_string(target).unwrap_or_default();
    format!(
        r#"(() => {{
  const t = {t};
  let el = null;
  if (t.startsWith('css:')) {{ el = document.querySelector(t.slice(4)); }}
  else {{
    const want = t.trim().toLowerCase();
    const text = (e) => (e.innerText || e.value || e.getAttribute('aria-label') || e.title || '').trim().toLowerCase();
    const all = [...document.querySelectorAll('button, a, [role=button], [role=link], [role=tab], [role=menuitem], input[type=submit], input[type=button], summary, label, [onclick]')]
      .filter((e) => e.getClientRects().length > 0);
    el = all.find((e) => text(e) === want) || all.find((e) => text(e).includes(want));
  }}
  if (!el) return null;
  el.scrollIntoView({{ block: 'center', inline: 'center' }});
  const r = el.getBoundingClientRect();
  return {{ x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName.toLowerCase() }};
}})()"#
    )
}

fn finder_field(target: &str) -> String {
    let t = serde_json::to_string(target).unwrap_or_default();
    format!(
        r#"(() => {{
  const t = {t};
  let el = null;
  if (t.startsWith('css:')) {{ el = document.querySelector(t.slice(4)); }}
  else {{
    const want = t.trim().toLowerCase();
    const fields = [...document.querySelectorAll('input, textarea, [contenteditable=true]')].filter((e) => e.getClientRects().length > 0);
    const label = (e) => {{
      const byFor = e.id ? document.querySelector('label[for="' + CSS.escape(e.id) + '"]') : null;
      return [e.getAttribute('placeholder'), e.getAttribute('aria-label'), e.getAttribute('name'), (byFor || e.closest('label'))?.innerText]
        .filter(Boolean).map((s) => s.trim().toLowerCase());
    }};
    el = fields.find((e) => label(e).includes(want)) || fields.find((e) => label(e).some((l) => l.includes(want)));
  }}
  if (!el) return null;
  el.scrollIntoView({{ block: 'center' }});
  el.focus();
  if (typeof el.select === 'function') el.select();
  return {{ tag: el.tagName.toLowerCase() }};
}})()"#
    )
}

async fn run_step(
    page: &Page<'_>,
    base: &Url,
    policy: &OriginPolicy,
    step: &Step,
    index: usize,
    shots: &mut Vec<Screenshot>,
) -> Result<String, StepError> {
    let until = Instant::now() + Duration::from_millis(STEP_TIMEOUT_MS);
    match step {
        Step::Navigate { url } => {
            let target = base.join(url).map_err(|e| StepError::Failed(format!("not a URL: {e}")))?;
            if !policy.permits(target.as_str()) {
                return Err(StepError::Failed(format!(
                    "{} is outside the allowed origin",
                    display_url(target.as_str())
                )));
            }
            let r = page.call("Page.navigate", json!({ "url": target.as_str() })).await?;
            if let Some(err) = r["errorText"].as_str().filter(|e| !e.is_empty()) {
                page.guard.check()?;
                return Err(StepError::Failed(format!("navigation failed: {err}")));
            }
            page.wait_ready(until).await?;
            Ok(format!("Loaded {}", display_url(target.as_str())))
        }
        Step::Click { target } => {
            let found = page.find(&finder_click(target), until).await?;
            let (Some(x), Some(y)) = (found["x"].as_f64(), found["y"].as_f64()) else {
                return Err(StepError::Failed(format!("nothing to click matches \"{target}\"")));
            };
            for kind in ["mouseMoved", "mousePressed", "mouseReleased"] {
                page.call(
                    "Input.dispatchMouseEvent",
                    json!({ "type": kind, "x": x, "y": y, "button": "left", "clickCount": 1 }),
                )
                .await?;
            }
            page.guard.sleep(250).await?;
            page.wait_ready(until).await?;
            Ok(format!("Clicked a <{}>", found["tag"].as_str().unwrap_or("element")))
        }
        Step::Type { target, text } => {
            let found = page.find(&finder_field(target), until).await?;
            if !found.is_object() {
                return Err(StepError::Failed(format!("no field matches \"{target}\"")));
            }
            page.call("Input.insertText", json!({ "text": text })).await?;
            // The typed text is not echoed: it may be a password.
            Ok(format!("Typed into a <{}>", found["tag"].as_str().unwrap_or("field")))
        }
        Step::Expect { text } => {
            let t = serde_json::to_string(text).unwrap_or_default();
            let script = format!(
                "(document.body && document.body.innerText.includes({t})) ? {{ ok: true }} : null"
            );
            if page.find(&script, until).await?.is_object() {
                Ok("Found on the page".to_string())
            } else {
                Err(StepError::Failed(format!("the page does not show \"{text}\"")))
            }
        }
        Step::Wait { ms } => {
            page.guard.sleep((*ms).min(MAX_WAIT_MS)).await?;
            Ok(String::new())
        }
        Step::Screenshot => {
            let png = page.screenshot().await?;
            if shots.len() < MAX_SCREENSHOTS {
                shots.push(Screenshot { step: Some(index), png_base64: png });
            }
            Ok("Captured".to_string())
        }
    }
}

/// Run one verification. `progress` sees every step as it changes.
pub async fn run(
    req: VerifyRequest,
    browser: BrowserInfo,
    cancel: watch::Receiver<bool>,
    progress: impl Fn(&StepRecord) + Send + Sync,
) -> VerifyReport {
    let started = Instant::now();
    let timeout = req.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).clamp(5_000, MAX_TIMEOUT_MS);
    let mut report = VerifyReport {
        id: req.id.clone(),
        url: display_url(&req.url),
        origin: String::new(),
        outcome: Outcome::Error,
        reason: String::new(),
        steps: Vec::new(),
        screenshots: Vec::new(),
        console_errors: Vec::new(),
        blocked_requests: Vec::new(),
        document_status: None,
        final_url: None,
        browser: browser.name.clone(),
        started_at: chrono::Utc::now().to_rfc3339(),
        duration_ms: 0,
        profile_removed: true,
    };
    let fail = |mut r: VerifyReport, why: String| {
        r.reason = why;
        r.duration_ms = started.elapsed().as_millis() as u64;
        r
    };

    // 1. Only a local app, only a bounded plan, only an installed browser.
    let (base, origin) = match local_origin(&req.url) {
        Ok(v) => v,
        Err(e) => return fail(report, e),
    };
    report.origin = origin.serialize();
    let policy = match OriginPolicy::new(origin.clone(), &req.extra_origins) {
        Ok(p) => p,
        Err(e) => return fail(report, format!("extra origin refused: {e}")),
    };
    if req.steps.len() > MAX_STEPS {
        return fail(report, format!("at most {MAX_STEPS} steps can run at once"));
    }
    // The plan always starts at the app's URL.
    let mut steps = req.steps.clone();
    if !matches!(steps.first(), Some(Step::Navigate { .. })) {
        steps.insert(0, Step::Navigate { url: base.to_string() });
    }
    report.steps = steps
        .iter()
        .enumerate()
        .map(|(index, s)| StepRecord {
            index,
            label: s.label(),
            status: StepStatus::Pending,
            detail: None,
            duration_ms: 0,
        })
        .collect();
    let Some(browser_path) = browser.path.clone().filter(|_| browser.found) else {
        return fail(report, browser.hint.unwrap_or_else(|| "No browser was found.".into()));
    };
    if !launch::port_open(&origin).await {
        return fail(
            report,
            format!("Nothing is answering at {}. Start the app, then verify.", origin.serialize()),
        );
    }
    if *cancel.borrow() {
        report.outcome = Outcome::Cancelled;
        return fail(report, "Cancelled before the browser started.".into());
    }

    // 2. A throwaway profile and a confined browser.
    let launch::Spawned { mut child, profile } =
        match launch::spawn(&browser_path, "flint-verify-", &policy) {
            Ok(v) => v,
            Err(e) => return fail(report, e),
        };

    let seen = Arc::new(Mutex::new(Seen::default()));
    let app_down: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let guard = Guard {
        cancel: cancel.clone(),
        deadline: started + Duration::from_millis(timeout),
        seen: seen.clone(),
        app_down: app_down.clone(),
    };

    let outcome = drive(
        &mut child,
        &guard,
        &policy,
        &base,
        &origin,
        &steps,
        &mut report,
        seen.clone(),
        app_down.clone(),
        &progress,
    )
    .await;

    // 3. Always: close the browser (the whole tree), then delete its profile.
    launch::kill(&mut child).await;
    report.profile_removed = profile.remove().await;

    if let Ok(s) = seen.lock() {
        report.console_errors = s.console.clone();
        report.blocked_requests = s.blocked.clone();
        report.document_status = s.document_status;
        report.final_url = s.final_url.clone();
    }
    let (outcome, reason) = outcome;
    report.outcome = outcome;
    report.reason = reason;
    if report.outcome == Outcome::Passed {
        if let Some(status) = report.document_status.filter(|s| *s >= 400) {
            report.outcome = Outcome::Failed;
            report.reason = format!("The page answered HTTP {status}.");
        } else if req.fail_on_console_error.unwrap_or(true) && !report.console_errors.is_empty() {
            report.outcome = Outcome::Failed;
            report.reason = format!(
                "Every step passed, but the page reported {} console error(s).",
                report.console_errors.len()
            );
        }
    }
    report.duration_ms = started.elapsed().as_millis() as u64;
    report
}

#[allow(clippy::too_many_arguments)]
async fn drive(
    child: &mut Child,
    guard: &Guard,
    policy: &OriginPolicy,
    base: &Url,
    origin: &Origin,
    steps: &[Step],
    report: &mut VerifyReport,
    seen: Arc<Mutex<Seen>>,
    app_down: Arc<Mutex<Option<String>>>,
    progress: &(impl Fn(&StepRecord) + Send + Sync),
) -> (Outcome, String) {
    let halt = |h: Halt| match h {
        Halt::Cancelled => (Outcome::Cancelled, "Cancelled.".to_string()),
        Halt::Stopped(why) => (Outcome::Failed, why),
    };
    let (cdp, events) = match tokio::select! {
        r = launch::connect(child) => r,
        _ = wait_cancel(guard.cancel.clone()) => return halt(Halt::Cancelled),
    } {
        Ok(v) => v,
        Err(e) => return (Outcome::Error, e),
    };

    // A tab of our own, confined before it loads anything.
    let (main_frame, session) = match launch::open_confined_tab(&cdp).await {
        Ok(v) => v,
        Err(e) => return (Outcome::Error, e),
    };
    let sink_seen = seen.clone();
    let events_task = events::spawn(
        cdp.clone(),
        events,
        policy.clone(),
        session.clone(),
        main_frame.clone(),
        events::NavigationBlock::Fail,
        move |observed| record(&sink_seen, observed),
    );
    if let Err(e) = launch::enable_tab(&cdp, &session).await {
        events_task.abort();
        return (Outcome::Error, e);
    }

    // The app server, watched while the run goes.
    let watch_origin = origin.clone();
    let watchdog = tokio::spawn(async move {
        let mut misses = 0;
        loop {
            tokio::time::sleep(Duration::from_millis(1000)).await;
            if launch::port_open(&watch_origin).await {
                misses = 0;
            } else {
                misses += 1;
                if misses >= 2 {
                    if let Ok(mut d) = app_down.lock() {
                        *d = Some(format!(
                            "The app at {} stopped answering; the run was stopped.",
                            watch_origin.serialize()
                        ));
                    }
                    break;
                }
            }
        }
    });

    let page = Page { cdp: &cdp, session: &session, guard };
    let mut result = (Outcome::Passed, "Every step passed.".to_string());
    for (i, step) in steps.iter().enumerate() {
        report.steps[i].status = StepStatus::Running;
        progress(&report.steps[i]);
        let t0 = Instant::now();
        let r = run_step(&page, base, policy, step, i, &mut report.screenshots).await;
        report.steps[i].duration_ms = t0.elapsed().as_millis() as u64;
        match r {
            Ok(detail) => {
                report.steps[i].status = StepStatus::Passed;
                report.steps[i].detail = (!detail.is_empty()).then_some(detail);
                progress(&report.steps[i]);
            }
            Err(e) => {
                let (outcome, why, detail) = match e {
                    StepError::Failed(d) => (Outcome::Failed, format!("Step {} failed: {d}.", i + 1), d),
                    StepError::Halt(h) => {
                        let (o, w) = halt(h);
                        (o, w.clone(), w)
                    }
                };
                report.steps[i].status = StepStatus::Failed;
                report.steps[i].detail = Some(detail);
                progress(&report.steps[i]);
                for later in report.steps.iter_mut().skip(i + 1) {
                    later.status = StepStatus::Skipped;
                    progress(later);
                }
                result = (outcome, why);
                break;
            }
        }
        if let Err(h) = guard.check() {
            result = halt(h);
            for later in report.steps.iter_mut().skip(i + 1) {
                later.status = StepStatus::Skipped;
            }
            break;
        }
    }
    // The final state, while the page is still there (not after a cancel).
    if result.0 != Outcome::Cancelled {
        if let Ok(Ok(v)) = tokio::time::timeout(
            Duration::from_secs(5),
            cdp.call("Page.captureScreenshot", json!({ "format": "png" }), Some(&session)),
        )
        .await
        {
            if let Some(png) = v["data"].as_str() {
                report.screenshots.push(Screenshot { step: None, png_base64: png.to_string() });
            }
        }
    }
    watchdog.abort();
    cdp.fire("Browser.close", json!({}), None);
    // Let the event loop record the page's last events.
    tokio::time::sleep(Duration::from_millis(100)).await;
    events_task.abort();
    result
}

async fn wait_cancel(mut rx: watch::Receiver<bool>) {
    loop {
        if *rx.borrow() {
            return;
        }
        if rx.changed().await.is_err() {
            // Sender gone: never cancelled.
            std::future::pending::<()>().await;
        }
    }
}

#[cfg(test)]
mod tests {
    //! These drive a real browser against a real local server. They run when
    //! a Chromium-based browser is installed (or `FLINT_BROWSER_PATH` names
    //! one) and are skipped, saying so, otherwise.
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct Server {
        port: u16,
        stop: Arc<AtomicBool>,
        /// Every request line and its headers, as received.
        requests: Arc<Mutex<Vec<String>>>,
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
        }
    }

    /// A tiny app: `/` with a button to `/next`, a subresource on another
    /// loopback port and a fetch to the internet (both to be blocked), `/redir`
    /// redirecting off the origin, `/err` logging a console error.
    fn serve(other_port: u16) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let log = requests.clone();
        std::thread::spawn(move || {
            while !flag.load(Ordering::SeqCst) {
                let Ok((mut s, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(20));
                    continue;
                };
                let _ = s.set_nonblocking(false);
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                log.lock().unwrap().push(req.to_string());
                let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                let (status, extra, body) = match path.as_str() {
                    "/" => ("200 OK", String::new(), format!(
                        "<html><body><h1>Home</h1><img src='http://127.0.0.1:{other_port}/pixel.png'>\
                         <button onclick=\"location.href='/next'\">Go on</button>\
                         <input placeholder='Your name'>\
                         <script>fetch('http://example.com/track').catch(()=>{{}})</script></body></html>")),
                    "/next" => ("200 OK", String::new(), "<html><body><h1>Welcome back</h1></body></html>".into()),
                    "/redir" => ("302 Found", format!("Location: http://127.0.0.1:{other_port}/\r\n"), String::new()),
                    "/err" => ("200 OK", String::new(), "<html><body>x<script>console.error('boom')</script></body></html>".into()),
                    "/slow" => ("200 OK", String::new(), "<html><body>slow</body></html>".into()),
                    // One socket to this origin (the control), one to another
                    // loopback port, which must never be reached.
                    "/ws" => ("200 OK", String::new(), format!(
                        "<html><body>ws<script>\
                         try {{ new WebSocket('ws://127.0.0.1:' + location.port + '/same-origin-socket') }} catch (e) {{}}\
                         try {{ new WebSocket('ws://127.0.0.1:{other_port}/off-origin-socket') }} catch (e) {{}}\
                         </script></body></html>")),
                    _ => ("404 Not Found", String::new(), "nope".into()),
                };
                let _ = write!(
                    s,
                    "HTTP/1.1 {status}\r\nContent-Type: text/html\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        Server { port, stop, requests }
    }

    fn browser_or_skip() -> Option<BrowserInfo> {
        let b = find_browser();
        if !b.found {
            eprintln!("skipped: no Chromium-based browser installed (set FLINT_BROWSER_PATH)");
            return None;
        }
        Some(b)
    }

    fn request(port: u16, path: &str, steps: Vec<Step>) -> VerifyRequest {
        VerifyRequest {
            id: "t".into(),
            url: format!("http://127.0.0.1:{port}{path}"),
            steps,
            timeout_ms: Some(60_000),
            fail_on_console_error: None,
            extra_origins: vec![],
        }
    }

    fn never() -> watch::Receiver<bool> {
        let (tx, rx) = watch::channel(false);
        std::mem::forget(tx);
        rx
    }

    #[tokio::test]
    async fn a_clicked_flow_passes_with_evidence_and_offsite_requests_blocked() {
        let Some(browser) = browser_or_skip() else { return };
        let other = TcpListener::bind("127.0.0.1:0").unwrap();
        let other_port = other.local_addr().unwrap().port();
        let app = serve(other_port);
        let seen_steps = Arc::new(Mutex::new(Vec::new()));
        let sink = seen_steps.clone();
        let report = run(
            request(app.port, "/", vec![
                Step::Type { target: "Your name".into(), text: "Ada".into() },
                Step::Click { target: "Go on".into() },
                Step::Expect { text: "Welcome back".into() },
            ]),
            browser,
            never(),
            move |s| sink.lock().unwrap().push((s.index, s.status)),
        )
        .await;
        assert_eq!(report.outcome, Outcome::Passed, "{report:#?}");
        assert_eq!(report.steps.len(), 4, "the app URL is opened first");
        assert!(report.steps.iter().all(|s| s.status == StepStatus::Passed));
        assert_eq!(report.document_status, Some(200));
        assert!(report.final_url.as_deref().unwrap_or("").ends_with("/next"));
        assert!(!report.screenshots.is_empty());
        assert!(report.profile_removed);
        let blocked: Vec<_> = report.blocked_requests.iter().map(|b| b.url.as_str()).collect();
        assert!(blocked.iter().any(|u| u.contains(&format!(":{other_port}/pixel.png"))), "{blocked:?}");
        assert!(blocked.iter().any(|u| u.contains("example.com")), "{blocked:?}");
        assert!(report.blocked_requests.iter().all(|b| !b.navigation));
        // Progress was reported as the steps ran.
        assert!(seen_steps.lock().unwrap().contains(&(2, StepStatus::Passed)));
    }

    /// Exact-origin confinement at the network layer. DevTools interception
    /// does not see WebSocket handshakes, and Chromium sends loopback
    /// traffic around a configured proxy by default, so neither of those
    /// alone keeps a page on 127.0.0.1:A from reaching 127.0.0.1:B.
    #[tokio::test]
    async fn an_off_origin_loopback_websocket_never_connects() {
        let Some(browser) = browser_or_skip() else { return };
        let other = TcpListener::bind("127.0.0.1:0").unwrap();
        let other_port = other.local_addr().unwrap().port();
        other.set_nonblocking(true).unwrap();
        let reached = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (count, stop) = (reached.clone(), Arc::new(AtomicBool::new(false)));
        let done = stop.clone();
        std::thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                if other.accept().is_ok() {
                    count.fetch_add(1, Ordering::SeqCst);
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        let app = serve(other_port);
        let report = run(request(app.port, "/ws", vec![Step::Wait { ms: 2_000 }]), browser, never(), |_| {}).await;
        stop.store(true, Ordering::SeqCst);
        // The control: the page did open a socket, to its own origin.
        let seen = app.requests.lock().unwrap().join("\n").to_ascii_lowercase();
        assert!(
            seen.contains("get /same-origin-socket") && seen.contains("upgrade: websocket"),
            "the page never tried a WebSocket, so the test proves nothing: {seen}"
        );
        assert_eq!(
            reached.load(Ordering::SeqCst),
            0,
            "a WebSocket reached another loopback port: {report:#?}"
        );
    }

    #[tokio::test]
    async fn a_redirect_off_the_origin_stops_the_run() {
        let Some(browser) = browser_or_skip() else { return };
        let other = TcpListener::bind("127.0.0.1:0").unwrap();
        let app = serve(other.local_addr().unwrap().port());
        let report = run(request(app.port, "/redir", vec![]), browser, never(), |_| {}).await;
        assert_eq!(report.outcome, Outcome::Failed, "{report:#?}");
        assert!(report.blocked_requests.iter().any(|b| b.navigation), "{report:#?}");
    }

    #[tokio::test]
    async fn a_console_error_fails_an_otherwise_passing_run() {
        let Some(browser) = browser_or_skip() else { return };
        let app = serve(9);
        let report = run(request(app.port, "/err", vec![]), browser, never(), |_| {}).await;
        assert_eq!(report.outcome, Outcome::Failed, "{report:#?}");
        assert!(report.console_errors.iter().any(|c| c.text.contains("boom")));
        assert!(report.reason.contains("console error"));
    }

    #[tokio::test]
    async fn cancelling_stops_the_browser_and_removes_its_profile() {
        let Some(browser) = browser_or_skip() else { return };
        let app = serve(9);
        let (tx, rx) = watch::channel(false);
        let t0 = Instant::now();
        let handle = tokio::spawn(run(
            request(app.port, "/slow", vec![Step::Wait { ms: 10_000 }]),
            browser,
            rx,
            |_| {},
        ));
        tokio::time::sleep(Duration::from_millis(2500)).await;
        tx.send(true).unwrap();
        let report = handle.await.unwrap();
        assert_eq!(report.outcome, Outcome::Cancelled, "{report:#?}");
        assert!(t0.elapsed() < Duration::from_secs(9));
        assert!(report.profile_removed);
    }

    #[tokio::test]
    async fn the_app_server_going_away_stops_the_run() {
        let Some(browser) = browser_or_skip() else { return };
        let app = serve(9);
        let port = app.port;
        let handle = tokio::spawn(run(request(port, "/slow", vec![Step::Wait { ms: 10_000 }]), browser, never(), |_| {}));
        tokio::time::sleep(Duration::from_millis(2500)).await;
        drop(app);
        let report = handle.await.unwrap();
        assert_eq!(report.outcome, Outcome::Failed, "{report:#?}");
        assert!(report.reason.contains("stopped answering"), "{}", report.reason);
    }

    #[tokio::test]
    async fn nothing_listening_fails_before_any_browser_starts() {
        let fake = BrowserInfo { found: true, path: Some("/nonexistent/browser".into()), name: None, hint: None };
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let report = run(request(port, "/", vec![]), fake, never(), |_| {}).await;
        assert_eq!(report.outcome, Outcome::Error);
        assert!(report.reason.contains("Nothing is answering"));
    }

    #[tokio::test]
    async fn a_remote_url_is_refused_and_a_missing_browser_explained() {
        let none = BrowserInfo { found: false, path: None, name: None, hint: Some("install one".into()) };
        let r = run(request(1, "/", vec![]), none.clone(), never(), |_| {}).await;
        assert_eq!(r.outcome, Outcome::Error);
        assert_eq!(r.reason, "install one");
        let mut remote = request(1, "/", vec![]);
        remote.url = "https://example.com".into();
        let r = run(remote, none, never(), |_| {}).await;
        assert!(r.reason.contains("not a local address"));
    }
}
