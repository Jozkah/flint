//! Real-Tauri UI smoke harness.
//!
//! This binary launches the *actual* application produced by
//! [`app_lib::build_app`] -- the same plugins, the same invoke handler, the same
//! managed state, the same generated context and therefore the same bundled
//! frontend -- and drives it through the real WebView. Cowork panels talk to the
//! backend over Tauri IPC, so a browser-only preview cannot exercise them; this
//! harness exists precisely to close that gap.
//!
//! Isolation: the harness sets `CI=e2e` and changes into a throwaway working
//! directory before building the app, which routes `get_jan_data_folder_path`
//! at `<temp>/data` instead of the developer's real Jan data folder. The temp
//! tree is removed on the way out.
//!
//! Fixtures resolve from `CARGO_MANIFEST_DIR` (baked in at compile time) or from
//! an explicit `--fixtures <dir>` argument. The session working directory is
//! never consulted.
//!
//! Exit code is non-zero if any scenario fails.

use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Listener, LogicalSize, Manager, WebviewWindow};

/// Compile-time crate root. Fixtures live under this, never under the CWD.
const MANIFEST_DIR: &str = env!("CARGO_MANIFEST_DIR");

static EVAL_SEQ: AtomicU64 = AtomicU64::new(0);

/// A provider name deliberately absent from `predefinedProviders`, so it counts
/// as a custom endpoint and needs no credential to be usable.
const SMOKE_PROVIDER: &str = "cowork-smoke-mock";
/// The single-label hostname the provider is configured at, exactly as a user
/// would type it. It is never rewritten to an address.
const SMOKE_ENDPOINT_HOST: &str = "v100";
/// The port the provider is configured at. `COWORK_SMOKE_PORT` moves it, so
/// two harness runs on one machine never share -- and re-script -- one
/// fixture server.
fn smoke_port() -> u16 {
    std::env::var("COWORK_SMOKE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080)
}
/// A documentation-range address standing in for the public answer a search
/// domain collision produces. Reaching it would hang; the point is that it is
/// never dialled.
const SMOKE_PUBLIC_DECOY: &str = "203.0.113.9";
const SMOKE_MODEL: &str = "smoke-model";
/// `AppHandle::exit` unwinds the event loop but does not set this process's
/// status, so the verdict is stashed here and applied once `run_app` returns.
static VERDICT: AtomicI32 = AtomicI32::new(2);
/// Set when `COWORK_SMOKE_KEEP` named a profile an earlier run left behind:
/// this process is the same install started again, so its state is inherited
/// on purpose and the restart scenarios run instead of the fresh-profile ones.
static RESUMED: AtomicBool = AtomicBool::new(false);
/// The fixture server, reachable from the watchdog so an aborted run never
/// leaves it behind.
static MOCK: std::sync::Mutex<Option<std::process::Child>> = std::sync::Mutex::new(None);
/// What the driver is waiting on right now, for the watchdog's report.
static LAST_STEP: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

/// The real-provider lane (`COWORK_SMOKE_REAL_BASE_URL`): base URL and model.
static LANE: std::sync::OnceLock<(String, String)> = std::sync::OnceLock::new();
/// The lane's ephemeral key: 32 random bytes made in this process, written
/// only into the isolated profile, never printed, passed or exported.
static LANE_KEY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
/// Every host the app's transport resolved during a lane run.
static LOOKED_UP: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
const LANE_PROVIDER: &str = "v100-lane";

fn note_step(step: &str) {
    if let Ok(mut last) = LAST_STEP.lock() {
        *last = step.chars().take(160).collect();
    }
}

fn kill_mock() {
    if let Ok(mut mock) = MOCK.lock() {
        if let Some(mut child) = mock.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
/// The MCP server entries the harness seeds, by name.
const SMOKE_MCP_USER_SERVER: &str = "smoke-user-server";
const SMOKE_MCP_WEB_SEARCH: &str = "smoke-web-search";

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/// Everything a scenario needs: the live window plus the fixture workspace.
struct Ctx {
    window: WebviewWindow,
    /// Read-only fixture source tree.
    #[allow(dead_code)]
    fixtures: PathBuf,
    /// Writable per-run workspace (projects are attached from here).
    #[allow(dead_code)]
    workspace: PathBuf,
    /// The materialised fixture project inside `workspace`.
    project: PathBuf,
    /// Port of the deterministic model fixture.
    mock_port: u16,
}

#[derive(Debug)]
struct Failure(String);

type ScenarioResult = Result<(), Failure>;

macro_rules! bail {
    ($($arg:tt)*) => {
        return Err(Failure(format!($($arg)*)))
    };
}

macro_rules! ensure {
    ($cond:expr, $($arg:tt)*) => {
        if !($cond) {
            return Err(Failure(format!($($arg)*)));
        }
    };
}

impl Ctx {
    /// Evaluate JavaScript in the real WebView and return its value.
    ///
    /// The script body is wrapped in an async IIFE; its resolved value is sent
    /// back over the Tauri event bus, which is the supported round trip
    /// (`WebviewWindow::eval` itself is fire-and-forget). A thrown error is
    /// reported as a scenario failure rather than a hang.
    fn eval(&self, js: &str) -> Result<Value, Failure> {
        // The WebView stalls for seconds at a time while it highlights a large
        // file or rescans the project tree, and a stall is not a failure.
        self.eval_with_timeout(js, Duration::from_secs(60))
    }

    fn eval_with_timeout(&self, js: &str, timeout: Duration) -> Result<Value, Failure> {
        let id = EVAL_SEQ.fetch_add(1, Ordering::SeqCst);
        let channel = format!("cowork-smoke-eval-{id}");
        let (tx, rx) = mpsc::channel::<String>();
        let handler_id = self.window.listen(channel.clone(), move |event| {
            let _ = tx.send(event.payload().to_string());
        });

        // `payload` is emitted as a JSON string so the value survives the event
        // bus regardless of shape; the Rust side unwraps one level below.
        //
        // The body is compiled inside the `try`, from a string, rather than
        // pasted into this script: a body that does not parse used to make
        // the whole script fail to parse, so nothing ran, nothing replied, and
        // a typo read exactly like a page that had stopped answering.
        let body = serde_json::to_string(js).unwrap_or_else(|_| "\"\"".into());
        let script = format!(
            r#"(async () => {{
  let out;
  try {{
    const AsyncFunction = Object.getPrototypeOf(async function () {{}}).constructor;
    const v = await new AsyncFunction({body})();
    out = {{ ok: v === undefined ? null : v }};
  }} catch (e) {{
    out = {{ err: (e && e.stack) ? String(e.stack) : String(e) }};
  }}
  try {{
    await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {{
      event: {channel:?},
      payload: JSON.stringify(out),
    }});
  }} catch (e) {{
    console.error('cowork-smoke transport failure', e);
  }}
}})();"#
        );

        note_step(&format!("dispatching: {}", js.trim()));
        if let Err(e) = self.window.eval(&script) {
            self.window.unlisten(handler_id);
            bail!("eval dispatch failed: {e}");
        }

        note_step(&format!("awaiting the page: {}", js.trim()));
        let received = rx.recv_timeout(timeout);
        self.window.unlisten(handler_id);

        let raw = match received {
            Ok(raw) => raw,
            Err(_) => {
                // Which side is stuck: a main thread that no longer runs
                // posted work cannot deliver the eval or its reply, while a
                // renderer that stopped running scripts leaves it answering.
                let (tx, rx) = mpsc::channel::<()>();
                let main = match self.window.run_on_main_thread(move || {
                    let _ = tx.send(());
                }) {
                    Ok(()) if rx.recv_timeout(Duration::from_secs(5)).is_ok() => {
                        "the app's main thread is answering; the page is not"
                    }
                    Ok(()) => "the app's main thread is blocked",
                    Err(_) => "the app's main thread could not be asked",
                };
                bail!(
                    "eval timed out after {timeout:?}; {main}; app children at the time: {}; window: {}; script was:\n{js}",
                    app_children(),
                    window_state(&self.window)
                )
            }
        };

        // The event payload is a JSON document containing a JSON string.
        let outer: Value = serde_json::from_str(&raw)
            .map_err(|e| Failure(format!("event payload was not JSON ({e}): {raw}")))?;
        let inner = match outer.as_str() {
            Some(s) => serde_json::from_str::<Value>(s)
                .map_err(|e| Failure(format!("inner payload was not JSON ({e}): {s}")))?,
            None => outer,
        };

        if let Some(err) = inner.get("err").and_then(Value::as_str) {
            bail!("script threw: {err}\nscript was:\n{js}");
        }
        Ok(inner.get("ok").cloned().unwrap_or(Value::Null))
    }

    fn eval_bool(&self, js: &str) -> Result<bool, Failure> {
        Ok(self.eval(js)?.as_bool().unwrap_or(false))
    }

    fn eval_string(&self, js: &str) -> Result<String, Failure> {
        Ok(self
            .eval(js)?
            .as_str()
            .map(str::to_owned)
            .unwrap_or_default())
    }

    /// Click the first element matching `selector` whose text or aria-label
    /// contains `needle` (case-insensitive). Returns the matched label.
    fn click_matching(&self, selector: &str, needle: &str) -> Result<String, Failure> {
        let found = self.eval_string(&format!(
            r#"const needle = {needle:?}.toLowerCase();
               const el = [...document.querySelectorAll({selector:?})].find(e => {{
                 const t = ((e.getAttribute('aria-label') || '') + ' ' + (e.textContent || '')).toLowerCase();
                 return t.includes(needle);
               }});
               if (!el) return '';
               el.scrollIntoView();
               el.click();
               return (el.getAttribute('aria-label') || el.textContent || 'clicked').trim();"#
        ))?;
        if found.is_empty() {
            bail!("no {selector} matching {needle:?} was present");
        }
        Ok(found)
    }

    /// Type into a React-controlled input/textarea using the native value
    /// setter, so React's onChange actually fires.
    fn type_into(&self, selector: &str, text: &str) -> ScenarioResult {
        let ok = self.eval_bool(&format!(
            r#"const el = document.querySelector({selector:?});
               if (!el) return false;
               const proto = el instanceof HTMLTextAreaElement
                 ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
               const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
               el.focus();
               setter.call(el, {text:?});
               el.dispatchEvent(new Event('input', {{ bubbles: true }}));
               return true;"#
        ))?;
        ensure!(ok, "input {selector:?} was not present");
        Ok(())
    }

    /// Navigate the SPA router and wait for the path to settle.
    fn goto(&self, path: &str) -> ScenarioResult {
        let clicked = self.eval_bool(&format!(
            r#"const a = document.querySelector('a[href={path:?}]');
               if (a) {{ a.click(); return true; }}
               return false;"#
        ))?;
        if !clicked {
            // Fall back to the History API for routes with no visible link.
            self.eval_with_timeout(
                &format!(
                    "window.history.pushState({{}}, '', {path:?});
                     window.dispatchEvent(new PopStateEvent('popstate'));
                     return true;"
                ),
                Duration::from_secs(45),
            )?;
        }
        self.wait_until(
            &format!("route {path}"),
            &format!("return window.location.pathname.startsWith({path:?});"),
            Duration::from_secs(15),
        )
    }

    /// Dispatch a script without waiting for a reply.
    ///
    /// Needed for anything that tears the page down -- a reload cannot deliver
    /// its own completion event.
    fn eval_detached(&self, js: &str) -> ScenarioResult {
        self.window
            .eval(js)
            .map_err(|e| Failure(format!("eval dispatch failed: {e}")))
    }

    /// Wait for the app to mount, and prove it started with no inherited state.
    ///
    /// This used to clear `localStorage` and reload the page, because the Cowork
    /// session store is keyed by the bundle identifier and outlived the run --
    /// so a run inherited the previous one's attached folder, a path in a temp
    /// workspace since deleted. Clearing and reloading is the wrong shape of
    /// fix: it depends on the page surviving a reload mid-teardown, and it hung
    /// for ninety seconds waiting for a React root that never remounted.
    ///
    /// The run now gets its own WebView2 user-data folder (see `main`), so the
    /// profile is empty because it is new. There is nothing to clear and no
    /// reload to survive. What is left is worth asserting rather than assuming:
    /// if the isolation ever breaks, this fails immediately and says so,
    /// instead of a later scenario failing against somebody else's session.
    fn reset_persisted_state(&self) -> ScenarioResult {
        self.wait_until(
            "React root to mount",
            "return !!document.querySelector('#root') && document.querySelector('#root').children.length > 0;",
            Duration::from_secs(90),
        )?;
        let leftovers = self.eval(
            "const keys = [];
             try { for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i)); }
             catch (e) { return 'unreadable: ' + e; }
             return keys.filter(k => k && k.startsWith('cowork')).join(',');",
        )?;
        let leftovers = leftovers.as_str().unwrap_or_default().to_string();
        if !leftovers.is_empty() {
            return Err(Failure(format!(
                "the WebView profile was not isolated: it already holds Cowork state ({leftovers}).                  WEBVIEW2_USER_DATA_FOLDER should point at this run's own directory."
            )));
        }
        Ok(())
    }

    /// Wait for the WebView to answer a trivial script again.
    ///
    /// Highlighting a large file or rescanning the project blocks scripts for
    /// tens of seconds; without this, one slow scenario fails every scenario
    /// after it.
    fn settle(&self) {
        for _ in 0..30 {
            std::thread::sleep(Duration::from_secs(1));
            if self
                .eval_with_timeout("return 1;", Duration::from_secs(5))
                .is_ok()
            {
                return;
            }
        }
    }

    /// Get the WebView answering again, reloading it if it will not.
    ///
    /// A scenario that leaves the page unresponsive fails every scenario after
    /// it on a sixty-second timeout evaluating a one-line query, and those
    /// read as defects in whatever ran next. Recovering between scenarios
    /// keeps one wedge from being reported as five failures.
    ///
    /// Returns whether a reload was needed, so the run can say so.
    fn recover(&self) -> bool {
        if self
            .eval_with_timeout("return 1;", Duration::from_secs(5))
            .is_ok()
        {
            return false;
        }
        let _ = self.window.eval("window.location.replace('/')");
        self.settle();
        true
    }

    /// Click a Cowork rail by its exact accessible name.
    /// Open a rail, leaving it open if it already was.
    ///
    /// The toolbar toggles, and a rail now survives leaving and re-entering
    /// the route (that is what keeps a session's view across a trip to
    /// Settings), so a blind click can just as easily close one.
    fn ensure_rail_open(&self, rail: &str, marker: &str) -> ScenarioResult {
        let present = format!("return !!document.querySelector({marker:?});");
        // One click, then give the panel time to render. Clicking again
        // because it had not appeared yet would toggle it straight back shut.
        for _ in 0..2 {
            if self.eval_bool(&present)? {
                return Ok(());
            }
            self.click_rail(rail)?;
            if self
                .wait_until(rail, &present, Duration::from_secs(10))
                .is_ok()
            {
                return Ok(());
            }
        }
        ensure!(self.eval_bool(&present)?, "the {rail} rail did not open");
        Ok(())
    }

    /// Make sure a model is selected before sending.
    ///
    /// A composer with no model selected accepts the text and then silently
    /// does nothing when you press send, so a scenario that skips this waits
    /// out its whole timeout on a reply that was never requested.
    fn ensure_model_selected(&self) -> ScenarioResult {
        let already = self.eval_bool(&format!(
            "return [...document.querySelectorAll('button')].some(b =>
               (b.textContent || '').includes({SMOKE_MODEL:?}));"
        ))?;
        if already {
            return Ok(());
        }
        self.eval(
            "const b = [...document.querySelectorAll('button')].find(x =>
               /select a model/i.test((x.getAttribute('aria-label') || '')
                 + ' ' + (x.textContent || '')));
             if (b) b.click();
             return true;",
        )?;
        self.wait_until(
            "the model picker",
            "return [...document.querySelectorAll('input')].some(i =>
                /search|find|model/i.test(i.getAttribute('placeholder') || ''));",
            Duration::from_secs(20),
        )?;
        self.type_into(
            "input[placeholder*='model' i], input[placeholder*='search' i]",
            "smoke",
        )?;
        std::thread::sleep(Duration::from_millis(800));
        let picked = self.eval_bool(&format!(
            "const el = [...document.querySelectorAll('[role=\"option\"],button,li,div')]
               .filter(e => e.children.length <= 2
                 && (e.textContent || '').trim().includes({SMOKE_MODEL:?}))
               .pop();
             if (!el) return false;
             (el.closest('[role=\"option\"],button,li') || el).click();
             return true;"
        ))?;
        if !picked {
            self.describe("model-picker-open")?;
            bail!("the picker never offered {SMOKE_MODEL}");
        }
        std::thread::sleep(Duration::from_millis(900));
        Ok(())
    }

    fn click_rail(&self, rail: &str) -> ScenarioResult {
        let clicked = self.eval_bool(&format!(
            r#"const el = [...document.querySelectorAll('button')].find(b =>
                 (b.getAttribute('aria-label') || b.textContent || '').trim() === {rail:?});
               if (!el) return false; el.click(); return true;"#
        ))?;
        ensure!(clicked, "rail button {rail:?} was not present");
        std::thread::sleep(Duration::from_millis(900));
        Ok(())
    }

    /// Re-script the model fixture for the scenario about to run.
    ///
    /// Driven from the WebView so the request comes from the same process and
    /// origin as the app's own traffic.
    fn script_model(&self, script: &str, tools: &[&str]) -> ScenarioResult {
        let tools = serde_json::to_string(tools).unwrap_or_else(|_| "[]".into());
        let port = self.mock_port;
        let ok = self.eval_bool(&format!(
            r#"const res = await fetch('http://127.0.0.1:{port}/__control', {{
                 method: 'POST',
                 headers: {{ 'Content-Type': 'application/json' }},
                 body: JSON.stringify({{ script: {script:?}, tools: {tools} }}),
               }});
               return res.ok;"#
        ))?;
        ensure!(ok, "could not re-script the model fixture to {script:?}");
        Ok(())
    }

    /// Script the next native picker answer. `None` scripts a cancellation.
    ///
    /// This drives the test-only seam in `core::filesystem::smoke_dialog`,
    /// which only exists because the crate was built with `cowork-smoke`.
    fn script_dialog(&self, pick: Option<&Path>) {
        use app_lib::core::filesystem::smoke_dialog::{CANCEL, SCRIPT_ENV};
        match pick {
            Some(path) => std::env::set_var(SCRIPT_ENV, path),
            None => std::env::set_var(SCRIPT_ENV, CANCEL),
        }
    }

    fn clear_dialog_script(&self) {
        std::env::remove_var(app_lib::core::filesystem::smoke_dialog::SCRIPT_ENV);
    }

    /// Dump a route's structure for scenario authoring.
    fn describe(&self, label: &str) -> ScenarioResult {
        let report = self.eval_string(
            r#"const ids = [...document.querySelectorAll('[data-testid],[data-test-id]')]
                 .map(e => e.getAttribute('data-testid') || e.getAttribute('data-test-id'));
               const buttons = [...document.querySelectorAll('button,[role="tab"],[role="button"]')]
                 .map(b => (b.getAttribute('aria-label') || b.textContent || '').trim()).filter(Boolean);
               const inputs = [...document.querySelectorAll('input,textarea')]
                 .map(i => i.getAttribute('placeholder') || i.getAttribute('aria-label') || i.type || '');
               return JSON.stringify({
                 path: location.pathname,
                 testids: [...new Set(ids)].slice(0, 90),
                 buttons: [...new Set(buttons)].slice(0, 90),
                 inputs: [...new Set(inputs)].slice(0, 40),
                 text: (document.body.innerText || '').slice(0, 2200),
               }, null, 1);"#,
        )?;
        println!("--- describe {label} ---\n{report}\n--- end {label} ---");
        Ok(())
    }

    /// Poll a boolean-returning script until it is true, or fail.
    fn wait_until(&self, what: &str, js: &str, timeout: Duration) -> ScenarioResult {
        let deadline = Instant::now() + timeout;
        let mut last = String::new();
        loop {
            match self.eval_bool(js) {
                Ok(true) => return Ok(()),
                Ok(false) => {}
                Err(Failure(e)) => last = e,
            }
            if Instant::now() >= deadline {
                bail!(
                    "timed out waiting for {what} ({timeout:?}). last error: {last}\nscript:\n{js}"
                );
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    }
}

// ---------------------------------------------------------------------------
// Fixture project
// ---------------------------------------------------------------------------

/// Deterministic project the harness attaches to.
///
/// Built fresh in the run's temp workspace rather than committed, so the
/// repository never carries a file named like a private key, a `.env`, or a
/// blob of NUL bytes -- and so the git history below is real rather than a
/// nested repo checked into this one.
fn materialize_project(workspace: &Path, template: Option<&Path>) -> Result<PathBuf, String> {
    // A distinctive name: scenarios assert on it, and "project" alone
    // also occurs in the *unattached* prompt text.
    let root = workspace.join("cowork-smoke-fixture");
    std::fs::create_dir_all(root.join("src/lib")).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(root.join("secrets")).map_err(|e| e.to_string())?;

    let write = |rel: &str, body: &[u8]| -> Result<(), String> {
        std::fs::write(root.join(rel), body).map_err(|e| format!("{rel}: {e}"))
    };

    write(
        "README.md",
        b"# Smoke fixture\n\nDeterministic project for cowork-smoke.\n",
    )?;
    write(
        "package.json",
        b"{\n  \"name\": \"cowork-smoke-fixture\",\n  \"version\": \"1.0.0\"\n}\n",
    )?;
    write(
        "src/index.ts",
        b"export const greet = (who: string): string => `hello ${who}`\n\nexport default greet\n",
    )?;
    // Long enough to need line numbers and a scrollbar in the Code viewer.
    let mut util = String::from("// nested module used by the Code panel scenarios\n");
    for i in 1..=120 {
        util.push_str(&format!("export const value{i} = {i}\n"));
    }
    write("src/lib/util.ts", util.as_bytes())?;
    write(
        "src/lib/config.json",
        b"{\n  \"retries\": 3,\n  \"verbose\": false\n}\n",
    )?;
    // A wide line, for the wrapping check.
    write(
        "src/lib/wide.ts",
        format!("export const wide = '{}'\n", "x".repeat(400)).as_bytes(),
    )?;
    // Externally modifiable, and the file the edit scenarios rewrite.
    write("notes.txt", b"line one\nline two\nline three\n")?;
    // Sensitive by name.
    write(".env", b"SMOKE_TOKEN=not-a-real-secret\n")?;
    write(
        "secrets/api_key.pem",
        b"-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n",
    )?;
    // Binary content behind a text extension: the sniffer must not trust the name.
    let mut binary = vec![0u8, 1, 2, 3, 0xff, 0xfe];
    binary.extend_from_slice(b"binary payload behind a .txt name");
    binary.extend_from_slice(&[0u8, 0u8, 7u8]);
    write("data.txt", &binary)?;

    if let Some(template) = template {
        // An explicit --fixtures tree is copied in on top of the generated one.
        copy_tree(template, &root)?;
    }

    git_init_with_working_tree_changes(&root)?;

    // Written after the commit so it never enters history, and deliberately not
    // ignored, so the file browser still lists it. 6 MiB is past any sane
    // inline-preview budget without making every project rescan expensive.
    write("huge.txt", "A".repeat(2 * 1024 * 1024).as_bytes())?;
    Ok(root)
}

/// Start the deterministic OpenAI-compatible fixture and return its port.
///
/// The provider's URL has to be written into settings.json before the app
/// launches, so the server is started first and re-scripted afterwards over its
/// `/__control` endpoint rather than restarted per scenario.
fn start_mock_provider(fixtures: &Path, port: u16) -> Result<(std::process::Child, u16), String> {
    // `--fixtures` names the *project* template; the server fixture sits beside
    // that directory, so accept either location.
    let candidates = [
        fixtures.join("mock_openai_server.py"),
        fixtures
            .parent()
            .unwrap_or(fixtures)
            .join("mock_openai_server.py"),
        Path::new(MANIFEST_DIR).join("tests/fixtures/mock_openai_server.py"),
    ];
    let script = candidates
        .iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            format!(
                "missing fixture mock_openai_server.py; looked in {}",
                candidates
                    .iter()
                    .map(|p| p.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })?;
    // `python3` is the name on unix and usually absent on Windows, where the
    // interpreter is `python` and `python3` is either missing or a Store alias
    // that opens a shop page instead of running anything. Ask for the first one
    // that answers, so the harness runs on whichever the machine has rather
    // than failing with "program not found" for a name that was never going to
    // exist here.
    let interpreter = ["python3", "python", "py"]
        .into_iter()
        .find(|name| {
            std::process::Command::new(name)
                .arg("--version")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        })
        .ok_or("no python interpreter found (tried python3, python, py)")?;
    let mut child = std::process::Command::new(interpreter)
        .arg(script)
        .arg("--model")
        .arg(SMOKE_MODEL)
        .arg("--port")
        .arg(port.to_string())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start the mock provider: {e}"))?;

    let stdout = child.stdout.take().ok_or("mock provider had no stdout")?;
    let mut reader = std::io::BufReader::new(stdout);
    let mut line = String::new();
    for _ in 0..50 {
        line.clear();
        if reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            break;
        }
        if let Some(port) = line.strip_prefix("PORT ") {
            let port: u16 = port
                .trim()
                .parse()
                .map_err(|e| format!("unreadable port {line:?}: {e}"))?;
            return Ok((child, port));
        }
    }
    let _ = child.kill();
    Err("the mock provider never announced a port".into())
}

/// Seed the fresh data folder so the app does not open first-run onboarding.
///
/// `routes/index.tsx` shows `SetupScreen` whenever `hasUsableProvider` is
/// false, and a pristine data folder has no providers at all. A *custom*
/// provider (one absent from `predefinedProviders`) is usable on models alone
/// -- no credential -- which is exactly what a harness needs: deterministic,
/// offline, and never touching a real endpoint.
fn seed_settings(data_folder: &Path, base_url: &str) -> Result<(), String> {
    std::fs::create_dir_all(data_folder).map_err(|e| e.to_string())?;
    let providers = serde_json::json!({
        "version": 18,
        "state": {
            "providers": [{
                "active": true,
                "persist": true,
                "provider": SMOKE_PROVIDER,
                "base_url": base_url,
                "api_key": "smoke-not-a-real-key",
                "settings": [],
                // Shape copied from a real configured provider: `model` and
                // `version` alongside `id`, or the store drops the entry and
                // the provider page shows "No model found".
                "models": [
                    { "id": SMOKE_MODEL, "model": SMOKE_MODEL, "name": SMOKE_MODEL,
                      "capabilities": ["completion", "tools"], "version": "1.0" },
                    { "id": "smoke-alt", "model": "smoke-alt", "name": "smoke-alt",
                      "capabilities": ["completion", "tools"], "version": "1.0" }
                ]
            }],
            "selectedProvider": SMOKE_PROVIDER,
            "selectedModel": {
                "id": SMOKE_MODEL, "model": SMOKE_MODEL, "name": SMOKE_MODEL,
                "capabilities": ["completion", "tools"], "version": "1.0"
            },
            "deletedModels": []
        }
    });
    let settings = serde_json::json!({
        "model-provider": providers.to_string(),
        // Onboarding nudges that would otherwise cover the surfaces under test.
        "jan-model-prompt-dismissed": "true",
        "productAnalytic": "false",
        "productAnalyticPrompt": "false",
    });
    std::fs::write(
        data_folder.join("settings.json"),
        serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// Seed `mcp_config.json` the way an upgraded install finds it:
///
/// - a server the user added (inactive, so it never has to start), which must
///   survive every rewrite (janhq/jan#8519);
/// - the hosted Exa entry an earlier Jan migration switched on by itself,
///   which the v5 migration must remove before anything dials it
///   (janhq/jan#8911);
/// - an active stdio server exposing a tool named `web_search`, which must be
///   approved and run as that server's tool while built-in web search is off
///   (janhq/jan#8777). It logs every call it receives into the data folder.
fn seed_mcp_config(data_folder: &Path) -> Result<(), String> {
    let interpreter = ["python3", "python", "py"]
        .into_iter()
        .find(|name| {
            std::process::Command::new(name)
                .arg("--version")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        })
        .ok_or("no python interpreter for the MCP fixture")?;
    let server = Path::new(MANIFEST_DIR).join("tests/fixtures/mock_mcp_web_search.py");
    let config = serde_json::json!({
        "mcpServers": {
            SMOKE_MCP_USER_SERVER: {
                "command": "smoke-user-command-that-never-runs",
                "args": ["--kept"],
                "env": {},
                "active": false
            },
            "exa": {
                "type": "http",
                "url": "https://mcp.exa.ai/mcp",
                "active": true
            },
            SMOKE_MCP_WEB_SEARCH: {
                "command": interpreter,
                "args": [
                    server.to_string_lossy(),
                    "--log",
                    data_folder.join("mcp-web-search-calls.jsonl").to_string_lossy()
                ],
                "env": {},
                "active": true
            }
        }
    });
    std::fs::write(
        data_folder.join("mcp_config.json"),
        serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            copy_tree(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .map_err(|e| format!("git {args:?}: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// A committed baseline plus real working-tree changes, so "what git sees" can
/// be told apart from "what a Cowork run changed".
fn git_init_with_working_tree_changes(root: &Path) -> Result<(), String> {
    git(root, &["init", "-q", "-b", "main"])?;
    git(root, &["config", "user.email", "smoke@example.invalid"])?;
    git(root, &["config", "user.name", "Cowork Smoke"])?;
    std::fs::write(root.join(".gitignore"), "# intentionally empty\n")
        .map_err(|e| e.to_string())?;
    git(root, &["add", "-A"])?;
    git(root, &["commit", "-qm", "baseline"])?;

    // Working-tree changes that predate any Cowork run.
    std::fs::write(
        root.join("README.md"),
        "# Smoke fixture\n\nEdited in the working tree before Cowork ran.\n",
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(root.join("untracked.md"), "created outside Cowork\n")
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/// A named check. Every entry here runs against the real app.
struct Scenario {
    name: &'static str,
    run: fn(&Ctx) -> ScenarioResult,
}

const SCENARIOS: &[Scenario] = &[
    Scenario {
        name: "app-startup",
        run: scenario_app_startup,
    },
    Scenario {
        name: "startup-makes-no-unconfigured-requests",
        run: scenario_no_unconfigured_egress,
    },
    Scenario {
        name: "chat-composer",
        run: scenario_chat_composer,
    },
    Scenario {
        name: "cowork-navigation",
        run: scenario_cowork_navigation,
    },
    Scenario {
        name: "settings-navigation",
        run: scenario_settings_navigation,
    },
    Scenario {
        name: "cowork-rails",
        run: scenario_cowork_rails,
    },
    Scenario {
        name: "temporary-chat-toggle",
        run: scenario_temporary_chat,
    },
    Scenario {
        name: "mcp-settings-surface",
        run: scenario_mcp_settings,
    },
    Scenario {
        name: "model-picker-search",
        run: scenario_model_picker,
    },
    Scenario {
        name: "dialog-seam-over-ipc",
        run: scenario_dialog_seam,
    },
    Scenario {
        name: "project-attachment-cancelled",
        run: scenario_attach_cancelled,
    },
    Scenario {
        name: "project-attachment",
        run: scenario_attach,
    },
    Scenario {
        name: "lazy-project-browsing",
        run: scenario_lazy_browsing,
    },
    Scenario {
        name: "code-tabs",
        run: scenario_code_tabs,
    },
    Scenario {
        name: "code-viewer-presentation",
        run: scenario_code_viewer,
    },
    Scenario {
        name: "file-read",
        run: scenario_file_read,
    },
    Scenario {
        name: "sensitive-file-rejection",
        run: scenario_sensitive_rejection,
    },
    Scenario {
        name: "binary-file-rejection",
        run: scenario_binary_rejection,
    },
    Scenario {
        name: "oversized-file-handling",
        run: scenario_oversized,
    },
    Scenario {
        name: "git-working-tree-vs-sandbox",
        run: scenario_git_vs_sandbox,
    },
    Scenario {
        name: "external-edit-structured-diff",
        run: scenario_external_edit_diff,
    },
    Scenario {
        name: "session-isolation",
        run: scenario_session_isolation,
    },
    Scenario {
        name: "settings-search-and-navigation",
        run: scenario_settings_search,
    },
    Scenario {
        name: "per-chat-model-and-reasoning",
        run: scenario_per_chat_controls,
    },
    Scenario {
        name: "cowork-search-and-settings",
        run: scenario_cowork_search_and_settings,
    },
    Scenario {
        name: "local-hostname-selects-the-private-address",
        run: scenario_local_hostname,
    },
    Scenario {
        name: "chat-streams-over-the-local-hostname",
        run: scenario_stream_over_local_hostname,
    },
    Scenario {
        name: "no-setup-wall-above-the-composer",
        run: scenario_no_setup_wall,
    },
    Scenario {
        name: "provider-error-is-actionable",
        run: scenario_provider_error,
    },
    Scenario {
        name: "model-round-trip",
        run: scenario_model_round_trip,
    },
    Scenario {
        name: "composer-controls-do-not-overlap",
        run: scenario_composer_layout,
    },
    Scenario {
        name: "composer-footer-clears-the-textarea",
        run: scenario_composer_footer,
    },
    Scenario {
        name: "header-controls-are-clickable",
        run: scenario_header_hit_test,
    },
    Scenario {
        name: "macos-title-bar",
        run: scenario_macos_title_bar,
    },
    Scenario {
        name: "prompt-snapshot-cross-session-refused",
        run: scenario_prompt_snapshot_isolation,
    },
    Scenario {
        name: "prompt-snapshot-panel",
        run: scenario_prompt_snapshot,
    },
    // A pair (AH-079): a past turn's context is replayed, stopped, refused and
    // left running; a restart brings every ending back.
    Scenario {
        name: "context-replay-1",
        run: scenario_context_replay_first,
    },
    Scenario {
        name: "context-replay-2",
        run: scenario_context_replay_second,
    },
    Scenario {
        name: "tool-activity-timeline",
        run: scenario_tool_activity,
    },
    Scenario {
        name: "proposal-review-apply",
        run: scenario_proposal_review,
    },
    Scenario {
        name: "proposal-flags",
        run: scenario_proposal_flags,
    },
    Scenario {
        name: "worktree-export",
        run: scenario_worktree_export,
    },
    Scenario {
        name: "managed-worktree-review",
        run: scenario_managed_worktree_review,
    },
    // A pair (AH-109): a team whose tasks overlap is stopped before it runs,
    // its isolated children's work is reviewed and partly applied, and what is
    // still waiting for review is there after a restart.
    Scenario {
        name: "team-review-persist-1",
        run: scenario_team_review_first,
    },
    Scenario {
        name: "team-review-persist-2",
        run: scenario_team_review_second,
    },
    Scenario {
        name: "command-palette-keybindings",
        run: scenario_palette_keybindings,
    },
    Scenario {
        name: "utility-agent-title",
        run: scenario_utility_agent_title,
    },
    Scenario {
        name: "session-export-import",
        run: scenario_session_export_import,
    },
    Scenario {
        name: "at-references-confined",
        run: scenario_at_references_confined,
    },
    Scenario {
        name: "unified-at-menu",
        run: scenario_unified_at_menu,
    },
    // A pair, like restart-persist: an alias saved in one process is offered
    // and resolved by the next.
    Scenario {
        name: "project-init",
        run: scenario_project_init,
    },
    Scenario {
        name: "session-handoff",
        run: scenario_session_handoff,
    },
    // A pair: what a handoff could not restore is still said after a restart.
    Scenario {
        name: "handoff-persist-1",
        run: scenario_handoff_persist_first,
    },
    Scenario {
        name: "handoff-persist-2",
        run: scenario_handoff_persist_second,
    },
    // A pair: a draft edited in one process is still there in the next.
    Scenario {
        name: "project-init-draft-1",
        run: scenario_project_init_draft_first,
    },
    Scenario {
        name: "project-init-draft-2",
        run: scenario_project_init_draft_second,
    },
    Scenario {
        name: "alias-persist-1",
        run: scenario_alias_persist_first,
    },
    Scenario {
        name: "alias-persist-2",
        run: scenario_alias_persist_second,
    },
    // Run as two invocations against one `COWORK_SMOKE_KEEP` workspace: the
    // first changes state, the app exits, the second starts it again and
    // checks the state came back.
    Scenario {
        name: "restart-persist-1",
        run: scenario_restart_persist_first,
    },
    Scenario {
        name: "restart-persist-2",
        run: scenario_restart_persist_second,
    },
    Scenario {
        name: "memory-proposal-approval",
        run: scenario_memory_proposal,
    },
    Scenario {
        name: "thread-files-are-atomic",
        run: scenario_thread_durability,
    },
    Scenario {
        name: "mcp-config-is-kept-and-the-default-exa-removed",
        run: scenario_mcp_config_durability,
    },
    Scenario {
        name: "a-malformed-tool-call-fails-cleanly",
        run: scenario_malformed_tool_call,
    },
    Scenario {
        name: "deleting-a-message-keeps-later-replies",
        run: scenario_delete_keeps_later_replies,
    },
    Scenario {
        name: "edited-instructions-reach-the-open-chat",
        run: scenario_instructions_reach_open_chat,
    },
    Scenario {
        name: "custom-endpoint-length-stop-offers-no-fake-resize",
        run: scenario_length_stop_on_custom_endpoint,
    },
    Scenario {
        name: "mcp-web-search-is-approved-as-the-servers-tool",
        run: scenario_mcp_web_search_approval,
    },
];

/// The real-provider lane: the app against a real OpenAI-compatible server,
/// driven through the UI end to end.
const LANE_SCENARIOS: &[Scenario] = &[
    Scenario {
        name: "lane-discovers-the-servers-models",
        run: lane_discovers_models,
    },
    Scenario {
        name: "lane-streams-a-reply-with-token-speed",
        run: lane_streams_a_reply,
    },
    // After a request has gone through the app's transport: the endpoint is
    // classified from the address that connection actually used, and model
    // discovery goes through the HTTP plugin, which records none.
    Scenario {
        name: "lane-endpoint-is-grouped-as-local",
        run: lane_grouped_local,
    },
    Scenario {
        name: "lane-memory-reaches-the-model",
        run: lane_memory_reaches_the_model,
    },
    Scenario {
        name: "lane-cowork-model-tool-model-loop",
        run: lane_cowork_tool_loop,
    },
    Scenario {
        name: "lane-key-and-peers-are-contained",
        run: lane_contained,
    },
];

/// Scenarios for a second process started on a kept profile
/// (`COWORK_SMOKE_KEEP`): what a real restart has to bring back.
const RESTART_SCENARIOS: &[Scenario] = &[
    // AH-109 phase two: what a restart brings back of a team's children.
    Scenario {
        name: "team-review-persist-2",
        run: scenario_team_review_second,
    },
    Scenario {
        name: "context-replay-2",
        run: scenario_context_replay_second,
    },
    Scenario {
        name: "tool-activity-survives-a-restart",
        run: scenario_tool_activity_after_restart,
    },
    Scenario {
        name: "a-torn-thread-tail-heals-after-a-restart",
        run: scenario_torn_tail_after_restart,
    },
    Scenario {
        name: "a-deleted-reply-stays-deleted-after-a-restart",
        run: scenario_delete_after_restart,
    },
];

/// The frontend bundle is loaded, React has mounted, and IPC round-trips.
fn scenario_app_startup(ctx: &Ctx) -> ScenarioResult {
    ctx.wait_until(
        "React root to mount",
        "return !!document.querySelector('#root') && document.querySelector('#root').children.length > 0;",
        Duration::from_secs(60),
    )?;

    // Real Tauri IPC, not a browser shim: ask the backend for its configuration.
    let ipc_ok = ctx.eval_bool(
        "const c = await window.__TAURI_INTERNALS__.invoke('get_app_configurations');
         return !!c && typeof c.data_folder === 'string';",
    )?;
    ensure!(ipc_ok, "get_app_configurations did not round-trip over IPC");

    let title = ctx.eval_string("return document.title;")?;
    ensure!(!title.is_empty(), "document.title was empty");
    Ok(())
}

/// The chat composer accepts text and arms its send control.
fn scenario_chat_composer(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/")?;
    ctx.wait_until(
        "chat composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;

    let disabled_before = ctx.eval_bool(
        "const b = document.querySelector('[data-test-id=\"send-message-button\"]');
         return !b || b.disabled === true;",
    )?;

    ctx.type_into(
        "[data-testid=\"chat-input\"]",
        "cowork smoke composer probe",
    )?;

    let value = ctx.eval_string(
        "return document.querySelector('[data-testid=\"chat-input\"]').value || '';",
    )?;
    ensure!(
        value.contains("cowork smoke composer probe"),
        "composer did not accept typed text (value was {value:?})"
    );

    ctx.wait_until(
        "send control to arm",
        "const b = document.querySelector('[data-test-id=\"send-message-button\"]');
         return !!b && b.disabled !== true;",
        Duration::from_secs(10),
    )?;

    // Leave the composer clean for later scenarios.
    ctx.type_into("[data-testid=\"chat-input\"]", "")?;
    let _ = disabled_before;
    Ok(())
}

/// The Cowork route mounts and its panels reach the backend over real IPC.
fn scenario_cowork_navigation(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "cowork surface to render",
        "return document.body.innerText.trim().length > 0
             && document.querySelectorAll('button').length > 0;",
        Duration::from_secs(30),
    )?;
    let path = ctx.eval_string("return window.location.pathname;")?;
    ensure!(
        path.starts_with("/cowork"),
        "route was {path:?}, not /cowork"
    );
    Ok(())
}

/// An individual settings page mounts (not the router's Not Found fallback).
fn scenario_settings_navigation(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/settings/general")?;
    ctx.wait_until(
        "settings/general content",
        "return location.pathname.startsWith('/settings/general')
             && !document.body.innerText.includes('Not Found')
             && document.body.innerText.trim().length > 40;",
        Duration::from_secs(30),
    )?;

    // The bare /settings path has no route; assert the app says so rather than
    // silently rendering an empty shell, so a future regression is visible.
    ctx.goto("/settings")?;
    std::thread::sleep(Duration::from_millis(600));
    let not_found = ctx.eval_bool("return document.body.innerText.includes('Not Found');")?;
    ensure!(
        not_found,
        "/settings changed behaviour: it no longer renders Not Found"
    );
    Ok(())
}

/// The Cowork right-hand rails (Code / Preview / Changes / Activity) all mount.
fn scenario_cowork_rails(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/cowork")?;
    // The rails are icon buttons: their names live in aria-label, not innerText.
    ctx.wait_until(
        "cowork rails",
        "const names = [...document.querySelectorAll('button')]
           .map(b => (b.getAttribute('aria-label') || b.textContent || '').trim());
         return ['Code','Preview','Changes','Activity'].every(r => names.includes(r));",
        Duration::from_secs(30),
    )?;

    for rail in ["Code", "Preview", "Changes", "Activity"] {
        // Match the rail exactly: "Code" must not select "Open code folder".
        ctx.click_rail(rail)?;
        let panel = ctx.eval_string("return document.body.innerText;")?;
        ensure!(
            !panel.trim().is_empty(),
            "rail {rail} produced an empty surface"
        );
    }
    Ok(())
}

/// The temporary-chat control toggles and reports its state.
fn scenario_temporary_chat(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/")?;
    ctx.wait_until(
        "temporary chat control",
        "return [...document.querySelectorAll('button')].some(b =>
            (b.getAttribute('aria-label') || b.textContent || '').trim() === 'Temporary Chat');",
        Duration::from_secs(30),
    )?;

    let before = ctx.eval_string(
        "const b = [...document.querySelectorAll('button')].find(b =>
            (b.getAttribute('aria-label') || b.textContent || '').trim() === 'Temporary Chat');
         return JSON.stringify({ pressed: b.getAttribute('aria-pressed'), cls: b.className });",
    )?;
    ctx.click_matching("button", "Temporary Chat")?;
    std::thread::sleep(Duration::from_millis(800));
    let after = ctx.eval_string(
        "const b = [...document.querySelectorAll('button')].find(b =>
            (b.getAttribute('aria-label') || b.textContent || '').trim() === 'Temporary Chat');
         if (!b) return 'GONE';
         return JSON.stringify({ pressed: b.getAttribute('aria-pressed'), cls: b.className });",
    )?;
    println!("      temporary-chat before={before}\n      temporary-chat after={after}");
    ensure!(
        before != after,
        "Temporary Chat control did not change state when clicked (state stayed {before})"
    );
    // Restore.
    if after != "GONE" {
        let _ = ctx.click_matching("button", "Temporary Chat");
    }
    Ok(())
}

/// The model picker opens and its search narrows the list.
fn scenario_model_picker(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/")?;
    // The trigger's label carries the current model, so match on the control's
    // role rather than a fixed string, and retry: a stray open popover from an
    // earlier scenario can swallow the first click.
    let open_js = "return [...document.querySelectorAll('input')].some(i =>
            /search|find|model/i.test(i.getAttribute('placeholder') || ''));";
    let mut opened = false;
    for _ in 0..3 {
        ctx.eval(
            "document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
             return true;",
        )?;
        std::thread::sleep(Duration::from_millis(400));
        let clicked = ctx.eval_bool(
            "const b = [...document.querySelectorAll('button')].find(x =>
               // Once a model is selected the trigger carries its name, so
               // matching the placeholder alone stops working.
               /select a model|smoke-model|smoke-alt/i.test(
                 (x.getAttribute('aria-label') || '') + ' ' + (x.textContent || ''))
               || x.closest('[data-model-trigger]'));
             if (!b) return false; b.click(); return true;",
        )?;
        if !clicked {
            continue;
        }
        if ctx
            .wait_until("the model picker to open", open_js, Duration::from_secs(8))
            .is_ok()
        {
            opened = true;
            break;
        }
    }
    ensure!(opened, "the model picker never exposed its search input");
    ctx.describe("model-picker")?;
    // Close the dialog deliberately: a left-open modal blocks the next
    // scenario's navigation.
    ctx.eval(
        "document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
         const close = document.querySelector('[role=\"dialog\"] button[aria-label*=\"lose\"]');
         if (close) close.click();
         return true;",
    )?;
    ctx.wait_until(
        "model picker to close",
        "return !document.querySelector('[role=\"dialog\"][data-state=\"open\"]');",
        Duration::from_secs(15),
    )?;
    Ok(())
}

/// The MCP settings page lists configured servers with lifecycle controls.
fn scenario_mcp_settings(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/settings/mcp-servers")?;
    ctx.wait_until(
        "MCP server list",
        "const t = document.body.innerText;
         return t.includes('MCP Servers') && t.includes('Transport:');",
        Duration::from_secs(30),
    )?;
    let switches = ctx.eval(
        "return document.querySelectorAll('[role=\"switch\"],button[role=\"switch\"]').length;",
    )?;
    println!("      mcp switches found: {switches}");
    ensure!(
        switches.as_u64().unwrap_or(0) > 0,
        "no MCP enable/disable switches rendered"
    );
    Ok(())
}

/// Every control in the title-bar band must actually receive a click.
///
/// A full-width `data-tauri-drag-region` sheet used to cover the top 48px of
/// the window, so pressing the model selector or the temporary-chat button
/// dragged the window instead. Scripted `.click()` bypasses hit-testing, so
/// only a hit test finds this: ask the document what is at each control's
/// centre.
fn scenario_header_hit_test(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/")?;
    ctx.wait_until(
        "the header",
        "return document.querySelectorAll('button').length > 2;",
        Duration::from_secs(30),
    )?;
    std::thread::sleep(Duration::from_millis(600));

    let report = ctx.eval_string(
        r#"const blocked = [];
           for (const b of document.querySelectorAll('button')) {
             const r = b.getBoundingClientRect();
             // Only the title-bar band, and only what is actually on screen.
             if (r.width === 0 || r.height === 0 || r.top > 60) continue;
             const x = Math.round(r.left + r.width / 2);
             const y = Math.round(r.top + r.height / 2);
             const hit = document.elementFromPoint(x, y);
             if (!hit || (hit !== b && !b.contains(hit))) {
               blocked.push({
                 control: (b.getAttribute('aria-label') || b.textContent || '?')
                   .trim().slice(0, 40),
                 covered_by: hit ? (hit.getAttribute('aria-label')
                   || hit.className || hit.tagName).toString().slice(0, 80) : 'nothing',
               });
             }
           }
           return JSON.stringify({ blocked });"#,
    )?;
    println!("      header hit test: {report}");
    let v: Value = serde_json::from_str(&report).unwrap_or(Value::Null);
    let blocked = v
        .get("blocked")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    ensure!(
        blocked.is_empty(),
        "controls in the title-bar band cannot be clicked: {report}"
    );
    Ok(())
}

/// macOS runs an overlay title bar with an inset traffic light, so the frontend
/// must supply its own drag region. Asserted only where the platform applies.
fn scenario_macos_title_bar(ctx: &Ctx) -> ScenarioResult {
    if !cfg!(target_os = "macos") {
        println!("      skipped: not macOS");
        return Ok(());
    }
    ctx.goto("/")?;
    let drag_regions =
        ctx.eval("return document.querySelectorAll('[data-tauri-drag-region]').length;")?;
    ensure!(
        drag_regions.as_u64().unwrap_or(0) > 0,
        "macOS overlay title bar has no [data-tauri-drag-region] element to drag by"
    );

    // The traffic light is inset by 20x32 in tauri.macos.conf.json; the sidebar
    // header must leave room for it rather than starting flush at the corner.
    let top_left_clear = ctx.eval_bool(
        "const el = document.elementFromPoint(24, 20);
         if (!el) return true;
         // Anything clickable here would sit under the traffic light.
         return !el.closest('button, a[href], input, select, textarea, [role=\"button\"]');",
    )?;
    ensure!(
        top_left_clear,
        "an interactive element sits under the macOS traffic-light inset"
    );
    Ok(())
}

/// The scripted picker answers the real `open_dialog` command over real IPC.
///
/// Runs before the UI attach scenarios so a failure says whether the seam or
/// the attach handler is at fault.
fn scenario_dialog_seam(ctx: &Ctx) -> ScenarioResult {
    let path = ctx.project.to_string_lossy().to_string();

    ctx.script_dialog(Some(&ctx.project));
    let picked = ctx.eval(
        "return await window.__TAURI_INTERNALS__.invoke('open_dialog',
            { options: { directory: true } });",
    );
    ctx.clear_dialog_script();
    let picked = picked?;
    ensure!(
        picked.as_str() == Some(path.as_str()),
        "scripted picker returned {picked:?}, expected {path:?}"
    );

    ctx.script_dialog(None);
    let cancelled = ctx.eval(
        "return await window.__TAURI_INTERNALS__.invoke('open_dialog',
            { options: { directory: true } });",
    );
    ctx.clear_dialog_script();
    ensure!(
        cancelled?.is_null(),
        "a scripted cancellation must return null"
    );
    Ok(())
}

/// The workspace pill. It is a popover *trigger*, not the attach action --
/// clicking it alone does nothing, which is what made the first version of the
/// attach scenario fail while reporting no error at all.
const PILL_JS: &str = r#"[...document.querySelectorAll('button')].find(b =>
    /no project folder attached/i.test(b.getAttribute('aria-label') || ''))"#;

/// The attach action, which lives inside the pill's popover.
const ATTACH_ITEM_JS: &str = r#"[...document.querySelectorAll('button,[role="menuitem"]')].find(b => {
    const t = ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).trim();
    return /^(attach a folder|attach project)$/i.test(t);
  })"#;

/// Open the pill popover and click its attach action.
fn open_picker_through_the_pill(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/cowork")?;

    // A retry, or a scenario that ran earlier, may have left a folder attached.
    // Detach through the pill rather than assuming a clean session, or the
    // "attach one" control is simply not there to click.
    if !ctx.eval_bool(&format!("return !!({PILL_JS});"))? {
        let _ = ctx.eval(
            "const pill = [...document.querySelectorAll('button')].find(b =>
               /attached read-only|project folder/i.test(b.getAttribute('aria-label') || ''));
             if (pill) pill.click();
             return true;",
        );
        std::thread::sleep(Duration::from_millis(700));
        let _ = ctx.eval(
            "const item = [...document.querySelectorAll('button,[role=\"menuitem\"]')]
               .find(e => /^detach folder$/i.test((e.textContent || '').trim()));
             if (item) item.click();
             return true;",
        );
        std::thread::sleep(Duration::from_millis(900));
    }

    ctx.wait_until(
        "the workspace pill",
        &format!("return !!({PILL_JS});"),
        Duration::from_secs(30),
    )?;
    ctx.eval(&format!("({PILL_JS}).click(); return true;"))?;
    ctx.wait_until(
        "the pill popover's attach action",
        &format!("return !!({ATTACH_ITEM_JS});"),
        Duration::from_secs(15),
    )?;
    ctx.eval(&format!("({ATTACH_ITEM_JS}).click(); return true;"))?;
    Ok(())
}

/// A dismissed picker must leave the session unattached.
fn scenario_attach_cancelled(ctx: &Ctx) -> ScenarioResult {
    ctx.script_dialog(None);
    let opened = open_picker_through_the_pill(ctx);
    std::thread::sleep(Duration::from_secs(3));
    ctx.clear_dialog_script();
    opened?;

    let still_unattached = ctx.eval_bool(&format!("return !!({PILL_JS});"))?;
    ensure!(
        still_unattached,
        "cancelling the picker still attached a project"
    );
    Ok(())
}

/// Attaching through the real handler, the real service hub and the real
/// `open_dialog` command -- only the OS modal is scripted.
fn scenario_attach(ctx: &Ctx) -> ScenarioResult {
    ctx.script_dialog(Some(&ctx.project));
    let opened = open_picker_through_the_pill(ctx);

    // Assert on the fixture's own directory name. "project" alone would also
    // match the unattached prompt, which is how the first version of this
    // scenario passed without ever attaching anything.
    let name = ctx
        .project
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let landed = opened.and_then(|()| {
        ctx.wait_until(
            "the project to attach",
            &format!(
                "return document.body.innerText.includes({name:?})
                     && !{PILL_JS};"
            ),
            Duration::from_secs(45),
        )
    });
    ctx.clear_dialog_script();
    landed?;

    // The Code rail must stop offering to attach and start browsing.
    ctx.click_rail("Code")?;
    ctx.wait_until(
        "the Code rail to leave its empty state",
        "return !document.body.innerText.includes('Attach a project folder to browse');",
        Duration::from_secs(20),
    )?;
    Ok(())
}
/// Open the Code rail and make sure the file tree -- not an open file -- is
/// showing.
///
/// Opening a file replaces the tree with the viewer, and the rail button is a
/// toggle, so clicking it again would close the panel outright. The panel's own
/// "Project explorer" control is the way back.
fn open_code_explorer(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/cowork")?;
    let explorer = "return !!document.querySelector('[data-testid=\"code-explorer\"]');";
    if !ctx.eval_bool(explorer)? {
        let went_back = ctx.eval_bool(
            "const b = [...document.querySelectorAll('button')].find(x =>
               /project explorer/i.test((x.getAttribute('aria-label') || '')
                 + ' ' + (x.getAttribute('title') || '')));
             if (!b) return false; b.click(); return true;",
        )?;
        if !went_back {
            ctx.click_rail("Code")?;
        }
        std::thread::sleep(Duration::from_millis(700));
    }
    ctx.wait_until("the code explorer", explorer, Duration::from_secs(20))
}

fn click_tree_entry(ctx: &Ctx, name: &str) -> Result<bool, Failure> {
    ctx.eval_bool(&format!(
        r#"const root = document.querySelector('[data-testid="code-explorer"]');
           if (!root) return false;
           // The name may sit on a leaf span rather than the row element, so
           // find the deepest node carrying exactly that text and climb to the
           // nearest thing that can actually be clicked.
           const leaf = [...root.querySelectorAll('*')]
             .filter(e => e.children.length === 0 && (e.textContent || '').trim() === {name:?})
             .pop()
             || [...root.querySelectorAll('*')]
               .filter(e => (e.textContent || '').trim() === {name:?})
               .pop();
           if (!leaf) return false;
           const target = leaf.closest('button,[role="treeitem"],[role="button"],a,li') || leaf;
           target.scrollIntoView({{ block: 'center' }});
           target.click();
           return true;"#
    ))
}

fn explorer_text(ctx: &Ctx) -> Result<String, Failure> {
    ctx.eval_string(
        "const r = document.querySelector('[data-testid=\"code-explorer\"]');
         return r ? r.textContent : '';",
    )
}

/// A folder's children appear only once it is expanded -- the tree is not
/// enumerated eagerly.
fn scenario_lazy_browsing(ctx: &Ctx) -> ScenarioResult {
    open_code_explorer(ctx)?;

    // An earlier scenario may have left src expanded, so collapse it first
    // rather than assuming the tree starts closed.
    if explorer_text(ctx)?.contains("index.ts") {
        click_tree_entry(ctx, "src")?;
        std::thread::sleep(Duration::from_millis(800));
    }

    let before = explorer_text(ctx)?;
    ensure!(
        before.contains("src"),
        "the explorer never listed the src folder (saw {before:?})"
    );
    ensure!(
        !before.contains("index.ts"),
        "src/index.ts was listed while src was collapsed; the tree is eager"
    );

    ensure!(
        click_tree_entry(ctx, "src")?,
        "could not click the src folder"
    );
    ctx.wait_until(
        "src to expand",
        "const r = document.querySelector('[data-testid=\"code-explorer\"]');
         return !!r && r.textContent.includes('index.ts');",
        Duration::from_secs(15),
    )?;

    // A nested folder is still not expanded.
    let after = explorer_text(ctx)?;
    ensure!(
        after.contains("lib"),
        "the nested lib folder did not appear after expanding src"
    );
    ensure!(
        !after.contains("util.ts"),
        "src/lib/util.ts was listed before lib was expanded; expansion is not lazy"
    );
    Ok(())
}

/// Opening files puts them in the Code panel, one tab each.
fn scenario_code_tabs(ctx: &Ctx) -> ScenarioResult {
    open_code_explorer(ctx)?;
    if !explorer_text(ctx)?.contains("index.ts") {
        click_tree_entry(ctx, "src")?;
        std::thread::sleep(Duration::from_millis(900));
    }
    ensure!(
        click_tree_entry(ctx, "index.ts")?,
        "could not open src/index.ts"
    );
    ctx.wait_until(
        "the code viewer",
        "return !!document.querySelector('[data-testid=\"code-viewer-body\"]')
             || !!document.querySelector('[data-testid=\"code-editor\"]');",
        Duration::from_secs(20),
    )?;

    // Opening a file replaces the tree, so go back to it before the second one.
    open_code_explorer(ctx)?;
    if !click_tree_entry(ctx, "README.md")? {
        let names = ctx.eval_string(
            "const r = document.querySelector('[data-testid=\"code-explorer\"]');
             if (!r) return 'no explorer';
             return [...r.querySelectorAll('*')]
               .filter(e => e.children.length === 0)
               .map(e => (e.textContent || '').trim())
               .filter(Boolean).slice(0, 40).join(' | ');",
        )?;
        bail!("could not open README.md; explorer leaves were: {names}");
    }
    ctx.wait_until(
        "a second open file",
        "const t = document.body.innerText;
         return t.includes('README.md') && t.includes('index.ts');",
        Duration::from_secs(20),
    )?;
    ctx.describe("code-tabs")?;
    Ok(())
}

/// Line numbers, highlighting, wrapping and scrolling in the Code viewer.
fn scenario_code_viewer(ctx: &Ctx) -> ScenarioResult {
    open_file(ctx, &["src", "lib", "util.ts"])?;
    ctx.wait_until(
        "util.ts to render",
        "const b = document.querySelector('[data-testid=\"code-viewer-body\"]');
         return !!b && b.textContent.includes('value120');",
        Duration::from_secs(45),
    )?;

    // Deliberately several small evals: one script that measured everything at
    // once kept exceeding the eval budget while the viewer was still
    // highlighting, and reported a timeout instead of a verdict.
    const BODY: &str = "document.querySelector('[data-testid=\"code-viewer-body\"]')";

    // Detect the gutter structurally. `textContent` concatenates without
    // separators, so "1" runs straight into the first line of code and no
    // text-shaped check can find it.
    let gutter = ctx.eval(&format!(
        "const b = {BODY}; if (!b) return 0;
         const nums = [...b.querySelectorAll('*')]
           .filter(e => e.children.length === 0 && /^[0-9]+$/.test((e.textContent || '').trim()))
           .map(e => parseInt(e.textContent.trim(), 10));
         return nums.includes(1) && nums.includes(120) ? nums.length : 0;"
    ))?;
    println!("      gutter entries: {gutter}");
    ensure!(
        gutter.as_u64().unwrap_or(0) >= 100,
        "the viewer showed no line-number gutter running from 1 to 120"
    );

    let colours = ctx.eval(&format!(
        "const b = {BODY}; if (!b) return 0;
         const spans = b.querySelectorAll('span');
         const seen = new Set();
         for (let i = 0; i < spans.length && i < 40; i++) seen.add(getComputedStyle(spans[i]).color);
         return seen.size;"
    ))?;
    println!("      distinct token colours: {colours}");
    ensure!(
        colours.as_u64().unwrap_or(0) > 1,
        "every token rendered in one colour, so nothing is highlighted"
    );

    let scrollable = ctx.eval_bool(&format!(
        "const b = {BODY}; return !!b && b.scrollHeight > b.clientHeight + 4;"
    ))?;
    ensure!(
        scrollable,
        "a 120-line file did not overflow its viewport, so scrolling is untested"
    );

    // Scrolling actually moves the viewport.
    let scrolled = ctx.eval_bool(
        "const b = document.querySelector('[data-testid=\"code-viewer-body\"]');
         if (!b) return false;
         const before = b.scrollTop;
         b.scrollTop = b.scrollHeight;
         return b.scrollTop > before;",
    )?;
    ensure!(scrolled, "the code viewer would not scroll");

    // Word wrap is a real toggle. The wrapping is applied to the element that
    // holds the lines rather than the panel body, so assert the observable
    // consequence instead of a computed style: a 400-character line stops
    // overflowing horizontally once wrapping is on.
    open_file(ctx, &["src", "lib", "wide.ts"])?;
    ctx.wait_until(
        "wide.ts to render",
        &format!("const b = {BODY}; return !!b && b.textContent.includes('xxxxxxxxxx');"),
        Duration::from_secs(45),
    )?;

    let overflow_before = ctx.eval_bool(&format!(
        "const b = {BODY}; return !!b && b.scrollWidth > b.clientWidth + 4;"
    ))?;
    let toggled = ctx.eval_bool(
        "const b = [...document.querySelectorAll('button')].find(x =>
           /word wrap/i.test((x.getAttribute('aria-label') || '')
             + ' ' + (x.getAttribute('title') || '')));
         if (!b) return false; b.click(); return true;",
    )?;
    ensure!(toggled, "the viewer exposed no word-wrap control");
    std::thread::sleep(Duration::from_millis(800));
    let overflow_after = ctx.eval_bool(&format!(
        "const b = {BODY}; return !!b && b.scrollWidth > b.clientWidth + 4;"
    ))?;
    println!("      horizontal overflow: {overflow_before} -> {overflow_after}");
    ensure!(
        overflow_before != overflow_after,
        "toggling word wrap did not change whether a 400-character line overflows"
    );
    Ok(())
}

/// Open a file by walking the tree from the explorer each time.
///
/// Opening a file replaces the tree, so every scenario that opens one has to
/// start from the explorer rather than assume the previous scenario's state.
fn open_file(ctx: &Ctx, path: &[&str]) -> ScenarioResult {
    open_code_explorer(ctx)?;
    for (i, part) in path.iter().enumerate() {
        let last = i + 1 == path.len();
        if !last && explorer_text(ctx)?.contains(path[i + 1]) {
            continue; // already expanded
        }
        ensure!(
            click_tree_entry(ctx, part)?,
            "could not click {part:?} while opening {path:?}"
        );
        std::thread::sleep(Duration::from_millis(900));
    }
    Ok(())
}

/// Reading a file shows its real contents.
fn scenario_file_read(ctx: &Ctx) -> ScenarioResult {
    open_file(ctx, &["src", "index.ts"])?;
    ctx.wait_until(
        "index.ts contents",
        "return document.body.innerText.includes('export const greet');",
        Duration::from_secs(25),
    )?;
    Ok(())
}

/// Opening a file named like a secret must be refused, not previewed.
fn scenario_sensitive_rejection(ctx: &Ctx) -> ScenarioResult {
    open_file(ctx, &[".env"])?;
    std::thread::sleep(Duration::from_secs(2));
    let text = ctx.eval_string("return document.body.innerText;")?;
    ensure!(
        !text.contains("SMOKE_TOKEN"),
        "the contents of .env were rendered into the UI"
    );
    println!("      after clicking .env, secret not shown");
    Ok(())
}

/// A binary file behind a text extension must be refused, not rendered.
fn scenario_binary_rejection(ctx: &Ctx) -> ScenarioResult {
    open_file(ctx, &["data.txt"])?;
    std::thread::sleep(Duration::from_secs(2));
    let text = ctx.eval_string("return document.body.innerText;")?;
    ensure!(
        !text.contains("binary payload behind"),
        "binary bytes were rendered as text despite the .txt extension"
    );
    println!("      after clicking data.txt, binary not rendered");
    Ok(())
}

/// A 2 MiB file must not be inlined whole.
fn scenario_oversized(ctx: &Ctx) -> ScenarioResult {
    open_code_explorer(ctx)?;
    ensure!(
        explorer_text(ctx)?.contains("huge.txt"),
        "the explorer did not list huge.txt"
    );
    open_file(ctx, &["huge.txt"])?;
    std::thread::sleep(Duration::from_secs(3));
    let len = ctx.eval("return document.body.innerText.length;")?;
    let len = len.as_u64().unwrap_or(0);
    println!("      body text length after opening a 2 MiB file: {len}");
    ensure!(
        len < 2_000_000,
        "a 2 MiB file was inlined into the DOM ({len} chars of text)"
    );
    Ok(())
}

/// Uncommitted working-tree changes are surfaced, and are attributed to the
/// working tree rather than to a Cowork run that never happened.
fn scenario_git_vs_sandbox(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/cowork")?;
    ctx.ensure_rail_open("Changes", "[data-testid=\"cowork-diff-panel\"]")?;
    ctx.wait_until(
        "the Changes rail",
        "return !!document.querySelector('[data-testid=\"cowork-diff-panel\"]');",
        Duration::from_secs(20),
    )?;
    std::thread::sleep(Duration::from_secs(2));
    let text = ctx.eval_string("return document.body.innerText;")?;
    println!(
        "      changes rail tail: {:?}",
        &text[text.len().saturating_sub(400)..]
    );

    // No Cowork run has happened in this session, so anything listed here comes
    // from the working tree the harness dirtied before attaching.
    ensure!(
        text.contains("README.md") || text.contains("untracked.md"),
        "the working-tree changes made before attaching are not listed"
    );
    ensure!(
        !text.contains("No changes yet"),
        "the Changes rail still claims there is nothing to show"
    );
    Ok(())
}

/// Open the access menu and choose a mode by its visible label.
///
/// Radix opens a dropdown on `pointerdown`, not on `click`. A blocked option
/// says why in its own text, and that is reported instead of a timeout.
fn choose_access(ctx: &Ctx, label: &str) -> ScenarioResult {
    choose_from_menu(ctx, "Where changes go", label)
}

/// The run mode, chosen the same way: attaching a repository starts a session
/// in Review first, which withholds every tool that could change anything.
fn choose_mode(ctx: &Ctx, label: &str) -> ScenarioResult {
    choose_from_menu(ctx, "What Jan may do", label)
}

/// Open the dropdown whose trigger is labelled `trigger` and pick `label`.
fn choose_from_menu(ctx: &Ctx, trigger: &str, label: &str) -> ScenarioResult {
    let opened = ctx.eval_bool(
        &format!(r#"const b = [...document.querySelectorAll('button')].find(x =>
             x.getAttribute('aria-label') === {trigger:?});
           if (!b) return false;
           b.dispatchEvent(new PointerEvent('pointerdown',
             {{ bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }}));
           return true;"#
        ),
    )?;
    ensure!(opened, "the {trigger} menu trigger is not on the page");
    // Toasts fade in seconds, so a refusal reported by one is collected as it
    // appears rather than looked for after the wait has already timed out.
    ctx.eval(
        "window.__smokeToasts = [];
         if (!window.__smokeToastObserver) {
           window.__smokeToastObserver = new MutationObserver(() => {
             document.querySelectorAll('[data-sonner-toast]').forEach(t => {
               const x = t.textContent || '';
               if (x && !window.__smokeToasts.includes(x)) window.__smokeToasts.push(x);
             });
           });
           window.__smokeToastObserver.observe(document.body, { childList: true, subtree: true });
         }
         return true;",
    )?;
    ctx.wait_until(
        &format!("the {label} option"),
        &format!(
            "return [...document.querySelectorAll('[role=\"menuitemradio\"],[role=\"menuitem\"]')]
               .some(e => (e.textContent || '').includes({label:?}));"
        ),
        Duration::from_secs(15),
    )?;
    let option = ctx.eval_string(&format!(
        "const o = [...document.querySelectorAll('[role=\"menuitemradio\"],[role=\"menuitem\"]')]
           .find(e => (e.textContent || '').includes({label:?}));
         const blocked = o.getAttribute('aria-disabled') === 'true';
         if (!blocked) o.click();
         return (blocked ? 'BLOCKED: ' : '') + (o.textContent || '');"
    ))?;
    ensure!(!option.starts_with("BLOCKED"), "{label} is not available here: {option}");
    let changed = ctx.wait_until(
        &format!("access to become {label}"),
        &format!(
            "const b = [...document.querySelectorAll('button')].find(x =>
               x.getAttribute('aria-label') === {trigger:?});
             return !!b && (b.textContent || '').includes({label:?});"
        ),
        Duration::from_secs(45),
    );
    if changed.is_err() {
        let seen = ctx
            .eval_string("return (window.__smokeToasts || []).join(' | ');")
            .unwrap_or_default();
        bail!("choosing {label} did not take effect; toasts seen: {seen:?}");
    }
    Ok(())
}

/// Managed worktree mode, end to end through the real UI on this platform.
/// Windows confinement for a Jan-owned worktree; AH-146/147/148/109.
///
/// Proves: the access menu offers Managed worktree (on Windows, where editing
/// the folder directly is not offered); a run's `write` and `bash` land in the
/// worktree and not in the attached folder -- the shell under the sandbox
/// writing there is the confinement grant in action; the Changes panel's
/// review lists the run's work; unticking a hunk and applying lands exactly
/// what was ticked in the attached folder.
fn scenario_managed_worktree_review(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    let file = "proposal-target.txt";
    let base: String = (1..=12).map(|i| format!("line {i}\n")).collect();
    let with = |lines: &[(usize, &str)]| -> String {
        (1..=12)
            .map(|i| match lines.iter().find(|(n, _)| *n == i) {
                Some((_, text)) => format!("{text}\n"),
                None => format!("line {i}\n"),
            })
            .collect()
    };
    let read = |p: &Path| std::fs::read_to_string(p).unwrap_or_default();
    if git(&ctx.project, &["ls-files", "--error-unmatch", file]).is_err() {
        std::fs::write(ctx.project.join(file), &base).map_err(|e| fail(e.to_string()))?;
        git(&ctx.project, &["add", file]).map_err(fail)?;
        git(&ctx.project, &["commit", "-qm", "proposal base"]).map_err(fail)?;
    }
    std::fs::write(ctx.project.join(file), &base).map_err(|e| fail(e.to_string()))?;
    let _ = std::fs::remove_file(ctx.project.join("shell-made.txt"));

    ctx.script_dialog(Some(&ctx.project));
    let opened = open_picker_through_the_pill(ctx);
    let name = ctx
        .project
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let landed = opened.and_then(|()| {
        ctx.wait_until(
            "the project to attach",
            &format!("return document.body.innerText.includes({name:?}) && !{PILL_JS};"),
            Duration::from_secs(45),
        )
    });
    ctx.clear_dialog_script();
    landed?;
    choose_access(ctx, "Managed worktree")?;
    choose_mode(ctx, "Ask before changes")?;
    // The tool list a Cowork run is built from asks readiness with no project
    // root, so this is the answer that decides whether the run gets `bash`.
    if let Ok((true, advertised)) = ipc(
        ctx,
        "plugin:agent-tools|advertised_tool_schemas",
        "{ projectRoot: null, reported: null }",
    ) {
        let bash: Vec<String> = advertised["omitted"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|o| o["name"] == "bash")
            .map(|o| o["message"].as_str().unwrap_or("").to_string())
            .collect();
        println!(
            "      NOTE: for a run with no project root, bash {}",
            if bash.is_empty() { "is advertised".to_string() } else { format!("is withheld: {}", bash.join("; ")) }
        );
    }

    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let project = ctx.project.to_string_lossy().to_string();
    let (ok, listed) = ipc(
        ctx,
        "agent_worktree_list",
        &format!("{{ dataFolder: {data:?}, project: {project:?} }}"),
    )?;
    ensure!(ok, "could not list worktrees: {listed}");
    let worktree = listed
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| r.get("path").and_then(Value::as_str))
        .map(PathBuf::from)
        .max_by_key(|p| {
            std::fs::metadata(p)
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
        })
        .ok_or_else(|| fail(format!("choosing Managed worktree made no worktree: {listed}")))?;
    let _ = git(&worktree, &["checkout", "--", "."]);
    let _ = std::fs::remove_file(worktree.join("shell-made.txt"));
    // Explicitly, not only through git: a retry must find the file as it was
    // before the write, or the write changes nothing and there is no diff to
    // show in its prompt.
    std::fs::write(worktree.join(file), &base).map_err(|e| fail(e.to_string()))?;

    // The run: one file write and one shell command, both relative to the
    // run's root, which in this mode is the worktree.
    let proposed = with(&[(1, "LINE 1 (agent)"), (10, "LINE 10 (agent)")]);
    // Absolute paths into the worktree, as the run is told: its tool root is
    // its own sandbox, and the folder it may change is named by path.
    let target_path = worktree.join(file).to_string_lossy().to_string();
    let shell_target = worktree.join("shell-made.txt").to_string_lossy().to_string();
    let write_call = format!(
        "write:{}",
        serde_json::json!({ "path": target_path, "content": proposed })
    );
    let bash_call = format!(
        "bash:{}",
        // Spaced, so it redirects in every shell this host can select: without
        // the space PowerShell reads `from-the-shell>` as one word and echoes it.
        serde_json::json!({ "command": format!("echo from-the-shell > \"{shell_target}\"") })
    );
    ctx.script_model("tools", &[write_call.as_str(), bash_call.as_str()])?;
    ctx.ensure_model_selected()?;
    ctx.type_into("[data-testid=\"chat-input\"]", "update the target file")?;
    ctx.wait_until(
        "the send control to arm",
        "const b = document.querySelector('[data-test-id=\"send-message-button\"]');
         return !!b && b.disabled !== true;",
        Duration::from_secs(60),
    )?;
    ctx.eval(
        "document.querySelector('[data-test-id=\"send-message-button\"]').click();
         return true;",
    )?;
    // Approve each change as a person would, until the run is over. Generous:
    // choosing a shell probes each candidate for up to ten seconds.
    let deadline = std::time::Instant::now() + Duration::from_secs(240);
    // AH-146: the write's prompt shows the change before it is allowed.
    let mut saw_preview = false;
    loop {
        if !saw_preview {
            saw_preview = ctx
                .eval_bool(
                    "const p = document.querySelector('[data-testid=\"approval-preview\"]');
                     return !!p && p.textContent.includes('LINE 1 (agent)');",
                )
                .unwrap_or(false);
        }
        let _ = ctx.eval(
            "const b = [...document.querySelectorAll('button')].find(x =>
               /^allow once$/i.test((x.textContent || '').trim()));
             if (b) b.click();
             return true;",
        );
        let started = ctx
            .eval_bool("return !!document.querySelector('[data-testid=\"tool-activity-item\"]');")
            .unwrap_or(false);
        let idle = ctx
            .eval_bool("return !!document.querySelector('[data-test-id=\"send-message-button\"]');")
            .unwrap_or(false);
        if started && idle {
            break;
        }
        ensure!(
            std::time::Instant::now() < deadline,
            "the run did not finish (tool item shown: {started}, composer idle: {idle}, \
             prompt preview seen: {saw_preview}); {}",
            run_state(ctx)
        );
        std::thread::sleep(Duration::from_millis(700));
    }

    ensure!(
        saw_preview,
        "the write's approval prompt did not show the change it would make"
    );
    ensure!(
        read(&worktree.join(file)) == proposed,
        "the write did not land in the worktree: {:?}",
        read(&worktree.join(file))
    );
    ensure!(read(&ctx.project.join(file)) == base, "the run wrote the attached folder");
    // The shell half is proven only where a shell can be confined at all. A
    // host where every sandboxed shell fails its start-up probe withholds
    // `bash`; that is reported as a limitation of this host, never as a pass.
    let transcript = ctx
        .eval_string("return (document.body.innerText || '');")
        .unwrap_or_default();
    if transcript.contains("bash is unavailable") || transcript.contains("unavailable tool 'bash'") {
        println!(
            "      NOTE: no shell could be started inside the sandbox on this host; \
             the shell's write to the worktree was not exercised"
        );
    } else {
        ensure!(
            shell_text(&worktree.join("shell-made.txt")).contains("from-the-shell"),
            "the confined shell could not write the worktree; transcript: {}",
            {
                // Enough to reach the helper's own diagnostic, which the shell
                // result carries above its exit code.
                let tail: String = transcript.chars().rev().take(3000).collect();
                tail.chars().rev().collect::<String>()
            }
        );
    }
    ensure!(
        !ctx.project.join("shell-made.txt").exists(),
        "the shell wrote the attached folder"
    );

    // Review through the Changes panel, and land one hunk of two.
    ctx.eval_bool(
        r#"const b = [...document.querySelectorAll('button')].find(x =>
             /^Changes$|changed/i.test(x.getAttribute('aria-label') || ''));
           if (!b) return false;
           if (b.getAttribute('aria-pressed') !== 'true') b.click();
           return true;"#,
    )?;
    ctx.wait_until(
        "the Review changes button",
        "return !!document.querySelector('[data-testid=\"proposal-create\"]');",
        Duration::from_secs(30),
    )?;
    ctx.eval("document.querySelector('[data-testid=\"proposal-create\"]').click(); return true;")?;
    ctx.wait_until(
        "the proposed file",
        &format!(
            "return !!document.querySelector('[data-testid=\"proposal-file\"][data-path={file:?}]');"
        ),
        Duration::from_secs(30),
    )?;
    ctx.eval(&format!(
        "const f = document.querySelector('[data-testid=\"proposal-file\"][data-path={file:?}]');
         f.querySelectorAll('[data-testid=\"proposal-hunk-toggle\"]')[1].click();
         const other = document.querySelector('[data-testid=\"proposal-file\"][data-path=\"shell-made.txt\"]');
         if (other) other.querySelector('[data-testid=\"proposal-file-toggle\"]').click();
         return true;"
    ))?;
    ctx.settle();
    ctx.eval("document.querySelector('[data-testid=\"proposal-apply\"]').click(); return true;")?;
    ctx.wait_until(
        "the apply to finish",
        "return !!(document.querySelector('[data-testid=\"proposal-message\"]')
           || document.querySelector('[data-testid=\"proposal-error\"]'));",
        Duration::from_secs(30),
    )?;
    let refused = ctx.eval_string(
        "const e = document.querySelector('[data-testid=\"proposal-error\"]');
         return e ? e.textContent : '';",
    )?;
    ensure!(refused.is_empty(), "applying the selection was refused: {refused}");
    ensure!(
        read(&ctx.project.join(file)) == with(&[(1, "LINE 1 (agent)")]),
        "the folder does not hold exactly the ticked hunk: {:?}",
        read(&ctx.project.join(file))
    );
    ensure!(
        !ctx.project.join("shell-made.txt").exists(),
        "an unticked file was applied"
    );

    let _ = choose_access(ctx, "Review only");
    std::fs::write(ctx.project.join(file), &base).map_err(|e| fail(e.to_string()))?;
    Ok(())
}

const TEAM_FILE: &str = "team-target.txt";
const TEAM_MARKER: &str = "team-review-phase-1.json";

fn team_lines(changes: &[(usize, &str)]) -> String {
    (1..=12)
        .map(|i| match changes.iter().find(|(n, _)| *n == i) {
            Some((_, text)) => format!("{text}\n"),
            None => format!("line {i}\n"),
        })
        .collect()
}

/// Every team child the backend recorded for the fixture project.
fn team_children(ctx: &Ctx) -> Result<Vec<Value>, Failure> {
    let project = ctx.project.to_string_lossy().to_string();
    let (ok, listed) = ipc(
        ctx,
        "agent_team_children_list",
        &format!("{{ project: {project:?}, session: null }}"),
    )?;
    ensure!(ok, "could not list team children: {listed}");
    Ok(listed.as_array().cloned().unwrap_or_default())
}

fn child<'a>(all: &'a [Value], task: &str) -> Option<&'a Value> {
    all.iter().find(|c| c["taskId"] == task)
}

/// The chat requests the model fixture has seen, newest last.
fn mock_requests(ctx: &Ctx) -> Result<Vec<Value>, Failure> {
    let port = ctx.mock_port;
    let raw = ctx.eval_string(&format!(
        "const r = await fetch('http://127.0.0.1:{port}/__requests');
         return JSON.stringify((await r.json()).requests || []);"
    ))?;
    serde_json::from_str(&raw).map_err(|e| Failure(format!("mock requests: {e}")))
}

/// Open the Changes rail and wait for the team review list with `rows` rows.
fn open_team_reviews(ctx: &Ctx, rows: usize) -> ScenarioResult {
    ctx.wait_until(
        "the Changes rail button",
        r#"const b = [...document.querySelectorAll('button')].find(x =>
             /^Changes$|changed/i.test(x.getAttribute('aria-label') || ''));
           if (!b) return false;
           if (b.getAttribute('aria-pressed') !== 'true') b.click();
           return true;"#,
        Duration::from_secs(30),
    )?;
    ctx.wait_until(
        &format!("{rows} team children in the review list"),
        &format!(
            "return document.querySelectorAll('[data-testid=\"team-child\"]').length === {rows};"
        ),
        Duration::from_secs(40),
    )
}

/// One attribute of a child's row in the review list.
fn row_attr(ctx: &Ctx, task: &str, attr: &str) -> Result<String, Failure> {
    ctx.eval_string(&format!(
        "const r = document.querySelector('[data-testid=\"team-child\"][data-task={task:?}]');
         return r ? (r.getAttribute({attr:?}) || '') : '(no row)';"
    ))
}

/// Evaluate inside one child's row: `row` is bound to it.
fn in_row(ctx: &Ctx, task: &str, js: &str) -> Result<Value, Failure> {
    ctx.eval(&format!(
        "const row = document.querySelector('[data-testid=\"team-child\"][data-task={task:?}]');
         if (!row) throw new Error('no row for {task}');
         {js}"
    ))
}

/// Open a child's review, make (or load) its proposal, and wait for its files.
fn open_child_review(ctx: &Ctx, task: &str, file: &str) -> ScenarioResult {
    in_row(
        ctx,
        task,
        "const b = row.querySelector('[data-testid=\"team-child-review\"]');
         if (b.disabled) throw new Error('the review is disabled');
         if (b.getAttribute('aria-expanded') !== 'true') b.click();
         return true;",
    )?;
    let has_file = format!(
        "const row = document.querySelector('[data-testid=\"team-child\"][data-task={task:?}]');
         return !!row && !!row.querySelector('[data-testid=\"proposal-file\"][data-path={file:?}]');"
    );
    // A proposal already stored (after a restart, say) loads by itself; one
    // not yet made is made by asking for it.
    if ctx
        .wait_until("a stored proposal", &has_file, Duration::from_secs(4))
        .is_err()
    {
        in_row(
            ctx,
            task,
            "const b = row.querySelector('[data-testid=\"proposal-create\"]');
             if (!b) throw new Error('no Review changes button');
             b.click(); return true;",
        )?;
    }
    ctx.wait_until(&format!("{task}'s proposed {file}"), &has_file, Duration::from_secs(40))
}

/// Click Apply in a child's review and return the error it shows, if any.
fn apply_child(ctx: &Ctx, task: &str) -> Result<String, Failure> {
    in_row(
        ctx,
        task,
        "row.querySelector('[data-testid=\"proposal-apply\"]').click(); return true;",
    )?;
    ctx.wait_until(
        &format!("{task}'s apply to finish"),
        &format!(
            "const row = document.querySelector('[data-testid=\"team-child\"][data-task={task:?}]');
             return !!row && !!(row.querySelector('[data-testid=\"proposal-message\"]')
               || row.querySelector('[data-testid=\"proposal-error\"]'));"
        ),
        Duration::from_secs(40),
    )?;
    Ok(in_row(
        ctx,
        task,
        "const e = row.querySelector('[data-testid=\"proposal-error\"]');
         return e ? e.textContent : '';",
    )?
    .as_str()
    .unwrap_or_default()
    .to_string())
}

/// Phase one of AH-109 on Windows, through the real app and the mock model.
///
/// A team of four isolated tasks, two of which declare the same file:
/// 1. the overlap is shown before any child runs, naming both tasks and the
///    path, and no child has reached the model or been recorded;
/// 2. it is resolved by running one after the other;
/// 3. every child works in a worktree of its own, and the user's checkout is
///    untouched by the run;
/// 4. the review list names each child's task, branch, base, worktree, files
///    and ending -- one completed, one completed after it, one failed, one
///    cancelled by stopping the run;
/// 5-7. one child's diff is opened and one hunk of two is applied: the folder
///    holds that hunk and not the other;
/// 8. a second child's change is refused against an edit made in the folder
///    since, and nothing of it -- not even its new file -- is written;
/// 11. the failed and cancelled children are shown as such and cannot be
///    reviewed until the person acknowledges it, and a proposal made anyway
///    says so;
/// 10. a junction out of a child's worktree refuses its proposal.
///
/// Phase two restarts the app and checks what is still waiting.
fn scenario_team_review_first(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    let read = |p: &Path| std::fs::read_to_string(p).unwrap_or_default();
    let base = team_lines(&[]);
    if git(&ctx.project, &["ls-files", "--error-unmatch", TEAM_FILE]).is_err() {
        std::fs::write(ctx.project.join(TEAM_FILE), &base).map_err(|e| fail(e.to_string()))?;
        git(&ctx.project, &["add", TEAM_FILE]).map_err(fail)?;
        git(&ctx.project, &["commit", "-qm", "team base"]).map_err(fail)?;
    }
    std::fs::write(ctx.project.join(TEAM_FILE), &base).map_err(|e| fail(e.to_string()))?;
    for stray in ["beta-new.txt", "gamma.txt", "delta.txt"] {
        let _ = std::fs::remove_file(ctx.project.join(stray));
    }
    let head = git(&ctx.project, &["rev-parse", "HEAD"]).map_err(fail)?.trim().to_string();
    ensure!(
        team_children(ctx)?.is_empty(),
        "this profile already holds team children; phase one needs a fresh one"
    );

    attach_project(ctx)?;
    choose_access(ctx, "Managed worktree")?;
    choose_mode(ctx, "Ask before changes")?;
    // Switching to Managed worktree makes the session's own worktree; until it
    // exists the run is still being set up, and a message sent now goes out
    // with the read-only toolset.
    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let project_arg = ctx.project.to_string_lossy().to_string();
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let (ok, listed) = ipc(
            ctx,
            "agent_worktree_list",
            &format!("{{ dataFolder: {data:?}, project: {project_arg:?} }}"),
        )?;
        if ok && listed.as_array().is_some_and(|a| !a.is_empty()) {
            break;
        }
        ensure!(Instant::now() < deadline, "choosing Managed worktree made no worktree: {listed}");
        std::thread::sleep(Duration::from_millis(500));
    }
    ctx.settle();
    // What the tool list says about the shell here, in the app's own process.
    let (ok, advertised) = ipc(
        ctx,
        "plugin:agent-tools|advertised_tool_schemas",
        &format!("{{ projectRoot: {project_arg:?}, reported: null }}"),
    )?;
    if ok {
        let bash: Vec<String> = advertised["omitted"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|o| o["name"] == "bash")
            .map(|o| o["message"].as_str().unwrap_or("").to_string())
            .collect();
        println!(
            "      NOTE: bash {}",
            if bash.is_empty() { "is advertised".to_string() } else { format!("is withheld: {}", bash.join("; ")) }
        );
    }

    let alpha = team_lines(&[(1, "LINE 1 (alpha)"), (10, "LINE 10 (alpha)")]);
    let beta = team_lines(&[(5, "LINE 5 (beta)")]);
    let write = |file: &str, content: &str| {
        format!(
            "write:{}",
            serde_json::json!({ "path": format!("{{{{FOLDER}}}}/{file}"), "content": content })
        )
    };
    let team = serde_json::json!({ "tasks": [
        { "id": "alpha", "description": "TASK-ALPHA: rewrite lines 1 and 10 of team-target.txt",
          "writes": [TEAM_FILE], "isolate": true },
        { "id": "beta", "description": "TASK-BETA: rewrite line 5 of team-target.txt and add beta-new.txt",
          "writes": [TEAM_FILE, "beta-new.txt"], "isolate": true },
        { "id": "gamma", "description": "TASK-GAMMA: add gamma.txt",
          "writes": ["gamma.txt"], "isolate": true },
        { "id": "delta", "description": "TASK-DELTA: add delta.txt",
          "writes": ["delta.txt"], "isolate": true }
    ]});
    let routes = serde_json::json!([
        { "match": "TASK-ALPHA", "tools": [write(TEAM_FILE, &alpha)], "summary": "alpha done" },
        { "match": "TASK-BETA", "tools": [write(TEAM_FILE, &beta), write("beta-new.txt", "made by beta\n")],
          "summary": "beta done" },
        { "match": "TASK-GAMMA", "tools": [write("gamma.txt", "half of gamma\n")], "then": "fail" },
        { "match": "TASK-DELTA", "tools": [write("delta.txt", "delta so far\n")], "then": "slow" }
    ]);
    let port = ctx.mock_port;
    let team_call = format!("team:{team}");
    ensure!(
        ctx.eval_bool(&format!(
            r#"const res = await fetch('http://127.0.0.1:{port}/__control', {{
                 method: 'POST', headers: {{ 'Content-Type': 'application/json' }},
                 body: JSON.stringify({{ script: 'tools', tools: [{team_call:?}], routes: {routes} }}),
               }});
               return res.ok;"#
        ))?,
        "could not script the team"
    );
    ctx.ensure_model_selected()?;
    // An imperative: a first message that only describes work is answered
    // with a read-only proposal, by design, and could not dispatch a team.
    ctx.type_into("[data-testid=\"chat-input\"]", "Implement these four tasks as a team.")?;
    ctx.wait_until(
        "the send control to arm",
        "const b = document.querySelector('[data-test-id=\"send-message-button\"]');
         return !!b && b.disabled !== true;",
        Duration::from_secs(60),
    )?;
    ctx.eval("document.querySelector('[data-test-id=\"send-message-button\"]').click(); return true;")?;

    // 1. The overlap, before anything runs.
    // In Ask mode the team call itself waits for Allow once, like any call
    // that can change something; the overlap is shown after that, and before
    // any child is provisioned.
    let shown_by = Instant::now() + Duration::from_secs(90);
    let mut seen = false;
    while Instant::now() < shown_by {
        let _ = ctx.eval(
            "const b = [...document.querySelectorAll('button')].find(x =>
               /^allow once$/i.test((x.textContent || '').trim()));
             if (b) b.click();
             return true;",
        );
        if ctx
            .eval_bool(
                "const r = document.querySelector('[data-testid=\"team-conflict\"]');
                 return !!r && r.getAttribute('data-tasks') === 'alpha,beta';",
            )
            .unwrap_or(false)
        {
            seen = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(700));
    }
    if !seen {
        let e = "the overlap between alpha and beta was not shown within 90s";
        let offered: Vec<String> = mock_requests(ctx)
            .unwrap_or_default()
            .iter()
            .map(|r| {
                r["tools"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|t| t["function"]["name"].as_str())
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .collect();
        bail!("{e}
      tools offered per request: {offered:?}
      {}", run_state(ctx));
    }
    let shown = ctx.eval_string(
        "return document.querySelector('[data-testid=\"team-conflicts\"]').innerText;",
    )?;
    ensure!(
        shown.contains(TEAM_FILE) && shown.contains("TASK-ALPHA") && shown.contains("TASK-BETA"),
        "the overlap does not name both tasks and the path: {shown}"
    );
    ensure!(
        ctx.eval_bool("return document.querySelectorAll('[data-testid=\"team-conflict\"]').length === 1;")?,
        "only alpha and beta overlap, but more was reported"
    );
    let early = mock_requests(ctx)?;
    ensure!(
        !serde_json::to_string(&early).unwrap_or_default().contains("TASK-ALPHA: rewrite")
            || early.iter().all(|r| {
                r["messages"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|m| m["role"] == "user")
                    .all(|m| !m.to_string().contains("TASK-"))
            }),
        "a child reached the model before the overlap was decided"
    );
    ensure!(
        team_children(ctx)?.is_empty(),
        "a child was recorded as started before the overlap was decided"
    );

    // 2. Run one after the other.
    ctx.eval(
        "const r = document.querySelector('[data-testid=\"team-conflict\"]');
         r.querySelector('input[data-choice=\"serialize-ab\"]').click();
         return true;",
    )?;
    ctx.wait_until(
        "Continue to arm",
        "const b = document.querySelector('[data-testid=\"team-conflicts-continue\"]');
         return !!b && !b.disabled;",
        Duration::from_secs(10),
    )?;
    ctx.eval("document.querySelector('[data-testid=\"team-conflicts-continue\"]').click(); return true;")?;

    // 3. The children work, each write allowed as a person would; the run is
    // stopped once only delta -- scripted never to finish -- is left.
    let deadline = Instant::now() + Duration::from_secs(300);
    let mut stopped = false;
    loop {
        let _ = ctx.eval(
            "const b = [...document.querySelectorAll('button')].find(x =>
               /^allow once$/i.test((x.textContent || '').trim()));
             if (b) b.click();
             return true;",
        );
        let all = team_children(ctx)?;
        let status = |t: &str| {
            child(&all, t)
                .and_then(|c| c["status"].as_str())
                .unwrap_or("-")
                .to_string()
        };
        let delta_wrote = child(&all, "delta")
            .map(|c| Path::new(c["worktreePath"].as_str().unwrap_or("")).join("delta.txt").exists())
            .unwrap_or(false);
        if !stopped
            && status("alpha") == "completed"
            && status("beta") == "completed"
            && status("gamma") == "failed"
            && status("delta") == "running"
            && delta_wrote
        {
            // Cowork's own stop: a menu, and "Stop current task" ends this
            // response and everything under it -- here, delta.
            ctx.eval(
                "const b = document.querySelector('[data-testid=\"cowork-stop\"]');
                 if (!b) throw new Error('no stop control');
                 b.click(); return true;",
            )?;
            ctx.wait_until(
                "the stop menu",
                "return !!document.querySelector('[data-testid=\"stop-current\"]');",
                Duration::from_secs(10),
            )?;
            ctx.eval(
                "document.querySelector('[data-testid=\"stop-current\"]').click(); return true;",
            )?;
            stopped = true;
        }
        if stopped && status("delta") == "cancelled" {
            break;
        }
        ensure!(
            Instant::now() < deadline,
            "the team did not reach the expected endings (alpha {}, beta {}, gamma {}, delta {}, delta wrote {delta_wrote}); {}",
            status("alpha"),
            status("beta"),
            status("gamma"),
            status("delta"),
            run_state(ctx)
        );
        std::thread::sleep(Duration::from_millis(700));
    }
    ctx.wait_until(
        "the composer to be idle after stopping",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(60),
    )?;

    let all = team_children(ctx)?;
    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let roots = tauri_plugin_agent_tools::workspace::worktrees_dir(Path::new(&data))
        .canonicalize()
        .map_err(|e| fail(format!("Jan's worktree folder: {e}")))?;
    let mut paths = std::collections::BTreeSet::new();
    for task in ["alpha", "beta", "gamma", "delta"] {
        let c = child(&all, task).ok_or_else(|| fail(format!("{task} was never recorded")))?;
        let wt = PathBuf::from(c["worktreePath"].as_str().unwrap_or_default());
        let resolved = wt.canonicalize().map_err(|e| fail(format!("{task}'s worktree: {e}")))?;
        ensure!(resolved.starts_with(&roots), "{task} worked outside Jan's worktrees: {}", wt.display());
        ensure!(c["baseSha"] == head.as_str(), "{task}'s base is not the project's HEAD: {}", c["baseSha"]);
        ensure!(
            c["branch"].as_str().unwrap_or("").starts_with("jan/cowork/"),
            "{task}'s branch is not Jan's: {}",
            c["branch"]
        );
        paths.insert(resolved);
    }
    ensure!(paths.len() == 4, "two children shared a worktree");
    let a = child(&all, "alpha").unwrap();
    let b = child(&all, "beta").unwrap();
    ensure!(
        a["endedAt"].as_str().unwrap_or("~") <= b["startedAt"].as_str().unwrap_or(""),
        "beta started before alpha finished: alpha ended {}, beta started {}",
        a["endedAt"],
        b["startedAt"]
    );
    let alpha_wt = PathBuf::from(a["worktreePath"].as_str().unwrap_or_default());
    ensure!(read(&alpha_wt.join(TEAM_FILE)) == alpha, "alpha's change is not in its worktree");
    ensure!(read(&ctx.project.join(TEAM_FILE)) == base, "the team wrote the attached folder");
    for stray in ["beta-new.txt", "gamma.txt", "delta.txt"] {
        ensure!(!ctx.project.join(stray).exists(), "a child wrote {stray} into the attached folder");
    }

    // 4. The review list.
    open_team_reviews(ctx, 4)?;
    for (task, state) in [("alpha", "completed"), ("beta", "completed"), ("gamma", "failed"), ("delta", "cancelled")] {
        let got = row_attr(ctx, task, "data-state")?;
        ensure!(got == state, "{task} is listed as {got}, not {state}");
    }
    let identity = in_row(
        ctx,
        "alpha",
        "return row.querySelector('[data-testid=\"team-child-identity\"]').textContent
           + '|' + [...row.querySelectorAll('[data-testid=\"team-child-file\"]')].map(f => f.textContent).join(',');",
    )?;
    let identity = identity.as_str().unwrap_or_default();
    ensure!(
        identity.contains("jan/cowork/") && identity.contains(&head[..10]) && identity.contains(TEAM_FILE)
            && identity.contains("+2") && identity.contains("-2"),
        "alpha's row does not identify its branch, base and change: {identity}"
    );

    // 11. Failed and cancelled children cannot pass as clean work.
    for task in ["gamma", "delta"] {
        ensure!(
            row_attr(ctx, task, "data-problem")? == "incomplete",
            "{task}'s ending is not reported as a problem"
        );
        let disabled = in_row(
            ctx,
            task,
            "return row.querySelector('[data-testid=\"team-child-review\"]').disabled;",
        )?;
        ensure!(disabled == Value::Bool(true), "{task} can be reviewed without acknowledging how it ended");
    }
    let project = ctx.project.to_string_lossy().to_string();
    let _ = project;
    let session = a["parentSession"].as_str().unwrap_or_default().to_string();
    let (ok, refused) = ipc(
        ctx,
        "agent_team_child_propose",
        &format!("{{ parentSession: {session:?}, taskId: 'gamma', acknowledge: false }}"),
    )?;
    ensure!(
        !ok && refused["kind"] == "incomplete",
        "a failed child's work was proposed as clean: {refused}"
    );
    in_row(
        ctx,
        "gamma",
        "row.querySelector('[data-testid=\"team-child-acknowledge\"]').click(); return true;",
    )?;
    ctx.settle();
    open_child_review(ctx, "gamma", "gamma.txt")?;
    let subject = in_row(
        ctx,
        "gamma",
        "const s = row.querySelector('[data-testid=\"proposal-subject\"]'); return s ? s.textContent : '';",
    )?;
    ensure!(
        subject.as_str().unwrap_or("").contains("failed, reviewed despite the warning"),
        "the proposal of a failed child does not say so: {subject}"
    );

    // 5-7. Alpha: the diff, one hunk of two.
    open_child_review(ctx, "alpha", TEAM_FILE)?;
    let hunks = in_row(
        ctx,
        "alpha",
        &format!(
            "const f = row.querySelector('[data-testid=\"proposal-file\"][data-path={TEAM_FILE:?}]');
             const t = f.querySelectorAll('[data-testid=\"proposal-hunk-toggle\"]');
             if (t.length !== 2) return t.length;
             t[1].click();
             return f.innerText;"
        ),
    )?;
    let hunks = hunks.as_str().unwrap_or_default().to_string();
    ensure!(
        hunks.contains("LINE 1 (alpha)") && hunks.contains("LINE 10 (alpha)"),
        "alpha's diff does not show both hunks: {hunks}"
    );
    ctx.settle();
    let refused = apply_child(ctx, "alpha")?;
    ensure!(refused.is_empty(), "applying alpha's first hunk was refused: {refused}");
    let after_alpha = team_lines(&[(1, "LINE 1 (alpha)")]);
    ensure!(
        read(&ctx.project.join(TEAM_FILE)) == after_alpha,
        "the folder does not hold exactly alpha's ticked hunk: {:?}",
        read(&ctx.project.join(TEAM_FILE))
    );

    // 8. Beta against an edit made in the folder since: refused, nothing written.
    let mine = team_lines(&[(1, "LINE 1 (alpha)"), (5, "line 5 (mine)")]);
    std::fs::write(ctx.project.join(TEAM_FILE), &mine).map_err(|e| fail(e.to_string()))?;
    open_child_review(ctx, "beta", TEAM_FILE)?;
    ensure!(
        in_row(ctx, "beta", "return !!row.querySelector('[data-testid=\"proposal-file\"][data-path=\"beta-new.txt\"]');")?
            == Value::Bool(true),
        "beta's new file is not in its review"
    );
    let refused = apply_child(ctx, "beta")?;
    ensure!(!refused.is_empty(), "beta applied over an edit made in the folder since");
    ensure!(
        in_row(ctx, "beta", "return !!row.querySelector('[data-testid=\"proposal-conflict\"]');")? == Value::Bool(true),
        "the conflict is not shown against beta's hunk"
    );
    ensure!(read(&ctx.project.join(TEAM_FILE)) == mine, "a refused apply changed the folder");
    ensure!(!ctx.project.join("beta-new.txt").exists(), "a refused apply wrote part of beta's change");

    // 10. A junction out of gamma's worktree.
    let outside = ctx.workspace.join("team-outside");
    std::fs::create_dir_all(&outside).map_err(|e| fail(e.to_string()))?;
    std::fs::write(outside.join("secret.txt"), "not the child's\n").map_err(|e| fail(e.to_string()))?;
    let gamma_wt = PathBuf::from(child(&all, "gamma").unwrap()["worktreePath"].as_str().unwrap_or_default());
    let link = gamma_wt.join("escape");
    if !link.exists() {
        // `mklink` reads a forward slash as a switch, and the kept workspace
        // path is spelled with them.
        let native = |p: &Path| p.to_string_lossy().replace('/', "\\");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(native(&link))
            .arg(native(&outside))
            .output()
            .map_err(|e| fail(e.to_string()))?;
        ensure!(made.status.success(), "could not make a junction: {}", String::from_utf8_lossy(&made.stderr));
    }
    let (ok, refused) = ipc(
        ctx,
        "agent_team_child_propose",
        &format!("{{ parentSession: {session:?}, taskId: 'gamma', acknowledge: true }}"),
    )?;
    ensure!(
        !ok && refused["kind"] == "link-escape",
        "a junction out of a child's worktree did not refuse its proposal: {refused}"
    );

    std::fs::write(
        ctx.workspace.join(TEAM_MARKER),
        serde_json::json!({ "session": session, "head": head }).to_string(),
    )
    .map_err(|e| fail(e.to_string()))
}

/// Phase two, a new process on the same profile: every child is still listed
/// with its ending, alpha as partly applied, beta's review still waiting with
/// its proposal intact, gamma refused for its junction -- and beta applies once
/// the folder no longer conflicts.
fn scenario_team_review_second(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    let read = |p: &Path| std::fs::read_to_string(p).unwrap_or_default();
    let marker: Value = serde_json::from_str(
        &std::fs::read_to_string(ctx.workspace.join(TEAM_MARKER))
            .map_err(|_| fail("phase one did not run against this workspace".into()))?,
    )
    .map_err(|e| fail(e.to_string()))?;
    let session = marker["session"].as_str().unwrap_or_default().to_string();

    let all = team_children(ctx)?;
    ensure!(all.len() == 4, "the restart lost team children: {} left", all.len());
    for (task, state) in [("alpha", "completed"), ("beta", "completed"), ("gamma", "failed"), ("delta", "cancelled")] {
        let got = child(&all, task).and_then(|c| c["state"].as_str()).unwrap_or("-");
        ensure!(got == state, "after a restart {task} is {got}, not {state}");
    }
    ensure!(
        child(&all, "gamma").and_then(|c| c["problem"]["kind"].as_str()) == Some("link-escape"),
        "after a restart gamma's junction is not reported"
    );

    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the cowork composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    open_team_reviews(ctx, 4)?;
    for (task, proposal) in [("alpha", "partially-applied"), ("beta", "pending"), ("gamma", "pending")] {
        let got = row_attr(ctx, task, "data-proposal")?;
        ensure!(got == proposal, "after a restart {task}'s proposal is {got:?}, not {proposal}");
    }
    ensure!(row_attr(ctx, "delta", "data-state")? == "cancelled", "delta's cancellation was lost");

    // Beta's stored review, reopened; the folder is put back so it can land.
    open_child_review(ctx, "beta", TEAM_FILE)?;
    let after_alpha = team_lines(&[(1, "LINE 1 (alpha)")]);
    std::fs::write(ctx.project.join(TEAM_FILE), &after_alpha).map_err(|e| fail(e.to_string()))?;
    let refused = apply_child(ctx, "beta")?;
    ensure!(refused.is_empty(), "beta's stored proposal was refused after the restart: {refused}");
    ensure!(
        read(&ctx.project.join(TEAM_FILE)) == team_lines(&[(1, "LINE 1 (alpha)"), (5, "LINE 5 (beta)")]),
        "the folder does not hold alpha's hunk and beta's change: {:?}",
        read(&ctx.project.join(TEAM_FILE))
    );
    ensure!(
        read(&ctx.project.join("beta-new.txt")) == "made by beta\n",
        "beta's new file did not land"
    );
    let _ = session;
    // Leave the fixture as it was.
    std::fs::write(ctx.project.join(TEAM_FILE), team_lines(&[])).map_err(|e| fail(e.to_string()))?;
    let _ = std::fs::remove_file(ctx.project.join("beta-new.txt"));
    Ok(())
}

/// A file a shell wrote, as text: Windows PowerShell's `>` writes UTF-16 with
/// a byte-order mark, cmd and bash write bytes as given.
fn shell_text(path: &Path) -> String {
    let Ok(bytes) = std::fs::read(path) else {
        return String::new();
    };
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Call a Tauri command over real IPC and hand back its JSON, or the refusal.
///
/// A refusal is data here, not a harness failure: several steps below exist to
/// prove that something is refused.
fn ipc(ctx: &Ctx, command: &str, args: &str) -> Result<(bool, Value), Failure> {
    let out = ctx.eval_string(&format!(
        r#"try {{
             const v = await window.__TAURI_INTERNALS__.invoke({command:?}, {args});
             return JSON.stringify({{ ok: true, v }});
           }} catch (e) {{
             return JSON.stringify({{ ok: false, v: e }});
           }}"#
    ))?;
    let parsed: Value = serde_json::from_str(&out)
        .map_err(|e| Failure(format!("{command} did not answer JSON ({e}): {out}")))?;
    Ok((
        parsed.get("ok").and_then(Value::as_bool).unwrap_or(false),
        parsed.get("v").cloned().unwrap_or(Value::Null),
    ))
}

/// A worktree's work reaches the folder only through a stored, bound proposal.
/// AH-146/147/148/109, on Windows, over real IPC into the real backend.
///
/// Driven through IPC rather than the access menu because Windows cannot
/// offer Managed worktree mode at all: AppContainer cannot yet confine a run
/// to a repository (`jail::supports_write_roots`), so the option is disabled
/// and the review that sits behind it is unreachable here. The backend, git
/// and the filesystem behaviour this proves are the Windows ones.
///
/// Proves: the proposal is stored before anything is approved and the folder is
/// untouched; approving one hunk of two lands only that hunk and an unselected
/// file stays out; a second proposal whose hunk overlaps an edit made in the
/// folder since is refused with that hunk named and nothing written; a changed
/// patch hash and a different agent are both refused; a rejected proposal
/// cannot then be applied; the audit trail holds no file content.
fn scenario_proposal_review(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    let file = "proposal-target.txt";
    let added = "agent-added.txt";
    let base: String = (1..=12).map(|i| format!("line {i}\n")).collect();
    let with = |lines: &[(usize, &str)]| -> String {
        (1..=12)
            .map(|i| match lines.iter().find(|(n, _)| *n == i) {
                Some((_, text)) => format!("{text}\n"),
                None => format!("line {i}\n"),
            })
            .collect()
    };
    let read = |p: &Path| std::fs::read_to_string(p).unwrap_or_default();

    // Committed in the source before the worktree exists, so it is the base.
    if git(&ctx.project, &["ls-files", "--error-unmatch", file]).is_err() {
        std::fs::write(ctx.project.join(file), &base).map_err(|e| fail(e.to_string()))?;
        git(&ctx.project, &["add", file]).map_err(fail)?;
        git(&ctx.project, &["commit", "-qm", "proposal base"]).map_err(fail)?;
    }
    std::fs::write(ctx.project.join(file), &base).map_err(|e| fail(e.to_string()))?;
    let _ = std::fs::remove_file(ctx.project.join(added));

    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let project = ctx.project.to_string_lossy().to_string();
    let session = "smoke-proposal";
    let (ok, record) = ipc(
        ctx,
        "agent_worktree_ensure",
        &format!("{{ dataFolder: {data:?}, sessionId: {session:?}, project: {project:?} }}"),
    )?;
    ensure!(ok, "could not make the worktree: {record}");
    let worktree = PathBuf::from(record.get("path").and_then(Value::as_str).unwrap_or_default());
    // A retry finds the worktree the last attempt left; start it from its base.
    let _ = git(&worktree, &["checkout", "--", "."]);
    let _ = std::fs::remove_file(worktree.join(added));

    std::fs::write(
        worktree.join(file),
        with(&[(1, "LINE 1 (agent)"), (10, "LINE 10 (agent)")]),
    )
    .map_err(|e| fail(e.to_string()))?;
    std::fs::write(worktree.join(added), "made by the agent\n").map_err(|e| fail(e.to_string()))?;

    let propose = |ctx: &Ctx| -> Result<Value, Failure> {
        let (ok, proposal) = ipc(
            ctx,
            "agent_proposal_from_worktree",
            &format!("{{ record: {record}, session: {session:?}, run: null, agent: null }}"),
        )?;
        ensure!(ok, "the worktree's changes were not proposed: {proposal}");
        Ok(proposal)
    };
    let proposal = propose(ctx)?;
    let id = proposal["id"].as_str().unwrap_or_default().to_string();

    // Stored before anything is approved; the folder untouched by proposing.
    let stored = read(&Path::new(&data).join("proposals").join(format!("{id}.json")));
    ensure!(
        stored.contains("\"state\": \"pending\""),
        "the proposal was not stored before approval"
    );
    ensure!(read(&ctx.project.join(file)) == base, "proposing changed the folder");

    let hunks_of = |p: &Value, path: &str| -> Vec<String> {
        p["files"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|f| f["path"] == path)
            .flat_map(|f| f["hunks"].as_array().cloned().unwrap_or_default())
            .filter_map(|h| h["id"].as_str().map(str::to_string))
            .collect()
    };
    let approval = |p: &Value, files: Value| -> Value {
        serde_json::json!({
            "proposalId": p["id"],
            "patchHash": p["patchHash"],
            "baseStateHash": p["baseStateHash"],
            "scope": p["scope"],
            "files": files,
        })
    };
    let hunks = hunks_of(&proposal, file);
    ensure!(hunks.len() == 2, "expected two hunks, got {hunks:?}");

    // Tampered and foreign approvals are refused before anything is written.
    let mut tampered = approval(&proposal, serde_json::json!([{ "path": file, "hunks": { "kind": "all" } }]));
    tampered["patchHash"] = Value::String("0".repeat(64));
    let (ok, refusal) = ipc(ctx, "agent_proposal_apply", &format!("{{ approval: {tampered} }}"))?;
    ensure!(!ok, "an approval for a different patch was applied");
    ensure!(
        refusal.to_string().contains("different version"),
        "the refusal did not say why: {refusal}"
    );
    let mut foreign = approval(&proposal, serde_json::json!([{ "path": file, "hunks": { "kind": "all" } }]));
    foreign["scope"]["agent"] = Value::String("reviewer".into());
    let (ok, _) = ipc(ctx, "agent_proposal_apply", &format!("{{ approval: {foreign} }}"))?;
    ensure!(!ok, "an approval naming another agent was applied");
    ensure!(read(&ctx.project.join(file)) == base, "a refused approval wrote the folder");

    // One hunk of two, and not the added file.
    let first = approval(
        &proposal,
        serde_json::json!([{ "path": file, "hunks": { "kind": "only", "ids": [hunks[0]] } }]),
    );
    let (ok, report) = ipc(ctx, "agent_proposal_apply", &format!("{{ approval: {first} }}"))?;
    ensure!(ok, "applying one hunk was refused: {report}");
    ensure!(
        report["state"] == "partially-applied",
        "one hunk of two should be a partial apply: {report}"
    );
    ensure!(
        read(&ctx.project.join(file)) == with(&[(1, "LINE 1 (agent)")]),
        "the folder does not hold exactly the approved hunk: {:?}",
        read(&ctx.project.join(file))
    );
    ensure!(!ctx.project.join(added).exists(), "an unselected file was applied");

    // Second round: the agent changes line 6, and so does the person, in the
    // folder, before approving. Refused, the hunk named, nothing written.
    std::fs::write(
        worktree.join(file),
        with(&[(1, "LINE 1 (agent)"), (6, "LINE 6 (agent)"), (10, "LINE 10 (agent)")]),
    )
    .map_err(|e| fail(e.to_string()))?;
    let second = propose(ctx)?;
    let user_edit = with(&[(1, "LINE 1 (agent)"), (6, "line 6 (edited by the person)")]);
    std::fs::write(ctx.project.join(file), &user_edit).map_err(|e| fail(e.to_string()))?;
    let everything = approval(
        &second,
        serde_json::json!([
            { "path": file, "hunks": { "kind": "all" } },
            { "path": added, "hunks": { "kind": "all" } }
        ]),
    );
    let (ok, refusal) = ipc(ctx, "agent_proposal_apply", &format!("{{ approval: {everything} }}"))?;
    ensure!(!ok, "an apply over a conflicting edit went through");
    let conflicts = refusal["conflicts"].as_array().cloned().unwrap_or_default();
    ensure!(
        conflicts.len() == 1 && conflicts[0]["path"] == file && conflicts[0]["hunk"] != "",
        "the conflict was not reported against its hunk: {refusal}"
    );
    ensure!(read(&ctx.project.join(file)) == user_edit, "a refused apply wrote the folder");
    ensure!(!ctx.project.join(added).exists(), "a refused apply created a file");

    // Rejected, and then not appliable.
    let (ok, rejected) = ipc(
        ctx,
        "agent_proposal_reject",
        &format!("{{ id: {:?}, scope: {} }}", second["id"].as_str().unwrap_or_default(), second["scope"]),
    )?;
    ensure!(ok && rejected["state"] == "rejected", "rejecting failed: {rejected}");
    let (ok, _) = ipc(ctx, "agent_proposal_apply", &format!("{{ approval: {everything} }}"))?;
    ensure!(!ok, "a rejected proposal was applied");
    ensure!(read(&ctx.project.join(file)) == user_edit, "rejecting changed the folder");

    // The audit trail links every step and holds no content.
    let audit = read(&Path::new(&data).join("audit").join("proposals.jsonl"));
    for event in ["created", "applied", "conflict", "refused", "rejected"] {
        ensure!(
            audit.contains(&format!("\"event\":\"{event}\"")),
            "the proposal audit has no {event} event"
        );
    }
    ensure!(
        !audit.contains("(agent)") && !audit.contains("made by the agent"),
        "the proposal audit holds file content"
    );

    // Leave nothing behind: the worktree is this scenario's own.
    let _ = ipc(
        ctx,
        "agent_worktree_discard",
        &format!("{{ dataFolder: {data:?}, record: {record}, force: true }}"),
    );
    std::fs::write(ctx.project.join(file), &base).map_err(|e| fail(e.to_string()))?;
    Ok(())
}

/// A dependency, a lock file and a migration in a worktree's changes are
/// flagged by the backend, and none of them is applied until the approval
/// acknowledges it -- over real IPC, into the real backend. AH-154/155/156.
fn scenario_proposal_flags(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    let read = |p: &Path| std::fs::read_to_string(p).unwrap_or_default();
    // In a folder of its own: the fixture project has a package.json of its
    // own at its root, with no dependencies.
    let manifest = "flags-fixture/package.json";
    let lock = "flags-fixture/yarn.lock";
    let migration = "db/migrations/0002_drop_users.sql";
    std::fs::create_dir_all(ctx.project.join("flags-fixture")).map_err(|e| fail(e.to_string()))?;
    let before = "{\n  \"name\": \"fixture\",\n  \"dependencies\": {\n    \"react\": \"^18.0.0\"\n  }\n}\n";
    let after = "{\n  \"name\": \"fixture\",\n  \"dependencies\": {\n    \"react\": \"^19.0.0\",\n    \"left-pad\": \"1.3.0\"\n  }\n}\n";

    if git(&ctx.project, &["ls-files", "--error-unmatch", manifest]).is_err() {
        std::fs::write(ctx.project.join(manifest), before).map_err(|e| fail(e.to_string()))?;
        git(&ctx.project, &["add", manifest]).map_err(fail)?;
        git(&ctx.project, &["commit", "-qm", "flags base"]).map_err(fail)?;
    }
    std::fs::write(ctx.project.join(manifest), before).map_err(|e| fail(e.to_string()))?;
    let _ = std::fs::remove_file(ctx.project.join(lock));
    let _ = std::fs::remove_dir_all(ctx.project.join("db"));

    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let project = ctx.project.to_string_lossy().to_string();
    let session = "smoke-proposal-flags";
    let (ok, record) = ipc(
        ctx,
        "agent_worktree_ensure",
        &format!("{{ dataFolder: {data:?}, sessionId: {session:?}, project: {project:?} }}"),
    )?;
    ensure!(ok, "could not make the worktree: {record}");
    let worktree = PathBuf::from(record.get("path").and_then(Value::as_str).unwrap_or_default());
    let _ = git(&worktree, &["checkout", "--", "."]);
    std::fs::create_dir_all(worktree.join("flags-fixture")).map_err(|e| fail(e.to_string()))?;
    std::fs::write(worktree.join(manifest), after).map_err(|e| fail(e.to_string()))?;
    std::fs::write(worktree.join(lock), "left-pad@1.3.0:\n  resolved \"https://registry.example/left-pad\"\n")
        .map_err(|e| fail(e.to_string()))?;
    std::fs::create_dir_all(worktree.join("db/migrations")).map_err(|e| fail(e.to_string()))?;
    std::fs::write(worktree.join(migration), "DROP TABLE users;\n").map_err(|e| fail(e.to_string()))?;

    let (ok, proposal) = ipc(
        ctx,
        "agent_proposal_from_worktree",
        &format!("{{ record: {record}, session: {session:?}, run: null, agent: null }}"),
    )?;
    ensure!(ok, "the worktree's changes were not proposed: {proposal}");
    let kinds = |path: &str| -> Vec<String> {
        proposal["files"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|f| f["path"] == path)
            .flat_map(|f| f["flags"].as_array().cloned().unwrap_or_default())
            .filter_map(|f| f["kind"].as_str().map(str::to_string))
            .collect()
    };
    ensure!(kinds(manifest) == ["dependency"], "package.json flags: {:?}", kinds(manifest));
    ensure!(kinds(lock) == ["lockfile"], "yarn.lock flags: {:?}", kinds(lock));
    ensure!(kinds(migration) == ["migration"], "migration flags: {:?}", kinds(migration));
    ensure!(
        proposal.to_string().contains("left-pad (dependencies) added at 1.3.0")
            && proposal.to_string().contains("react (dependencies) changed from ^18.0.0 to ^19.0.0"),
        "the dependency flag does not say what changed: {}",
        proposal["files"]
    );

    let approval = |acknowledged: Value| -> Value {
        serde_json::json!({
            "proposalId": proposal["id"],
            "patchHash": proposal["patchHash"],
            "baseStateHash": proposal["baseStateHash"],
            "scope": proposal["scope"],
            "files": [
                { "path": manifest, "hunks": { "kind": "all" } },
                { "path": lock, "hunks": { "kind": "all" } },
                { "path": migration, "hunks": { "kind": "all" } }
            ],
            "acknowledged": acknowledged,
        })
    };

    // Refused, typed and whole, without the acknowledgement -- and with one
    // that names only some of the flagged files.
    for acknowledged in [serde_json::json!([]), serde_json::json!([manifest])] {
        let a = approval(acknowledged);
        let (ok, refusal) = ipc(ctx, "agent_proposal_apply", &format!("{{ approval: {a} }}"))?;
        ensure!(!ok, "a flagged change was applied without being acknowledged");
        let named: Vec<&str> = refusal["unacknowledged"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        ensure!(
            named.contains(&lock) && named.contains(&migration),
            "the refusal did not name the unacknowledged files: {refusal}"
        );
        ensure!(read(&ctx.project.join(manifest)) == before, "a refused apply wrote package.json");
        ensure!(!ctx.project.join(lock).exists(), "a refused apply wrote the lock file");
        ensure!(!ctx.project.join(migration).exists(), "a refused apply wrote the migration");
    }

    // Acknowledged: everything lands.
    let a = approval(serde_json::json!([manifest, lock, migration]));
    let (ok, report) = ipc(ctx, "agent_proposal_apply", &format!("{{ approval: {a} }}"))?;
    ensure!(ok, "the acknowledged change was refused: {report}");
    ensure!(read(&ctx.project.join(manifest)) == after, "package.json did not land");
    ensure!(ctx.project.join(migration).exists(), "the migration did not land");

    let _ = ipc(
        ctx,
        "agent_worktree_discard",
        &format!("{{ dataFolder: {data:?}, record: {record}, force: true }}"),
    );
    std::fs::write(ctx.project.join(manifest), before).map_err(|e| fail(e.to_string()))?;
    let _ = std::fs::remove_file(ctx.project.join(lock));
    let _ = std::fs::remove_dir_all(ctx.project.join("db"));
    Ok(())
}

/// A managed worktree exports as a patch bundle that reproduces it, over real
/// IPC into the real backend; the user's checkout is not touched, and the
/// checkout itself cannot be exported as if it were a worktree. AH-168.
fn scenario_worktree_export(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let project = ctx.project.to_string_lossy().to_string();
    let session = "smoke-export";
    let file = "export-target.txt";
    if git(&ctx.project, &["ls-files", "--error-unmatch", file]).is_err() {
        std::fs::write(ctx.project.join(file), "a\nb\nc\n").map_err(|e| fail(e.to_string()))?;
        git(&ctx.project, &["add", file]).map_err(fail)?;
        git(&ctx.project, &["commit", "-qm", "export base"]).map_err(fail)?;
    }
    let status_before = git(&ctx.project, &["status", "--porcelain"]).unwrap_or_default();

    let (ok, record) = ipc(
        ctx,
        "agent_worktree_ensure",
        &format!("{{ dataFolder: {data:?}, sessionId: {session:?}, project: {project:?} }}"),
    )?;
    ensure!(ok, "could not make the worktree: {record}");
    let worktree = PathBuf::from(record["path"].as_str().unwrap_or_default());
    let _ = git(&worktree, &["checkout", "--", "."]);

    // Nothing changed yet: a typed refusal, and no bundle.
    let (ok, refused) = ipc(ctx, "agent_worktree_export", &format!("{{ record: {record} }}"))?;
    ensure!(!ok && refused["kind"] == "no-changes", "an unchanged worktree was exported: {refused}");

    std::fs::write(worktree.join(file), "a\nB\nc\n").map_err(|e| fail(e.to_string()))?;
    std::fs::write(worktree.join("export-new.txt"), "new\n").map_err(|e| fail(e.to_string()))?;
    let (ok, report) = ipc(ctx, "agent_worktree_export", &format!("{{ record: {record} }}"))?;
    ensure!(ok, "the export was refused: {report}");
    let bundle = PathBuf::from(report["path"].as_str().unwrap_or_default());
    ensure!(
        bundle.starts_with(Path::new(&data).join("exports")) || bundle.to_string_lossy().contains("exports"),
        "the bundle is not under Jan's exports folder: {}",
        bundle.display()
    );
    let patch = std::fs::read_to_string(bundle.join("changes.patch")).unwrap_or_default();
    ensure!(
        patch.contains("-b\n+B\n") && patch.contains("+++ b/export-new.txt"),
        "the patch does not hold the changes:\n{patch}"
    );
    let manifest: Value = serde_json::from_str(
        &std::fs::read_to_string(bundle.join("manifest.json")).unwrap_or_default(),
    )
    .map_err(|e| fail(format!("manifest: {e}")))?;
    ensure!(manifest["baseSha"] == record["baseSha"], "the manifest names another base: {manifest}");
    ensure!(
        git(&ctx.project, &["status", "--porcelain"]).unwrap_or_default() == status_before,
        "exporting changed the user's checkout"
    );

    // The checkout, dressed as a worktree record, is refused.
    let mut forged = record.clone();
    forged["path"] = Value::String(project.clone());
    let (ok, refused) = ipc(ctx, "agent_worktree_export", &format!("{{ record: {forged} }}"))?;
    ensure!(!ok && refused["kind"] == "not-managed", "the checkout was exported: {refused}");

    let _ = ipc(
        ctx,
        "agent_worktree_discard",
        &format!("{{ dataFolder: {data:?}, record: {record}, force: true }}"),
    );
    Ok(())
}

/// Press a chord the way the keyboard does: a `keydown` on the window.
fn press(ctx: &Ctx, key: &str, ctrl: bool, shift: bool, alt: bool) -> ScenarioResult {
    ctx.eval(&format!(
        "window.dispatchEvent(new KeyboardEvent('keydown', {{ key: {key:?},
           ctrlKey: {ctrl}, shiftKey: {shift}, altKey: {alt}, bubbles: true, cancelable: true }}));
         return true;"
    ))?;
    Ok(())
}

/// The command palette and rebindable shortcuts. AH-206 / AH-207.
///
/// Proves, in the real WebView: Ctrl+Shift+P opens the palette from a page
/// that is not the palette's own; typing ranks locally and Enter navigates;
/// in Settings → Shortcuts a chord another command uses is refused with that
/// command named; a free chord is accepted, written to the backend settings
/// store (so a restart restores it) and then opens the palette while the old
/// chord no longer does; Reset restores the default.
fn scenario_palette_keybindings(ctx: &Ctx) -> ScenarioResult {
    let palette_open =
        "return !!document.querySelector('[data-testid=\"command-palette\"]');";
    ctx.goto("/")?;
    ctx.settle();
    press(ctx, "P", true, true, false)?;
    ctx.wait_until("the palette to open", palette_open, Duration::from_secs(15))?;

    // Ranked locally; Enter runs the best match.
    ctx.eval(
        "const i = document.querySelector('[data-testid=\"command-palette-input\"]');
         const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
         set.call(i, 'system monitor');
         i.dispatchEvent(new Event('input', { bubbles: true }));
         return true;",
    )?;
    ctx.wait_until(
        "the system monitor entry to rank first",
        "const first = document.querySelector('[data-testid=\"command-palette-item\"]');
         return !!first && first.getAttribute('data-command') === 'nav-system-monitor';",
        Duration::from_secs(10),
    )?;
    ctx.eval(
        "document.querySelector('[data-testid=\"command-palette-input\"]')
           .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
         return true;",
    )?;
    ctx.wait_until(
        "Enter to navigate and close the palette",
        "return window.location.pathname === '/system-monitor'
           && !document.querySelector('[data-testid=\"command-palette\"]');",
        Duration::from_secs(15),
    )?;

    // Rebinding: a taken chord is refused with its owner named.
    ctx.goto("/settings/shortcuts")?;
    ctx.wait_until(
        "the palette's shortcut row",
        "return !!document.querySelector('[data-testid=\"rebind-commandPalette\"]');",
        Duration::from_secs(30),
    )?;
    let row = "document.querySelector('[data-testid=\"rebind-commandPalette\"]')";
    ctx.eval(&format!(
        "{row}.querySelector('[data-testid=\"rebind-change\"]').click(); return true;"
    ))?;
    ctx.wait_until(
        "recording to start",
        &format!("return !!{row}.querySelector('[data-testid=\"rebind-recording\"]');"),
        Duration::from_secs(10),
    )?;
    // Ctrl+N is New Chat.
    press(ctx, "n", true, false, false)?;
    ctx.wait_until(
        "the conflict to be named",
        &format!(
            "const e = {row}.querySelector('[data-testid=\"rebind-error\"]');
             return !!e && /New Chat/.test(e.textContent || '');"
        ),
        Duration::from_secs(10),
    )?;
    ensure!(
        ctx.eval_bool("return window.location.pathname === '/settings/shortcuts';")?,
        "recording a taken chord ran its command instead"
    );

    // A free chord is accepted and persisted.
    press(ctx, "y", true, false, true)?;
    ctx.wait_until(
        "the new binding to be accepted",
        &format!("return !{row}.querySelector('[data-testid=\"rebind-recording\"]');"),
        Duration::from_secs(10),
    )?;
    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let settings = Path::new(&data).join("settings.json");
    let mut persisted = String::new();
    for _ in 0..20 {
        persisted = std::fs::read_to_string(&settings).unwrap_or_default();
        if persisted.contains("commandPalette") {
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    ensure!(
        persisted.contains("keybindings") && persisted.contains("commandPalette"),
        "the new binding was not written to the settings store"
    );

    // The new chord opens the palette; the old one no longer does.
    ctx.goto("/")?;
    ctx.settle();
    press(ctx, "P", true, true, false)?;
    std::thread::sleep(Duration::from_millis(800));
    ensure!(
        !ctx.eval_bool(palette_open)?,
        "the old chord still opens the palette after it was rebound"
    );
    press(ctx, "y", true, false, true)?;
    ctx.wait_until("the new chord to open the palette", palette_open, Duration::from_secs(10))?;
    ctx.eval(
        "document.querySelector('[data-testid=\"command-palette-input\"]')
           .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
         return true;",
    )?;
    ctx.settle();

    // Reset restores the default, and the store forgets the override.
    ctx.goto("/settings/shortcuts")?;
    ctx.wait_until(
        "the reset button",
        &format!("return !!{row}.querySelector('[data-testid=\"rebind-reset\"]');"),
        Duration::from_secs(30),
    )?;
    ctx.eval(&format!(
        "{row}.querySelector('[data-testid=\"rebind-reset\"]').click(); return true;"
    ))?;
    ctx.wait_until(
        "the reset to take effect",
        &format!("return !{row}.querySelector('[data-testid=\"rebind-reset\"]');"),
        Duration::from_secs(10),
    )?;
    Ok(())
}

/// An edit made outside Jan shows up as a structured diff, with the added and
/// removed lines distinguished rather than a blob of text.
fn scenario_external_edit_diff(ctx: &Ctx) -> ScenarioResult {
    let notes = ctx.project.join("notes.txt");
    std::fs::write(
        &notes,
        "line one\nline two CHANGED\nline three\nline four added\n",
    )
    .map_err(|e| Failure(format!("could not edit the fixture: {e}")))?;

    ctx.goto("/cowork")?;
    ctx.click_rail("Changes")?;
    std::thread::sleep(Duration::from_secs(1));

    // The panel holds the last scan; an edit made outside Jan only appears once
    // it rescans, so ask it to.
    ctx.eval(
        "const b = [...document.querySelectorAll('button')].find(x =>
           /refresh|rescan|reload/i.test((x.getAttribute('aria-label') || '')
             + ' ' + (x.getAttribute('title') || '')));
         if (b) b.click();
         return !!b;",
    )?;

    ctx.wait_until(
        "notes.txt to appear in Changes",
        "return document.body.textContent.includes('notes.txt');",
        Duration::from_secs(60),
    )?;

    // Open the file's diff and check it is structured: additions and deletions
    // are separate rows, not one lump of text.
    // The row is collapsed: expand it so the hunk is rendered.
    ctx.eval_bool(
        "const row = [...document.querySelectorAll('*')]
           .filter(e => (e.textContent || '').trim().endsWith('notes.txt')
                        && e.children.length <= 3)
           .pop();
         if (!row) return false;
         const clickable = row.closest('button,[role=\"button\"],[aria-expanded]')
           || row.parentElement?.querySelector('button,[aria-expanded]')
           || row;
         clickable.click();
         return true;",
    )?;
    std::thread::sleep(Duration::from_secs(2));
    // If it is still collapsed, click whatever advertises itself as expandable.
    if !ctx.eval_bool("return document.body.textContent.includes('line four added');")? {
        ctx.eval(
            "for (const e of document.querySelectorAll('[aria-expanded=\"false\"]')) {
               e.click();
             }
             return true;",
        )?;
        std::thread::sleep(Duration::from_secs(2));
    }

    let diff = ctx.eval_string(
        "const t = document.body.textContent || '';
         return JSON.stringify({
           added: t.includes('line four added'),
           changed: t.includes('line two CHANGED'),
           original: t.includes('line two') ,
         });",
    )?;
    println!("      diff content: {diff}");
    let v: Value = serde_json::from_str(&diff).unwrap_or(Value::Null);
    ensure!(
        v.get("added") == Some(&Value::Bool(true)) && v.get("changed") == Some(&Value::Bool(true)),
        "the diff did not show the edited and added lines: {diff}"
    );

    // Structured, not a blob: additions and deletions are marked apart from
    // each other rather than printed as one run of text.
    let structured = ctx.eval_bool(
        "const marked = [...document.querySelectorAll('*')].filter(e =>
           e.children.length === 0 && /^[+-]/.test((e.textContent || '').trim()));
         const cls = new Set([...document.querySelectorAll('[class*=\"add\"],[class*=\"insert\"],[class*=\"delete\"],[class*=\"remove\"]')]
           .map(e => e.className.toString()));
         return marked.length > 0 || cls.size > 0;",
    )?;
    ensure!(
        structured,
        "the diff rendered as plain text with no added/removed distinction"
    );
    Ok(())
}

/// A new session starts with no project of its own.
fn scenario_session_isolation(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/cowork")?;
    let name = ctx
        .project
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    ctx.wait_until(
        "the attached session",
        &format!("return document.body.textContent.includes({name:?});"),
        Duration::from_secs(30),
    )?;

    ctx.click_matching("button", "New session")?;
    ctx.wait_until(
        "a fresh session with no folder",
        &format!("return !!({PILL_JS});"),
        Duration::from_secs(30),
    )?;
    let leaked = ctx.eval_bool(&format!(
        "return document.body.textContent.includes({name:?});"
    ))?;
    ensure!(
        !leaked,
        "a new session inherited the previous session's attached project"
    );
    Ok(())
}

/// Settings search narrows the list, and a result navigates to its own page.
fn scenario_settings_search(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/settings/general")?;
    ctx.wait_until(
        "the settings search box",
        "return !!document.querySelector('input[role=\"combobox\"]')
             || [...document.querySelectorAll('input')].some(i =>
                  /search settings/i.test(i.getAttribute('placeholder') || ''));",
        Duration::from_secs(30),
    )?;

    // The search is a combobox over a settings index, not a filter on the nav:
    // it opens a results listbox. Assert on that.
    let sel = "input[role=\"combobox\"]";
    ctx.type_into(sel, "hardware")?;
    ctx.wait_until(
        "search results",
        "const box = document.getElementById('settings-search-results');
         return !!box && box.querySelectorAll('[role=\"option\"]').length > 0;",
        Duration::from_secs(25),
    )?;
    let hits = ctx.eval(
        "return document.getElementById('settings-search-results')
           .querySelectorAll('[role=\"option\"]').length;",
    )?;
    println!("      results for 'hardware': {hits}");

    // A query that matches nothing must produce no options.
    ctx.type_into(sel, "zzzznotasettinganywhere")?;
    ctx.wait_until(
        "the results to empty for a query nothing matches",
        "const box = document.getElementById('settings-search-results');
         return !box || box.querySelectorAll('[role=\"option\"]').length === 0;",
        Duration::from_secs(25),
    )?;

    // Choosing a result navigates to that individual setting.
    ctx.type_into(sel, "hardware")?;
    ctx.wait_until(
        "search results again",
        "const box = document.getElementById('settings-search-results');
         return !!box && box.querySelectorAll('[role=\"option\"]').length > 0;",
        Duration::from_secs(25),
    )?;
    ctx.eval(
        "document.getElementById('settings-search-results')
           .querySelector('[role=\"option\"]').click();
         return true;",
    )?;
    ctx.wait_until(
        "the setting's own page",
        "return location.pathname.startsWith('/settings/')
             && !location.pathname.endsWith('/general');",
        Duration::from_secs(25),
    )?;
    let landed = ctx.eval_string("return location.pathname + location.hash;")?;
    println!("      settings search navigated to: {landed}");
    Ok(())
}

/// The Cowork composer carries its own model and reasoning controls.
fn scenario_per_chat_controls(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the composer controls",
        "const names = [...document.querySelectorAll('button')]
           .map(b => (b.getAttribute('aria-label') || b.textContent || '').trim());
         return names.some(n => /select a model|smoke-model/i.test(n))
             && names.some(n => /sampling parameters/i.test(n));",
        Duration::from_secs(30),
    )?;

    // The reasoning/sampling control opens and offers a thinking setting.
    ctx.click_matching("button", "Sampling parameters")?;
    ctx.wait_until(
        "the sampling popover",
        "const t = document.body.textContent || '';
         return /thinking|reasoning|temperature|top[_ ]?p/i.test(t);",
        Duration::from_secs(20),
    )?;
    ctx.describe("sampling-popover")?;
    ctx.eval(
        "document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
         return true;",
    )?;
    Ok(())
}

/// The composer reserves space for its control row instead of drawing it over
/// the textarea.
///
/// The row is absolutely positioned at the bottom of the composer, so the box
/// reserves its height. That reserve used to be a constant one row tall, and a
/// row that wrapped grew upward across the input.
fn scenario_composer_footer(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    std::thread::sleep(Duration::from_millis(600));

    let report = ctx.eval_string(
        r#"const ta = document.querySelector('[data-testid="chat-input"]');
           const send = document.querySelector('[data-test-id="send-message-button"]');
           if (!ta || !send) return JSON.stringify({ error: 'missing composer parts' });
           // The control row is the send button's positioned ancestor.
           let footer = send;
           while (footer && getComputedStyle(footer).position !== 'absolute') {
             footer = footer.parentElement;
           }
           if (!footer) return JSON.stringify({ error: 'no positioned control row' });
           const t = ta.getBoundingClientRect();
           const f = footer.getBoundingClientRect();
           return JSON.stringify({
             textareaBottom: Math.round(t.bottom),
             footerTop: Math.round(f.top),
             footerHeight: Math.round(f.height),
             overlap: Math.round(t.bottom - f.top),
           });"#,
    )?;
    println!("      composer footer: {report}");
    let v: Value = serde_json::from_str(&report).unwrap_or(Value::Null);
    ensure!(
        v.get("error").is_none(),
        "could not measure the composer: {report}"
    );
    let overlap = v.get("overlap").and_then(Value::as_i64).unwrap_or(0);
    ensure!(
        overlap <= 1,
        "the control row covers the bottom {overlap}px of the textarea: {report}"
    );
    Ok(())
}

/// `@` references name only what is inside the attached folder. AH-204.
///
/// In the real composer with the fixture attached: the picker offers
/// folder-relative paths and nothing outside the folder; a message naming an
/// in-folder file, a `../` file and an absolute path is sent, and the payload
/// the model received (the prompt snapshot) carries the in-folder file, says
/// the other two were not included, and holds none of the outside file.
fn scenario_at_references_confined(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    let outside = ctx.workspace.join("outside-secret.txt");
    std::fs::write(&outside, "OUTSIDE-FOLDER-CONTENT\n").map_err(|e| fail(e.to_string()))?;

    ctx.script_model("plain", &[])?;
    ctx.script_dialog(Some(&ctx.project));
    let opened = open_picker_through_the_pill(ctx);
    let name = ctx
        .project
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let landed = opened.and_then(|()| {
        ctx.wait_until(
            "the project to attach",
            &format!("return document.body.innerText.includes({name:?}) && !{PILL_JS};"),
            Duration::from_secs(45),
        )
    });
    ctx.clear_dialog_script();
    landed?;
    ctx.ensure_model_selected()?;

    // The picker: folder-relative entries only.
    ctx.type_into("[data-testid=\"chat-input\"]", "@ind")?;
    let offered = ctx.wait_until(
        "the picker to offer src/index.ts",
        "return (document.body.innerText || '').includes('src/index.ts');",
        Duration::from_secs(20),
    );
    let picker_text = ctx
        .eval_string(
            "const b = [...document.querySelectorAll('button,li,div')]
               .filter(e => /index\\.ts/.test(e.textContent || '') && e.children.length < 6)
               .map(e => e.textContent).join(' | ');
             return b;",
        )
        .unwrap_or_default();
    offered.map_err(|e| Failure(format!("{} -- picker: {picker_text:?}", e.0)))?;
    ensure!(
        !picker_text.contains(":\\") && !picker_text.contains("Users"),
        "the picker offered an absolute path: {picker_text:?}"
    );

    // A message naming one path inside, one climbing out, one absolute.
    let absolute = outside.to_string_lossy().to_string();
    ctx.type_into(
        "[data-testid=\"chat-input\"]",
        &format!("compare @src/index.ts with @../outside-secret.txt and @{absolute}"),
    )?;
    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let prompts = Path::new(&data).join("audit").join("prompts.jsonl");
    let before = std::fs::read_to_string(&prompts).unwrap_or_default().len();
    ctx.wait_until(
        "the send control to arm",
        "const b = document.querySelector('[data-test-id=\"send-message-button\"]');
         return !!b && b.disabled !== true;",
        Duration::from_secs(60),
    )?;
    ctx.eval(
        "document.querySelector('[data-test-id=\"send-message-button\"]').click();
         return true;",
    )?;
    ctx.wait_until(
        "the model's reply",
        "return document.body.textContent.includes('Hello from the smoke model');",
        Duration::from_secs(90),
    )?;
    let mut sent = String::new();
    for _ in 0..40 {
        let all = std::fs::read_to_string(&prompts).unwrap_or_default();
        sent = all.get(before..).unwrap_or_default().to_string();
        if sent.contains("compare") {
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    ensure!(sent.contains("compare"), "no prompt snapshot of the message was recorded");
    ensure!(
        sent.contains("hello ${who}") || sent.contains("hello $") || sent.contains("greet"),
        "the in-folder reference was not included"
    );
    ensure!(
        !sent.contains("OUTSIDE-FOLDER-CONTENT"),
        "a reference outside the attached folder reached the model"
    );
    ensure!(
        sent.matches("was not included").count() >= 2,
        "the refused references were not stated in the message"
    );
    let _ = std::fs::remove_file(&outside);
    Ok(())
}

/// Attach the fixture project through the pill, as a person would.
fn attach_project(ctx: &Ctx) -> ScenarioResult {
    ctx.script_dialog(Some(&ctx.project));
    let opened = open_picker_through_the_pill(ctx);
    let name = ctx
        .project
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let landed = opened.and_then(|()| {
        ctx.wait_until(
            "the project to attach",
            &format!("return document.body.innerText.includes({name:?}) && !{PILL_JS};"),
            Duration::from_secs(45),
        )
    });
    ctx.clear_dialog_script();
    landed
}

/// Press a key in the composer, the way the keyboard does: a keydown on the
/// focused textarea.
fn key_in_composer(ctx: &Ctx, key: &str, alt: bool) -> ScenarioResult {
    ctx.eval(&format!(
        "const el = document.querySelector('[data-testid=\"chat-input\"]');
         el.focus();
         el.dispatchEvent(new KeyboardEvent('keydown',
           {{ key: {key:?}, altKey: {alt}, bubbles: true, cancelable: true }}));
         return true;"
    ))?;
    Ok(())
}

/// The tokens the `@` menu offers, in order.
fn menu_tokens(ctx: &Ctx) -> Result<Vec<String>, Failure> {
    let raw = ctx.eval_string(
        "return JSON.stringify([...document.querySelectorAll(
           '[data-testid=\"reference-menu\"] [role=\"option\"]')].map(o => o.dataset.token));",
    )?;
    serde_json::from_str(&raw).map_err(|e| Failure(format!("menu tokens: {e}: {raw}")))
}

/// Name the file `@query` finds first as `name`, from the keyboard: Alt+A,
/// type the name, submit.
fn save_alias_from_keyboard(
    ctx: &Ctx,
    query: &str,
    target: &str,
    name: &str,
    lines: Option<&str>,
) -> ScenarioResult {
    ctx.type_into("[data-testid=\"chat-input\"]", &format!("@{query}"))?;
    ctx.wait_until(
        "the file to be offered",
        &format!(
            "return !!document.querySelector('[data-testid=\"reference-menu\"] [role=\"option\"][data-token={target:?}]');"
        ),
        Duration::from_secs(20),
    )?;
    let first = menu_tokens(ctx)?;
    ensure!(
        first.first().map(String::as_str) == Some(target),
        "{target} is not the active row: {first:?}"
    );
    key_in_composer(ctx, "a", true)?;
    ctx.wait_until(
        "the alias name field",
        "return document.activeElement && document.activeElement.dataset.testid === 'alias-name';",
        Duration::from_secs(10),
    )?;
    ctx.eval(&format!(
        "const el = document.querySelector('[data-testid=\"alias-name\"]');
         const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
         set.call(el, {name:?});
         el.dispatchEvent(new Event('input', {{ bubbles: true }}));
         return true;"
    ))?;
    if let Some(lines) = lines {
        ctx.eval(&format!(
            "const el = document.querySelector('[data-testid=\"alias-lines\"]');
             const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
             set.call(el, {lines:?});
             el.dispatchEvent(new Event('input', {{ bubbles: true }}));
             return true;"
        ))?;
    }
    ctx.eval("document.querySelector('[data-testid=\"alias-form\"]').requestSubmit(); return true;")?;
    let saved_as = match lines {
        Some(lines) if lines.contains('-') => format!("{target}:{lines}"),
        Some(lines) => format!("{target}:{lines}-{lines}"),
        None => target.to_string(),
    };
    ctx.wait_until(
        "the alias to be saved and announced",
        &format!(
            "const s = document.querySelector('[data-testid=\"reference-status\"]');
             return !!s && s.textContent.includes('Saved @alias:{name} for {saved_as}');"
        ),
        Duration::from_secs(10),
    )?;
    ctx.wait_until(
        "focus to return to the composer",
        "return document.activeElement && document.activeElement.dataset.testid === 'chat-input';",
        Duration::from_secs(5),
    )
}

/// Send `text` from the composer and return what the model was sent.
fn send_and_capture(ctx: &Ctx, text: &str, marker: &str) -> Result<String, Failure> {
    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let prompts = Path::new(&data).join("audit").join("prompts.jsonl");
    let before = std::fs::read_to_string(&prompts).unwrap_or_default().len();
    ctx.type_into("[data-testid=\"chat-input\"]", text)?;
    ctx.wait_until(
        "the send control to arm",
        "const b = document.querySelector('[data-test-id=\"send-message-button\"]');
         return !!b && b.disabled !== true;",
        Duration::from_secs(60),
    )?;
    ctx.eval(
        "document.querySelector('[data-test-id=\"send-message-button\"]').click();
         return true;",
    )?;
    let mut sent = String::new();
    for _ in 0..240 {
        let all = std::fs::read_to_string(&prompts).unwrap_or_default();
        sent = all.get(before..).unwrap_or_default().to_string();
        if sent.contains(marker) {
            return Ok(sent);
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    bail!("no prompt snapshot containing {marker:?} was recorded; got: {}", &sent[..sent.len().min(400)])
}

/// One `@` menu for files, skills, saved agents and aliases (AH-204/AH-205),
/// driven by the keyboard alone, in the real WebView.
fn scenario_unified_at_menu(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    // One of each kind for the menu to offer: a skill in the folder, and a
    // saved agent in Jan's own store.
    let skills = ctx.project.join(".jan").join("agent").join("skills");
    std::fs::create_dir_all(&skills).map_err(|e| fail(e.to_string()))?;
    std::fs::write(
        skills.join("reviewer.md"),
        "---\nname: reviewer\ndescription: Reviews a diff\n---\nRead the diff and say what is wrong.\n",
    )
    .map_err(|e| fail(e.to_string()))?;
    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let agents = Path::new(&data).join("agent-workspace").join("subagents");
    std::fs::create_dir_all(&agents).map_err(|e| fail(e.to_string()))?;
    std::fs::write(
        agents.join("review-bot.toml"),
        "name = \"review-bot\"\ndescription = \"Second opinion on a change\"\nsystem_prompt = \"Review.\"\n",
    )
    .map_err(|e| fail(e.to_string()))?;

    ctx.script_model("plain", &[])?;
    attach_project(ctx)?;
    ctx.ensure_model_selected()?;

    // One list, every kind, and no absolute path.
    ctx.type_into("[data-testid=\"chat-input\"]", "@rev")?;
    ctx.wait_until(
        "the skill to be offered",
        "return !!document.querySelector('[data-testid=\"reference-menu\"] [data-token=\"skill:reviewer\"]');",
        Duration::from_secs(20),
    )?;
    let tokens = menu_tokens(ctx)?;
    ensure!(
        tokens.iter().any(|t| t == "agent:review-bot"),
        "the saved agent is not in the menu: {tokens:?}"
    );
    ensure!(
        !tokens.iter().any(|t| t.contains(":\\") || t.starts_with('/')),
        "the menu offered an absolute path: {tokens:?}"
    );

    // Keyboard alone: the arrow moves the active row, Enter inserts it.
    let active = |ctx: &Ctx| {
        ctx.eval_string(
            "const id = document.querySelector('[data-testid=\"chat-input\"]').getAttribute('aria-activedescendant');
             const el = id && document.getElementById(id);
             return el ? el.dataset.token : '';",
        )
    };
    let first = active(ctx)?;
    key_in_composer(ctx, "ArrowDown", false)?;
    let second = active(ctx)?;
    ensure!(
        !second.is_empty() && second != first,
        "ArrowDown did not move the active row ({first:?} -> {second:?})"
    );
    key_in_composer(ctx, "Enter", false)?;
    ctx.wait_until(
        "the reference to be inserted rather than sent",
        &format!(
            "return document.querySelector('[data-testid=\"chat-input\"]').value.trim() === {:?};",
            format!("@{second}")
        ),
        Duration::from_secs(5),
    )?;

    // Name a file from the keyboard, and find it offered back.
    save_alias_from_keyboard(ctx, "ind", "src/index.ts", "entry", None)?;
    ctx.type_into("[data-testid=\"chat-input\"]", "@alias:")?;
    ctx.wait_until(
        "the alias to be offered",
        "return !!document.querySelector('[data-testid=\"reference-menu\"] [data-token=\"alias:entry\"]');",
        Duration::from_secs(10),
    )?;

    // A named selection: line 1 of the file, and nothing else of it.
    save_alias_from_keyboard(ctx, "ind", "src/index.ts", "firstline", Some("1"))?;
    let sent = send_and_capture(ctx, "quote @alias:firstline please", "quote")?;
    ensure!(
        sent.contains("src/index.ts (lines 1-1)"),
        "the selection alias was not resolved to its lines"
    );
    ensure!(
        !sent.contains("export default greet"),
        "the selection alias carried lines outside the selection"
    );
    ctx.wait_until(
        "the reply to the selection message",
        "return document.body.textContent.includes('Hello from the smoke model');",
        Duration::from_secs(90),
    )?;

    // Used: the alias is resolved to the file's content, and the agent is
    // named with how to reach it.
    let sent = send_and_capture(ctx, "summarize @alias:entry then ask @agent:review-bot", "summarize")?;
    ensure!(
        sent.contains("@alias:entry is src/index.ts"),
        "the alias was not resolved to its file"
    );
    ensure!(
        sent.contains("hello ${who}") || sent.contains("greet"),
        "the aliased file's content was not included"
    );
    ensure!(
        sent.contains("call the task tool with agent \\\"review-bot\\\"")
            || sent.contains("call the task tool with agent \"review-bot\""),
        "the agent reference did not say how to reach it"
    );
    Ok(())
}

/// Set a text field's value the way typing does, so React sees the change.
fn set_field(ctx: &Ctx, selector: &str, value: &str) -> ScenarioResult {
    let ok = ctx.eval_bool(&format!(
        "const el = document.querySelector({selector:?});
         if (!el) return false;
         const proto = el instanceof HTMLTextAreaElement
           ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
         Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, {value:?});
         el.dispatchEvent(new Event('input', {{ bubbles: true }}));
         return true;"
    ))?;
    ensure!(ok, "{selector} is not on the page");
    Ok(())
}

/// Open the project description dialog and wait for its draft.
fn open_project_init(ctx: &Ctx) -> Result<String, Failure> {
    ctx.wait_until(
        "the offer to describe the project",
        "return !!document.querySelector('[data-testid=\"project-init-open\"]');",
        Duration::from_secs(30),
    )?;
    ctx.eval("document.querySelector('[data-testid=\"project-init-open\"]').click(); return true;")?;
    ctx.wait_until(
        "the proposed JAN.md",
        "const t = document.querySelector('[data-testid=\"project-init-text\"]');
         return !!t && t.value.length > 0;",
        Duration::from_secs(30),
    )?;
    ctx.eval_string("return document.querySelector('[data-testid=\"project-init-text\"]').value;")
}

/// AH-209 through the real UI: survey, edit, accept; nothing written before.
fn scenario_project_init(ctx: &Ctx) -> ScenarioResult {
    let jan_md = ctx.project.join("JAN.md");
    let _ = std::fs::remove_file(&jan_md);
    ctx.script_model("plain", &[])?;
    attach_project(ctx)?;

    let draft = open_project_init(ctx)?;
    ensure!(
        draft.starts_with("# cowork-smoke-fixture"),
        "the draft is not named from package.json: {draft:?}"
    );
    // The README as it is on disk -- the fixture edits it in the working tree
    // after committing, and the survey reads the working tree.
    let readme = std::fs::read_to_string(ctx.project.join("README.md")).unwrap_or_default();
    let first_paragraph = readme
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('#'))
        .unwrap_or_default()
        .to_string();
    ensure!(
        !first_paragraph.is_empty() && draft.contains(&first_paragraph),
        "the draft does not carry the README's description ({first_paragraph:?}): {draft:?}"
    );
    ensure!(
        !draft.contains("SMOKE_TOKEN"),
        "the draft carries the content of .env"
    );
    ensure!(
        draft.contains("TypeScript"),
        "the draft does not say what the project is written in: {draft:?}"
    );
    let not_read = ctx.eval_string(
        "const l = document.querySelector('[data-testid=\"project-init-not-read\"]');
         return l ? l.textContent : '';",
    )?;
    ensure!(
        not_read.contains("skipped by design"),
        "the dialog does not say what the survey did not read: {not_read:?}"
    );
    ensure!(!jan_md.exists(), "surveying wrote JAN.md");

    let edited = format!("{draft}- Checked by the smoke run.\n");
    set_field(ctx, "[data-testid=\"project-init-text\"]", &edited)?;
    ctx.eval("document.querySelector('[data-testid=\"project-init-accept\"]').click(); return true;")?;
    ctx.wait_until(
        "the write to be announced",
        "const s = document.querySelector('[data-testid=\"project-init-status\"]');
         return !!s && s.textContent.includes('Wrote JAN.md');",
        Duration::from_secs(20),
    )?;
    let written = std::fs::read_to_string(&jan_md).map_err(|e| Failure(format!("JAN.md: {e}")))?;
    ensure!(written == edited, "JAN.md is not exactly the accepted text: {written:?}");
    ctx.wait_until(
        "the offer to go once JAN.md exists",
        "return !document.querySelector('[data-testid=\"project-init-open\"]');",
        Duration::from_secs(20),
    )?;

    // Refusal: a second acceptance over the file is refused and changes nothing.
    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let project = ctx.project.to_string_lossy().to_string();
    let (ok, refusal) = ipc(
        ctx,
        "plugin:agent-tools|project_init_accept",
        &format!("{{ dataFolder: {data:?}, root: {project:?}, content: 'OVERWRITTEN', overwrite: false }}"),
    )?;
    ensure!(!ok, "a second JAN.md was written over the first");
    ensure!(
        refusal.to_string().contains("already has a JAN.md"),
        "the refusal did not say why: {refusal}"
    );
    ensure!(
        std::fs::read_to_string(&jan_md).unwrap_or_default() == edited,
        "the refused write changed JAN.md"
    );
    let _ = std::fs::remove_file(&jan_md);
    Ok(())
}

const DRAFT_MARKER: &str = "project-init-phase-1.txt";
const DRAFT_TEXT: &str = "DRAFT-KEPT-ACROSS-RESTART";

/// Phase one: edit a draft, close the dialog without accepting, and exit.
fn scenario_project_init_draft_first(ctx: &Ctx) -> ScenarioResult {
    let _ = std::fs::remove_file(ctx.project.join("JAN.md"));
    ctx.script_model("plain", &[])?;
    attach_project(ctx)?;
    let draft = open_project_init(ctx)?;
    set_field(
        ctx,
        "[data-testid=\"project-init-text\"]",
        &format!("{draft}{DRAFT_TEXT}\n"),
    )?;
    ctx.eval(
        "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
         const a = document.activeElement;
         if (a) a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
         return true;",
    )?;
    ctx.wait_until(
        "the dialog to close",
        "return !document.querySelector('[data-testid=\"project-init-dialog\"]');",
        Duration::from_secs(10),
    )?;
    ensure!(!ctx.project.join("JAN.md").exists(), "closing the dialog wrote JAN.md");
    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let settings = Path::new(&data).join("settings.json");
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let raw = std::fs::read_to_string(&settings).unwrap_or_default();
        if raw.contains("project-init-drafts") && raw.contains(DRAFT_TEXT) {
            break;
        }
        ensure!(
            std::time::Instant::now() < deadline,
            "the edited draft never reached settings.json"
        );
        std::thread::sleep(Duration::from_millis(200));
    }
    std::fs::write(ctx.workspace.join(DRAFT_MARKER), "edited").map_err(|e| Failure(e.to_string()))
}

/// Phase two, a new process: the edit is still there, and discarding it
/// writes nothing.
fn scenario_project_init_draft_second(ctx: &Ctx) -> ScenarioResult {
    ensure!(
        ctx.workspace.join(DRAFT_MARKER).exists(),
        "phase one did not run against this workspace"
    );
    ctx.script_model("plain", &[])?;
    attach_project(ctx)?;
    ctx.wait_until(
        "the offer to continue the draft",
        "const b = document.querySelector('[data-testid=\"project-init-open\"]');
         return !!b && b.textContent.includes('Continue');",
        Duration::from_secs(30),
    )?;
    let draft = open_project_init(ctx)?;
    ensure!(
        draft.contains(DRAFT_TEXT),
        "the draft edited before the restart did not come back: {draft:?}"
    );
    ctx.eval("document.querySelector('[data-testid=\"project-init-discard\"]').click(); return true;")?;
    ctx.wait_until(
        "the discard to be announced",
        "const s = document.querySelector('[data-testid=\"project-init-status\"]');
         return !!s && s.textContent.includes('Nothing was written');",
        Duration::from_secs(10),
    )?;
    ensure!(!ctx.project.join("JAN.md").exists(), "discarding wrote JAN.md");
    Ok(())
}

const ALIAS_MARKER: &str = "alias-phase-1.txt";

/// Phase one: save an alias from the keyboard, then let the process exit.
fn scenario_alias_persist_first(ctx: &Ctx) -> ScenarioResult {
    ctx.script_model("plain", &[])?;
    attach_project(ctx)?;
    ctx.ensure_model_selected()?;
    save_alias_from_keyboard(ctx, "ind", "src/index.ts", "persisted", None)?;
    // Saved means on disk: the settings write is debounced, and the first run
    // of this pair exited inside that window, before the write had left the
    // WebView. A person does not quit within half a second of saving; this
    // waits for what they would have waited for.
    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let settings = Path::new(&data).join("settings.json");
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let raw = std::fs::read_to_string(&settings).unwrap_or_default();
        if raw.contains("reference-aliases") && raw.contains("persisted") {
            break;
        }
        ensure!(
            std::time::Instant::now() < deadline,
            "the alias never reached settings.json"
        );
        std::thread::sleep(Duration::from_millis(200));
    }
    std::fs::write(ctx.workspace.join(ALIAS_MARKER), "saved")
        .map_err(|e| Failure(e.to_string()))
}

/// Phase two, a new process on the same data folder: the alias is offered
/// again and resolves to the same file.
fn scenario_alias_persist_second(ctx: &Ctx) -> ScenarioResult {
    ensure!(
        ctx.workspace.join(ALIAS_MARKER).exists(),
        "phase one did not run against this workspace"
    );
    ctx.script_model("plain", &[])?;
    attach_project(ctx)?;
    ctx.ensure_model_selected()?;
    ctx.type_into("[data-testid=\"chat-input\"]", "@alias:")?;
    ctx.wait_until(
        "the alias saved before the restart to be offered",
        "return !!document.querySelector('[data-testid=\"reference-menu\"] [data-token=\"alias:persisted\"]');",
        Duration::from_secs(20),
    )?;
    let sent = send_and_capture(ctx, "after the restart use @alias:persisted", "after the restart")?;
    ensure!(
        sent.contains("@alias:persisted is src/index.ts"),
        "the alias did not resolve after the restart"
    );
    Ok(())
}

/// The first file named `name` under `dir`, depth first.
fn find_file(dir: &Path, name: &str) -> Option<PathBuf> {
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_file(&path, name) {
                return Some(found);
            }
        } else if path.file_name().is_some_and(|n| n == name) {
            return Some(path);
        }
    }
    None
}

const RESTART_MARKER: &str = "restart-phase-1.txt";
const UNDO_FILE: &str = "persist-undo.txt";

/// Open the Changes rail and wait for the per-turn undo list.
fn open_turn_undo(ctx: &Ctx) -> ScenarioResult {
    // Waited for: right after a navigation the rail is not drawn yet.
    ctx.wait_until(
        "the Changes rail button",
        r#"const b = [...document.querySelectorAll('button')].find(x =>
             /^Changes$|changed/i.test(x.getAttribute('aria-label') || ''));
           if (!b) return false;
           if (b.getAttribute('aria-pressed') !== 'true') b.click();
           return true;"#,
        Duration::from_secs(30),
    )?;
    ctx.wait_until(
        "the per-turn undo list",
        "return !!document.querySelector('[data-testid=\"turn-undo-row\"]');",
        Duration::from_secs(30),
    )
}

/// Phase one of a real restart (AH-207, AH-202): change state the app must
/// keep, then let the process exit.
///
/// Rebinds the command palette to Ctrl+Alt+Y, and runs a Cowork turn whose
/// `write` creates a file, then undoes that turn from the Changes panel -- so
/// the second phase can check both the binding and the undo position.
fn scenario_restart_persist_first(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    // The binding.
    ctx.goto("/settings/shortcuts")?;
    ctx.wait_until(
        "the palette's shortcut row",
        "return !!document.querySelector('[data-testid=\"rebind-commandPalette\"]');",
        Duration::from_secs(30),
    )?;
    let row = "document.querySelector('[data-testid=\"rebind-commandPalette\"]')";
    ctx.eval(&format!(
        "{row}.querySelector('[data-testid=\"rebind-change\"]').click(); return true;"
    ))?;
    ctx.wait_until(
        "recording to start",
        &format!("return !!{row}.querySelector('[data-testid=\"rebind-recording\"]');"),
        Duration::from_secs(10),
    )?;
    press(ctx, "y", true, false, true)?;
    ctx.wait_until(
        "the new binding to be accepted",
        &format!("return !!{row}.querySelector('[data-testid=\"rebind-reset\"]');"),
        Duration::from_secs(10),
    )?;

    // A turn that writes a file, undone from the turn that made it.
    let write_call = format!(
        "write:{}",
        serde_json::json!({ "path": UNDO_FILE, "content": "written by the turn\n" })
    );
    ctx.script_model("tools", &[write_call.as_str()])?;
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the cowork composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    ctx.ensure_model_selected()?;
    ctx.eval(
        "const b = [...document.querySelectorAll('button')].find(x =>
           /new session/i.test((x.textContent || '').trim()));
         if (b) b.click();
         return true;",
    )?;
    ctx.settle();
    ctx.type_into("[data-testid=\"chat-input\"]", "write the persistence file")?;
    ctx.wait_until(
        "the send control to arm",
        "const b = document.querySelector('[data-test-id=\"send-message-button\"]');
         return !!b && b.disabled !== true;",
        Duration::from_secs(60),
    )?;
    ctx.eval(
        "document.querySelector('[data-test-id=\"send-message-button\"]').click();
         return true;",
    )?;
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    loop {
        let _ = ctx.eval(
            "const b = [...document.querySelectorAll('button')].find(x =>
               /^allow once$/i.test((x.textContent || '').trim()));
             if (b) b.click();
             return true;",
        );
        let started = ctx
            .eval_bool("return !!document.querySelector('[data-testid=\"tool-activity-item\"]');")
            .unwrap_or(false);
        let idle = ctx
            .eval_bool("return !!document.querySelector('[data-test-id=\"send-message-button\"]');")
            .unwrap_or(false);
        if started && idle {
            break;
        }
        ensure!(
            std::time::Instant::now() < deadline,
            "the run did not finish (tool item shown: {started}, composer idle: {idle}); {}",
            run_state(ctx)
        );
        std::thread::sleep(Duration::from_millis(700));
    }
    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let written = find_file(Path::new(&data), UNDO_FILE)
        .ok_or_else(|| fail("the turn's write is not on disk".into()))?;
    ensure!(
        std::fs::read_to_string(&written).unwrap_or_default() == "written by the turn\n",
        "the turn wrote something else"
    );

    open_turn_undo(ctx)?;
    ctx.eval(
        "document.querySelector('[data-testid=\"turn-undo-row\"][data-state=\"applied\"] [data-testid=\"turn-undo-button\"]').click();
         return true;",
    )?;
    let undone = ctx.wait_until(
        "the undo to be reported",
        "return !!document.querySelector('[data-testid=\"turn-undo-row\"][data-state=\"undone\"]');",
        Duration::from_secs(30),
    );
    if undone.is_err() {
        let status = ctx
            .eval_string(
                "const s = document.querySelector('[data-testid=\"turn-undo-status\"]');
                 return s ? s.textContent : '(no status)';",
            )
            .unwrap_or_default();
        bail!("the undo did not take effect; the panel said: {status:?}");
    }
    ensure!(!written.exists(), "undo did not remove the file the turn created");
    std::fs::write(ctx.workspace.join(RESTART_MARKER), written.to_string_lossy().as_bytes())
        .map_err(|e| fail(e.to_string()))?;
    Ok(())
}

/// Phase two, in a new process on the same data folder and WebView profile:
/// the binding and the undo position came back, and both still work.
fn scenario_restart_persist_second(ctx: &Ctx) -> ScenarioResult {
    let marker = std::fs::read_to_string(ctx.workspace.join(RESTART_MARKER))
        .map_err(|_| Failure("phase one did not run against this workspace".into()))?;
    let written = PathBuf::from(marker.trim());
    ensure!(!written.exists(), "the undone file came back on its own");

    // The binding: the old chord does nothing, the new one opens the palette.
    let palette_open =
        "return !!document.querySelector('[data-testid=\"command-palette\"]');";
    ctx.goto("/")?;
    ctx.settle();
    press(ctx, "P", true, true, false)?;
    std::thread::sleep(Duration::from_millis(800));
    ensure!(
        !ctx.eval_bool(palette_open)?,
        "after a restart the default chord opens the palette again: the binding was lost"
    );
    press(ctx, "y", true, false, true)?;
    ctx.wait_until(
        "the restored binding to open the palette",
        palette_open,
        Duration::from_secs(10),
    )?;
    ctx.eval(
        "document.querySelector('[data-testid=\"command-palette-input\"]')
           .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
         return true;",
    )?;
    ctx.settle();

    // The undo position: the turn is still undone, and redo still works.
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the cowork composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    open_turn_undo(ctx)?;
    ctx.wait_until(
        "the undone turn to be listed as undone",
        "return !!document.querySelector('[data-testid=\"turn-undo-row\"][data-state=\"undone\"] [data-testid=\"turn-redo\"]');",
        Duration::from_secs(20),
    )?;
    ctx.eval(
        "document.querySelector('[data-testid=\"turn-undo-row\"][data-state=\"undone\"] [data-testid=\"turn-redo\"]').click();
         return true;",
    )?;
    ctx.wait_until(
        "the redo to be reported",
        "return !!document.querySelector('[data-testid=\"turn-undo-row\"][data-state=\"applied\"]');",
        Duration::from_secs(30),
    )?;
    ensure!(
        std::fs::read_to_string(&written).unwrap_or_default() == "written by the turn\n",
        "redo after the restart did not put the file back"
    );

    // Leave the binding as it was.
    ctx.goto("/settings/shortcuts")?;
    ctx.wait_until(
        "the reset button",
        "return !!document.querySelector('[data-testid=\"rebind-commandPalette\"] [data-testid=\"rebind-reset\"]');",
        Duration::from_secs(30),
    )?;
    ctx.eval(
        "document.querySelector('[data-testid=\"rebind-commandPalette\"] [data-testid=\"rebind-reset\"]').click();
         return true;",
    )?;
    Ok(())
}

/// Where the app's window is and what state it is in, for a page that has
/// stopped answering: a window that is minimised, hidden or off every screen
/// is throttled by WebView2 whatever the flags say.
///
/// Deliberately no picture. An earlier version captured the whole desktop,
/// which recorded everything else the person had open.
fn window_state(window: &tauri::WebviewWindow) -> String {
    format!(
        "visible={:?} minimized={:?} focused={:?} position={:?} size={:?} monitor={:?}",
        window.is_visible().ok(),
        window.is_minimized().ok(),
        window.is_focused().ok(),
        window.outer_position().ok().map(|p| (p.x, p.y)),
        window.outer_size().ok().map(|s| (s.width, s.height)),
        window.current_monitor().ok().flatten().map(|m| m.name().cloned()),
    )
}

/// Every process this app started that is still running, with its command
/// line: what a stalled app is waiting on, when it waits on a child.
///
/// Asked from outside the app's own event loop (a separate PowerShell), so it
/// answers even while the main thread is blocked.
fn app_children() -> String {
    let me = std::process::id();
    let out = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
        ])
        .output();
    let Ok(out) = out else {
        return "(could not list processes)".into();
    };
    let all: Vec<Value> = match serde_json::from_slice(&out.stdout) {
        Ok(Value::Array(a)) => a,
        _ => return "(unreadable process list)".into(),
    };
    let mut ours = vec![u64::from(me)];
    let mut found = Vec::new();
    let mut webviews: Vec<u64> = Vec::new();
    let mut changed = true;
    while changed {
        changed = false;
        for p in &all {
            let (Some(pid), Some(parent)) = (p["ProcessId"].as_u64(), p["ParentProcessId"].as_u64()) else {
                continue;
            };
            if ours.contains(&parent) && !ours.contains(&pid) {
                ours.push(pid);
                let name = p["Name"].as_str().unwrap_or("?");
                // WebView2 is always there and always many; the interesting
                // children are everything else.
                if name.eq_ignore_ascii_case("msedgewebview2.exe") {
                    webviews.push(pid);
                } else {
                    let cmd: String = p["CommandLine"].as_str().unwrap_or("").chars().take(200).collect();
                    found.push(format!("{pid} {name}: {cmd}"));
                }
                changed = true;
            }
        }
    }
    // Whether the page is busy or waiting: CPU each WebView2 process used over
    // two seconds. A renderer running script at 100% of a core and one parked
    // on a wait look the same from the page, and not from here.
    let busy = if webviews.is_empty() {
        String::new()
    } else {
        let ids = webviews.iter().map(u64::to_string).collect::<Vec<_>>().join(",");
        let script = format!(
            "$ids=@({ids}); $a=@{{}}; foreach($i in $ids){{ $p=Get-Process -Id $i -ErrorAction SilentlyContinue; if($p){{$a[$i]=$p.CPU}} }}; \
             Start-Sleep -Seconds 2; \
             foreach($i in $ids){{ $p=Get-Process -Id $i -ErrorAction SilentlyContinue; if($p -and $a.ContainsKey($i)){{ '{{0}}:{{1:N2}}s' -f $i, ($p.CPU - $a[$i]) }} }}"
        );
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).split_whitespace().collect::<Vec<_>>().join(" "))
            .unwrap_or_default()
    };
    let busy = format!("; WebView2 CPU over 2s: {}", if busy.is_empty() { "(none)" } else { &busy });
    if found.is_empty() {
        format!("(none but WebView2){busy}")
    } else {
        format!("{}{busy}", found.join(" | "))
    }
}

/// What a run that will not finish is waiting on: an approval nobody can see,
/// a button that is not there, or the conversation's own last words.
fn run_state(ctx: &Ctx) -> String {
    format!("{}; app children: {}", run_state_page(ctx), app_children())
}

fn run_state_page(ctx: &Ctx) -> String {
    ctx.eval_string(
        r#"const t = document.body.innerText || '';
           const allow = [...document.querySelectorAll('button')]
             .filter(x => /^allow once$/i.test((x.textContent || '').trim())).length;
           const input = document.querySelector('[data-testid="chat-input"]');
           let pane = input;
           for (let i = 0; pane && i < 12; i++) pane = pane.parentElement;
           const tail = ((pane && pane.innerText) || t).slice(-900);
           return JSON.stringify({
             visibility: document.visibilityState,
             focused: document.hasFocus(),
             approvalAsked: t.includes('needs your approval'),
             allowOnceButtons: allow,
             stopShown: !!document.querySelector('[data-test-id="stop-button"], [aria-label*="Stop" i]'),
             composer: !!input,
             testIds: [...document.querySelectorAll('[data-test-id]')].map(e => e.getAttribute('data-test-id')).slice(0, 40),
             footerButtons: input
               ? [...(input.closest('form') || input.parentElement.parentElement.parentElement).querySelectorAll('button')]
                   .map(b => (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 30)).slice(0, 25)
               : [],
             tail,
           });"#,
    )
    .unwrap_or_else(|e| format!("(state unavailable: {})", e.0))
}

/// Every toast on screen, joined, for asserting what a handler reported.
fn toasts(ctx: &Ctx) -> String {
    ctx.eval_string(
        "return [...document.querySelectorAll('[data-sonner-toast]')]
           .map(t => t.textContent).join(' | ');",
    )
    .unwrap_or_default()
}

/// A session exports to one file and comes back as a new session. AH-203.
///
/// Proves, in the real WebView with the real dialogs scripted: a run with a
/// tool call and a credential typed into the prompt exports through the
/// session menu; the file is versioned, carries the turns, and holds neither
/// the credential nor the provider key nor the attached folder; importing it
/// creates a session showing the conversation; importing it again is refused;
/// a file with a schema version this build does not know is refused by name.
fn scenario_session_export_import(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    let secret = "abcdefghijklmnopqrstuvwxyz0123456789";
    ctx.script_model("tools", &["ls:{\"path\":\".\"}"])?;
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the cowork composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    ctx.wait_until(
        "the previous run to finish",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(90),
    )?;
    ctx.ensure_model_selected()?;
    ctx.eval(
        "const b = [...document.querySelectorAll('button')].find(x =>
           /new session/i.test((x.textContent || '').trim()));
         if (b) b.click();
         return true;",
    )?;
    ctx.settle();
    ctx.type_into(
        "[data-testid=\"chat-input\"]",
        &format!("list the folder, and use Authorization: Bearer {secret}"),
    )?;
    ctx.wait_until(
        "the send control to arm",
        "const b = document.querySelector('[data-test-id=\"send-message-button\"]');
         return !!b && b.disabled !== true;",
        Duration::from_secs(60),
    )?;
    ctx.eval(
        "document.querySelector('[data-test-id=\"send-message-button\"]').click();
         return true;",
    )?;
    ctx.wait_until(
        "the tool call in the transcript",
        "return !!document.querySelector('[data-testid=\"tool-activity-item\"]');",
        Duration::from_secs(90),
    )?;
    ctx.wait_until(
        "the run to finish",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(90),
    )?;
    ctx.settle();

    // Export through the current session's own menu. The scripted picker has
    // to name a file that exists, so the target is created empty first.
    let dir = std::env::temp_dir().join(format!("jan-smoke-export-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| fail(e.to_string()))?;
    let target = dir.join("exported.jan-session.json");
    std::fs::write(&target, "").map_err(|e| fail(e.to_string()))?;
    ctx.script_dialog(Some(&target));
    let opened = ctx.eval_bool(
        r#"const row = document.querySelector('[data-sidebar="menu-button"][data-active="true"]')
             ?.closest('li');
           const more = row && row.querySelector('[data-sidebar="menu-action"]');
           if (!more) return false;
           more.dispatchEvent(new PointerEvent('pointerdown',
             { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
           return true;"#,
    );
    let exported = opened.and_then(|ok| {
        ensure!(ok, "the current session's menu is not on the page");
        ctx.wait_until(
            "the export item",
            "return !!document.querySelector('[data-testid=\"export-session\"]');",
            Duration::from_secs(10),
        )?;
        ctx.eval("document.querySelector('[data-testid=\"export-session\"]').click(); return true;")?;
        let mut body = String::new();
        for _ in 0..40 {
            body = std::fs::read_to_string(&target).unwrap_or_default();
            if body.contains("jan.cowork-session") {
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        Ok(body)
    });
    ctx.clear_dialog_script();
    let body = exported?;
    ensure!(
        body.contains("\"schemaVersion\": 1"),
        "the export was not written or is not versioned; toasts: {}",
        toasts(ctx)
    );
    ensure!(body.contains("list the folder"), "the export does not carry the turns");
    ensure!(!body.contains(secret), "the export holds the credential typed into the prompt");
    ensure!(!body.contains("smoke-not-a-real-key"), "the export holds the provider key");
    let folder = ctx.project.to_string_lossy().replace('\\', "\\\\");
    ensure!(!body.contains(&folder), "the export holds the attached folder's path");

    // Import it: a new session showing the conversation.
    let import = |ctx: &Ctx, file: &Path| -> ScenarioResult {
        ctx.script_dialog(Some(file));
        let clicked = ctx.eval_bool(
            "const b = [...document.querySelectorAll('button')].find(x =>
               /import session/i.test((x.textContent || '').trim()));
             if (!b) return false; b.click(); return true;",
        );
        std::thread::sleep(Duration::from_millis(1500));
        ctx.clear_dialog_script();
        ensure!(clicked?, "the Import session action is not on the page");
        Ok(())
    };
    import(ctx, &target)?;
    ctx.wait_until(
        "the import to be reported",
        "return [...document.querySelectorAll('[data-sonner-toast]')]
           .some(t => /Session imported/.test(t.textContent || ''));",
        Duration::from_secs(20),
    )?;
    ctx.wait_until(
        "the imported conversation to show",
        "return (document.body.innerText || '').includes('list the folder');",
        Duration::from_secs(20),
    )?;

    // Again: refused, not duplicated.
    import(ctx, &target)?;
    ctx.wait_until(
        "a second import to be refused",
        "return [...document.querySelectorAll('[data-sonner-toast]')]
           .some(t => /already imported/.test(t.textContent || ''));",
        Duration::from_secs(20),
    )?;

    // A schema version this build does not know: refused by name.
    let future = dir.join("future.jan-session.json");
    let newer = body.replacen("\"schemaVersion\": 1", "\"schemaVersion\": 9", 1);
    std::fs::write(&future, newer).map_err(|e| fail(e.to_string()))?;
    import(ctx, &future)?;
    ctx.wait_until(
        "an unknown schema version to be refused",
        "return [...document.querySelectorAll('[data-sonner-toast]')]
           .some(t => /schema version 9/.test(t.textContent || ''));",
        Duration::from_secs(20),
    )?;
    let _ = std::fs::remove_dir_all(&dir);
    Ok(())
}

/// Hand a session to another computer, and continue it there. AH-210.
///
/// In the real WebView: a run in a session with the fixture attached is
/// handed off through the session menu; the file names the folder by name,
/// branch and commit and carries no path from this machine; importing it says
/// plainly what could not be restored, checks the folder once it is attached,
/// and names a model this machine does not have.
fn scenario_session_handoff(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    let readme = ctx.project.join("README.md").to_string_lossy().to_string();
    ctx.script_model(
        "tools",
        &[&format!("read:{}", serde_json::json!({ "path": readme }))],
    )?;
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the cowork composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    ctx.eval(
        "const b = [...document.querySelectorAll('button')].find(x =>
           /new session/i.test((x.textContent || '').trim()));
         if (b) b.click();
         return true;",
    )?;
    ctx.settle();
    attach_project(ctx)?;
    ctx.ensure_model_selected()?;
    ctx.type_into("[data-testid=\"chat-input\"]", "read the readme for the handoff")?;
    ctx.wait_until(
        "the send control to arm",
        "const b = document.querySelector('[data-test-id=\"send-message-button\"]');
         return !!b && b.disabled !== true;",
        Duration::from_secs(60),
    )?;
    ctx.eval("document.querySelector('[data-test-id=\"send-message-button\"]').click(); return true;")?;
    ctx.wait_until(
        "the tool call in the transcript",
        "return !!document.querySelector('[data-testid=\"tool-activity-item\"]');",
        Duration::from_secs(90),
    )?;
    ctx.wait_until(
        "the run to finish",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(90),
    )?;
    ctx.settle();

    let dir = std::env::temp_dir().join(format!("jan-smoke-handoff-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| fail(e.to_string()))?;
    let target = dir.join("handoff.jan-session.json");
    std::fs::write(&target, "").map_err(|e| fail(e.to_string()))?;
    ctx.script_dialog(Some(&target));
    let saved = ctx
        .eval_bool(
            r#"const row = document.querySelector('[data-sidebar="menu-button"][data-active="true"]')
                 ?.closest('li');
               const more = row && row.querySelector('[data-sidebar="menu-action"]');
               if (!more) return false;
               more.dispatchEvent(new PointerEvent('pointerdown',
                 { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
               return true;"#,
        )
        .and_then(|ok| {
            ensure!(ok, "the current session's menu is not on the page");
            ctx.wait_until(
                "the handoff item",
                "return !!document.querySelector('[data-testid=\"handoff-session\"]');",
                Duration::from_secs(10),
            )?;
            ctx.eval("document.querySelector('[data-testid=\"handoff-session\"]').click(); return true;")?;
            let mut body = String::new();
            for _ in 0..40 {
                body = std::fs::read_to_string(&target).unwrap_or_default();
                if body.contains("\"handoff\"") {
                    break;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
            Ok(body)
        });
    ctx.clear_dialog_script();
    let body = saved?;
    ensure!(
        body.contains("\"handoff\""),
        "the handoff was not written; toasts: {}",
        toasts(ctx)
    );
    ensure!(
        body.contains("read the readme for the handoff"),
        "the handoff does not carry the conversation"
    );
    // No path from this machine: the fixture, its workspace, either separator.
    let workspace = ctx.workspace.to_string_lossy().to_string();
    for spelled in [
        workspace.replace('\\', "\\\\"),
        workspace.replace('\\', "/"),
    ] {
        ensure!(
            !body.to_lowercase().contains(&spelled.to_lowercase()),
            "the handoff holds a path from this machine: {spelled}"
        );
    }
    ensure!(
        body.contains("<folder>"),
        "the folder's path was not replaced by what it means"
    );
    ensure!(!body.contains("smoke-not-a-real-key"), "the handoff holds the provider key");
    let parsed: Value = serde_json::from_str(&body).map_err(|e| fail(e.to_string()))?;
    let identity = &parsed["handoff"]["folder"];
    ensure!(
        identity["name"] == "cowork-smoke-fixture",
        "the folder is not named: {identity}"
    );
    ensure!(
        identity["head"].as_str().is_some_and(|h| h.len() == 40),
        "the folder's commit is not recorded: {identity}"
    );
    ensure!(
        parsed["handoff"]["model"]["provider"] == SMOKE_PROVIDER,
        "the model is not named: {}",
        parsed["handoff"]["model"]
    );

    // Import it: what could not be restored is said plainly.
    let import = |ctx: &Ctx, file: &Path| -> ScenarioResult {
        ctx.script_dialog(Some(file));
        let clicked = ctx.eval_bool(
            "const b = [...document.querySelectorAll('button')].find(x =>
               /import session/i.test((x.textContent || '').trim()));
             if (!b) return false; b.click(); return true;",
        );
        std::thread::sleep(Duration::from_millis(1500));
        ctx.clear_dialog_script();
        ensure!(clicked?, "the Import session action is not on the page");
        Ok(())
    };
    import(ctx, &target)?;
    ctx.wait_until(
        "the notice of what to restore",
        "const n = document.querySelector('[data-testid=\"handoff-item-folder\"]');
         return !!n && n.textContent.includes('cowork-smoke-fixture');",
        Duration::from_secs(20),
    )?;
    ensure!(
        !ctx.eval_bool("return !!document.querySelector('[data-testid=\"handoff-item-model\"]');")?,
        "the session's model was reported missing, though this machine has it"
    );

    // Attach the folder: it is checked against the one the session was on.
    attach_project(ctx)?;
    ctx.wait_until(
        "the attached folder to be checked",
        "const c = document.querySelector('[data-testid=\"handoff-folder-check\"]');
         return !!c && c.textContent.includes('matches');",
        Duration::from_secs(20),
    )?;

    // A model this machine does not have is named, not silently swapped.
    let other = dir.join("other-model.jan-session.json");
    let mut changed = parsed.clone();
    changed["exportId"] = Value::from("handoff-other-model");
    changed["handoff"]["model"]["id"] = Value::from("not-a-model");
    std::fs::write(&other, serde_json::to_vec_pretty(&changed).unwrap())
        .map_err(|e| fail(e.to_string()))?;
    import(ctx, &other)?;
    ctx.wait_until(
        "the missing model to be named",
        "const n = document.querySelector('[data-testid=\"handoff-item-model\"]');
         return !!n && n.textContent.includes('not-a-model');",
        Duration::from_secs(20),
    )?;
    let _ = std::fs::remove_dir_all(&dir);
    Ok(())
}

const HANDOFF_MARKER: &str = "handoff-phase-1.txt";
const HANDOFF_EXPORT_ID: &str = "handoff-persist-check";

/// Phase one: import a handoff whose folder and model this machine does not
/// have, see the notice, and exit once the session is on disk.
fn scenario_handoff_persist_first(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    let file = ctx.workspace.join("persist.jan-session.json");
    let bundle = serde_json::json!({
        "format": "jan.cowork-session",
        "schemaVersion": 1,
        "exportId": HANDOFF_EXPORT_ID,
        "exportedAt": "2026-09-10T00:00:00Z",
        "session": { "id": "remote-1", "title": "Handed over", "turns": [], "updated": 1 },
        "toolActivity": [],
        "fileActivity": [],
        "changeSummary": [],
        "handoff": {
            "folder": { "name": "far-away-repo", "branch": "main", "head": "0123456789abcdef0123456789abcdef01234567" },
            "model": { "provider": "provider-not-here", "id": "model-x" }
        }
    });
    std::fs::write(&file, serde_json::to_vec_pretty(&bundle).unwrap()).map_err(|e| fail(e.to_string()))?;
    ctx.goto("/cowork")?;
    ctx.script_dialog(Some(&file));
    let clicked = ctx.eval_bool(
        "const b = [...document.querySelectorAll('button')].find(x =>
           /import session/i.test((x.textContent || '').trim()));
         if (!b) return false; b.click(); return true;",
    );
    std::thread::sleep(Duration::from_millis(1500));
    ctx.clear_dialog_script();
    ensure!(clicked?, "the Import session action is not on the page");
    ctx.wait_until(
        "the notice naming the provider",
        "const n = document.querySelector('[data-testid=\"handoff-item-provider\"]');
         return !!n && n.textContent.includes('provider-not-here');",
        Duration::from_secs(20),
    )?;
    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let settings = Path::new(&data).join("settings.json");
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let raw = std::fs::read_to_string(&settings).unwrap_or_default();
        if raw.contains(HANDOFF_EXPORT_ID) && raw.contains("far-away-repo") {
            break;
        }
        ensure!(
            std::time::Instant::now() < deadline,
            "the imported session never reached settings.json"
        );
        std::thread::sleep(Duration::from_millis(200));
    }
    std::fs::write(ctx.workspace.join(HANDOFF_MARKER), "imported").map_err(|e| fail(e.to_string()))
}

/// Phase two, a new process: the notice is still there, and dismissing it
/// is remembered.
fn scenario_handoff_persist_second(ctx: &Ctx) -> ScenarioResult {
    ensure!(
        ctx.workspace.join(HANDOFF_MARKER).exists(),
        "phase one did not run against this workspace"
    );
    ctx.goto("/cowork")?;
    // The imported session, by its title in the sidebar.
    ctx.wait_until(
        "the imported session in the sidebar",
        "const b = [...document.querySelectorAll('[data-sidebar=\"menu-button\"]')]
           .find(x => (x.textContent || '').includes('Handed over'));
         if (b) b.click();
         return !!b;",
        Duration::from_secs(20),
    )?;
    ctx.wait_until(
        "the notice to come back after the restart",
        "const f = document.querySelector('[data-testid=\"handoff-item-folder\"]');
         const p = document.querySelector('[data-testid=\"handoff-item-provider\"]');
         return !!f && f.textContent.includes('far-away-repo') && !!p;",
        Duration::from_secs(20),
    )?;
    ctx.eval("document.querySelector('[data-testid=\"handoff-dismiss\"]').click(); return true;")?;
    ctx.wait_until(
        "the notice to be dismissed",
        "return !document.querySelector('[data-testid=\"handoff-notice\"]');",
        Duration::from_secs(10),
    )?;
    Ok(())
}

/// Titling a conversation is a hidden utility agent. AH-208.
///
/// After a real round trip on the chat route, the automatic title call runs
/// through `runUtilityAgent`, and this proves it is accountable without being
/// a leak: a `title` record lands in `audit/utility-agents.jsonl` for this
/// conversation, it says no tools were offered, and it holds neither the
/// user's message, nor the model's reply, nor the provider key.
fn scenario_utility_agent_title(ctx: &Ctx) -> ScenarioResult {
    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let log = Path::new(&data).join("audit").join("utility-agents.jsonl");
    let before = std::fs::read_to_string(&log).unwrap_or_default().lines().count();

    scenario_model_round_trip(ctx)?;

    let mut fresh: Vec<String> = Vec::new();
    for _ in 0..60 {
        fresh = std::fs::read_to_string(&log)
            .unwrap_or_default()
            .lines()
            .skip(before)
            .map(str::to_string)
            .collect();
        if fresh.iter().any(|l| l.contains("\"kind\":\"title\"")) {
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    let title = fresh
        .iter()
        .find(|l| l.contains("\"kind\":\"title\""))
        .ok_or_else(|| Failure("the automatic title call was never recorded".into()))?;
    ensure!(
        title.contains("\"outcome\":\"succeeded\""),
        "the title call did not succeed: {title}"
    );
    ensure!(
        title.contains("\"toolsOffered\":false"),
        "the title call is not recorded as tool-free: {title}"
    );
    let all = fresh.join("\n");
    for leaked in ["hello smoke", "Hello from the smoke model", "smoke-not-a-real-key"] {
        ensure!(!all.contains(leaked), "the utility-agent record holds {leaked:?}");
    }
    Ok(())
}

/// A message reaches the model and its reply comes back.
///
/// Everything downstream of a run -- the activity timeline, tool rows,
/// cancellation -- depends on this working, so it is asserted on its own.
fn scenario_model_round_trip(ctx: &Ctx) -> ScenarioResult {
    ctx.script_model("plain", &[])?;
    ctx.goto("/")?;
    ctx.wait_until(
        "the chat composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;

    // Pick the model through the picker rather than relying on the seeded
    // selection: the persisted store normalises what it is given, and a chat
    // with no model selected silently does nothing when you press send.
    let already = ctx.eval_bool(&format!(
        "return [...document.querySelectorAll('button')].some(b =>
           (b.textContent || '').includes({SMOKE_MODEL:?}));"
    ))?;
    if !already {
        ctx.eval(
            "const b = [...document.querySelectorAll('button')].find(x =>
               /select a model/i.test((x.getAttribute('aria-label') || '')
                 + ' ' + (x.textContent || '')));
             if (b) b.click();
             return true;",
        )?;
        ctx.wait_until(
            "the model picker",
            "return [...document.querySelectorAll('input')].some(i =>
                /search|find|model/i.test(i.getAttribute('placeholder') || ''));",
            Duration::from_secs(20),
        )?;
        ctx.type_into(
            "input[placeholder*='model' i], input[placeholder*='search' i]",
            "smoke",
        )?;
        std::thread::sleep(Duration::from_millis(800));
        let picked = ctx.eval_bool(&format!(
            "const el = [...document.querySelectorAll('[role=\"option\"],button,li,div')]
               .filter(e => e.children.length <= 2
                 && (e.textContent || '').trim().includes({SMOKE_MODEL:?}))
               .pop();
             if (!el) return false;
             (el.closest('[role=\"option\"],button,li') || el).click();
             return true;"
        ))?;
        if !picked {
            ctx.describe("model-picker-open")?;
            bail!("the picker never offered {SMOKE_MODEL}");
        }
        std::thread::sleep(Duration::from_millis(900));
    }

    ctx.type_into("[data-testid=\"chat-input\"]", "hello smoke")?;
    // Sixty seconds, not fifteen: the previous scenario's run may still be
    // streaming when this one starts, and while it is the control is a stop
    // button rather than a send one.
    ctx.wait_until(
        "the send control to arm",
        "const b = document.querySelector('[data-test-id=\"send-message-button\"]');
         return !!b && b.disabled !== true;",
        Duration::from_secs(60),
    )?;
    ctx.eval(
        "document.querySelector('[data-test-id=\"send-message-button\"]').click();
         return true;",
    )?;

    let replied = ctx.wait_until(
        "the model's reply",
        "return document.body.textContent.includes('Hello from the smoke model');",
        Duration::from_secs(60),
    );
    if replied.is_err() {
        let tail = ctx.eval_string(
            "const t = document.body.textContent || '';
             return t.slice(Math.max(0, t.length - 900));",
        )?;
        println!("      round-trip page tail: {tail}");
    }
    replied?;
    Ok(())
}

/// Startup reaches nothing the user did not configure.
///
/// The llama.cpp extension used to fetch an embedding model from
/// huggingface.co during provisioning, and again on the first RAG call if that
/// failed. The extension runs in the WebView, so the browser's own resource
/// timeline is the right instrument: every request the page made is in it.
fn scenario_no_unconfigured_egress(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/")?;
    // Give provisioning time to do whatever it is going to do.
    std::thread::sleep(Duration::from_secs(5));

    let port = ctx.mock_port;
    let report = ctx.eval_string(&format!(
        r#"const allowed = (url) =>
             url.startsWith('tauri://')
             || url.startsWith('asset://')
             || url.startsWith('ipc://')
             || url.startsWith('data:')
             || url.startsWith('blob:')
             || url.includes('://localhost')
             || url.includes('://tauri.localhost')
             || url.includes('://asset.localhost')
             || url.includes('://ipc.localhost')
             // The one endpoint this run configured.
             || url.includes('127.0.0.1:{port}');
           const foreign = performance
             .getEntriesByType('resource')
             .map((e) => e.name)
             .filter((name) => !allowed(name));
           return JSON.stringify({{ foreign: [...new Set(foreign)].slice(0, 20) }});"#
    ))?;
    println!("      unconfigured requests at startup: {report}");
    let v: Value = serde_json::from_str(&report).unwrap_or(Value::Null);
    let foreign = v
        .get("foreign")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    ensure!(
        foreign.is_empty(),
        "startup reached endpoints nobody configured: {report}"
    );
    Ok(())
}

/// AH-078. A real model request, then "What the model received" opened from
/// that request's own activity.
fn scenario_prompt_snapshot(ctx: &Ctx) -> ScenarioResult {
    ctx.script_model("plain", &[])?;
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the cowork composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;

    // While a run streams the send control is replaced by a stop control, so
    // this selector finds nothing until the previous scenario's run is over.
    ctx.wait_until(
        "the previous run to finish",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(90),
    )?;
    ctx.ensure_model_selected()?;
    // A fresh session first. The reply text is asserted on below, and a
    // previous attempt's reply is still on screen -- matching that made the
    // scenario continue before this attempt's dispatch had even happened, and
    // then blame the panel for not showing a snapshot that did not exist yet.
    ctx.eval(
        "const b = [...document.querySelectorAll('button')].find(x =>
           /new session/i.test((x.textContent || '').trim()));
         if (b) b.click();
         return true;",
    )?;
    ctx.settle();
    ctx.wait_until(
        "an empty transcript",
        "return !document.body.innerText.includes('Hello from the smoke model');",
        Duration::from_secs(20),
    )?;

    ctx.type_into("[data-testid=\"chat-input\"]", "snapshot probe")?;
    // Sixty seconds, not fifteen: the previous scenario's run may still be
    // streaming when this one starts, and while it is the control is a stop
    // button rather than a send one.
    ctx.wait_until(
        "the send control to arm",
        "const b = document.querySelector('[data-test-id=\"send-message-button\"]');
         return !!b && b.disabled !== true;",
        Duration::from_secs(60),
    )?;
    ctx.eval(
        "document.querySelector('[data-test-id=\"send-message-button\"]').click();
         return true;",
    )?;

    // Was one recorded at all? This separates "the transport never captured
    // it" from "it was captured and the timeline did not show it", which look
    // identical from the DOM.
    // The dispatch is recorded before anything is rendered, so a missing panel
    // and a missing record are different defects and must not read alike.
    // Polled: the click only starts the dispatch, and reading the log once,
    // straight after it, raced the transport writing the record.
    let count = || {
        std::env::var("JAN_DATA_FOLDER")
            .map(|d| Path::new(&d).join("audit/prompts.jsonl"))
            .ok()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .count()
    };
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut records = count();
    while records == 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(250));
        records = count();
    }
    ensure!(
        records >= 1,
        "the dispatch was never recorded ({records} records on disk)"
    );

    // The reply first. Without this a chat that never happened is reported as
    // "the panel did not appear", which is the wrong defect entirely.
    ctx.wait_until(
        "the model's reply",
        "return document.body.innerText.includes('Hello from the smoke model');",
        Duration::from_secs(90),
    )?;

    // The panel appears on the assistant message the snapshot produced.
    ctx.wait_until(
        "the prompt snapshot panel",
        "return !!document.querySelector('[data-testid=\"prompt-snapshot\"]');",
        Duration::from_secs(90),
    )?;

    // Collapsed until asked for.
    let open_before = ctx.eval_bool(
        "return document.querySelector('[data-testid=\"prompt-snapshot\"]').open === true;",
    )?;
    ensure!(!open_before, "the panel must be collapsed by default");

    ctx.eval(
        "document.querySelector('[data-testid=\"prompt-snapshot-toggle\"]').click();
         return true;",
    )?;
    ctx.wait_until(
        "the snapshot to load",
        "return !!document.querySelector('[data-testid=\"prompt-snapshot-meta\"]');",
        Duration::from_secs(45),
    )?;

    let meta = ctx.eval_string(
        "return document.querySelector('[data-testid=\"prompt-snapshot-meta\"]').textContent;",
    )?;
    println!("      snapshot meta: {meta}");
    ensure!(
        meta.contains(SMOKE_PROVIDER) || meta.contains(SMOKE_MODEL),
        "the panel did not name the provider or model: {meta}"
    );
    ensure!(meta.contains("fnv1a64:"), "no payload hash shown: {meta}");
    ensure!(
        ctx.eval_bool(
            "return !!document.querySelector('[data-testid=\"prompt-snapshot-redactions\"]');"
        )?,
        "no redaction summary shown"
    );

    // Both views render the same payload.
    ctx.wait_until(
        "the tree view",
        "return !!document.querySelector('[data-testid=\"prompt-snapshot-tree\"]');",
        Duration::from_secs(15),
    )?;
    ctx.eval(
        "document.querySelector('[data-testid=\"prompt-snapshot-view-json\"]').click();
         return true;",
    )?;
    ctx.wait_until(
        "the JSON view",
        "return !!document.querySelector('[data-testid=\"prompt-snapshot-json\"]');",
        Duration::from_secs(15),
    )?;

    // Nothing that looks like a credential reaches the panel. The seeded
    // provider carries an api key, so this is a real check and not a tautology.
    let panel = ctx.eval_string(
        "return document.querySelector('[data-testid=\"prompt-snapshot\"]').textContent;",
    )?;
    for secret in ["smoke-not-a-real-key", "Bearer ", "sk-"] {
        ensure!(!panel.contains(secret), "the panel exposed {secret:?}");
    }
    Ok(())
}

const REPLAY_MARKER: &str = "context-replay-phase-1.json";
const REPLAY_PROBE: &str = "replay probe one";

/// The newest snapshot the transport recorded of a turn whose user message
/// contains `needle`, leaving out replays' own dispatches.
fn recorded_dispatch(needle: &str) -> Option<Value> {
    let data = std::env::var("JAN_DATA_FOLDER").ok()?;
    let text = std::fs::read_to_string(Path::new(&data).join("audit/prompts.jsonl")).ok()?;
    text.lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|s| s["agent"] != "replay")
        .filter(|s| {
            s["payload"]["messages"].as_array().is_some_and(|m| {
                m.iter()
                    .any(|x| x["role"] == "user" && x["content"].to_string().contains(needle))
            })
        })
        .last()
}

/// JS for the `i`th prompt snapshot panel, opened.
fn replay_panel(i: usize) -> String {
    format!(
        r#"{{ const p = document.querySelectorAll('[data-testid="prompt-snapshot"]')[{i}];
           if (p && !p.open) p.querySelector('[data-testid="prompt-snapshot-toggle"]').click(); }}"#
    )
}

/// The replay rows of panel `i`, newest first, as `state/matched/kind`.
fn replay_rows(ctx: &Ctx, i: usize) -> Result<Vec<String>, Failure> {
    let raw = ctx.eval_string(&format!(
        r#"const p = document.querySelectorAll('[data-testid="prompt-snapshot"]')[{i}];
           if (!p) return '[]';
           return JSON.stringify([...p.querySelectorAll('[data-testid="prompt-replay"]')].map(r =>
             [r.getAttribute('data-state'), r.getAttribute('data-matched'), r.getAttribute('data-kind')].join('/')));"#
    ))?;
    serde_json::from_str(&raw).map_err(|e| Failure(format!("replay rows: {e}")))
}

fn click_replay(ctx: &Ctx, i: usize) -> ScenarioResult {
    ctx.wait_until(
        "the replay control to be ready",
        &format!(
            r#"{}
               const b = document.querySelectorAll('[data-testid="prompt-snapshot"]')[{i}]
                 ?.querySelector('[data-testid="prompt-snapshot-replay"]');
               return !!b && !b.disabled;"#,
            replay_panel(i)
        ),
        Duration::from_secs(45),
    )?;
    ctx.eval(&format!(
        r#"document.querySelectorAll('[data-testid="prompt-snapshot"]')[{i}]
             .querySelector('[data-testid="prompt-snapshot-replay"]').click();
           return true;"#
    ))?;
    Ok(())
}

fn wait_top_replay(ctx: &Ctx, i: usize, rows: usize, state: &str) -> ScenarioResult {
    ctx.wait_until(
        &format!("replay {rows} of panel {i} to be {state}"),
        &format!(
            r#"const p = document.querySelectorAll('[data-testid="prompt-snapshot"]')[{i}];
               const rows = p ? [...p.querySelectorAll('[data-testid="prompt-replay"]')] : [];
               return rows.length === {rows} && rows[0].getAttribute('data-state') === {state:?};"#
        ),
        Duration::from_secs(60),
    )
}

/// AH-079, phase one: a past turn's exact context is sent again from the
/// panel that shows it, and the backend confirms the replay dispatch carried
/// the same payload. A replay is stopped part-way; a turn whose snapshot had a
/// field redacted is refused, in the panel and by the backend; and a replay is
/// left running when the app exits, for phase two to find.
fn scenario_context_replay_first(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    ctx.script_model("plain", &[])?;
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the cowork composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    ctx.wait_until(
        "the previous run to finish",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(90),
    )?;
    ctx.ensure_model_selected()?;
    ctx.eval(
        "const b = [...document.querySelectorAll('button')].find(x =>
           /new session/i.test((x.textContent || '').trim()));
         if (b) b.click();
         return true;",
    )?;
    ctx.settle();
    ctx.wait_until(
        "an empty transcript",
        "return !document.body.innerText.includes('Hello from the smoke model');",
        Duration::from_secs(20),
    )?;

    let send = |text: &str| -> ScenarioResult {
        ctx.type_into("[data-testid=\"chat-input\"]", text)?;
        ctx.wait_until(
            "the send control to arm",
            "const b = document.querySelector('[data-test-id=\"send-message-button\"]');
             return !!b && b.disabled !== true;",
            Duration::from_secs(60),
        )?;
        ctx.eval(
            "document.querySelector('[data-test-id=\"send-message-button\"]').click();
             return true;",
        )?;
        Ok(())
    };
    let replies = |n: usize| -> ScenarioResult {
        ctx.wait_until(
            &format!("{n} model repl(ies) and an idle composer"),
            &format!(
                "return (document.body.innerText.split('Hello from the smoke model').length - 1) >= {n}
                   && !!document.querySelector('[data-test-id=\"send-message-button\"]')
                   && document.querySelectorAll('[data-testid=\"prompt-snapshot\"]').length >= {n};"
            ),
            Duration::from_secs(90),
        )
    };

    // 1. A turn to replay.
    send(REPLAY_PROBE)?;
    replies(1)?;
    let original = recorded_dispatch(REPLAY_PROBE)
        .ok_or_else(|| fail("the turn's dispatch was not recorded".into()))?;
    let session = original["session"].as_str().unwrap_or_default().to_string();
    let snapshot = original["id"].as_str().unwrap_or_default().to_string();
    ensure!(
        original["redactions"].as_array().is_some_and(|r| r.is_empty()),
        "the probe turn's snapshot has redactions: {}",
        original["redactions"]
    );

    // 2. Replayed from its panel: completed, and the same payload again.
    let before = mock_requests(ctx)?.len();
    click_replay(ctx, 0)?;
    wait_top_replay(ctx, 0, 1, "completed")?;
    let rows = replay_rows(ctx, 0)?;
    ensure!(
        rows[0].starts_with("completed/true"),
        "the replay did not confirm the same context: {rows:?}"
    );
    let requests = mock_requests(ctx)?;
    ensure!(requests.len() > before, "the replay never reached the model");
    let probes: Vec<&Value> = requests
        .iter()
        .filter(|r| r.to_string().contains(REPLAY_PROBE))
        .collect();
    ensure!(probes.len() >= 2, "the model saw {} probe request(s)", probes.len());
    let (turn, replay) = (probes[probes.len() - 2], probes[probes.len() - 1]);
    ensure!(
        turn == replay,
        "the replay sent a different request:\n turn   {turn}\n replay {replay}"
    );

    // 3. Stopped part-way.
    ctx.script_model("slow", &[])?;
    click_replay(ctx, 0)?;
    wait_top_replay(ctx, 0, 2, "running")?;
    ctx.wait_until(
        "the Stop control",
        "return !!document.querySelector('[data-testid=\"prompt-replay-cancel\"]');",
        Duration::from_secs(20),
    )?;
    ctx.eval(
        "document.querySelector('[data-testid=\"prompt-replay-cancel\"]').click(); return true;",
    )?;
    wait_top_replay(ctx, 0, 2, "cancelled")?;
    let rows = replay_rows(ctx, 0)?;
    ensure!(
        !rows.iter().any(|r| r.starts_with("running")),
        "a stopped replay still reads as running: {rows:?}"
    );

    // 4. A turn whose snapshot had a field redacted is refused.
    ctx.script_model("plain", &[])?;
    send("replay probe two uses sk-abcdefghijklmnopqrstuvwxyz0123 please")?;
    replies(2)?;
    let secret = recorded_dispatch("replay probe two")
        .ok_or_else(|| fail("the second turn's dispatch was not recorded".into()))?;
    let secret_id = secret["id"].as_str().unwrap_or_default().to_string();
    ensure!(
        secret["redactions"].as_array().is_some_and(|r| !r.is_empty()),
        "the fixture secret was not redacted, so there is nothing to refuse"
    );
    ctx.wait_until(
        "the redacted turn's replay control, disabled with a reason",
        &format!(
            r#"{}
               const p = document.querySelectorAll('[data-testid="prompt-snapshot"]')[1];
               const b = p && p.querySelector('[data-testid="prompt-snapshot-replay"]');
               const why = p && p.querySelector('[data-testid="prompt-snapshot-replay-blocked"]');
               return !!b && b.disabled && !!why && /redacted/.test(why.textContent);"#,
            replay_panel(1)
        ),
        Duration::from_secs(45),
    )?;
    let (ok, refused) = ipc(
        ctx,
        "agent_replay_begin",
        &format!("{{ session: {session:?}, snapshotId: {secret_id:?} }}"),
    )?;
    ensure!(
        !ok && refused["kind"] == "redacted",
        "the backend did not refuse the redacted snapshot: {refused}"
    );
    let (ok, foreign) = ipc(
        ctx,
        "agent_replay_begin",
        &format!("{{ session: 'someone-else', snapshotId: {snapshot:?} }}"),
    )?;
    ensure!(
        !ok && foreign["kind"] == "not-found",
        "another session could replay this snapshot: {foreign}"
    );

    // 5. Left running as the app exits.
    ctx.script_model("slow", &[])?;
    click_replay(ctx, 0)?;
    wait_top_replay(ctx, 0, 3, "running")?;
    std::fs::write(
        ctx.workspace.join(REPLAY_MARKER),
        serde_json::json!({ "session": session, "snapshot": snapshot, "secret": secret_id })
            .to_string(),
    )
    .map_err(|e| fail(e.to_string()))
}

/// AH-079, phase two, a new process on the same profile: every replay is
/// still listed with its ending, the one left running reads as interrupted,
/// and the refusal is kept.
fn scenario_context_replay_second(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    let marker: Value = serde_json::from_str(
        &std::fs::read_to_string(ctx.workspace.join(REPLAY_MARKER))
            .map_err(|_| fail("phase one did not run against this workspace".into()))?,
    )
    .map_err(|e| fail(e.to_string()))?;
    let session = marker["session"].as_str().unwrap_or_default();
    let snapshot = marker["snapshot"].as_str().unwrap_or_default();
    let secret = marker["secret"].as_str().unwrap_or_default();
    ctx.script_model("plain", &[])?;

    let (ok, listed) = ipc(
        ctx,
        "agent_replays_list",
        &format!("{{ session: {session:?}, snapshotId: {snapshot:?} }}"),
    )?;
    ensure!(ok, "listing replays failed after a restart: {listed}");
    let states: Vec<&str> = listed
        .as_array()
        .map(|a| a.iter().filter_map(|r| r["state"].as_str()).collect())
        .unwrap_or_default();
    ensure!(
        states == ["interrupted", "cancelled", "completed"],
        "after a restart the replays are {states:?}"
    );
    ensure!(
        listed[2]["matched"] == true && !listed[2]["text"].as_str().unwrap_or_default().is_empty(),
        "the completed replay lost its result: {}",
        listed[2]
    );
    let (_, refusals) = ipc(
        ctx,
        "agent_replays_list",
        &format!("{{ session: {session:?}, snapshotId: {secret:?} }}"),
    )?;
    ensure!(
        refusals[0]["state"] == "refused" && refusals[0]["error"]["kind"] == "redacted",
        "the refusal was not kept: {refusals}"
    );

    // And in the panel.
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the turn's snapshot panel after a restart",
        "return document.querySelectorAll('[data-testid=\"prompt-snapshot\"]').length >= 1;",
        Duration::from_secs(60),
    )?;
    ctx.eval(&format!("{} return true;", replay_panel(0)))?;
    ctx.wait_until(
        "the replays listed in the panel",
        r#"const p = document.querySelectorAll('[data-testid="prompt-snapshot"]')[0];
           return p.querySelectorAll('[data-testid="prompt-replay"]').length === 3;"#,
        Duration::from_secs(45),
    )?;
    let rows = replay_rows(ctx, 0)?;
    let shown: Vec<&str> = rows.iter().map(|r| r.split('/').next().unwrap_or("")).collect();
    ensure!(
        shown == ["interrupted", "cancelled", "completed"],
        "the panel shows {rows:?} after a restart"
    );
    Ok(())
}

/// A tool call is recorded, stays in the conversation, and survives a reload.
/// AH-050/AH-172.
fn scenario_tool_activity(ctx: &Ctx) -> ScenarioResult {
    // A real tool call, not a plain reply: the model asks for `list`, the
    // dispatcher runs it, and the record has to show the whole life of it.
    ctx.script_model(
        "tools",
        &["ls:{\"path\":\".\"}", "read:{\"path\":\"no-such-file.txt\"}"],
    )?;
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the cowork composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    ctx.wait_until(
        "the previous run to finish",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(90),
    )?;
    ctx.ensure_model_selected()?;

    // A fresh session, so what is asserted below belongs to this run.
    ctx.eval(
        "const b = [...document.querySelectorAll('button')].find(x =>
           /new session/i.test((x.textContent || '').trim()));
         if (b) b.click();
         return true;",
    )?;
    ctx.settle();

    let before = activity_events(ctx);
    ctx.type_into("[data-testid=\"chat-input\"]", "list the folder")?;
    ctx.wait_until(
        "the send control to arm",
        "const b = document.querySelector('[data-test-id=\"send-message-button\"]');
         return !!b && b.disabled !== true;",
        Duration::from_secs(60),
    )?;
    ctx.eval(
        "document.querySelector('[data-test-id=\"send-message-button\"]').click();
         return true;",
    )?;

    // The call appears in the conversation as its own item.
    let card = ctx.wait_until(
        "the tool call in the transcript",
        "return !!document.querySelector('[data-testid=\"tool-activity-item\"]');",
        Duration::from_secs(90),
    );
    if card.is_err() {
        // Which half failed matters: a model that never asked for a tool and a
        // dispatcher that never ran one look identical in the DOM.
        println!("      events on disk: {}", activity_events(ctx).len());
        println!(
            "      transcript: {}",
            ctx.eval_string("return (document.body.innerText || '').slice(0, 700);")
                .unwrap_or_default()
        );
    }
    card?;
    ctx.wait_until(
        "the run to finish",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(90),
    )?;

    // The record, not the DOM: a card drawn from live state and a card drawn
    // from the record look identical, and only one of them survives a reload.
    let events = activity_events(ctx);
    ensure!(
        events.len() > before.len(),
        "the tool call was never recorded ({} events before, {} after)",
        before.len(),
        events.len()
    );
    let fresh = &events[before.len()..];
    for phase in ["requested", "running"] {
        ensure!(
            fresh
                .iter()
                .any(|e| e.contains(&format!("\"phase\":\"{phase}\""))),
            "no {phase} event was recorded"
        );
    }
    ensure!(
        fresh
            .iter()
            .any(|e| e.contains("\"phase\":\"succeeded\"") || e.contains("\"phase\":\"failed\"")),
        "the call never reached a terminal phase"
    );
    for secret in ["smoke-not-a-real-key", "Bearer ", "sk-"] {
        ensure!(
            !fresh.iter().any(|e| e.contains(secret)),
            "the record contains {secret:?}"
        );
    }

    // The count the provider reported is bound to the dispatch it counted, and
    // to that dispatch's snapshot. AH-073.
    let usage = std::env::var("JAN_DATA_FOLDER")
        .map(|d| Path::new(&d).join("audit/payload-usage.jsonl"))
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default();
    let counted: Vec<&str> = usage.lines().filter(|l| !l.trim().is_empty()).collect();
    // Collected rather than returned on the spot: accounting is its own
    // feature (AH-073), and failing here used to hide whether the timeline
    // survives a reload, whether hiding completed activity hides the right
    // things, and whether any record carries the key. The scenario still fails
    // if accounting does -- at the end, after those have been checked.
    let mut accounting_failure: Option<String> = None;
    if counted.is_empty() {
        accounting_failure = Some("the dispatched payload was never accounted for".to_string());
    }
    for record in &counted {
        if accounting_failure.is_some() {
            break;
        }
        if !record.contains("\"source\":\"provider\"") {
            accounting_failure =
                Some(format!("a count was recorded that the provider did not report: {record}"));
        } else if record.contains("\"invocation\":\"\"") {
            // An unbound count is the defect this record exists to prevent.
            accounting_failure = Some(format!("a count was recorded against no dispatch: {record}"));
        } else if record.contains("\"snapshot\":\"\"") {
            accounting_failure =
                Some(format!("a count was recorded against no payload snapshot: {record}"));
        }
    }

    // Reload. The conversation is rebuilt from what was stored, so a tool call
    // that only lived in the run's memory disappears here.
    ctx.goto("/")?;
    ctx.settle();
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the tool call to survive the reload",
        "return !!document.querySelector('[data-testid=\"tool-activity-item\"]');",
        Duration::from_secs(45),
    )?;

    // Both calls are on the record, one succeeded and one failed.
    let all = activity_events(ctx);
    let fresh_all = &all[before.len()..];
    ensure!(
        fresh_all.iter().any(|e| e.contains("\"tool\":\"ls\"") && e.contains("\"phase\":\"succeeded\"")),
        "the succeeding call was not recorded as succeeded"
    );
    ensure!(
        fresh_all.iter().any(|e| e.contains("\"tool\":\"read\"") && e.contains("\"phase\":\"failed\"")),
        "the failing call was not recorded as failed"
    );
    let shown_before = ctx.eval_string(
        "return String(document.querySelectorAll('[data-testid=\"tool-activity-item\"]').length);",
    )?;
    ensure!(
        shown_before.parse::<usize>().unwrap_or(0) >= 2,
        "both calls should be visible before hiding anything (saw {shown_before})"
    );

    // "Hide completed tool activity" hides only what finished cleanly.
    let toggle_hide = |ctx: &Ctx, on: bool| -> ScenarioResult {
        ctx.goto("/settings/agent-tools")?;
        ctx.wait_until(
            "the hide-completed switch",
            "return !!document.querySelector('[data-testid=\"hide-completed-tools\"]');",
            Duration::from_secs(30),
        )?;
        ctx.eval(&format!(
            "const sw = document.querySelector('[data-testid=\"hide-completed-tools\"]');
             const on = sw.getAttribute('aria-checked') === 'true';
             if (on !== {on}) sw.click();
             return true;"
        ))?;
        ctx.settle();
        ctx.goto("/")?;
        ctx.settle();
        ctx.goto("/cowork")
    };
    toggle_hide(ctx, true)?;
    ctx.wait_until(
        "the hidden-activity notice",
        "return !!document.querySelector('[data-testid=\"hidden-tools\"]');",
        Duration::from_secs(30),
    )?;
    let shown_hidden = ctx.eval_string(
        "return String(document.querySelectorAll('[data-testid=\"tool-activity-item\"]').length);",
    )?;
    let hidden_ok = shown_hidden.parse::<usize>().unwrap_or(0);
    // Put the preference back before asserting, so a failure here does not
    // leave every later scenario looking at hidden activity.
    toggle_hide(ctx, false)?;
    ensure!(
        hidden_ok >= 1,
        "the failed call must stay visible with completed activity hidden (saw {shown_hidden})"
    );
    ensure!(
        hidden_ok < shown_before.parse::<usize>().unwrap_or(0),
        "hiding completed activity hid nothing (saw {shown_hidden} of {shown_before})"
    );

    // No credential in any record a run writes.
    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    for file in [
        "audit/tool-activity.jsonl",
        "audit/prompts.jsonl",
        "audit/payload-usage.jsonl",
        "audit/permissions.jsonl",
    ] {
        let text = std::fs::read_to_string(Path::new(&data).join(file)).unwrap_or_default();
        ensure!(
            !text.contains("smoke-not-a-real-key"),
            "{file} contains the provider key"
        );
    }
    if let Some(failure) = accounting_failure {
        bail!("{failure}");
    }
    Ok(())
}

/// The lifecycle events on disk, one JSON line each.
fn activity_events(_ctx: &Ctx) -> Vec<String> {
    std::env::var("JAN_DATA_FOLDER")
        .map(|d| Path::new(&d).join("audit/tool-activity.jsonl"))
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(str::to_string)
        .collect()
}

/// A snapshot belonging to another session must not be retrievable.
fn scenario_prompt_snapshot_isolation(ctx: &Ctx) -> ScenarioResult {
    // Straight at the command, because this is a boundary the UI must not be
    // able to talk its way around either.
    let refused = ctx.eval(
        "try {
           const r = await window.__TAURI_INTERNALS__.invoke('agent_prompt_snapshots', {
             snapshotId: 'snap-1', session: 'a-session-that-is-not-mine'
           });
           return { ok: r };
         } catch (e) {
           return { err: String(e) };
         }",
    )?;
    println!("      cross-session lookup: {refused}");
    // Either refused outright, or empty -- never another session's payload.
    let leaked = refused
        .get("ok")
        .and_then(Value::as_array)
        .is_some_and(|rows| !rows.is_empty());
    ensure!(!leaked, "a snapshot leaked across sessions: {refused}");

    // An unscoped list must be refused rather than returning everything.
    let unscoped = ctx.eval(
        "try {
           const r = await window.__TAURI_INTERNALS__.invoke('agent_prompt_snapshots', {});
           return { ok: r };
         } catch (e) {
           return { err: String(e) };
         }",
    )?;
    ensure!(
        unscoped.get("err").is_some(),
        "an unscoped snapshot list must be refused: {unscoped}"
    );
    Ok(())
}

/// A failing provider says which endpoint failed, with what status, and who
/// answered -- not a bare status word.
fn scenario_provider_error(ctx: &Ctx) -> ScenarioResult {
    // Reproduces the reported failure: a local-looking endpoint answered 403 by
    // something on the internet.
    ctx.script_model("proxy-403", &[])?;
    // Confirm the fixture really is refusing before driving the UI: scripting
    // it and clicking in the same breath raced the switch.
    ctx.wait_until(
        "the fixture to start refusing",
        &format!(
            "const r = await fetch('http://127.0.0.1:{}/v1/models');
             return r.status === 403;",
            ctx.mock_port
        ),
        Duration::from_secs(20),
    )?;
    let restore = |ctx: &Ctx| {
        let _ = ctx.script_model("plain", &[]);
    };

    let outcome = (|| -> ScenarioResult {
        ctx.goto(&format!("/settings/providers/{SMOKE_PROVIDER}"))?;
        ctx.wait_until(
            "the provider page",
            "return document.body.textContent.length > 40;",
            Duration::from_secs(30),
        )?;

        // Refresh the model list, which is the request that fails. The button
        // is disabled while a refresh is in flight and the page mounts its
        // model section asynchronously, so one click is not reliably one
        // request -- press until the toast actually arrives.
        // Record every toast as it is inserted. Sampling the DOM races the
        // toast's own lifetime: sonner dismisses it after a few seconds, so a
        // poll that lands either side of that window sees nothing and reports
        // "no toast" for a toast that was shown.
        ctx.eval(
            "if (!globalThis.__toastLog) {
               globalThis.__toastLog = [];
               const seen = new WeakSet();
               const record = (n) => {
                 if (!(n instanceof HTMLElement)) return;
                 for (const t of n.matches?.('[data-sonner-toast]')
                        ? [n]
                        : [...n.querySelectorAll?.('[data-sonner-toast]') || []]) {
                   if (seen.has(t)) continue;
                   seen.add(t);
                   globalThis.__toastLog.push((t.textContent || '').trim());
                 }
               };
               new MutationObserver((records) => {
                 for (const r of records) r.addedNodes.forEach(record);
               }).observe(document.body, { childList: true, subtree: true });
             }
             globalThis.__toastLog.length = 0;
             return true;",
        )?;
        let toast_present = "return (globalThis.__toastLog || []).some(t => t.includes('403'));";
        let mut pressed = false;
        for _ in 0..4 {
            let clicked = ctx.eval_bool(
                "const b = [...document.querySelectorAll('button')].find(x =>
                   /^refresh/i.test(((x.getAttribute('aria-label') || '')
                     + ' ' + (x.getAttribute('title') || '')
                     + ' ' + (x.textContent || '')).trim()));
                 if (!b || b.disabled) return false; b.click(); return true;",
            )?;
            if clicked {
                pressed = true;
                if ctx
                    .wait_until("the failure toast", toast_present, Duration::from_secs(20))
                    .is_ok()
                {
                    break;
                }
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        if !pressed {
            ctx.describe("provider-page")?;
            bail!("the provider page offered no way to refresh its models");
        }

        // Observe the toast itself. Searching all of document.body raced the
        // toast's own lifetime and matched text from anywhere on the page.
        if ctx
            .wait_until("the failure toast", toast_present, Duration::from_secs(30))
            .is_err()
        {
            // Say what did appear. "No toast mentioning 403" and "a toast
            // saying the refresh succeeded" are different defects.
            let seen = ctx.eval_string("return JSON.stringify(globalThis.__toastLog || []);")?;
            bail!("no toast mentioned 403; toasts seen: {seen}");
        }

        let toast = ctx.eval_string(
            "const all = globalThis.__toastLog || [];
             const hit = all.filter(t => t.includes('403'));
             return JSON.stringify({
               count: hit.length,
               total: all.length,
               text: hit.join(' | '),
             });",
        )?;
        let v: Value = serde_json::from_str(&toast).unwrap_or(Value::Null);
        let text = v
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        println!("      failure toast: {toast}");

        ensure!(
            v.get("count").and_then(Value::as_u64) == Some(1),
            "expected exactly one failure toast: {toast}"
        );
        for needle in [
            SMOKE_PROVIDER,
            "GET",
            "403",
            "cloudflare",
            // The endpoint as configured, not the address it resolved to:
            // the message has to name what the user typed.
            &format!("{SMOKE_ENDPOINT_HOST}:{}", smoke_port()),
        ] {
            ensure!(
                text.contains(needle),
                "the toast never mentioned {needle:?}: {text}"
            );
        }
        ensure!(
            text.to_lowercase()
                .contains("resolving to a public address"),
            "the toast offered no remediation: {text}"
        );
        ensure!(
            !text.contains("[object Object]"),
            "the toast rendered a raw object: {text}"
        );
        // The seeded key must never be echoed back to the screen.
        ensure!(
            !text.contains("smoke-not-a-real-key"),
            "the toast leaked the provider's API key: {text}"
        );

        // And it must be dismissible. An error toast is deliberately sticky --
        // a message this actionable should not vanish while it is being read --
        // so the check is that dismissing it works, not that it expires.
        ctx.eval(
            "for (const t of document.querySelectorAll('[data-sonner-toast]')) {
               const b = t.querySelector('[data-close-button], button');
               if (b) b.click();
             }
             return true;",
        )?;
        ctx.wait_until(
            "the toast to be dismissed",
            "return ![...document.querySelectorAll('[data-sonner-toast]')]
               .some(t => (t.textContent || '').includes('403'));",
            Duration::from_secs(20),
        )?;

        Ok(())
    })();

    restore(ctx);
    outcome
}

/// Nothing in the composer footer may sit on top of anything else.
///
/// The send button and the Code/Preview/Changes/Activity rail icons share one
/// row. When the row runs out of width the send control is drawn over the rail
/// icons instead of the row wrapping or reserving space, which makes those
/// icons unclickable where they overlap.
/// The reported defect, end to end: a provider configured at a single-label
/// hostname must reach the machine on the private address, never the public
/// answer a search-domain collision produced.
fn scenario_local_hostname(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/cowork")?;
    ctx.settle();

    // Model discovery over the production command, at the URL exactly as
    // configured. Nothing here rewrites it to an address.
    let listed = ctx.eval_string(&format!(
        r#"const r = await window.__TAURI_INTERNALS__.invoke('provider_http_request', {{
             request: {{
               url: 'http://{host}:{port}/v1/models',
               method: 'GET',
               headers: {{ 'Content-Type': 'application/json' }},
               body: null,
               timeoutSecs: 15,
             }},
           }});
           return JSON.stringify({{ status: r.status, peer: r.peer, body: r.body.slice(0, 300) }});"#,
        host = SMOKE_ENDPOINT_HOST,
        port = smoke_port(),
    ))?;
    println!("      discovery: {listed}");
    let v: Value = serde_json::from_str(&listed).unwrap_or(Value::Null);
    ensure!(
        v.get("status").and_then(Value::as_u64) == Some(200),
        "model discovery at the configured hostname did not answer 200: {listed}"
    );
    ensure!(
        v.get("body")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains(SMOKE_MODEL),
        "model discovery did not list {SMOKE_MODEL}: {listed}"
    );
    // The peer is the private address, not the public decoy.
    let peer = v.get("peer").and_then(Value::as_str).unwrap_or_default();
    ensure!(
        peer.starts_with("127.0.0.1:"),
        "the request reached {peer:?} instead of the private address"
    );

    let diag = ctx.eval_string(&format!(
        r#"const d = await window.__TAURI_INTERNALS__.invoke(
             'provider_endpoint_diagnostics', {{ host: {host:?}, port: {port} }});
           return JSON.stringify(d);"#,
        host = SMOKE_ENDPOINT_HOST,
        port = smoke_port(),
    ))?;
    println!("      diagnostics: {diag}");
    let d: Value = serde_json::from_str(&diag).unwrap_or(Value::Null);
    ensure!(
        d.get("selected").and_then(Value::as_str) == Some("127.0.0.1"),
        "the selected address was not the private one: {diag}"
    );
    ensure!(
        d.get("suppressedPublic").and_then(Value::as_bool) == Some(true),
        "the public candidate was not suppressed: {diag}"
    );
    ensure!(
        d.get("localName").and_then(Value::as_bool) == Some(true),
        "{SMOKE_ENDPOINT_HOST} was not treated as a local name: {diag}"
    );
    let decoy = d
        .get("candidates")
        .and_then(Value::as_array)
        .map(|c| {
            c.iter().any(|one| {
                one.get("address").and_then(Value::as_str) == Some(SMOKE_PUBLIC_DECOY)
                    && one.get("eligible").and_then(Value::as_bool) == Some(false)
            })
        })
        .unwrap_or(false);
    ensure!(
        decoy,
        "the public candidate is not reported as an ineligible candidate: {diag}"
    );
    ensure!(
        d.get("responded")
            .and_then(Value::as_str)
            .unwrap_or_default()
            == "127.0.0.1",
        "diagnostics did not record the responding peer: {diag}"
    );
    // Diagnostics never carry the credential the provider is configured with.
    ensure!(
        !diag.contains("smoke-not-a-real-key") && !diag.to_lowercase().contains("bearer"),
        "the diagnostics leaked a credential"
    );
    Ok(())
}

/// A chat streams through the same resolved endpoint as discovery.
fn scenario_stream_over_local_hostname(ctx: &Ctx) -> ScenarioResult {
    ctx.script_model("plain", &[])?;
    // Forget what was resolved so this scenario proves the whole path, not a
    // decision another scenario already made.
    ctx.eval(&format!(
        "await window.__TAURI_INTERNALS__.invoke('provider_endpoint_refresh',
           {{ host: {host:?}, port: {port} }});
         return true;",
        host = SMOKE_ENDPOINT_HOST,
        port = smoke_port(),
    ))?;

    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the cowork composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    // While a run streams the send control is replaced by a stop control, so
    // this selector finds nothing until the previous scenario's run is over.
    ctx.wait_until(
        "the previous run to finish",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(90),
    )?;
    ctx.ensure_model_selected()?;
    ctx.type_into("[data-testid=\"chat-input\"]", "stream over the short name")?;
    // Sixty seconds, not fifteen: the previous scenario's run may still be
    // streaming when this one starts, and while it is the control is a stop
    // button rather than a send one.
    ctx.wait_until(
        "the send control to arm",
        "const b = document.querySelector('[data-test-id=\"send-message-button\"]');
         return !!b && b.disabled !== true;",
        Duration::from_secs(60),
    )?;
    ctx.eval(
        "document.querySelector('[data-test-id=\"send-message-button\"]').click();
         return true;",
    )?;
    ctx.wait_until(
        "the model's reply",
        "return document.body.innerText.includes('Hello from the smoke model');",
        Duration::from_secs(90),
    )?;

    let diag = ctx.eval_string(&format!(
        r#"const d = await window.__TAURI_INTERNALS__.invoke(
             'provider_endpoint_diagnostics', {{ host: {host:?}, port: {port} }});
           return JSON.stringify(d);"#,
        host = SMOKE_ENDPOINT_HOST,
        port = smoke_port(),
    ))?;
    println!("      streaming diagnostics: {diag}");
    let d: Value = serde_json::from_str(&diag).unwrap_or(Value::Null);
    ensure!(
        d.get("responded").and_then(Value::as_str) == Some("127.0.0.1"),
        "the streamed completion did not go to the private address: {diag}"
    );
    ensure!(
        d.get("suppressedPublic").and_then(Value::as_bool) == Some(true),
        "the public candidate was not suppressed for the streaming request: {diag}"
    );
    Ok(())
}

/// Nothing between the last thing said and the composer but the composer.
fn scenario_no_setup_wall(ctx: &Ctx) -> ScenarioResult {
    ctx.script_model("plain", &[])?;
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the cowork composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    // While a run streams the send control is replaced by a stop control, so
    // this selector finds nothing until the previous scenario's run is over.
    ctx.wait_until(
        "the previous run to finish",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(90),
    )?;
    ctx.ensure_model_selected()?;
    ctx.type_into("[data-testid=\"chat-input\"]", "clear the wall")?;
    // Sixty seconds, not fifteen: the previous scenario's run may still be
    // streaming when this one starts, and while it is the control is a stop
    // button rather than a send one.
    ctx.wait_until(
        "the send control to arm",
        "const b = document.querySelector('[data-test-id=\"send-message-button\"]');
         return !!b && b.disabled !== true;",
        Duration::from_secs(60),
    )?;
    ctx.eval(
        "document.querySelector('[data-test-id=\"send-message-button\"]').click();
         return true;",
    )?;
    ctx.wait_until(
        "the model's reply",
        "return document.body.innerText.includes('Hello from the smoke model');",
        Duration::from_secs(90),
    )?;
    ctx.settle();

    let report = ctx.eval_string(
        r#"const gone = (sel) => document.querySelectorAll(sel).length;
           const composer = document.querySelector('[data-testid="chat-input"]');
           const c = composer.getBoundingClientRect();
           // Anything diagnostic still rendered in the conversation would sit
           // above the composer and below the transcript.
           const snapshots = [...document.querySelectorAll('[data-testid="prompt-snapshot"]')];
           const orphan = snapshots.filter((s) => {
             const r = s.getBoundingClientRect();
             // A snapshot bar whose own row has no message text above it in the
             // same column is the empty bar that used to sit over the composer.
             return r.bottom <= c.top && r.bottom > c.top - 80;
           }).length;
           return JSON.stringify({
             compat: gone('[data-testid="cowork-compat"]'),
             readiness: gone('[aria-label="common:readiness.title"], section[aria-label*="readiness"]'),
             detailsBody: gone('[data-testid="session-details-body"]'),
             trigger: gone('[data-testid="session-details-trigger"]'),
             orphanSnapshotBars: orphan,
           });"#,
    )?;
    println!("      wall: {report}");
    let v: Value = serde_json::from_str(&report).unwrap_or(Value::Null);
    let count = |k: &str| v.get(k).and_then(Value::as_u64).unwrap_or(u64::MAX);
    ensure!(
        count("compat") == 0,
        "the compatibility section is still in the conversation: {report}"
    );
    ensure!(
        count("readiness") == 0,
        "the readiness card is still in the conversation: {report}"
    );
    ensure!(
        count("detailsBody") == 0,
        "session details are expanded rather than closed: {report}"
    );
    ensure!(
        count("trigger") == 1,
        "there is no compact session-details control: {report}"
    );
    ensure!(
        count("orphanSnapshotBars") == 0,
        "an empty snapshot bar is sitting above the composer: {report}"
    );

    // The details are still reachable, and they carry the information that was
    // taken out of the conversation.
    ctx.eval(
        "document.querySelector('[data-testid=\"session-details-trigger\"]').click(); return true;",
    )?;
    ctx.wait_until(
        "the session details",
        "return !!document.querySelector('[data-testid=\"session-details-body\"]');",
        Duration::from_secs(10),
    )?;
    let has = ctx.eval_bool(
        "const b = document.querySelector('[data-testid=\"session-details-body\"]');
         return !!b && b.textContent.trim().length > 0;",
    )?;
    ensure!(has, "the session details opened empty");
    // Closed through its own control rather than a synthetic Escape, and the
    // overlay must actually leave the DOM -- a closed one still covering the
    // window is how a dialog silently blocks every later click.
    ctx.eval(
        "const c = [...document.querySelectorAll('[data-slot=\"dialog-content\"] button')]
           .find(b => (b.textContent || '').trim() === 'Close');
         if (c) { c.click(); return true; }
         document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
         return true;",
    )?;
    ctx.wait_until(
        "the dialog overlay to leave the DOM",
        "return !document.querySelector('[data-slot=\"dialog-overlay\"]');",
        Duration::from_secs(10),
    )?;
    Ok(())
}

/// Search and Settings are reachable from Cowork, and coming back returns to
/// the session as it was.
fn scenario_cowork_search_and_settings(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the cowork composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;

    // A draft and an open rail: the state a trip to Settings must not lose.
    ctx.type_into("[data-testid=\"chat-input\"]", "draft that must survive")?;
    ctx.click_matching("button", "Changes")?;
    ctx.settle();
    let rail_open = ctx.eval_bool(
        "return [...document.querySelectorAll('button')].some(b =>
           (b.getAttribute('aria-label') || b.textContent || '').trim() === 'Changes'
           && b.getAttribute('aria-pressed') === 'true')
         || !!document.querySelector('[data-testid=\"cowork-diff-panel\"]');",
    )?;

    // They live in the left nav now, so it has to be open.
    ctx.eval(
        "const t = document.querySelector('[data-sidebar=\"trigger\"]');
         if (t && !document.querySelector('[data-testid=\"cowork-search\"]')) t.click();
         return true;",
    )?;
    ctx.wait_until(
        "the cowork nav",
        "return !!document.querySelector('[data-testid=\"cowork-search\"]');",
        Duration::from_secs(15),
    )?;

    // Neither control may be covered by anything.
    let reach = ctx.eval_string(
        r#"const report = [];
           for (const id of ['cowork-search', 'cowork-settings']) {
             const el = document.querySelector(`[data-testid="${id}"]`);
             if (!el) { report.push({ id, missing: true }); continue; }
             const r = el.getBoundingClientRect();
             const cx = Math.round(r.left + r.width / 2);
             const cy = Math.round(r.top + r.height / 2);
             const hit = document.elementFromPoint(cx, cy);
             if (hit && (el.contains(hit) || hit === el)) continue;
             report.push({
               id,
               rect: { x: Math.round(r.left), y: Math.round(r.top),
                       w: Math.round(r.width), h: Math.round(r.height) },
               point: { cx, cy },
               hit: hit ? (() => {
                 const hr = hit.getBoundingClientRect();
                 return {
                   tag: hit.tagName,
                   testid: hit.getAttribute('data-testid'),
                   cls: (hit.className || '').toString().slice(0, 160),
                   z: getComputedStyle(hit).zIndex,
                   pos: getComputedStyle(hit).position,
                   pe: getComputedStyle(hit).pointerEvents,
                   rect: { x: Math.round(hr.left), y: Math.round(hr.top),
                           w: Math.round(hr.width), h: Math.round(hr.height) },
                   attrs: [...hit.attributes].map(a => a.name + '=' + a.value).join(' ').slice(0, 200),
                   parent: hit.parentElement ? {
                     tag: hit.parentElement.tagName,
                     cls: (hit.parentElement.className || '').toString().slice(0, 120),
                     attrs: [...hit.parentElement.attributes].map(a => a.name).join(',').slice(0, 120),
                   } : null,
                   kids: hit.children.length,
                 };
               })() : null,
             });
           }
           return JSON.stringify(report);"#,
    )?;
    ensure!(
        reach == "[]",
        "a quick action is covered by something else: {reach}"
    );

    // Search opens the shared dialog rather than a second implementation.
    ctx.eval("document.querySelector('[data-testid=\"cowork-search\"]').click(); return true;")?;
    ctx.wait_until(
        "the shared search dialog",
        "return !!document.querySelector('[role=\"dialog\"]');",
        Duration::from_secs(15),
    )?;
    // Closed through its own control. A synthetic Escape does not reach the
    // dismissable layer here, and a dialog that never closes leaves its
    // `fixed inset-0` overlay over everything after it.
    ctx.eval(
        "const c = [...document.querySelectorAll('[data-slot=\"dialog-content\"] button')]
           .find(b => (b.textContent || '').trim() === 'Close');
         if (c) { c.click(); return true; }
         document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
         return true;",
    )?;
    // The overlay is `fixed inset-0`, so anything hit-tested while it is still
    // leaving would report as covered by it.
    ctx.wait_until(
        "the dialog overlay to leave the DOM",
        "return !document.querySelector('[data-slot=\"dialog-overlay\"]');",
        Duration::from_secs(10),
    )?;
    ctx.settle();

    ctx.eval("document.querySelector('[data-testid=\"cowork-settings\"]').click(); return true;")?;
    ctx.wait_until(
        "the settings route",
        "return location.hash.includes('/settings') || location.pathname.includes('/settings');",
        Duration::from_secs(20),
    )?;

    // Back to Cowork: same session, same draft, same rail.
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the cowork composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    ctx.settle();

    let draft = ctx.eval_string(
        "const el = document.querySelector('[data-testid=\"chat-input\"]');
         return el ? (el.value || el.textContent || '') : '';",
    )?;
    ensure!(
        draft.contains("draft that must survive"),
        "the composer draft did not survive the trip to Settings: {draft:?}"
    );

    if rail_open {
        let still = ctx.eval_bool(
            "return [...document.querySelectorAll('button')].some(b =>
               (b.getAttribute('aria-label') || b.textContent || '').trim() === 'Changes'
               && b.getAttribute('aria-pressed') === 'true')
             || !!document.querySelector('[data-testid=\"cowork-diff-panel\"]');",
        )?;
        ensure!(
            still,
            "the open rail was lost on the way back from Settings"
        );
    }
    Ok(())
}

fn scenario_composer_layout(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the composer",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(30),
    )?;
    std::thread::sleep(Duration::from_millis(600));

    let report = ctx.eval_string(
        r#"const send = document.querySelector('[data-test-id="send-message-button"]');
           if (!send) return JSON.stringify({ error: 'no send button' });
           const s = send.getBoundingClientRect();
           const names = ['Code', 'Preview', 'Changes', 'Activity'];
           const clashes = [];
           for (const n of names) {
             const b = [...document.querySelectorAll('button')].find(x =>
               (x.getAttribute('aria-label') || x.textContent || '').trim() === n);
             if (!b) continue;
             const r = b.getBoundingClientRect();
             const overlapX = Math.min(s.right, r.right) - Math.max(s.left, r.left);
             const overlapY = Math.min(s.bottom, r.bottom) - Math.max(s.top, r.top);
             if (overlapX > 1 && overlapY > 1) {
               clashes.push({ rail: n, overlapX: Math.round(overlapX), overlapY: Math.round(overlapY) });
             }
             // Whatever the geometry says, the rail's own centre must belong to
             // the rail: that is what decides whether a click reaches it.
             const cx = Math.round(r.left + r.width / 2);
             const cy = Math.round(r.top + r.height / 2);
             const hit = document.elementFromPoint(cx, cy);
             if (hit && !b.contains(hit) && hit !== b && !hit.contains(b)) {
               clashes.push({
                 rail: n,
                 covered_by: hit.tagName,
                 cls: (hit.className || '').toString().slice(0, 120),
                 z: getComputedStyle(hit).zIndex,
                 pos: getComputedStyle(hit).position,
               });
             }
           }
           return JSON.stringify({ send: { left: Math.round(s.left), right: Math.round(s.right) }, clashes });"#,
    )?;
    println!("      composer layout: {report}");
    let v: Value = serde_json::from_str(&report).unwrap_or(Value::Null);
    let clashes = v
        .get("clashes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    ensure!(
        clashes.is_empty(),
        "composer controls overlap the rail icons: {report}"
    );
    Ok(())
}
// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

fn fixtures_dir(args: &[String]) -> PathBuf {
    let explicit = args
        .windows(2)
        .find(|w| w[0] == "--fixtures")
        .map(|w| PathBuf::from(&w[1]));
    explicit.unwrap_or_else(|| Path::new(MANIFEST_DIR).join("tests/fixtures/cowork-smoke"))
}

fn main() {
    // The agent-tools plugin re-executes the current binary as its Windows
    // sandbox helper for every confined shell. Without this hand-off, as in
    // the app's own `main`, each helper launch of this binary started a whole
    // second harness -- WebView, fixture server and a full scenario run --
    // which loaded the machine, fought over the fixture port and wedged the
    // WebView under test.
    tauri_plugin_agent_tools::run_sandbox_helper_if_requested();

    let args: Vec<String> = std::env::args().collect();
    let fixtures = fixtures_dir(&args);

    // Per-run scratch tree. `CI=e2e` makes the app resolve its data folder
    // relative to the CWD, so chdir'ing here keeps the run out of the real
    // Jan data folder.
    // `COWORK_SMOKE_KEEP=<dir>` keeps the profile for a second run, which is
    // how a real restart is exercised: the second process inherits the data
    // folder and the WebView profile exactly as an installed app would.
    let keep = std::env::var_os("COWORK_SMOKE_KEEP").map(PathBuf::from);
    let workspace = keep
        .clone()
        .unwrap_or_else(|| std::env::temp_dir().join(format!("cowork-smoke-{}", std::process::id())));
    let resumed = keep.is_some() && workspace.join("data").join("settings.json").is_file();
    RESUMED.store(resumed, Ordering::SeqCst);
    if !resumed {
        let _ = std::fs::remove_dir_all(&workspace);
    }
    std::fs::create_dir_all(&workspace).expect("failed to create smoke workspace");
    // `JAN_DATA_FOLDER` is the only override `resolve_jan_data_folder` honours,
    // and it is the one that matters: settings.json -- which is where the
    // Cowork session store actually persists, via `settings_set` -- is resolved
    // through that function and NOT through `CI=e2e`. Without this the harness
    // writes its sessions into the developer's real Jan data folder, and each
    // run inherits the previous run's attached folder from a temp directory
    // that has since been deleted.
    // The provider is reached at a single-label hostname on a fixed port, so
    // every scenario that talks to a model exercises the short-hostname path
    // that was resolving to the wrong machine.
    let lane_base = std::env::var("COWORK_SMOKE_REAL_BASE_URL").ok();
    if let Some(base) = &lane_base {
        let model = std::env::var("COWORK_SMOKE_REAL_MODEL").unwrap_or_else(|_| "pxa-27b".into());
        let _ = LANE.set((base.clone(), model));
        let bytes: [u8; 32] = rand::random();
        let _ = LANE_KEY.set(bytes.iter().map(|b| format!("{b:02x}")).collect());
        println!("real-provider lane: {base} (a fresh 32-byte key, never shown)");
    }
    let mock_port = if lane_base.is_some() {
        0
    } else {
        let (mock, mock_port) = match start_mock_provider(&fixtures, smoke_port()) {
            Ok(pair) => pair,
            Err(e) => {
                eprintln!("FATAL: {e}");
                std::process::exit(2);
            }
        };
        *MOCK.lock().unwrap_or_else(|e| e.into_inner()) = Some(mock);
        println!("mock provider on port {mock_port}");
        mock_port
    };

    // Deterministic resolution for the harness only: `v100` answers with a
    // public address and a loopback one, exactly the shape that sent requests
    // out of the network. Nothing else about the request path changes -- the
    // app still builds and sends through `core::net::transport`.
    struct SmokeDns;
    impl app_lib::core::net::resolver::DnsProbe for SmokeDns {
        fn lookup(&self, host: &str, port: u16) -> Result<Vec<std::net::SocketAddr>, String> {
            if host.eq_ignore_ascii_case(SMOKE_ENDPOINT_HOST) {
                return Ok(vec![
                    std::net::SocketAddr::new(SMOKE_PUBLIC_DECOY.parse().unwrap(), port),
                    std::net::SocketAddr::new("127.0.0.1".parse().unwrap(), port),
                ]);
            }
            app_lib::core::net::resolver::SystemDns.lookup(host, port)
        }
    }
    /// The lane resolves for real, and remembers every name it was asked for.
    struct RecordingDns;
    impl app_lib::core::net::resolver::DnsProbe for RecordingDns {
        fn lookup(&self, host: &str, port: u16) -> Result<Vec<std::net::SocketAddr>, String> {
            if let Ok(mut seen) = LOOKED_UP.lock() {
                seen.push(format!("{host}:{port}"));
            }
            app_lib::core::net::resolver::SystemDns.lookup(host, port)
        }
    }
    if lane_base.is_some() {
        app_lib::core::net::transport::set_probe(std::sync::Arc::new(RecordingDns));
    } else {
        app_lib::core::net::transport::set_probe(std::sync::Arc::new(SmokeDns));
    }

    let data_folder = workspace.join("data");
    let seeded = if resumed {
        println!("resuming the profile at {}", workspace.display());
        Ok(())
    } else if let (Some((base, _)), Some(key)) = (LANE.get(), LANE_KEY.get()) {
        seed_lane_settings(&data_folder, base, key)
    } else {
        seed_settings(
            &data_folder,
            &format!("http://{SMOKE_ENDPOINT_HOST}:{}/v1", smoke_port()),
        )
        .and_then(|()| seed_mcp_config(&data_folder))
    };
    if let Err(e) = seeded {
        eprintln!("FATAL: could not seed the smoke data folder: {e}");
        kill_mock();
        std::process::exit(2);
    }
    std::env::set_var("JAN_DATA_FOLDER", &data_folder);
    std::env::set_var("CI", "e2e");
    // A WebView profile of this run's own.
    //
    // `JAN_DATA_FOLDER` moves what the *app* writes; it does nothing about what
    // the *WebView* keeps. localStorage, sessionStorage, IndexedDB, the service
    // worker registration and the HTTP cache all live in the WebView2 user-data
    // folder, which is keyed by the bundle identifier and shared with the user's
    // own Jan. So a run inherited the previous run's Cowork session -- an
    // attached folder in a temp directory long since deleted -- and the harness
    // tried to paper over it by clearing storage and reloading, which is where
    // it hung waiting ninety seconds for a React root that never came back.
    //
    // Pointing WebView2 at a fresh directory makes that whole problem not exist:
    // storage starts empty because it is a new profile, no reload is needed, and
    // two runs cannot see each other's state even if one crashes half way.
    let webview_profile = workspace.join("webview");
    std::fs::create_dir_all(&webview_profile).expect("failed to create webview profile");
    std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &webview_profile);
    // The harness window is often behind other windows on a desktop someone is
    // using. Chromium treats an occluded WebView as hidden: it throttles its
    // timers and backgrounds its renderer, and a page that waits on a timer
    // then stops answering the harness's scripts for minutes with the CPU
    // idle -- exactly the stall these runs kept hitting. A real user looks at
    // the window they are waiting on; the harness cannot, so it opts out.
    // `COWORK_SMOKE_THROTTLE=1` keeps the default, to reproduce the stall.
    if std::env::var_os("COWORK_SMOKE_THROTTLE").is_none() {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion \
             --disable-background-timer-throttling --disable-renderer-backgrounding \
             --disable-backgrounding-occluded-windows",
        );
    }
    std::env::set_current_dir(&workspace).expect("failed to enter smoke workspace");
    // Provider keys go to the isolated data folder's encrypted file, not the
    // system credential store, which is shared with the developer's own Jan.
    app_lib::core::server::provider_secrets::use_file_secrets_only();

    let app = app_lib::build_app();
    let handle: AppHandle = app.handle().clone();

    let driver_workspace = workspace.clone();
    std::thread::spawn(move || {
        let code = drive(&handle, fixtures, driver_workspace.clone(), mock_port);
        if std::env::var_os("COWORK_SMOKE_KEEP").is_none() {
            let _ = std::fs::remove_dir_all(&driver_workspace);
        }
        // Never leave the fixture server behind.
        kill_mock();
        VERDICT.store(code, Ordering::SeqCst);
        // On macOS the platform event loop terminates the process itself with
        // status 0, so `handle.exit(code)` would discard the verdict. Run
        // Tauri's resource cleanup and then own the exit status here. Scenarios
        // that start background work are responsible for stopping it.
        handle.cleanup_before_exit();
        std::process::exit(code);
    });

    app_lib::run_app(app);
    std::process::exit(VERDICT.load(Ordering::SeqCst));
}

/// Always fails. Enabled by `--self-test-fail` so the harness can prove its own
/// non-zero exit path instead of assuming it.
fn scenario_self_test_fail(_ctx: &Ctx) -> ScenarioResult {
    bail!("deliberate failure injected by --self-test-fail")
}

const SELF_TEST_FAIL: Scenario = Scenario {
    name: "self-test-fail",
    run: scenario_self_test_fail,
};

fn drive(handle: &AppHandle, fixtures: PathBuf, workspace: PathBuf, mock_port: u16) -> i32 {
    let window = match wait_for_window(handle, Duration::from_secs(60)) {
        Some(w) => w,
        None => {
            eprintln!("FATAL: main window never appeared");
            return 2;
        }
    };
    // Layout assertions compare real geometry, so the window must be the same
    // size on every run rather than whatever the platform last remembered.
    if let Err(e) = window.set_size(LogicalSize::new(1440.0, 900.0)) {
        eprintln!("WARN: could not fix the window size: {e}");
    }
    std::thread::sleep(Duration::from_millis(800));

    let template = fixtures.is_dir().then(|| fixtures.clone());
    let existing = workspace.join("cowork-smoke-fixture");
    let materialized = if RESUMED.load(Ordering::SeqCst) && existing.is_dir() {
        Ok(existing)
    } else {
        materialize_project(&workspace, template.as_deref())
    };
    let project = match materialized {
        Ok(p) => p,
        Err(e) => {
            eprintln!("FATAL: could not materialise the fixture project: {e}");
            return 2;
        }
    };
    println!("fixture project: {}", project.display());

    let ctx = Ctx {
        window,
        fixtures,
        workspace,
        project,
        mock_port,
    };

    let resumed = RESUMED.load(Ordering::SeqCst);
    let started = if resumed {
        // Inherited state is the point of a restart run; only wait for mount.
        ctx.wait_until(
            "React root to mount",
            "return !!document.querySelector('#root') && document.querySelector('#root').children.length > 0;",
            Duration::from_secs(90),
        )
    } else {
        ctx.reset_persisted_state()
    };
    if let Err(Failure(e)) = started {
        eprintln!("FATAL: could not reset persisted WebView state: {e}");
        return 2;
    }

    let self_test = std::env::args().any(|a| a == "--self-test-fail");
    // `--only a,b` runs just those scenarios. A scenario that wedges the
    // WebView fails every scenario after it, so the only honest way to judge
    // one is to run it by itself.
    let only: Option<Vec<String>> = std::env::args()
        .collect::<Vec<_>>()
        .windows(2)
        .find(|w| w[0] == "--only")
        .map(|w| w[1].split(',').map(|s| s.trim().to_string()).collect());
    let set = if LANE.get().is_some() {
        LANE_SCENARIOS
    } else if resumed {
        RESTART_SCENARIOS
    } else {
        SCENARIOS
    };
    let scenarios: Vec<&Scenario> = set
        .iter()
        .chain(if self_test {
            std::slice::from_ref(&SELF_TEST_FAIL)
        } else {
            &[]
        })
        .filter(|s| match &only {
            Some(names) => names.iter().any(|n| n == s.name),
            None => true,
        })
        .collect();
    if let Some(names) = &only {
        for name in names {
            if !scenarios.iter().any(|s| &s.name == name) && !(self_test && name == SELF_TEST_FAIL.name) {
                eprintln!("FATAL: no scenario named {name:?}");
                return 2;
            }
        }
    }

    let mut failed = 0usize;
    let mut wedged: Vec<&str> = Vec::new();
    for scenario in &scenarios {
        ctx.settle();
        if ctx.recover() {
            // Whatever ran before left the page unresponsive. Say so against
            // the scenario that inherits it, so a cascade is never read as a
            // string of unrelated defects.
            println!(
                "      (recovered a wedged WebView before {})",
                scenario.name
            );
            wedged.push(scenario.name);
        }
        // Up to three attempts. The WebView stalls for tens of seconds while
        // it highlights a large file or rescans the tree, and one stall
        // cascades into every scenario that follows until it recovers. A stall
        // is not a defect, but a pass that needed a retry is reported as such
        // so it never reads as a clean one.
        // A bound on one scenario, retries included. Each wait already has a
        // timeout, but a page that stops answering turns every eval into a
        // full-length one; past this the run says where it was and stops,
        // instead of looking hung.
        let limit = std::env::var("COWORK_SMOKE_SCENARIO_LIMIT_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(1200);
        let done = std::sync::Arc::new(AtomicBool::new(false));
        {
            let done = done.clone();
            let name = scenario.name;
            std::thread::spawn(move || {
                let started = Instant::now();
                while !done.load(Ordering::SeqCst) {
                    if started.elapsed() > Duration::from_secs(limit) {
                        let step = LAST_STEP.lock().map(|s| s.clone()).unwrap_or_default();
                        println!("FAIL {name}\n      no verdict after {limit}s; last step: {step}");
                        kill_mock();
                        std::process::exit(3);
                    }
                    std::thread::sleep(Duration::from_secs(2));
                }
            });
        }
        let mut attempt = 0;
        let mut first_err: Option<String> = None;
        let outcome = loop {
            attempt += 1;
            match (scenario.run)(&ctx) {
                Ok(()) => break Ok(attempt > 1),
                Err(Failure(e)) => {
                    if first_err.is_none() {
                        first_err = Some(e.clone());
                    }
                    // One attempt unless asked for more. A pass on a retry is
                    // evidence of a flake, not of a pass, and the stall that
                    // retries were added for is gone: it was the WebView being
                    // backgrounded behind other windows (see the browser
                    // arguments set in `main`). `COWORK_SMOKE_RETRIES=<n>`
                    // allows up to n more, reported as such.
                    let allowed = std::env::var("COWORK_SMOKE_RETRIES")
                        .ok()
                        .and_then(|v| v.parse::<u32>().ok())
                        .unwrap_or(0)
                        .min(2);
                    let last = attempt > allowed || scenario.name == SELF_TEST_FAIL.name;
                    if last {
                        break Err(Failure(match first_err {
                            Some(ref f) if f != &e => {
                                format!("{e}\n(first attempt failed with: {f})")
                            }
                            _ => e,
                        }));
                    }
                    // Let the WebView finish whatever wedged it. A page that
                    // stopped answering a script entirely does not recover by
                    // waiting: the retry would only time out the same way, so
                    // reload it first.
                    if e.contains("eval timed out") {
                        println!("      (reloading an unresponsive WebView before retrying)");
                        ctx.eval_detached("window.location.replace('/')").ok();
                    }
                    ctx.settle();
                }
            }
        };
        done.store(true, Ordering::SeqCst);
        match outcome {
            Ok(false) => println!("PASS {}", scenario.name),
            Ok(true) => {
                println!("PASS {} (on retry)", scenario.name);
                // What the first attempt hit, so a retry never hides a defect.
                if let Some(first) = &first_err {
                    println!("      first attempt failed with: {first}");
                }
            }
            Err(Failure(msg)) => {
                failed += 1;
                println!(
                    "FAIL {}\n      {}",
                    scenario.name,
                    msg.replace('\n', "\n      ")
                );
            }
        }
    }

    println!(
        "\n{} scenario(s) executed, {} passed, {} failed",
        scenarios.len(),
        scenarios.len() - failed,
        failed
    );
    if !wedged.is_empty() {
        // Named, so a failure inherited from a wedged page is never read as a
        // defect in the scenario that inherited it.
        println!(
            "{} scenario(s) started after a wedged WebView had to be reloaded: {}",
            wedged.len(),
            wedged.join(", ")
        );
    }
    i32::from(failed > 0)
}

fn wait_for_window(handle: &AppHandle, timeout: Duration) -> Option<WebviewWindow> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(w) = handle.get_webview_window("main") {
            return Some(w);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Where a scope's memories live on disk, for the assertions that have to look
/// past the DOM.
fn memory_records_path(scope_file: &str) -> Option<PathBuf> {
    std::env::var("JAN_DATA_FOLDER").ok().map(|d| {
        Path::new(&d)
            .join("agent-workspace")
            .join("memory")
            .join("records")
            .join(scope_file)
    })
}

/// A proposed memory is asked about, answered, and the answer sticks.
///
/// This asserts on the DOM *and* on the file. A card that renders from renderer
/// state while nothing is written, and a record that is written while no card
/// renders, are both failures that a DOM-only or a file-only check reports as a
/// pass.
///
/// No message is sent: a turn would put a provider round trip between this
/// scenario and the thing it tests, and a proposal is keyed to the chat rather
/// than to anything in the transcript. The route, the components and the
/// commands are the production ones.
fn scenario_memory_proposal(ctx: &Ctx) -> ScenarioResult {
    let records = match memory_records_path("session.jsonl") {
        Some(p) => p,
        None => bail!("JAN_DATA_FOLDER is not set, so the store cannot be inspected"),
    };
    // Start from a store with no proposals in it, so "the card is gone" below
    // means this scenario's proposal was answered rather than that an earlier
    // scenario's never appeared.
    let _ = std::fs::remove_file(&records);

    let thread_id = "smoke-memory-proposal";
    let open_chat = |ctx: &Ctx| -> ScenarioResult {
        // Leaving the route and coming back is what remounts the surface, and
        // remounting is what re-reads the store. `goto` on the route that is
        // already current does nothing at all, which is the trap here. A full
        // page reload is not an option: it tears down the channel this harness
        // evaluates over.
        ctx.goto("/")?;
        ctx.settle();
        ctx.goto(&format!("/threads/{thread_id}"))?;
        ctx.wait_until(
            "the conversation to render",
            "return !!document.querySelector('[data-testid=\"chat-input\"]');",
            Duration::from_secs(45),
        )
    };
    open_chat(ctx)?;

    // Propose over real IPC, the way the model-facing path does. Automatic
    // saving is off by default, so this has to come back as a question.
    let outcome = ctx.eval_string(&format!(
        r#"const c = await window.__TAURI_INTERNALS__.invoke('get_app_configurations');
           const out = await window.__TAURI_INTERNALS__.invoke(
             'plugin:agent-tools|memory_record_propose_inferred',
             {{
               location: {{ dataFolder: c.data_folder, sessionId: {thread_id:?} }},
               scope: 'chat',
               content: 'The user prefers tabs for indentation.',
               sourceSessionId: {thread_id:?},
               sourceMessageId: 'smoke-1',
             }},
           );
           return JSON.stringify(out);"#
    ))?;
    ensure!(
        outcome.contains("needsApproval"),
        "an inferred memory saved itself with automatic saving off: {outcome}"
    );
    ensure!(
        outcome.contains("automatic-saving-disabled"),
        "the reason was not the one the card explains: {outcome}"
    );

    // On disk before anything is clicked: the question survives the turn.
    let on_disk = std::fs::read_to_string(&records).unwrap_or_default();
    ensure!(
        on_disk.contains(r#""state":"proposed""#),
        "the proposal was not recorded, so it could not survive a restart"
    );
    ensure!(
        !on_disk.contains(r#""state":"active""#),
        "an unanswered proposal was stored as an active memory"
    );

    // Does the backend offer it? Asked separately so "the list is empty" and
    // "the list has it and nothing rendered" cannot be reported as one failure.
    let listed = ctx.eval_string(&format!(
        r#"const c = await window.__TAURI_INTERNALS__.invoke('get_app_configurations');
           const out = await window.__TAURI_INTERNALS__.invoke(
             'plugin:agent-tools|memory_proposals_list',
             {{ location: {{ dataFolder: c.data_folder, sessionId: {thread_id:?} }} }},
           );
           return JSON.stringify(out);"#
    ))?;
    ensure!(
        listed.contains("prefers tabs"),
        "the backend did not offer the proposal to the renderer: {listed}"
    );

    // And in the DOM, in the conversation it came from. A question the user has
    // not answered has to still be there when they come back to the chat.
    open_chat(ctx)?;
    ctx.wait_until(
        "the approval card",
        "return !!document.querySelector('[data-testid=\"memory-proposal-card\"]');",
        Duration::from_secs(30),
    )?;
    let shown = ctx.eval_string(
        r#"const card = document.querySelector('[data-testid="memory-proposal-card"]');
           const text = (sel) => {
             const el = card.querySelector(sel);
             return el ? el.textContent : '';
           };
           return JSON.stringify({
             reason: card.getAttribute('data-reason'),
             content: text('[data-testid="memory-proposal-content"]'),
             explanation: text('[data-testid="memory-proposal-explanation"]'),
             approvable: !!card.querySelector('[data-testid="memory-proposal-approve"]'),
           });"#,
    )?;
    ensure!(
        shown.contains("automatic-saving-disabled"),
        "the card did not carry the backend's reason: {shown}"
    );
    ensure!(
        shown.contains("waiting for you"),
        "the card explained nothing specific: {shown}"
    );
    ensure!(
        shown.contains("prefers tabs"),
        "the card did not show what would be remembered: {shown}"
    );
    ensure!(
        shown.contains("\"approvable\":true"),
        "an approvable proposal offered no way to approve it: {shown}"
    );

    // Approve it. The card is not the decision -- the click round-trips, and
    // the file is what says whether it took.
    ctx.eval(
        "document.querySelector('[data-testid=\"memory-proposal-approve\"]').click();
         return true;",
    )?;
    ctx.wait_until(
        "the card to clear",
        "return !document.querySelector('[data-testid=\"memory-proposal-card\"]');",
        Duration::from_secs(30),
    )?;
    let after = std::fs::read_to_string(&records).unwrap_or_default();
    ensure!(
        after.contains(r#""state":"active""#),
        "approving did not make the memory real: {after}"
    );
    ensure!(
        !after.contains(r#""state":"proposed""#),
        "the answered question was left in the store as a proposal"
    );

    // Come back again. The decision is a fact on disk, not renderer state, and
    // re-entering the conversation re-reads the store: the answered question is
    // not there to ask.
    open_chat(ctx)?;
    ctx.settle();
    let reappeared = ctx
        .eval_bool("return !!document.querySelector('[data-testid=\"memory-proposal-card\"]');")?;
    ensure!(
        !reappeared,
        "a question that was already answered was asked again on re-entry"
    );

    // A contradiction is a different question, and it must never render as
    // something to wave through.
    //
    // Each side names one option and not the other, on purpose: `detect_conflicts`
    // ignores a pair where both records mention both sides, so "prefers tabs over
    // spaces" and "prefers spaces over tabs" are *not* reported as a conflict. That
    // is deliberate conservatism -- an unresolved conflict withholds both records,
    // so a false one silently costs the user two good memories.
    let conflict = ctx.eval_string(&format!(
        r#"const c = await window.__TAURI_INTERNALS__.invoke('get_app_configurations');
           const out = await window.__TAURI_INTERNALS__.invoke(
             'plugin:agent-tools|memory_record_propose_inferred',
             {{
               location: {{ dataFolder: c.data_folder, sessionId: {thread_id:?} }},
               scope: 'chat',
               content: 'The user prefers spaces for indentation.',
               sourceSessionId: {thread_id:?},
               sourceMessageId: 'smoke-2',
             }},
           );
           return JSON.stringify(out);"#
    ))?;
    ensure!(
        conflict.contains("conflicts-with-existing"),
        "a contradiction was not detected: {conflict}"
    );
    open_chat(ctx)?;
    ctx.wait_until(
        "the conflict card",
        "return !!document.querySelector('[data-testid=\"memory-proposal-card\"]');",
        Duration::from_secs(30),
    )?;
    let conflict_card = ctx.eval_string(
        r#"const card = document.querySelector('[data-testid="memory-proposal-card"]');
           return JSON.stringify({
             reason: card.getAttribute('data-reason'),
             approve: !!card.querySelector('[data-testid="memory-proposal-approve"]'),
             review: !!card.querySelector('[data-testid="memory-proposal-resolve-conflict"]'),
           });"#,
    )?;
    ensure!(
        conflict_card.contains("\"approve\":false"),
        "a conflicted proposal offered an Approve button: {conflict_card}"
    );
    ensure!(
        conflict_card.contains("\"review\":true"),
        "a conflicted proposal offered no way to settle it: {conflict_card}"
    );

    // Leave the store as this scenario found it.
    let _ = std::fs::remove_file(&records);
    Ok(())
}

// ---------------------------------------------------------------------------
// Durability and integration regressions (the batch-1 fixes, end to end)
// ---------------------------------------------------------------------------

fn data_folder() -> Result<PathBuf, Failure> {
    std::env::var("JAN_DATA_FOLDER")
        .map(PathBuf::from)
        .map_err(|_| Failure("JAN_DATA_FOLDER is not set".into()))
}

/// Type into the chat composer, send, and wait for `expect` on the page.
fn send_and_wait(ctx: &Ctx, text: &str, expect: &str) -> ScenarioResult {
    ctx.type_into("[data-testid=\"chat-input\"]", text)?;
    ctx.wait_until(
        "the send control to arm",
        "const b = document.querySelector('[data-test-id=\"send-message-button\"]');
         return !!b && b.disabled !== true;",
        Duration::from_secs(60),
    )?;
    ctx.eval(
        "document.querySelector('[data-test-id=\"send-message-button\"]').click();
         return true;",
    )?;
    ctx.wait_until(
        &format!("{expect:?} on the page"),
        &format!("return (document.body.innerText || '').includes({expect:?});"),
        Duration::from_secs(90),
    )
}

/// The thread open in the chat route, and its directory on disk.
fn open_thread_dir(ctx: &Ctx) -> Result<(String, PathBuf), Failure> {
    ctx.wait_until(
        "a thread route",
        "return location.pathname.startsWith('/threads/') && location.pathname.length > 9;",
        Duration::from_secs(30),
    )?;
    let path = ctx.eval_string("return location.pathname;")?;
    let id = path
        .trim_start_matches("/threads/")
        .trim_end_matches('/')
        .to_string();
    Ok((path, data_folder()?.join("threads").join(id)))
}

/// Every line of a messages file, each of which must be a JSON object.
fn message_lines(dir: &Path) -> Result<Vec<Value>, Failure> {
    let text = std::fs::read_to_string(dir.join("messages.jsonl"))
        .map_err(|e| Failure(format!("messages.jsonl: {e}")))?;
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            serde_json::from_str::<Value>(l)
                .map_err(|e| Failure(format!("an unparseable line survived ({e}): {l:.120}")))
        })
        .collect()
}

/// Staging files still present after any in-flight write has had time to
/// finish. The atomic writer creates `<name>.tmp` and renames it over the
/// target, so one seen for an instant is a write in progress, not a leak; one
/// that is still there seconds later is.
fn staging_files(dir: &Path) -> Vec<String> {
    let list = || -> Vec<String> {
        std::fs::read_dir(dir)
            .map(|rd| {
                rd.flatten()
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .filter(|n| n.ends_with(".tmp"))
                    .collect()
            })
            .unwrap_or_default()
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let found = list();
        if found.is_empty() || Instant::now() >= deadline {
            return found;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// janhq/jan#8019. Thread files are replaced atomically (no staging file left
/// behind, every record parses). Ends by tearing the final line the way a
/// crash mid-append does; `a-torn-thread-tail-heals-after-a-restart` checks
/// that it neither hides the conversation nor swallows the next message.
fn scenario_thread_durability(ctx: &Ctx) -> ScenarioResult {
    ctx.script_model("plain", &[])?;
    ctx.goto("/")?;
    ctx.wait_until(
        "the chat composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    ctx.wait_until(
        "the previous run to finish",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(90),
    )?;
    ctx.ensure_model_selected()?;
    send_and_wait(ctx, "durable message one", "Hello from the smoke model")?;
    let (route, dir) = open_thread_dir(ctx)?;

    // The reply is persisted when its stream ends, not when it is drawn.
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let n = message_lines(&dir).map(|l| l.len()).unwrap_or(0);
        if n >= 2 {
            break;
        }
        ensure!(
            Instant::now() < deadline,
            "the exchange never reached {} ({n} records)",
            dir.display()
        );
        std::thread::sleep(Duration::from_millis(300));
    }
    let meta = std::fs::read_to_string(dir.join("thread.json"))
        .map_err(|e| Failure(format!("thread.json: {e}")))?;
    serde_json::from_str::<Value>(&meta)
        .map_err(|e| Failure(format!("thread.json does not parse: {e}")))?;
    let before = message_lines(&dir)?.len();
    ensure!(
        staging_files(&dir).is_empty(),
        "a staging file was left behind: {:?}",
        staging_files(&dir)
    );

    // What a crash mid-append leaves: an unterminated fragment. It is the last
    // thing this process does, so the restart half finds it exactly as a crash
    // would have left it; reloading the page in place instead left the WebView2
    // page unanswered in this harness.
    {
        use std::io::Write as _;
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(dir.join("messages.jsonl"))
            .map_err(|e| Failure(e.to_string()))?;
        f.write_all(TORN_TAIL.as_bytes())
            .map_err(|e| Failure(e.to_string()))?;
    }
    write_handoff(
        ctx,
        TORN_TAIL_HANDOFF,
        &serde_json::json!({ "route": route, "dir": dir, "before": before }),
    )
}

/// The fragment `thread-files-are-atomic` leaves at the end of a thread file.
const TORN_TAIL: &str = r#"{"id":"smoke-torn-tail","role":"assis"#;
const TORN_TAIL_HANDOFF: &str = "torn-tail";

/// Second process on the profile `thread-files-are-atomic` tore: the
/// conversation opens from disk despite the fragment, and the next message is
/// neither glued onto it nor lost (janhq/jan#8019).
fn scenario_torn_tail_after_restart(ctx: &Ctx) -> ScenarioResult {
    let handoff = read_handoff(ctx, TORN_TAIL_HANDOFF, "thread-files-are-atomic")?;
    let route = handoff["route"].as_str().unwrap_or_default().to_string();
    let dir = PathBuf::from(handoff["dir"].as_str().unwrap_or_default());
    let before = handoff["before"].as_u64().unwrap_or(0) as usize;
    let on_disk = std::fs::read_to_string(dir.join("messages.jsonl"))
        .map_err(|e| Failure(format!("messages.jsonl: {e}")))?;
    ensure!(
        on_disk.ends_with(TORN_TAIL),
        "the torn fragment was gone before the restart, so nothing here reads a torn file"
    );

    ctx.goto(&route)?;
    ctx.wait_until(
        "the conversation to survive the torn tail",
        "const t = document.body.innerText || '';
         return t.includes('durable message one') && t.includes('Hello from the smoke model');",
        Duration::from_secs(45),
    )?;

    ctx.ensure_model_selected()?;
    ctx.script_model("plain", &[])?;
    send_and_wait(ctx, "durable message two", "durable message two")?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match message_lines(&dir) {
            Ok(lines) if lines.len() >= before + 2 => {
                let text = serde_json::to_string(&lines).unwrap_or_default();
                ensure!(
                    !text.contains("smoke-torn-tail"),
                    "the torn fragment was kept as a record"
                );
                ensure!(
                    text.contains("durable message two"),
                    "the message sent after the torn tail was lost"
                );
                break;
            }
            Ok(_) => {}
            Err(Failure(e)) if Instant::now() >= deadline => bail!("{e}"),
            Err(_) => {}
        }
        ensure!(
            Instant::now() < deadline,
            "the second exchange never reached disk"
        );
        std::thread::sleep(Duration::from_millis(300));
    }
    ensure!(
        staging_files(&dir).is_empty(),
        "a staging file was left behind: {:?}",
        staging_files(&dir)
    );
    Ok(())
}

/// janhq/jan#8519 and #8911 through the real app. After startup the user's
/// server is still configured and the hosted Exa entry Jan's own migration
/// once switched on is gone; and a config that stops parsing is copied aside
/// before the defaults are written, instead of being overwritten.
fn scenario_mcp_config_durability(ctx: &Ctx) -> ScenarioResult {
    let data = data_folder()?;
    let path = data.join("mcp_config.json");
    let original =
        std::fs::read_to_string(&path).map_err(|e| Failure(format!("mcp_config.json: {e}")))?;
    let config: Value = serde_json::from_str(&original)
        .map_err(|e| Failure(format!("mcp_config.json does not parse: {e}")))?;
    let servers = config
        .get("mcpServers")
        .and_then(Value::as_object)
        .ok_or_else(|| Failure("no mcpServers".into()))?;
    ensure!(
        servers.contains_key(SMOKE_MCP_USER_SERVER),
        "the user's server was dropped at startup: {:?}",
        servers.keys().collect::<Vec<_>>()
    );
    ensure!(
        !servers.contains_key("exa"),
        "the default hosted Exa entry survived the migration"
    );
    let logs = std::fs::read_dir(data.join("logs"))
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| std::fs::read_to_string(e.path()).ok())
                .collect::<String>()
        })
        .unwrap_or_default();
    ensure!(
        !logs.contains("mcp.exa.ai"),
        "the app log mentions mcp.exa.ai, so something tried to reach it"
    );

    // The settings page lists what the file holds.
    ctx.goto("/settings/mcp-servers")?;
    ctx.wait_until(
        "the user's MCP server in the list",
        // Case-insensitive: the page shows names with CSS `capitalize`, which
        // `innerText` applies.
        &format!(
            "return (document.body.innerText || '').toLowerCase().includes({SMOKE_MCP_USER_SERVER:?});"
        ),
        Duration::from_secs(30),
    )?;

    // An unreadable config: kept aside, never destroyed.
    let corrupt = "{ \"mcpServers\": { \"smoke-user-server\": ";
    std::fs::write(&path, corrupt).map_err(|e| Failure(e.to_string()))?;
    let served = ctx.eval_string(
        "return String(await window.__TAURI_INTERNALS__.invoke('get_mcp_configs'));",
    );
    let kept: Vec<PathBuf> = std::fs::read_dir(&data)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .is_some_and(|n| n.to_string_lossy().starts_with("mcp_config.json.corrupt-"))
                })
                .collect()
        })
        .unwrap_or_default();
    let kept_ok = kept
        .iter()
        .any(|p| std::fs::read_to_string(p).ok().as_deref() == Some(corrupt));
    // Put the real config back before judging, so later scenarios keep their
    // servers whatever happened here.
    std::fs::write(&path, &original).map_err(|e| Failure(e.to_string()))?;
    for p in &kept {
        let _ = std::fs::remove_file(p);
    }
    served?;
    ensure!(
        kept_ok,
        "the unreadable config was not kept aside before defaults were written ({} copies)",
        kept.len()
    );
    let after = ctx.eval_string(
        "return String(await window.__TAURI_INTERNALS__.invoke('get_mcp_configs'));",
    )?;
    ensure!(
        after.contains(SMOKE_MCP_USER_SERVER),
        "the restored config did not load: {after:.200}"
    );
    Ok(())
}

/// A model that sends tool-call arguments that are not JSON must not wedge
/// the run or the thread: the call fails, the run ends, the conversation
/// reloads, and the next turn works (janhq/jan#8519's missing-`arguments`
/// replay was one form of this).
fn scenario_malformed_tool_call(ctx: &Ctx) -> ScenarioResult {
    ctx.script_model("tools", &["read:{\"path\":"])?;
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the cowork composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    ctx.wait_until(
        "the previous run to finish",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(90),
    )?;
    ctx.ensure_model_selected()?;
    ctx.eval(
        "const b = [...document.querySelectorAll('button')].find(x =>
           /new session/i.test((x.textContent || '').trim()));
         if (b) b.click();
         return true;",
    )?;
    ctx.settle();

    ctx.type_into("[data-testid=\"chat-input\"]", "read with broken arguments")?;
    ctx.wait_until(
        "the send control to arm",
        "const b = document.querySelector('[data-test-id=\"send-message-button\"]');
         return !!b && b.disabled !== true;",
        Duration::from_secs(60),
    )?;
    ctx.eval(
        "document.querySelector('[data-test-id=\"send-message-button\"]').click();
         return true;",
    )?;
    ctx.wait_until(
        "the run to start",
        "return !document.querySelector('[data-test-id=\"send-message-button\"]')
           || (document.body.innerText || '').includes('read with broken arguments');",
        Duration::from_secs(30),
    )?;
    ctx.wait_until(
        "the run to end instead of hanging",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(120),
    )?;

    // The page reloads cleanly with the conversation intact.
    ctx.goto("/")?;
    ctx.settle();
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the conversation after a reload",
        "return (document.body.innerText || '').includes('read with broken arguments');",
        Duration::from_secs(45),
    )?;

    // And the session still works. The history carries a tool result, so the
    // fixture answers with its summary -- which the first run already put on
    // the page, so only a reply drawn after the follow-up counts.
    ctx.script_model("plain", &[])?;
    let before = model_requests(ctx).map(|r| r.len()).unwrap_or(0);
    let answered = send_and_wait(ctx, "are you still there", "are you still there").and_then(|()| {
        ctx.wait_until(
            "a reply after the follow-up",
            "const t = document.body.innerText || '';
             const i = t.lastIndexOf('are you still there');
             return i >= 0 && t.slice(i).includes('Done. I used the tools you allowed.');",
            Duration::from_secs(90),
        )
    });
    if answered.is_err() {
        // Which half failed: a follow-up that never reached the model, or one
        // the model answered and the page did not show.
        let requests = model_requests(ctx).unwrap_or_default();
        println!(
            "      model requests before/after the follow-up: {before}/{}",
            requests.len()
        );
        if let Some(last) = requests.last() {
            let roles: Vec<String> = last
                .get("messages")
                .and_then(Value::as_array)
                .map(|m| {
                    m.iter()
                        .map(|x| {
                            let role = x.get("role").and_then(Value::as_str).unwrap_or("?");
                            let calls = x
                                .get("tool_calls")
                                .map(|c| c.to_string())
                                .unwrap_or_default();
                            format!("{role}{}", if calls.is_empty() { String::new() } else { format!(" {calls:.160}") })
                        })
                        .collect()
                })
                .unwrap_or_default();
            println!("      last request messages: {roles:?}");
        }
        println!(
            "      page tail: {}",
            ctx.eval_string("const t = document.body.innerText || ''; return t.slice(-600);")
                .unwrap_or_default()
        );
    }
    answered
}

/// Second process on a kept profile: the tool activity the first process
/// recorded is drawn again from the record, and hydrating it writes nothing.
fn scenario_tool_activity_after_restart(ctx: &Ctx) -> ScenarioResult {
    let before = activity_events(ctx);
    ensure!(
        !before.is_empty(),
        "the kept profile holds no tool activity; run tool-activity-timeline with COWORK_SMOKE_KEEP first"
    );
    ensure!(
        before.iter().any(|e| e.contains("\"phase\":\"succeeded\"")),
        "the kept record has no finished call to hydrate"
    );
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the recorded tool call after a restart",
        "return !!document.querySelector('[data-testid=\"tool-activity-item\"]');",
        Duration::from_secs(60),
    )?;
    ctx.settle();
    let after = activity_events(ctx);
    let new: Vec<&String> = after[before.len().min(after.len())..]
        .iter()
        .filter(|e| !e.contains("\"phase\":\"stale\""))
        .collect();
    ensure!(
        new.is_empty(),
        "hydrating the timeline wrote {} new event(s): {:?}",
        new.len(),
        new.iter().take(2).collect::<Vec<_>>()
    );
    Ok(())
}

/// Set the words the model fixture answers with.
fn script_reply(ctx: &Ctx, reply: &str) -> ScenarioResult {
    let port = ctx.mock_port;
    let ok = ctx.eval_bool(&format!(
        r#"const res = await fetch('http://127.0.0.1:{port}/__control', {{
             method: 'POST',
             headers: {{ 'Content-Type': 'application/json' }},
             body: JSON.stringify({{ reply: {reply:?} }}),
           }});
           return res.ok;"#
    ))?;
    ensure!(ok, "could not set the fixture reply");
    Ok(())
}

const DEFAULT_REPLY: &str = "Hello from the smoke model.";

/// The chat bodies the fixture received, oldest first.
fn model_requests(ctx: &Ctx) -> Result<Vec<Value>, Failure> {
    let port = ctx.mock_port;
    let raw = ctx.eval_string(&format!(
        "const r = await fetch('http://127.0.0.1:{port}/__requests');
         return JSON.stringify(await r.json());"
    ))?;
    let v: Value = serde_json::from_str(&raw).map_err(|e| Failure(e.to_string()))?;
    Ok(v.get("requests")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

/// The system prompt of the most recent chat request.
fn last_system_prompt(ctx: &Ctx) -> Result<String, Failure> {
    let requests = model_requests(ctx)?;
    let last = requests
        .last()
        .ok_or_else(|| Failure("the fixture received no chat request".into()))?;
    Ok(last
        .get("messages")
        .and_then(Value::as_array)
        .map(|m| {
            m.iter()
                .filter(|m| m.get("role").and_then(Value::as_str) == Some("system"))
                .map(|m| m.get("content").map(|c| c.to_string()).unwrap_or_default())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default())
}

/// A fresh chat with the smoke model selected.
fn new_chat(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/")?;
    ctx.wait_until(
        "the chat composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    ctx.wait_until(
        "the previous run to finish",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(90),
    )?;
    ctx.ensure_model_selected()
}

/// janhq/jan#8495. Deleting a reply in the middle of a conversation re-links
/// what hung below it, so the later exchange stays on screen and on disk;
/// `a-deleted-reply-stays-deleted-after-a-restart` checks it after a restart.
fn scenario_delete_keeps_later_replies(ctx: &Ctx) -> ScenarioResult {
    let result = (|| {
        ctx.script_model("plain", &[])?;
        new_chat(ctx)?;
        script_reply(ctx, "Reply alpha from the smoke model.")?;
        send_and_wait(ctx, "message alpha", "Reply alpha from the smoke model.")?;
        let (route, dir) = open_thread_dir(ctx)?;
        ctx.wait_until(
            "the first run to finish",
            "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
            Duration::from_secs(60),
        )?;
        script_reply(ctx, "Reply bravo from the smoke model.")?;
        send_and_wait(ctx, "message bravo", "Reply bravo from the smoke model.")?;
        ctx.wait_until(
            "the second run to finish",
            "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
            Duration::from_secs(60),
        )?;
        std::thread::sleep(Duration::from_secs(1));

        // The first reply's own action row: its last button is the trash.
        let clicked = ctx.eval_string(
            r#"const rows = [...document.querySelectorAll('div.group\\/message')];
               const row = rows.find(r => (r.innerText || '').includes('Reply alpha from the smoke model.')
                                       && !(r.innerText || '').includes('message bravo'));
               if (!row) return 'no row';
               const buttons = [...row.querySelectorAll('button')].filter(b => b.querySelector('svg'));
               const trash = buttons.find(b => b.querySelector('svg.tabler-icon-trash'))
                 || buttons[buttons.length - 1];
               if (!trash) return 'no button';
               trash.click();
               return 'clicked';"#,
        )?;
        if clicked != "clicked" {
            ctx.describe("delete-message")?;
            bail!("could not reach the reply's delete control: {clicked}");
        }
        ctx.wait_until(
            "the delete confirmation",
            "return !!document.querySelector('[role=\"dialog\"] button[aria-label=\"Delete Message\"]');",
            Duration::from_secs(15),
        )?;
        ctx.eval(
            "document.querySelector('[role=\"dialog\"] button[aria-label=\"Delete Message\"]').click();
             return true;",
        )?;
        ctx.wait_until(
            "the reply to go",
            "return !(document.body.innerText || '').includes('Reply alpha from the smoke model.');",
            Duration::from_secs(20),
        )?;
        let visible = |ctx: &Ctx| {
            ctx.eval_bool(
                "const t = document.body.innerText || '';
                 return t.includes('message bravo') && t.includes('Reply bravo from the smoke model.');",
            )
        };
        ensure!(visible(ctx)?, "the later exchange vanished with the deleted reply");

        // On disk: the reply is gone and the later exchange is not.
        let lines = message_lines(&dir)?;
        let text = serde_json::to_string(&lines).unwrap_or_default();
        ensure!(
            !text.contains("Reply alpha from the smoke model."),
            "the deleted reply is still on disk"
        );
        ensure!(
            text.contains("Reply bravo from the smoke model.") && text.contains("message bravo"),
            "the later exchange is not on disk"
        );

        // The restart half rebuilds the tree from the record. Reloading the
        // page in place left the WebView2 page unanswered in this harness.
        write_handoff(ctx, DELETE_HANDOFF, &serde_json::json!({ "route": route }))
    })();
    let _ = script_reply(ctx, DEFAULT_REPLY);
    result
}

const DELETE_HANDOFF: &str = "deleted-reply";

/// Second process on the profile `deleting-a-message-keeps-later-replies`
/// left: the tree rebuilt from the record still shows the later exchange and
/// not the deleted reply.
fn scenario_delete_after_restart(ctx: &Ctx) -> ScenarioResult {
    let handoff = read_handoff(ctx, DELETE_HANDOFF, "deleting-a-message-keeps-later-replies")?;
    ctx.goto(handoff["route"].as_str().unwrap_or_default())?;
    ctx.wait_until(
        "the later exchange after a restart",
        "const t = document.body.innerText || '';
         return t.includes('message bravo') && t.includes('Reply bravo from the smoke model.');",
        Duration::from_secs(45),
    )?;
    ensure!(
        !ctx.eval_bool(
            "return (document.body.innerText || '').includes('Reply alpha from the smoke model.');"
        )?,
        "the deleted reply came back after a restart"
    );
    Ok(())
}

/// Where a scenario whose second half needs a restart leaves what that half
/// needs, inside the kept profile.
fn handoff_path(ctx: &Ctx, name: &str) -> PathBuf {
    ctx.workspace.join(format!("handoff-{name}.json"))
}

fn write_handoff(ctx: &Ctx, name: &str, value: &Value) -> ScenarioResult {
    std::fs::write(handoff_path(ctx, name), value.to_string())
        .map_err(|e| Failure(format!("could not leave the restart handoff: {e}")))
}

fn read_handoff(ctx: &Ctx, name: &str, first: &str) -> Result<Value, Failure> {
    let text = std::fs::read_to_string(handoff_path(ctx, name)).map_err(|_| {
        Failure(format!(
            "the kept profile has no handoff from {first}; run it with COWORK_SMOKE_KEEP first"
        ))
    })?;
    serde_json::from_str(&text).map_err(|e| Failure(format!("unreadable handoff: {e}")))
}

/// Open the edit dialog for the assistant named `name`, set its instructions,
/// save, and return what they were.
fn set_assistant_instructions(ctx: &Ctx, name: &str, instructions: &str) -> Result<String, Failure> {
    ctx.goto("/settings/assistant")?;
    ctx.wait_until(
        "the assistant list",
        "return !!document.querySelector('button[title=\"Edit Assistant\"]');",
        Duration::from_secs(30),
    )?;
    let opened = ctx.eval_bool(&format!(
        r#"const edits = [...document.querySelectorAll('button[title="Edit Assistant"]')];
           let target = null;
           for (const b of edits) {{
             let row = b;
             for (let i = 0; i < 6 && row && !(row.innerText || '').includes({name:?}); i++) row = row.parentElement;
             if (row && (row.innerText || '').includes({name:?})) {{ target = b; break; }}
           }}
           if (!target) target = edits[0];
           target.click();
           return true;"#
    ))?;
    ensure!(opened, "no Edit Assistant control");
    ctx.wait_until(
        "the instructions field",
        "return !!document.querySelector('textarea[placeholder=\"Enter instructions\"]');",
        Duration::from_secs(15),
    )?;
    let previous = ctx.eval_string(
        "return document.querySelector('textarea[placeholder=\"Enter instructions\"]').value;",
    )?;
    ctx.type_into("textarea[placeholder=\"Enter instructions\"]", instructions)?;
    std::thread::sleep(Duration::from_millis(300));
    let saved = ctx.eval_bool(
        "const b = [...document.querySelectorAll('[role=\"dialog\"] button')]
           .find(x => (x.textContent || '').trim() === 'Save');
         if (!b) return false; b.click(); return true;",
    )?;
    ensure!(saved, "no Save button in the assistant dialog");
    ctx.wait_until(
        "the dialog to close",
        "return !document.querySelector('textarea[placeholder=\"Enter instructions\"]');",
        Duration::from_secs(15),
    )?;
    Ok(previous)
}

/// janhq/jan#8524. Editing the assistant an open chat uses changes what the
/// next request in that chat carries -- not only new chats.
fn scenario_instructions_reach_open_chat(ctx: &Ctx) -> ScenarioResult {
    ctx.script_model("plain", &[])?;
    new_chat(ctx)?;
    send_and_wait(ctx, "instructions check one", "Hello from the smoke model")?;
    let (route, dir) = open_thread_dir(ctx)?;
    ctx.wait_until(
        "the run to finish",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(60),
    )?;
    let thread: Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("thread.json")).map_err(|e| Failure(e.to_string()))?,
    )
    .map_err(|e| Failure(e.to_string()))?;
    let name = thread
        .pointer("/assistants/0/name")
        .and_then(Value::as_str)
        .unwrap_or("Jan")
        .to_string();

    let nonce = format!("SMOKE-INSTRUCTION-{}", std::process::id());
    ensure!(
        !last_system_prompt(ctx)?.contains(&nonce),
        "the nonce was in the prompt before it was set"
    );
    let previous = set_assistant_instructions(ctx, &name, &format!("Always sign off with {nonce}."))?;
    let result = (|| {
        ctx.goto(&route)?;
        ctx.wait_until(
            "the open chat",
            "return (document.body.innerText || '').includes('instructions check one');",
            Duration::from_secs(30),
        )?;
        ctx.ensure_model_selected()?;
        send_and_wait(ctx, "instructions check two", "instructions check two")?;
        ctx.wait_until(
            "the run to finish",
            "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
            Duration::from_secs(60),
        )?;
        let system = last_system_prompt(ctx)?;
        ensure!(
            system.contains(&nonce),
            "the open chat still sent the old instructions: {system:.300}"
        );
        Ok(())
    })();
    // Leave the assistant as it was for every later scenario.
    let restored = set_assistant_instructions(ctx, &name, &previous);
    result?;
    restored.map(|_| ())
}

/// janhq/jan#8760. A custom endpoint that stops a turn with
/// `finish_reason: "length"` has no known context window, so the reply stays as
/// a stopped turn: no "ran out of context" verdict and no Increase Context Size
/// button that would change nothing on a server Jan does not run.
fn scenario_length_stop_on_custom_endpoint(ctx: &Ctx) -> ScenarioResult {
    let result = (|| {
        ctx.script_model("length", &[])?;
        new_chat(ctx)?;
        script_reply(ctx, "A reply the output cap cut short")?;
        send_and_wait(ctx, "write something long", "A reply the output cap cut short")?;
        ctx.wait_until(
            "the run to finish",
            "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
            Duration::from_secs(60),
        )?;
        std::thread::sleep(Duration::from_secs(2));
        let text = ctx.eval_string("return document.body.innerText || '';")?;
        ensure!(
            !text.contains("Increase Context Size"),
            "a custom endpoint was offered Increase Context Size"
        );
        ensure!(
            !text.contains("Model ran out of context size"),
            "an output-cap stop was reported as a context overflow on an unknown window"
        );
        Ok(())
    })();
    let _ = ctx.script_model("plain", &[]);
    let _ = script_reply(ctx, DEFAULT_REPLY);
    result
}

/// Read or set the built-in web search switch; returns the previous state.
fn set_builtin_web_search(ctx: &Ctx, on: bool) -> Result<bool, Failure> {
    ctx.goto("/settings/web-search")?;
    ctx.wait_until(
        "the web search switch",
        "return !!document.querySelector('button[role=\"switch\"]');",
        Duration::from_secs(30),
    )?;
    let was = ctx.eval_bool(
        "return document.querySelector('button[role=\"switch\"]').getAttribute('aria-checked') === 'true';",
    )?;
    if was != on {
        ctx.eval("document.querySelector('button[role=\"switch\"]').click(); return true;")?;
        ctx.wait_until(
            "the switch to move",
            &format!(
                "return document.querySelector('button[role=\"switch\"]').getAttribute('aria-checked') === '{on}';"
            ),
            Duration::from_secs(10),
        )?;
        ctx.settle();
    }
    Ok(was)
}

/// janhq/jan#8777. With built-in web search off, a `web_search` call comes
/// from the MCP server that offers one: it is held for the user's approval
/// and, once allowed, runs on that server -- not auto-approved and sent to
/// Jan's native adapter because of its name.
fn scenario_mcp_web_search_approval(ctx: &Ctx) -> ScenarioResult {
    let log = data_folder()?.join("mcp-web-search-calls.jsonl");
    let calls = || {
        std::fs::read_to_string(&log)
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .count()
    };
    let was_on = set_builtin_web_search(ctx, false)?;
    let result = (|| {
        let before = calls();
        ctx.script_model("tools", &["web_search:{\"query\":\"smoke approval query\"}"])?;
        new_chat(ctx)?;
        ctx.type_into("[data-testid=\"chat-input\"]", "search the web for the smoke query")?;
        ctx.wait_until(
            "the send control to arm",
            "const b = document.querySelector('[data-test-id=\"send-message-button\"]');
             return !!b && b.disabled !== true;",
            Duration::from_secs(60),
        )?;
        ctx.eval(
            "document.querySelector('[data-test-id=\"send-message-button\"]').click();
             return true;",
        )?;
        let asked = ctx.wait_until(
            "the approval request",
            "return (document.body.innerText || '').includes('This tool needs your approval before it runs.');",
            Duration::from_secs(60),
        );
        if asked.is_err() {
            println!(
                "      page: {}",
                ctx.eval_string("return (document.body.innerText || '').slice(-800);")
                    .unwrap_or_default()
            );
        }
        asked?;
        ensure!(
            calls() == before,
            "the MCP server ran web_search before the user approved it"
        );
        let clicked = ctx.eval_bool(
            "const b = [...document.querySelectorAll('button')]
               .find(x => (x.textContent || '').trim() === 'Allow Once');
             if (!b) return false; b.click(); return true;",
        )?;
        ensure!(clicked, "no Allow Once control on the approval card");
        let deadline = Instant::now() + Duration::from_secs(60);
        while calls() == before {
            ensure!(
                Instant::now() < deadline,
                "the approved web_search never reached the MCP server that offered it"
            );
            std::thread::sleep(Duration::from_millis(300));
        }
        let text = std::fs::read_to_string(&log).unwrap_or_default();
        ensure!(
            text.contains("smoke approval query"),
            "the MCP server was called without the model's arguments: {text:.200}"
        );
        ctx.wait_until(
            "the run to finish",
            "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
            Duration::from_secs(90),
        )?;
        let sent = serde_json::to_string(&model_requests(ctx)?).unwrap_or_default();
        ensure!(
            sent.contains("SMOKE-MCP-WEB-SEARCH-RESULT"),
            "the server's result never went back to the model"
        );
        Ok(())
    })();
    let _ = ctx.script_model("plain", &[]);
    let restored = set_builtin_web_search(ctx, was_on);
    result?;
    restored.map(|_| ())
}

// ---------------------------------------------------------------------------
// Real-provider lane
// ---------------------------------------------------------------------------

/// A custom provider pointing at the real server, with the ephemeral key and
/// one placeholder model: discovery has to find the real one.
fn seed_lane_settings(data_folder: &Path, base_url: &str, key: &str) -> Result<(), String> {
    std::fs::create_dir_all(data_folder).map_err(|e| e.to_string())?;
    let placeholder = serde_json::json!({
        "id": "lane-placeholder", "model": "lane-placeholder", "name": "lane-placeholder",
        "capabilities": ["completion"], "version": "1.0"
    });
    let providers = serde_json::json!({
        "version": 18,
        "state": {
            "providers": [{
                "active": true,
                "persist": true,
                "provider": LANE_PROVIDER,
                "base_url": base_url,
                "api_key": key,
                "settings": [],
                "models": [placeholder]
            }],
            "selectedProvider": LANE_PROVIDER,
            "selectedModel": placeholder,
            "deletedModels": []
        }
    });
    let settings = serde_json::json!({
        "model-provider": providers.to_string(),
        "jan-model-prompt-dismissed": "true",
        "productAnalytic": "false",
        "productAnalyticPrompt": "false",
    });
    std::fs::write(
        data_folder.join("settings.json"),
        serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

fn lane_model() -> String {
    LANE.get().map(|(_, m)| m.clone()).unwrap_or_default()
}

/// Pick `model` in the composer's model picker.
fn select_model(ctx: &Ctx, model: &str) -> ScenarioResult {
    let already = ctx.eval_bool(&format!(
        "return [...document.querySelectorAll('button')].some(b =>
           (b.textContent || '').trim() === {model:?} || (b.textContent || '').includes({model:?}));"
    ))?;
    if already {
        return Ok(());
    }
    ctx.eval(
        "const b = [...document.querySelectorAll('button')].find(x =>
           /select a model|lane-placeholder/i.test((x.getAttribute('aria-label') || '')
             + ' ' + (x.textContent || '')));
         if (b) b.click();
         return true;",
    )?;
    ctx.wait_until(
        "the model picker",
        "return [...document.querySelectorAll('input')].some(i =>
            /search|find|model/i.test(i.getAttribute('placeholder') || ''));",
        Duration::from_secs(20),
    )?;
    ctx.type_into(
        "input[placeholder*='model' i], input[placeholder*='search' i]",
        model,
    )?;
    std::thread::sleep(Duration::from_millis(800));
    let picked = ctx.eval_bool(&format!(
        "const el = [...document.querySelectorAll('[role=\"option\"],button,li,div')]
           .filter(e => e.children.length <= 2 && (e.textContent || '').trim() === {model:?})
           .pop();
         if (!el) return false;
         (el.closest('[role=\"option\"],button,li') || el).click();
         return true;"
    ))?;
    if !picked {
        ctx.describe("lane-model-picker")?;
        bail!("the picker never offered {model}");
    }
    std::thread::sleep(Duration::from_millis(900));
    Ok(())
}

fn lane_provider_page(ctx: &Ctx) -> ScenarioResult {
    ctx.goto(&format!("/settings/providers/{LANE_PROVIDER}"))?;
    ctx.wait_until(
        "the provider page",
        "return !!document.querySelector('button[title=\"Refresh\"]');",
        Duration::from_secs(30),
    )
}

/// Discovery through the app: the provider page's Refresh asks the server's
/// `/v1/models`, and the real model appears beside the seeded placeholder.
fn lane_discovers_models(ctx: &Ctx) -> ScenarioResult {
    let model = lane_model();
    lane_provider_page(ctx)?;
    ensure!(
        !ctx.eval_bool(&format!("return !!document.querySelector('h1[title={model:?}]');"))?,
        "{model} was listed before discovery"
    );
    ctx.eval("document.querySelector('button[title=\"Refresh\"]').click(); return true;")?;
    let found = ctx.wait_until(
        "the discovered model",
        &format!("return !!document.querySelector('h1[title={model:?}]');"),
        Duration::from_secs(60),
    );
    if found.is_err() {
        println!(
            "      page: {}",
            ctx.eval_string("return (document.body.innerText || '').slice(0, 900);")
                .unwrap_or_default()
        );
    }
    found
}

/// A private or tailnet endpoint is listed under Local in the settings
/// sidebar once the resolver has classified it.
fn lane_grouped_local(ctx: &Ctx) -> ScenarioResult {
    lane_provider_page(ctx)?;
    ctx.wait_until(
        "the endpoint under the Local heading",
        &format!(
            r#"const spans = [...document.querySelectorAll('span')];
               const local = spans.find(s => (s.textContent || '').trim() === 'Local');
               const remote = spans.find(s => (s.textContent || '').trim() === 'Remote');
               const item = [...document.querySelectorAll('a,button,div,span')]
                 .filter(e => e.children.length === 0 && (e.textContent || '').trim().toLowerCase() === {LANE_PROVIDER:?})
                 .shift();
               if (!local || !item) return false;
               const after = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
               if (!after(local, item)) return false;
               // Under Local means not also past the Remote heading that
               // follows it.
               if (remote && after(local, remote) && after(remote, item)) return false;
               return true;"#
        ),
        Duration::from_secs(45),
    )
}

/// The model streams a reply the prompt did not contain, and the reply shows
/// its token speed.
fn lane_streams_a_reply(ctx: &Ctx) -> ScenarioResult {
    let model = lane_model();
    new_chat_lane(ctx, &model)?;
    let a: u32 = 100 + rand::random::<u32>() % 800;
    let b: u32 = 100 + rand::random::<u32>() % 800;
    let expect = format!("LANE-{}", a + b);
    ctx.type_into(
        "[data-testid=\"chat-input\"]",
        &format!("Compute {a}+{b}. Reply with only LANE- followed by the sum, for example LANE-7, and nothing else."),
    )?;
    send_armed(ctx)?;
    ctx.wait_until(
        "the streamed answer",
        &format!("return (document.body.innerText || '').includes({expect:?});"),
        Duration::from_secs(240),
    )?;
    ctx.wait_until(
        "the run to finish",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(240),
    )?;
    ctx.wait_until(
        "the token speed",
        "return /\\d+ tokens\\/sec/.test(document.body.innerText || '');",
        Duration::from_secs(20),
    )?;
    let speed = ctx.eval_string(
        "const m = (document.body.innerText || '').match(/\\d+ tokens\\/sec[^\\n]*/); return m ? m[0] : '';",
    )?;
    println!("      reply {expect} at {speed}");
    Ok(())
}

fn new_chat_lane(ctx: &Ctx, model: &str) -> ScenarioResult {
    ctx.goto("/")?;
    ctx.wait_until(
        "the chat composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    select_model(ctx, model)
}

fn send_armed(ctx: &Ctx) -> ScenarioResult {
    ctx.wait_until(
        "the send control to arm",
        "const b = document.querySelector('[data-test-id=\"send-message-button\"]');
         return !!b && b.disabled !== true;",
        Duration::from_secs(60),
    )?;
    ctx.eval(
        "document.querySelector('[data-test-id=\"send-message-button\"]').click();
         return true;",
    )?;
    Ok(())
}

/// The last prompt snapshot written for `thread`, as text.
fn last_snapshot_for(thread: &str) -> Result<String, Failure> {
    let text = std::fs::read_to_string(data_folder()?.join("audit/prompts.jsonl"))
        .map_err(|e| Failure(format!("audit/prompts.jsonl: {e}")))?;
    Ok(text
        .lines()
        .rev()
        .find(|l| l.contains(thread))
        .unwrap_or_default()
        .to_string())
}

/// A remembered fact is injected into the request the model receives, and
/// the model answers from it.
fn lane_memory_reaches_the_model(ctx: &Ctx) -> ScenarioResult {
    let model = lane_model();
    new_chat_lane(ctx, &model)?;
    ctx.type_into("[data-testid=\"chat-input\"]", "Reply with only the word READY.")?;
    send_armed(ctx)?;
    ctx.wait_until(
        "the first reply",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]')
           && (document.body.innerText || '').includes('READY');",
        Duration::from_secs(240),
    )?;
    let (route, _) = open_thread_dir(ctx)?;
    let thread = route.trim_start_matches("/threads/").trim_end_matches('/').to_string();

    let pass = format!("amber-{}", rand::random::<u32>() % 90000 + 10000);
    let proposed = ctx.eval_string(&format!(
        r#"const c = await window.__TAURI_INTERNALS__.invoke('get_app_configurations');
           const out = await window.__TAURI_INTERNALS__.invoke(
             'plugin:agent-tools|memory_record_propose_inferred',
             {{ location: {{ dataFolder: c.data_folder, sessionId: {thread:?} }},
                scope: 'chat',
                content: 'The lane passphrase is {pass}.',
                sourceSessionId: {thread:?},
                sourceMessageId: 'lane-1' }});
           return JSON.stringify(out);"#
    ))?;
    println!("      memory proposal: {proposed:.160}");
    ctx.goto("/")?;
    ctx.goto(&route)?;
    let card = ctx.wait_until(
        "the memory proposal",
        "return !!document.querySelector('[data-testid=\"memory-proposal-approve\"]');",
        Duration::from_secs(30),
    );
    if card.is_ok() {
        ctx.eval(
            "document.querySelector('[data-testid=\"memory-proposal-approve\"]').click(); return true;",
        )?;
        std::thread::sleep(Duration::from_secs(2));
    }

    ctx.type_into(
        "[data-testid=\"chat-input\"]",
        "What is the lane passphrase? Reply with only the passphrase.",
    )?;
    send_armed(ctx)?;
    ctx.wait_until(
        "the answer",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]')
           && (document.body.innerText || '').split('What is the lane passphrase').length > 1;",
        Duration::from_secs(240),
    )?;
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut snapshot = String::new();
    while Instant::now() < deadline {
        snapshot = last_snapshot_for(&thread)?;
        if snapshot.contains("What is the lane passphrase") {
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    ensure!(
        snapshot.contains("Remembered") && snapshot.contains(&pass),
        "the request the model received did not carry the memory (card shown: {}): {:.300}",
        card.is_ok(),
        snapshot
    );
    ctx.wait_until(
        "the model to answer from memory",
        &format!("return (document.body.innerText || '').includes({pass:?});"),
        Duration::from_secs(60),
    )
}

/// Turn tool calling on for the lane model through its edit dialog.
fn enable_tools(ctx: &Ctx, model: &str) -> ScenarioResult {
    lane_provider_page(ctx)?;
    let opened = ctx.eval_bool(&format!(
        r#"const h = document.querySelector('h1[title={model:?}]');
           if (!h) return false;
           let row = h;
           for (let i = 0; i < 8 && row; i++) {{
             const pencil = row.querySelector('svg.tabler-icon-pencil');
             if (pencil) {{ (pencil.closest('.cursor-pointer') || pencil).click(); return true; }}
             row = row.parentElement;
           }}
           return false;"#
    ))?;
    ensure!(opened, "no edit control for {model}");
    ctx.wait_until(
        "the tools switch",
        "return !!document.querySelector('#tools-capability');",
        Duration::from_secs(15),
    )?;
    let on = ctx.eval_bool(
        "return document.querySelector('#tools-capability').getAttribute('aria-checked') === 'true';",
    )?;
    if !on {
        ctx.eval("document.querySelector('#tools-capability').click(); return true;")?;
        std::thread::sleep(Duration::from_millis(300));
        let saved = ctx.eval_bool(
            "const b = [...document.querySelectorAll('[role=\"dialog\"] button')]
               .find(x => /^save/i.test((x.textContent || '').trim()));
             if (!b || b.disabled) return false; b.click(); return true;",
        )?;
        ensure!(saved, "no enabled Save in the model dialog");
    }
    std::thread::sleep(Duration::from_secs(1));
    let _ = ctx.eval(
        "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;",
    );
    Ok(())
}

/// One real model -> tool -> model loop in Cowork, with the provider's usage
/// recorded against the dispatch and the context window reported.
fn lane_cowork_tool_loop(ctx: &Ctx) -> ScenarioResult {
    let model = lane_model();
    enable_tools(ctx, &model)?;
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the cowork composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    ctx.eval(
        "const b = [...document.querySelectorAll('button')].find(x =>
           /new session/i.test((x.textContent || '').trim()));
         if (b) b.click();
         return true;",
    )?;
    ctx.settle();
    select_model(ctx, &model)?;
    let before = activity_events(ctx).len();
    ctx.type_into(
        "[data-testid=\"chat-input\"]",
        "Call the ls tool exactly once to list the workspace root. After it returns, reply with the single word FINISHED.",
    )?;
    send_armed(ctx)?;
    ctx.wait_until(
        "the tool call to finish",
        "return !!document.querySelector('[data-testid=\"tool-activity-item\"][data-tool-state=\"output-available\"]');",
        Duration::from_secs(300),
    )?;
    ctx.wait_until(
        "the model's answer after the tool",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]')
           && /FINISHED/.test(document.body.innerText || '');",
        Duration::from_secs(300),
    )?;
    let fresh: Vec<String> = activity_events(ctx).into_iter().skip(before).collect();
    ensure!(
        fresh.iter().any(|e| e.contains("\"tool\":\"ls\"") && e.contains("\"phase\":\"succeeded\"")),
        "no succeeded ls call was recorded: {:?}",
        fresh.iter().take(3).collect::<Vec<_>>()
    );
    let usage = std::fs::read_to_string(data_folder()?.join("audit/payload-usage.jsonl"))
        .unwrap_or_default();
    ensure!(
        usage
            .lines()
            .any(|l| l.contains(&format!("\"model\":\"{model}\"")) && l.contains("\"source\":\"provider\"")),
        "the provider's usage for {model} was not recorded"
    );
    // The breakdown lives in the session details dialog, mounted only while
    // it is open.
    ctx.eval(
        "const t = document.querySelector('[data-testid=\"session-details-trigger\"]');
         if (t) t.click();
         return true;",
    )?;
    ctx.wait_until(
        "the session details",
        "return !!document.querySelector('[data-testid=\"session-details-body\"]');",
        Duration::from_secs(15),
    )?;
    let window = ctx.eval_string(
        r#"const d = document.querySelector('details[aria-label="What the model received"]');
           if (!d) return 'no breakdown';
           d.open = true;
           // The innermost element whose text starts with the label is the
           // label itself; its row is the first ancestor carrying more text.
           const label = [...d.querySelectorAll('*')]
             .filter(e => (e.textContent || '').trim().startsWith('Context window')).pop();
           if (!label) return 'no context row';
           let row = label;
           while (row.parentElement && row.parentElement !== d
                  && (row.textContent || '').trim() === 'Context window') row = row.parentElement;
           return row.textContent.replace(/\s+/g, ' ').trim().slice(0, 160);"#,
    )?;
    println!("      context window: {window}");
    let _ = ctx.eval(
        "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;",
    );
    ensure!(
        window.starts_with("Context window"),
        "the run did not report its context window: {window}"
    );
    Ok(())
}

/// Where the key is, and whom the app talked to.
fn lane_contained(ctx: &Ctx) -> ScenarioResult {
    let key = LANE_KEY.get().cloned().unwrap_or_default();
    ensure!(key.len() == 64, "the lane key was not made");
    // Never in this process's arguments or environment.
    ensure!(
        !std::env::args().any(|a| a.contains(&key)),
        "the key is in the process arguments"
    );
    ensure!(
        !std::env::vars().any(|(_, v)| v.contains(&key)),
        "the key is in the process environment"
    );

    // Every file of the run's profile, data folder and WebView profile both.
    let root = ctx.workspace.clone();
    let mut hits: Vec<String> = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if let Ok(bytes) = std::fs::read(&p) {
                if bytes.windows(key.len()).any(|w| w == key.as_bytes()) {
                    hits.push(
                        p.strip_prefix(&root)
                            .unwrap_or(&p)
                            .to_string_lossy()
                            .replace('\\', "/"),
                    );
                }
            }
        }
    }
    println!("      key found in: {hits:?}");
    let allowed = |rel: &str| {
        rel == "data/settings.json" || (rel.starts_with("webview/") && rel.contains("Local Storage"))
    };
    let stray: Vec<&String> = hits.iter().filter(|h| !allowed(h)).collect();
    ensure!(
        stray.is_empty(),
        "the key is stored outside credential handling: {stray:?}"
    );

    // Every connection the app opened, from its own log, plus what the
    // transport resolved and what the page fetched.
    let base = LANE.get().map(|(b, _)| b.clone()).unwrap_or_default();
    let lane_host = base
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .split('/')
        .next()
        .unwrap_or_default()
        .to_string();
    let logs = std::fs::read_dir(data_folder()?.join("logs"))
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| std::fs::read_to_string(e.path()).ok())
                .collect::<String>()
        })
        .unwrap_or_default();
    let mut peers: Vec<String> = logs
        .lines()
        .filter_map(|l| l.split("starting new connection: ").nth(1))
        .map(|u| {
            u.trim()
                .trim_start_matches("http://")
                .trim_start_matches("https://")
                .trim_end_matches('/')
                .to_string()
        })
        .collect();
    peers.sort();
    peers.dedup();
    let resolved: Vec<String> = LOOKED_UP.lock().map(|v| v.clone()).unwrap_or_default();
    let page = ctx.eval_string(
        "return JSON.stringify([...new Set(performance.getEntriesByType('resource').map(e => e.name))]);",
    )?;
    println!("      connections: {peers:?}; resolved: {:?}", {
        let mut r = resolved.clone();
        r.sort();
        r.dedup();
        r
    });
    let local = |p: &str| {
        p.starts_with("127.0.0.1") || p.starts_with("localhost") || p.starts_with("[::1]")
    };
    let foreign: Vec<&String> = peers
        .iter()
        .filter(|p| **p != lane_host && !local(p))
        .collect();
    ensure!(foreign.is_empty(), "the app connected elsewhere: {foreign:?}");
    ensure!(
        !peers.iter().any(|p| p.ends_with(":8080")) && !resolved.iter().any(|p| p.ends_with(":8080")),
        "something reached port 8080"
    );
    let page_urls: Vec<String> = serde_json::from_str(&page).unwrap_or_default();
    let page_foreign: Vec<&String> = page_urls
        .iter()
        .filter(|u| {
            !(u.starts_with("tauri://")
                || u.starts_with("asset://")
                || u.starts_with("ipc://")
                || u.starts_with("data:")
                || u.starts_with("blob:")
                || u.contains("://localhost")
                || u.contains("://tauri.localhost")
                || u.contains("://asset.localhost")
                || u.contains("://ipc.localhost"))
        })
        .collect();
    ensure!(
        page_foreign.is_empty(),
        "the page fetched from elsewhere: {page_foreign:?}"
    );
    Ok(())
}
