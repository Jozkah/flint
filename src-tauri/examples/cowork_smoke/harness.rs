/// Compile-time crate root. Fixtures live under this, never under the CWD.
const MANIFEST_DIR: &str = env!("CARGO_MANIFEST_DIR");

static EVAL_SEQ: AtomicU64 = AtomicU64::new(0);

/// A provider name deliberately absent from `predefinedProviders`, so it counts
/// as a custom endpoint and needs no credential to be usable.
const SMOKE_PROVIDER: &str = "cowork-smoke-mock";
/// The single-label hostname the provider is configured at, exactly as a user
/// would type it. It is never rewritten to an address.
const SMOKE_ENDPOINT_HOST: &str = "llm-host";
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
const LANE_PROVIDER: &str = "llm-host-lane";

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
/// Every method the web-search fixture received, and its process id.
const MCP_METHODS_LOG: &str = "mcp-web-search-methods.jsonl";
const MCP_PID_FILE: &str = "mcp-web-search.pid";

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
    /// The script body is wrapped in an async IIFE; its resolved value is left
    /// in the page and collected with `eval_with_callback` (`WebviewWindow::eval`
    /// itself is fire-and-forget). A thrown error is reported as a scenario
    /// failure rather than a hang.
    fn eval(&self, js: &str) -> Result<Value, Failure> {
        // The WebView stalls for seconds at a time while it highlights a large
        // file or rescans the project tree, and a stall is not a failure.
        self.eval_with_timeout(js, Duration::from_secs(60))
    }

    fn eval_with_timeout(&self, js: &str, timeout: Duration) -> Result<Value, Failure> {
        let id = EVAL_SEQ.fetch_add(1, Ordering::SeqCst);

        // The result is left in the page and read back with
        // `eval_with_callback`, never sent over the Tauri event bus. This is
        // the fix proved in 2bd94407a (on `claude/token-usage-integration`),
        // taken as it is rather than worked around: the bus drops events here.
        // `Listeners::emit_filter` only `try_lock`s its handler table, parks
        // the emit in a pending queue when another thread holds it, and
        // flushes that queue only on a later emit that reaches a handler, so
        // while the app is busy (a run with subagents, a readiness probe) a
        // result the page had already emitted was never delivered and read as
        // a page that had stopped answering.
        //
        // The body is compiled inside the `try`, from a string, rather than
        // pasted into this script: a body that does not parse used to make the
        // whole script fail to parse, so nothing ran and nothing replied.
        let body = serde_json::to_string(js).unwrap_or_else(|_| "\"\"".into());
        let script = format!(
            r#"(async () => {{
  const results = (window.__smokeResults = window.__smokeResults || {{}});
  let out;
  try {{
    const AsyncFunction = Object.getPrototypeOf(async function () {{}}).constructor;
    const v = await new AsyncFunction({body})();
    out = {{ ok: v === undefined ? null : v }};
  }} catch (e) {{
    out = {{ err: (e && e.stack) ? String(e.stack) : String(e) }};
  }}
  results[{id}] = JSON.stringify(out);
}})();"#
        );

        note_step(&format!("dispatching: {}", js.trim()));
        if let Err(e) = self.window.eval(&script) {
            bail!("eval dispatch failed: {e}");
        }

        note_step(&format!("awaiting the page: {}", js.trim()));
        let collect = format!(
            "(() => {{ const r = window.__smokeResults || {{}}; const v = r[{id}];
                 if (v === undefined) return null; delete r[{id}]; return v; }})()"
        );
        let deadline = Instant::now() + timeout;
        let timed_out = |why: &str| -> Failure {
            // Which side is stuck: a main thread that no longer runs posted
            // work cannot deliver the eval, while a renderer that stopped
            // running scripts leaves it answering.
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
            Failure(format!(
                "eval {id} timed out after {timeout:?} ({why}); {main}; app children at the time: {}; window: {}; script was:\n{js}",
                app_children(),
                window_state(&self.window)
            ))
        };
        let raw = loop {
            let (tx, rx) = mpsc::channel::<String>();
            if let Err(e) = self.window.eval_with_callback(&collect, move |v| {
                let _ = tx.send(v);
            }) {
                bail!("eval {id} could not be collected: {e}");
            }
            let left = deadline.saturating_duration_since(Instant::now());
            // `eval_with_callback` hands back the expression's value as JSON:
            // `null` while the script is still running, else the result string.
            match rx.recv_timeout(left.max(Duration::from_millis(1))) {
                Ok(v) if v != "null" && !v.is_empty() => break v,
                Ok(_) => {}
                Err(_) => return Err(timed_out("the collector never answered")),
            }
            if Instant::now() >= deadline {
                return Err(timed_out("the script had not finished"));
            }
            std::thread::sleep(Duration::from_millis(40));
        };

        // The callback value is a JSON string holding the JSON result.
        let outer: Value = serde_json::from_str(&raw)
            .map_err(|e| Failure(format!("eval result was not JSON ({e}): {raw}")))?;
        let inner = match outer.as_str() {
            Some(s) => serde_json::from_str::<Value>(s)
                .map_err(|e| Failure(format!("inner result was not JSON ({e}): {s}")))?,
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
               /select a model|smoke-alt/i.test((x.getAttribute('aria-label') || '')
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
        // The Changes button carries its summary in its name ("Changes — 1
        // file changed · +2 −1"), and a route that was only just opened may
        // not have drawn the rail yet, so wait for it rather than look once.
        let script = format!(
            r#"const el = [...document.querySelectorAll('button')].find(b =>
                 {{ const name = (b.getAttribute('aria-label') || b.textContent || '').trim();
                    return name === {rail:?} || name.startsWith({rail:?} + ' — '); }});
               if (!el) return false; el.click(); return true;"#
        );
        let deadline = Instant::now() + Duration::from_secs(15);
        let clicked = loop {
            if self.eval_bool(&script)? {
                break true;
            }
            if Instant::now() >= deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(250));
        };
        if !clicked {
            let _ = self.describe("rail");
        }
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
    // A port already in use means another fixture server is listening there,
    // often one left behind by a run the app ended itself. Python's server can
    // still bind beside it on Windows, and the app's requests then reach
    // either one, so a run would quietly assert against another run's log.
    // Refuse instead.
    if std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(300),
    )
    .is_ok()
    {
        return Err(format!(
            "port {port} is already in use; a leftover fixture server may be listening there"
        ));
    }
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
                    data_folder.join("mcp-web-search-calls.jsonl").to_string_lossy(),
                    "--methods",
                    data_folder.join(MCP_METHODS_LOG).to_string_lossy(),
                    "--pid",
                    data_folder.join(MCP_PID_FILE).to_string_lossy()
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
        name: "mcp-server-log-is-viewable-in-the-app",
        run: scenario_mcp_server_log,
    },
    Scenario {
        name: "compaction-policy-set-in-settings",
        run: scenario_compaction_policy_set,
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
        name: "atelier-explore",
        run: scenario_atelier_explore,
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
    // Real mouse input against the native Windows title bar. Opt-in
    // (`COWORK_SMOKE_REAL_INPUT=1`): it moves the desktop's actual pointer.
    Scenario {
        name: "window-chrome",
        run: scenario_window_chrome,
    },
    Scenario {
        name: "background-job-isolation",
        run: scenario_background_job_isolation,
    },
    Scenario {
        name: "execution-record",
        run: scenario_execution_record,
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
        name: "agent-roles",
        run: scenario_agent_roles,
    },
    Scenario {
        name: "agent-role-cancel",
        run: scenario_role_cancel,
    },
    Scenario {
        name: "execution-timeline",
        run: scenario_execution_timeline,
    },
    Scenario {
        name: "timeline-diff-by-invocation",
        run: scenario_timeline_diff_by_invocation,
    },
    Scenario {
        name: "timeline-shows-what-a-command-used",
        run: scenario_timeline_resources,
    },
    Scenario {
        name: "cowork-run-killed-mid-turn",
        run: scenario_cowork_killed_mid_turn,
    },
    Scenario {
        name: "network-ca-bundle-in-the-desktop",
        run: scenario_network_ca_bundle,
    },
    Scenario {
        name: "team-member-restarted-in-place",
        run: scenario_team_member_restarted,
    },
    Scenario {
        name: "context-diff",
        run: scenario_context_diff,
    },
    // A pair (AH-005/AH-177).
    Scenario {
        name: "event-export-1",
        run: scenario_event_export_first,
    },
    Scenario {
        name: "event-export-2",
        run: scenario_event_export_second,
    },
    // A pair (AH-169, and the AH-154/155/156 review UI).
    Scenario {
        name: "bundle-import-1",
        run: scenario_bundle_import_first,
    },
    Scenario {
        name: "bundle-import-2",
        run: scenario_bundle_import_second,
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
        name: "stop-cancels-only-the-selected-session",
        run: scenario_stop_is_per_session,
    },
    Scenario {
        name: "custom-headers-reach-the-provider-and-secrets-stay-secret",
        run: scenario_custom_headers,
    },
    Scenario {
        name: "deleting-a-running-session-stops-only-its-run",
        run: scenario_delete_running_session,
    },
    Scenario {
        name: "project-tooling-is-detected-and-told-to-the-model",
        run: scenario_project_tooling,
    },
    Scenario {
        name: "steering-reaches-the-running-session-at-its-next-boundary",
        run: scenario_steering,
    },
    Scenario {
        name: "session-messaging-overlap-request-reaches-running-peer",
        run: scenario_session_messaging,
    },
    Scenario {
        name: "stop-session-stops-a-same-project-peer-after-approval",
        run: scenario_stop_session,
    },
    Scenario {
        name: "stopping-a-run-withdraws-its-approval-prompt",
        run: scenario_stop_withdraws_approval,
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
    Scenario {
        name: "beginner-model-picker-rows-are-keyboard-selectable",
        run: scenario_picker_rows_keyboard,
    },
    Scenario {
        name: "beginner-always-allow-then-revoke-asks-again",
        run: scenario_always_allow_then_revoke,
    },
    Scenario {
        name: "beginner-mcp-trust-follows-server-identity",
        run: scenario_mcp_trust_identity,
    },
    Scenario {
        name: "beginner-guide-card-persists-and-explains-terms",
        run: scenario_guide_card,
    },
    Scenario {
        name: "beginner-collection-memory-reaches-its-chats-only",
        run: scenario_collection_memory,
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
        name: "branchcraft-desktop",
        run: scenario_branchcraft_desktop,
    },
    Scenario {
        name: "branchcraft-desktop-restart",
        run: scenario_branchcraft_desktop_restart,
    },
    Scenario {
        name: "lane-key-and-peers-are-contained",
        run: lane_contained,
    },
];

/// Scenarios for a second process started on a kept profile
/// (`COWORK_SMOKE_KEEP`): what a real restart has to bring back.
const RESTART_SCENARIOS: &[Scenario] = &[
    Scenario {
        name: "compaction-policy-survives-a-restart",
        run: scenario_compaction_policy_after_restart,
    },
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
        name: "bundle-import-2",
        run: scenario_bundle_import_second,
    },
    Scenario {
        name: "event-export-2",
        run: scenario_event_export_second,
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
    Scenario {
        name: "window-chrome-restart",
        run: scenario_window_chrome_restart,
    },
    Scenario {
        name: "execution-record-restart",
        run: scenario_execution_record_restart,
    },
    Scenario {
        name: "custom-headers-survive-a-restart",
        run: scenario_custom_headers_after_restart,
    },
    Scenario {
        name: "session-models-survive-a-restart",
        run: scenario_session_models_after_restart,
    },
    Scenario {
        name: "agent-role-cancel-restart",
        run: scenario_role_cancel_restart,
    },
    Scenario {
        name: "execution-timeline-restart",
        run: scenario_execution_timeline_restart,
    },
    Scenario {
        name: "timeline-replay-after-a-restart",
        run: scenario_timeline_replay_after_restart,
    },
    Scenario {
        name: "cowork-interrupted-turn-continues-after-restart",
        run: scenario_cowork_interrupted_turn_continues,
    },
    Scenario {
        name: "team-member-restart-survives-a-restart",
        run: scenario_team_member_restart_after_restart,
    },
    Scenario {
        name: "context-diff-restart",
        run: scenario_context_diff_restart,
    },
];
