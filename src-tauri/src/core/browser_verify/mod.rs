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

pub mod cdp;
pub mod runner;

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use url::{Host, Url};

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

// --- origins -----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origin {
    pub scheme: String,
    pub host: String,
    pub port: u16,
}

impl Origin {
    pub fn of(url: &Url) -> Option<Origin> {
        if !matches!(url.scheme(), "http" | "https") {
            return None;
        }
        Some(Origin {
            scheme: url.scheme().to_string(),
            host: url.host_str()?.to_ascii_lowercase(),
            port: url.port_or_known_default()?,
        })
    }

    pub fn serialize(&self) -> String {
        format!("{}://{}:{}", self.scheme, self.host, self.port)
    }

    /// `host:port` to open a TCP connection to (IPv6 unbracketed).
    pub fn socket_host(&self) -> String {
        self.host.trim_start_matches('[').trim_end_matches(']').to_string()
    }
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// The run's URL and origin, if it is an http(s) URL on this machine.
pub fn local_origin(raw: &str) -> Result<(Url, Origin), String> {
    let url = Url::parse(raw.trim()).map_err(|e| format!("not a URL: {e}"))?;
    let origin = Origin::of(&url).ok_or("only http and https pages can be verified")?;
    if !is_loopback(&url) {
        return Err(format!(
            "{} is not a local address; only an app running on this machine (localhost, 127.0.0.1, [::1]) can be verified",
            origin.serialize()
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("a URL with credentials in it is not verified".to_string());
    }
    Ok((url, origin))
}

/// What the browser may load.
#[derive(Debug, Clone)]
pub struct OriginPolicy {
    allowed: Vec<Origin>,
}

impl OriginPolicy {
    /// `primary` plus the extra origins, each of which must itself be local.
    pub fn new(primary: Origin, extra: &[String]) -> Result<Self, String> {
        let mut allowed = vec![primary];
        for raw in extra {
            let (_, o) = local_origin(raw)?;
            if !allowed.contains(&o) {
                allowed.push(o);
            }
        }
        Ok(OriginPolicy { allowed })
    }

    pub fn allowed(&self) -> &[Origin] {
        &self.allowed
    }

    /// Whether a request for `raw` may go ahead. Same origin means same
    /// scheme, host and port: `localhost` and `127.0.0.1` are different
    /// origins, as they are to the browser.
    pub fn permits(&self, raw: &str) -> bool {
        let Ok(url) = Url::parse(raw) else { return false };
        match url.scheme() {
            "http" | "https" => Origin::of(&url).is_some_and(|o| self.allowed.contains(&o)),
            "data" => true,
            "about" => url.path() == "blank" || url.path() == "srcdoc",
            "blob" => Url::parse(url.path()).ok().and_then(|u| Origin::of(&u))
                .is_some_and(|o| self.allowed.contains(&o)),
            "ws" | "wss" => {
                let scheme = if url.scheme() == "ws" { "http" } else { "https" };
                url.host_str().is_some_and(|h| {
                    self.allowed.contains(&Origin {
                        scheme: scheme.to_string(),
                        host: h.to_ascii_lowercase(),
                        port: url.port().unwrap_or(if scheme == "http" { 80 } else { 443 }),
                    })
                })
            }
            _ => false,
        }
    }
}

/// A URL as shown in evidence: no query or fragment (they can carry tokens),
/// and bounded.
pub fn display_url(raw: &str) -> String {
    let shown = match Url::parse(raw) {
        Ok(mut u) if u.scheme() != "data" => {
            u.set_query(None);
            u.set_fragment(None);
            let _ = u.set_password(None);
            let _ = u.set_username("");
            u.to_string()
        }
        Ok(_) => "data:…".to_string(),
        Err(_) => raw.to_string(),
    };
    shown.chars().take(200).collect()
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

/// Process-local browser selected by the user. This lives in the shared
/// discovery layer so Verify in Browser and agent screenshot use the same
/// executable for the rest of the Flint process.
static CHOSEN_BROWSER: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

fn browser_name(path: &Path) -> String {
    let p = path.to_string_lossy().to_ascii_lowercase();
    if p.contains("msedge") || p.contains("microsoft edge") || p.contains("edge") {
        "Microsoft Edge".into()
    } else if p.contains("brave") {
        "Brave".into()
    } else if p.contains("opera") {
        "Opera".into()
    } else if p.contains("vivaldi") {
        "Vivaldi".into()
    } else if p.contains("arc") {
        "Arc".into()
    } else if p.contains("chromium") {
        "Chromium".into()
    } else {
        "Google Chrome".into()
    }
}

fn windows_candidates(
    program_files: Option<&Path>,
    program_files_x86: Option<&Path>,
    local_app_data: Option<&Path>,
) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for root in [program_files, program_files_x86].into_iter().flatten().filter(|p| p.is_absolute()) {
        out.push(root.join("Google").join("Chrome").join("Application").join("chrome.exe"));
        out.push(root.join("Microsoft").join("Edge").join("Application").join("msedge.exe"));
        out.push(root.join("BraveSoftware").join("Brave-Browser").join("Application").join("brave.exe"));
        out.push(root.join("Vivaldi").join("Application").join("vivaldi.exe"));
        out.push(root.join("Opera").join("launcher.exe"));
        out.push(root.join("Arc").join("Arc.exe"));
    }
    if let Some(root) = local_app_data.filter(|p| p.is_absolute()) {
        out.push(root.join("Google").join("Chrome").join("Application").join("chrome.exe"));
        out.push(root.join("Microsoft").join("Edge").join("Application").join("msedge.exe"));
        out.push(root.join("BraveSoftware").join("Brave-Browser").join("Application").join("brave.exe"));
        out.push(root.join("Vivaldi").join("Application").join("vivaldi.exe"));
        out.push(root.join("Programs").join("Opera").join("launcher.exe"));
        out.push(root.join("Programs").join("Opera GX").join("launcher.exe"));
        out.push(root.join("Programs").join("Arc").join("Arc.exe"));
        // Arc's MSIX/App Installer builds expose an app-execution alias here.
        out.push(root.join("Microsoft").join("WindowsApps").join("Arc.exe"));
    }
    out
}

/// Default install locations. On Windows only absolute roots from the
/// environment are used, so a planted executable in the working directory is
/// never launched; PATH is not searched anywhere.
fn candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Opera.app/Contents/MacOS/Opera",
        "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
        "/Applications/Arc.app/Contents/MacOS/Arc",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/opt/google/chrome/chrome",
        "/usr/bin/microsoft-edge",
        "/usr/bin/microsoft-edge-stable",
        "/opt/microsoft/msedge/msedge",
        "/usr/bin/brave-browser",
        "/usr/bin/brave-browser-stable",
        "/usr/bin/opera",
        "/usr/bin/opera-stable",
        "/usr/bin/vivaldi",
        "/usr/bin/arc",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ]
    .iter()
    .map(PathBuf::from)
    .collect();
    let var = |name: &str| std::env::var_os(name).map(PathBuf::from).filter(|p| p.is_absolute());
    out.extend(windows_candidates(
        var("ProgramFiles").as_deref(),
        var("ProgramFiles(x86)").as_deref(),
        var("LOCALAPPDATA").as_deref(),
    ));
    out
}

fn chosen_browser() -> Option<String> {
    CHOSEN_BROWSER.lock().ok().and_then(|g| g.clone())
}

fn set_chosen_browser(path: &str) -> Result<BrowserInfo, String> {
    let path = path.trim();
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err("the browser path must be absolute".to_string());
    }
    if !p.is_file() {
        return Err(format!("no file at {path}"));
    }
    if let Ok(mut chosen) = CHOSEN_BROWSER.lock() {
        *chosen = Some(path.to_string());
    }
    Ok(find_browser_with_override(Some(path)))
}

/// Resolve the browser for every Flint browser consumer. A user-selected
/// executable wins over environment variables and default install locations.
pub fn find_browser() -> BrowserInfo {
    let chosen = chosen_browser();
    find_browser_with_override(chosen.as_deref())
}

/// Resolve a browser with a one-call override. Used by tests and by the shared
/// resolver after reading the process-local selected browser.
pub fn find_browser_with_override(override_path: Option<&str>) -> BrowserInfo {
    let explicit = override_path
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && p.is_file())
        .or_else(|| {
            ["FLINT_BROWSER_PATH", "CHROME_PATH"]
                .iter()
                .filter_map(std::env::var_os)
                .map(PathBuf::from)
                .find(|p| p.is_absolute() && p.is_file())
        });
    match explicit.or_else(|| candidates().into_iter().find(|p| p.is_file())) {
        Some(path) => BrowserInfo {
            found: true,
            name: Some(browser_name(&path)),
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

/// Whether this process runs as root, where Chrome refuses to start with its
/// sandbox (a container, typically).
fn running_as_root() -> bool {
    #[cfg(unix)]
    {
        // SAFETY: geteuid has no preconditions and cannot fail.
        unsafe { libc::geteuid() == 0 }
    }
    #[cfg(not(unix))]
    {
        false
    }
}

/// The proxy bypass list: no implicit loopback bypass, then exactly the
/// allowed origins' `host:port` (any scheme, so the app's own `ws://` works).
pub fn proxy_bypass_list(allowed: &[Origin]) -> String {
    let mut rules = vec!["<-loopback>".to_string()];
    rules.extend(allowed.iter().map(|o| format!("{}:{}", o.host, o.port)));
    rules.join(";")
}

/// Arguments for a throwaway, confined, headless browser that may connect
/// only to `allowed`.
pub fn browser_args(profile: &Path, as_root: bool, allowed: &[Origin]) -> Vec<String> {
    let mut args: Vec<String> = [
        "--headless=new",
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-sync",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-domain-reliability",
        "--disable-client-side-phishing-detection",
        "--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication",
        "--metrics-recording-only",
        "--no-pings",
        "--password-store=basic",
        "--use-mock-keychain",
        "--mute-audio",
        "--window-size=1280,800",
        "--proxy-server=http://127.0.0.1:9",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    args.push(format!("--proxy-bypass-list={}", proxy_bypass_list(allowed)));
    args.push(format!("--user-data-dir={}", profile.display()));
    if as_root {
        args.push("--no-sandbox".to_string());
    }
    args.push("about:blank".to_string());
    args
}

/// Loopback addresses, for tests and the app-server watchdog.
pub fn loopback_ip(host: &str) -> Option<IpAddr> {
    match host {
        "localhost" => Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        "::1" | "[::1]" => Some(IpAddr::V6(Ipv6Addr::LOCALHOST)),
        other => other.parse().ok().filter(|ip: &IpAddr| ip.is_loopback()),
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
    fn only_a_loopback_http_url_is_verified() {
        assert!(local_origin("http://localhost:5173/app").is_ok());
        assert!(local_origin("http://127.0.0.1:3000").is_ok());
        assert!(local_origin("http://[::1]:8080/").is_ok());
        assert!(local_origin("https://example.com").is_err());
        assert!(local_origin("http://192.168.1.10:3000").is_err());
        assert!(local_origin("http://localhost.evil.com:3000").is_err());
        assert!(local_origin("file:///etc/passwd").is_err());
        assert!(local_origin("http://user:pw@localhost:3000").is_err());
    }

    #[test]
    fn the_policy_is_the_exact_origin() {
        let (_, o) = local_origin("http://localhost:5173/").unwrap();
        let p = OriginPolicy::new(o, &[]).unwrap();
        assert!(p.permits("http://localhost:5173/assets/app.js?v=1"));
        assert!(p.permits("ws://localhost:5173/@vite/client"));
        assert!(p.permits("data:image/png;base64,AAAA"));
        assert!(p.permits("about:blank"));
        assert!(p.permits("blob:http://localhost:5173/0f7c"));
        assert!(!p.permits("http://localhost:5174/"));
        assert!(!p.permits("http://127.0.0.1:5173/"));
        assert!(!p.permits("https://localhost:5173/"));
        assert!(!p.permits("https://fonts.googleapis.com/css"));
        assert!(!p.permits("ws://localhost:9229/"));
        assert!(!p.permits("blob:https://evil.example/0f7c"));
        assert!(!p.permits("file:///etc/passwd"));
        assert!(!p.permits("chrome://settings"));
        assert!(!p.permits("not a url"));
    }

    #[test]
    fn extra_origins_must_be_local_and_are_then_allowed() {
        let (_, o) = local_origin("http://localhost:5173/").unwrap();
        let p = OriginPolicy::new(o.clone(), &["http://localhost:8787".into()]).unwrap();
        assert!(p.permits("http://localhost:8787/api"));
        assert!(OriginPolicy::new(o, &["https://api.example.com".into()]).is_err());
    }

    #[test]
    fn a_fresh_profile_and_a_dead_proxy_every_time() {
        let (_, o) = local_origin("http://localhost:5173/").unwrap();
        let (_, v6) = local_origin("http://[::1]:8080/").unwrap();
        let args = browser_args(Path::new("/tmp/flint-verify-x"), false, &[o.clone(), v6]);
        assert!(args.contains(&"--user-data-dir=/tmp/flint-verify-x".to_string()));
        assert!(args.contains(&"--proxy-server=http://127.0.0.1:9".to_string()));
        assert!(args.contains(&"--proxy-bypass-list=<-loopback>;localhost:5173;[::1]:8080".to_string()));
        assert!(args.contains(&"--disable-extensions".to_string()));
        assert!(!args.contains(&"--no-sandbox".to_string()));
        assert!(browser_args(Path::new("/p"), true, &[o]).contains(&"--no-sandbox".to_string()));
    }

    #[test]
    fn evidence_urls_drop_queries_and_credentials() {
        assert_eq!(
            display_url("http://localhost:3000/cb?token=abc#x"),
            "http://localhost:3000/cb"
        );
        assert_eq!(display_url("data:text/html,<script>"), "data:…");
    }

    #[test]
    fn browser_name_recognises_the_alternative_browsers() {
        assert_eq!(browser_name(Path::new("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser")), "Brave");
        assert_eq!(browser_name(Path::new("/usr/bin/brave-browser")), "Brave");
        assert_eq!(browser_name(Path::new(r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe")), "Brave");
        assert_eq!(browser_name(Path::new("/Applications/Opera.app/Contents/MacOS/Opera")), "Opera");
        assert_eq!(browser_name(Path::new(r"C:\Users\u\AppData\Local\Programs\Opera\launcher.exe")), "Opera");
        assert_eq!(browser_name(Path::new("/usr/bin/vivaldi")), "Vivaldi");
        assert_eq!(browser_name(Path::new(r"C:\Users\u\AppData\Local\Vivaldi\Application\vivaldi.exe")), "Vivaldi");
        assert_eq!(browser_name(Path::new("/Applications/Arc.app/Contents/MacOS/Arc")), "Arc");
        assert_eq!(browser_name(Path::new(r"C:\Users\u\AppData\Local\Microsoft\WindowsApps\Arc.exe")), "Arc");
        assert_eq!(browser_name(Path::new("/usr/bin/arc")), "Arc");
        assert_eq!(browser_name(Path::new("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")), "Google Chrome");
        assert_eq!(browser_name(Path::new(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe")), "Microsoft Edge");
        assert_eq!(browser_name(Path::new("/usr/bin/chromium")), "Chromium");
    }

    #[test]
    fn windows_candidates_cover_real_install_layouts() {
        let pf = Path::new(r"C:\Program Files");
        let pf86 = Path::new(r"C:\Program Files (x86)");
        let local = Path::new(r"C:\Users\u\AppData\Local");
        let c = windows_candidates(Some(pf), Some(pf86), Some(local));
        assert!(c.contains(&PathBuf::from(r"C:\Program Files\Vivaldi\Application\vivaldi.exe")));
        assert!(c.contains(&PathBuf::from(r"C:\Users\u\AppData\Local\Vivaldi\Application\vivaldi.exe")));
        assert!(c.contains(&PathBuf::from(r"C:\Users\u\AppData\Local\Programs\Opera\launcher.exe")));
        assert!(c.contains(&PathBuf::from(r"C:\Users\u\AppData\Local\Programs\Opera GX\launcher.exe")));
        assert!(c.contains(&PathBuf::from(r"C:\Users\u\AppData\Local\Microsoft\WindowsApps\Arc.exe")));
        assert!(!c.iter().any(|p| p.to_string_lossy().contains("app-20")));
    }

    #[test]
    fn the_candidate_list_covers_the_alternative_browsers() {
        let c = candidates();
        assert!(c.contains(&PathBuf::from("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser")));
        assert!(c.contains(&PathBuf::from("/Applications/Opera.app/Contents/MacOS/Opera")));
        assert!(c.contains(&PathBuf::from("/Applications/Vivaldi.app/Contents/MacOS/Vivaldi")));
        assert!(c.contains(&PathBuf::from("/Applications/Arc.app/Contents/MacOS/Arc")));
        assert!(c.contains(&PathBuf::from("/usr/bin/brave-browser")));
        assert!(c.contains(&PathBuf::from("/usr/bin/opera")));
        assert!(c.contains(&PathBuf::from("/usr/bin/vivaldi")));
        assert!(c.contains(&PathBuf::from("/usr/bin/arc")));
        assert!(c.contains(&PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")));
        assert!(c.contains(&PathBuf::from("/usr/bin/chromium")));
    }

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
        let before = chosen_browser();
        let tmp = tempfile::Builder::new().prefix("flint-shared-browser-").tempdir().unwrap();
        let exe = tmp.path().join("brave-browser");
        std::fs::write(&exe, b"x").unwrap();
        set_chosen_browser(exe.to_str().unwrap()).unwrap();
        let info = find_browser();
        assert_eq!(info.path.as_deref(), Some(exe.to_str().unwrap()));
        assert_eq!(info.name.as_deref(), Some("Brave"));
        *CHOSEN_BROWSER.lock().unwrap() = before;
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
