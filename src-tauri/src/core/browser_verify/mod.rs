//! "Verify in browser": drive a separate, throwaway Chromium-based browser
//! (Chrome, Edge, Brave, Opera, Vivaldi, Arc or Chromium) against a local app
//! the user is previewing, and bring back evidence.
//!
//! What this is not: Flint's own webview. The browser is a separate process
//! with a fresh temporary profile (no cookies, storage or extensions from
//! anywhere), deleted when the run ends. Flint's preview webview and its
//! profile are never touched, so nothing the app under test does can reach
//! Flint's privileged context.
//!
//! Confinement. Only the local origin being verified (and any other loopback
//! origin the caller explicitly lists) may be loaded:
//! - every request -- navigations, redirects, subresources, frames, workers
//!   (auto-attached) -- is paused through the DevTools `Fetch` domain and
//!   failed unless its origin is allowed; a blocked main-frame navigation
//!   (including a redirect off the origin) stops the run;
//! - underneath that, every connection -- including WebSockets, popups and
//!   service workers, which the interception does not see -- goes to a dead
//!   proxy, except to the exact `host:port` of an allowed origin. Chromium
//!   normally sends loopback traffic around a proxy; that implicit bypass is
//!   removed (`<-loopback>`), so another port on this machine is refused too.
//!
//! No browser is ever downloaded: an installed Chromium-based browser is used
//! (the default install locations, `FLINT_BROWSER_PATH`/`CHROME_PATH`, or a
//! user-chosen executable), or the caller gets a setup message saying none
//! was found.

pub mod runner;

// The launch, confinement and DevTools pieces are shared with the agent's
// interactive `browser` tool, so they live in the agent-tools crate.
pub use tauri_plugin_agent_tools::browser::confine::*;
pub use tauri_plugin_agent_tools::browser::{cdp, events, launch};

#[cfg(not(feature = "cli"))]
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};

/// Steps one run may carry.
pub const MAX_STEPS: usize = 30;
/// Default and ceiling for a whole run.
pub const DEFAULT_TIMEOUT_MS: u64 = 90_000;
pub const MAX_TIMEOUT_MS: u64 = 300_000;
/// One step, unless the run's own deadline is sooner.
pub const STEP_TIMEOUT_MS: u64 = 15_000;
/// A `wait` step is capped at this.
pub const MAX_WAIT_MS: u64 = 10_000;

/// One thing the browser is asked to do, in order.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum Step {
    /// Load a URL: absolute, or relative to the run's URL. Must be allowed.
    Navigate { url: String },
    /// Click the element whose visible text (or label) matches `target`, or
    /// the first match of a CSS selector written `css:<selector>`.
    Click { target: String },
    /// Type `text` into the field matching `target` (placeholder, label, name,
    /// or `css:<selector>`).
    Type { target: String, text: String },
    /// The page's visible text must contain `text`.
    Expect { text: String },
    /// Wait, capped at `MAX_WAIT_MS`.
    Wait { ms: u64 },
    /// Capture the page now (the final state is always captured too).
    Screenshot,
}

impl Step {
    /// The line shown to the user for this step.
    pub fn label(&self) -> String {
        match self {
            Step::Navigate { url } => format!("Open {url}"),
            Step::Click { target } => format!("Click \"{target}\""),
            Step::Type { target, text } => {
                format!("Type {} characters into \"{target}\"", text.chars().count())
            }
            Step::Expect { text } => format!("Expect the page to show \"{text}\""),
            Step::Wait { ms } => format!("Wait {} ms", (*ms).min(MAX_WAIT_MS)),
            Step::Screenshot => "Take a screenshot".to_string(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct VerifyRequest {
    /// Chosen by the caller, so it can cancel before the run answers.
    pub id: String,
    /// The local app's URL. Its origin is the one the run is confined to.
    pub url: String,
    #[serde(default)]
    pub steps: Vec<Step>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// Console errors fail the run (default true).
    #[serde(default)]
    pub fail_on_console_error: Option<bool>,
    /// Other loopback origins the user permitted (an API on another port).
    #[serde(default)]
    pub extra_origins: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Pending,
    Running,
    Passed,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct StepRecord {
    pub index: usize,
    pub label: String,
    pub status: StepStatus,
    pub detail: Option<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Passed,
    Failed,
    Cancelled,
    /// The run could not start: no browser, not a local URL, app not running.
    Error,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ConsoleEntry {
    /// `error`, `exception` or `log` (a browser log entry at error level).
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BlockedRequest {
    pub url: String,
    pub resource_type: String,
    /// A main-frame navigation: these stop the run.
    pub navigation: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Screenshot {
    /// The step it was taken after; `None` for the final capture.
    pub step: Option<usize>,
    pub png_base64: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct VerifyReport {
    pub id: String,
    pub url: String,
    /// The origin the run was confined to.
    pub origin: String,
    pub outcome: Outcome,
    /// Why, in one sentence.
    pub reason: String,
    pub steps: Vec<StepRecord>,
    pub screenshots: Vec<Screenshot>,
    pub console_errors: Vec<ConsoleEntry>,
    pub blocked_requests: Vec<BlockedRequest>,
    /// HTTP status of the last main-frame document.
    pub document_status: Option<u16>,
    pub final_url: Option<String>,
    /// Which installed browser ran it.
    pub browser: Option<String>,
    pub started_at: String,
    pub duration_ms: u64,
    /// The temporary profile was deleted afterwards.
    pub profile_removed: bool,
}

// --- the browser -------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BrowserInfo {
    pub found: bool,
    pub path: Option<String>,
    pub name: Option<String>,
    /// What to do when none was found.
    pub hint: Option<String>,
}

use tauri_plugin_agent_tools::browser_discovery;

/// Choose a browser for this process. The choice lives in
/// `browser_discovery`, which the agent `screenshot` tool also resolves
/// through, so both use the executable named here. Refused when the file is
/// not there or is clearly not Chromium-based (Firefox and the like).
fn set_chosen_browser(path: &str) -> Result<BrowserInfo, String> {
    let chosen = browser_discovery::set_chosen_browser(path)?;
    Ok(find_browser_with_override(chosen.to_str()))
}

/// Resolve the browser for every Flint browser consumer. A user-selected
/// executable wins over environment variables and default install locations.
pub fn find_browser() -> BrowserInfo {
    let chosen = browser_discovery::chosen_browser();
    find_browser_with_override(chosen.as_deref())
}

/// Resolve a browser with a one-call override. Used by tests and by the shared
/// resolver after reading the process-local selected browser.
pub fn find_browser_with_override(override_path: Option<&str>) -> BrowserInfo {
    match browser_discovery::find_browser_path_with_override(override_path) {
        Some(path) => BrowserInfo {
            found: true,
            name: Some(browser_discovery::browser_name(&path)),
            path: Some(path.to_string_lossy().into_owned()),
            hint: None,
        },
        None => BrowserInfo {
            found: false,
            path: None,
            name: None,
            hint: Some(
                "No Chrome, Edge, Brave, Opera, Vivaldi, Arc or Chromium was found. Install one \
                 (any Chromium-based browser works), choose its executable, or set \
                 FLINT_BROWSER_PATH. Flint does not download a browser."
                    .to_string(),
            ),
        },
    }
}

// --- commands ----------------------------------------------------------------

#[cfg(not(feature = "cli"))]
pub mod commands {
    use super::*;
    use std::collections::HashMap;
    use tauri::Emitter;
    use tokio::sync::watch;

    pub const EVENT_PROGRESS: &str = "browser-verify://progress";

    static RUNS: LazyLock<Mutex<HashMap<String, watch::Sender<bool>>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    /// Which browser every browser consumer in this process would use.
    #[tauri::command]
    pub async fn browser_verify_detect() -> BrowserInfo {
        tokio::task::spawn_blocking(find_browser)
            .await
            .unwrap_or(BrowserInfo { found: false, path: None, name: None, hint: None })
    }

    /// Name a browser executable to use for this Flint process. The shared
    /// resolver means browser verification and the screenshot tool both pick
    /// this exact executable after the user chooses it.
    #[tauri::command]
    pub async fn browser_verify_set_browser(path: String) -> Result<BrowserInfo, String> {
        tokio::task::spawn_blocking(move || set_chosen_browser(&path))
            .await
            .map_err(|e| format!("could not check the browser: {e}"))?
    }

    /// Run one verification to its end (or cancellation) and return the
    /// evidence. Steps are also emitted as they change.
    #[tauri::command]
    pub async fn browser_verify_run(
        app: tauri::AppHandle,
        request: VerifyRequest,
    ) -> VerifyReport {
        let (tx, rx) = watch::channel(false);
        let id = request.id.clone();
        if let Ok(mut runs) = RUNS.lock() {
            if let Some(old) = runs.insert(id.clone(), tx) {
                let _ = old.send(true);
            }
        }
        let emit_id = id.clone();
        let report = runner::run(
            request,
            find_browser(),
            rx,
            move |step| {
                let _ = app.emit(EVENT_PROGRESS, Progress { id: &emit_id, step });
            },
        )
        .await;
        if let Ok(mut runs) = RUNS.lock() {
            runs.remove(&id);
        }
        report
    }

    #[derive(Clone, Serialize)]
    struct Progress<'a> {
        id: &'a str,
        step: &'a StepRecord,
    }

    /// Stop a run: the browser is closed and its profile deleted.
    #[tauri::command]
    pub fn browser_verify_cancel(id: String) -> bool {
        RUNS.lock()
            .ok()
            .and_then(|runs| runs.get(&id).map(|tx| tx.send(true).is_ok()))
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_user_chosen_browser_wins_over_the_default_locations() {
        let tmp = tempfile::Builder::new().prefix("flint-browser-test-").tempdir().unwrap();
        let exe = tmp.path().join("my-browser");
        std::fs::write(&exe, b"x").unwrap();
        let info = find_browser_with_override(Some(exe.to_str().unwrap()));
        assert!(info.found);
        assert_eq!(info.path.as_deref(), Some(exe.to_str().unwrap()));
        assert_eq!(info.name.as_deref(), Some("Google Chrome"), "an unrecognised name falls back to Chrome");
    }

    #[test]
    fn a_non_chromium_browser_is_not_accepted_as_the_chosen_one() {
        let tmp = tempfile::Builder::new().prefix("flint-firefox-test-").tempdir().unwrap();
        let exe = tmp.path().join("firefox.exe");
        std::fs::write(&exe, b"x").unwrap();
        let err = set_chosen_browser(exe.to_str().unwrap()).unwrap_err();
        assert!(err.contains("not a Chromium-based browser"), "{err}");
    }

    #[test]
    fn a_missing_or_relative_override_is_ignored() {
        let info = find_browser_with_override(Some("relative/path"));
        if info.found {
            assert_ne!(info.path.as_deref(), Some("relative/path"));
        }
        let info = find_browser_with_override(Some("/nonexistent/browser-xyz"));
        if info.found {
            assert_ne!(info.path.as_deref(), Some("/nonexistent/browser-xyz"));
        }
    }

    #[test]
    fn selected_browser_is_shared_by_the_default_resolver() {
        let before = browser_discovery::chosen_browser();
        let tmp = tempfile::Builder::new().prefix("flint-shared-browser-").tempdir().unwrap();
        let exe = tmp.path().join("brave-browser");
        std::fs::write(&exe, b"x").unwrap();
        set_chosen_browser(exe.to_str().unwrap()).unwrap();
        let info = find_browser();
        assert_eq!(info.path.as_deref(), Some(exe.to_str().unwrap()));
        assert_eq!(info.name.as_deref(), Some("Brave"));
        browser_discovery::restore_chosen_browser(before);
    }

    #[test]
    fn steps_read_from_json_and_label_themselves() {
        let steps: Vec<Step> = serde_json::from_str(
            r#"[{"kind":"navigate","url":"/"},{"kind":"click","target":"Sign in"},
                {"kind":"type","target":"Email","text":"a@b.c"},{"kind":"expect","text":"Welcome"},
                {"kind":"wait","ms":999999},{"kind":"screenshot"}]"#,
        )
        .unwrap();
        assert_eq!(steps.len(), 6);
        assert_eq!(steps[2].label(), "Type 5 characters into \"Email\"");
        assert_eq!(steps[4].label(), "Wait 10000 ms");
    }
}
