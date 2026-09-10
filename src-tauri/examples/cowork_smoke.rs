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
use std::sync::atomic::{AtomicI32, AtomicU64, Ordering};
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
const SMOKE_ENDPOINT_PORT: u16 = 8080;
/// A documentation-range address standing in for the public answer a search
/// domain collision produces. Reaching it would hang; the point is that it is
/// never dialled.
const SMOKE_PUBLIC_DECOY: &str = "203.0.113.9";
const SMOKE_MODEL: &str = "smoke-model";
/// `AppHandle::exit` unwinds the event loop but does not set this process's
/// status, so the verdict is stashed here and applied once `run_app` returns.
static VERDICT: AtomicI32 = AtomicI32::new(2);

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
        let script = format!(
            r#"(async () => {{
  let out;
  try {{
    const v = await (async () => {{ {js} }})();
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

        if let Err(e) = self.window.eval(&script) {
            self.window.unlisten(handler_id);
            bail!("eval dispatch failed: {e}");
        }

        let received = rx.recv_timeout(timeout);
        self.window.unlisten(handler_id);

        let raw = match received {
            Ok(raw) => raw,
            Err(_) => bail!("eval timed out after {timeout:?}; script was:\n{js}"),
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
    Scenario {
        name: "tool-activity-timeline",
        run: scenario_tool_activity,
    },
    Scenario {
        name: "memory-proposal-approval",
        run: scenario_memory_proposal,
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
    let recorded = std::env::var("JAN_DATA_FOLDER")
        .map(|d| Path::new(&d).join("audit/prompts.jsonl"))
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default();
    let records = recorded.lines().filter(|l| !l.trim().is_empty()).count();
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
            &format!("{SMOKE_ENDPOINT_HOST}:{SMOKE_ENDPOINT_PORT}"),
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
        port = SMOKE_ENDPOINT_PORT,
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
        port = SMOKE_ENDPOINT_PORT,
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
        port = SMOKE_ENDPOINT_PORT,
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
        port = SMOKE_ENDPOINT_PORT,
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
    let args: Vec<String> = std::env::args().collect();
    let fixtures = fixtures_dir(&args);

    // Per-run scratch tree. `CI=e2e` makes the app resolve its data folder
    // relative to the CWD, so chdir'ing here keeps the run out of the real
    // Jan data folder.
    let workspace = std::env::temp_dir().join(format!("cowork-smoke-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&workspace);
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
    let (mut mock, mock_port) = match start_mock_provider(&fixtures, SMOKE_ENDPOINT_PORT) {
        Ok(pair) => pair,
        Err(e) => {
            eprintln!("FATAL: {e}");
            std::process::exit(2);
        }
    };
    println!("mock provider on port {mock_port}");

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
    app_lib::core::net::transport::set_probe(std::sync::Arc::new(SmokeDns));

    let data_folder = workspace.join("data");
    if let Err(e) = seed_settings(
        &data_folder,
        &format!("http://{SMOKE_ENDPOINT_HOST}:{SMOKE_ENDPOINT_PORT}/v1"),
    ) {
        eprintln!("FATAL: could not seed the smoke data folder: {e}");
        let _ = mock.kill();
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
    std::env::set_current_dir(&workspace).expect("failed to enter smoke workspace");

    let app = app_lib::build_app();
    let handle: AppHandle = app.handle().clone();

    let driver_workspace = workspace.clone();
    std::thread::spawn(move || {
        let code = drive(&handle, fixtures, driver_workspace.clone(), mock_port);
        let _ = std::fs::remove_dir_all(&driver_workspace);
        // Never leave the fixture server behind.
        let _ = mock.kill();
        let _ = mock.wait();
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
    let project = match materialize_project(&workspace, template.as_deref()) {
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

    if let Err(Failure(e)) = ctx.reset_persisted_state() {
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
    let scenarios: Vec<&Scenario> = SCENARIOS
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
            if !scenarios.iter().any(|s| &s.name == name) {
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
                    let last = attempt >= 3 || scenario.name == SELF_TEST_FAIL.name;
                    if last {
                        break Err(Failure(match first_err {
                            Some(ref f) if f != &e => {
                                format!("{e}\n(first attempt failed with: {f})")
                            }
                            _ => e,
                        }));
                    }
                    // Let the WebView finish whatever wedged it.
                    ctx.settle();
                }
            }
        };
        match outcome {
            Ok(false) => println!("PASS {}", scenario.name),
            Ok(true) => println!("PASS {} (on retry)", scenario.name),
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
