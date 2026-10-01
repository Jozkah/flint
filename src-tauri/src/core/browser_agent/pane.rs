//! The commands that drive the built-in browser pane for an agent.
//!
//! Every tool call arrives here from the web side, which has already shown any
//! prompt the user needed to answer. This file does not trust that: it decides
//! again, from the URL the webview reports, before it touches the page.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, EventTarget, Manager, Runtime, Webview};
use url::Url;

use super::fence;
use super::policy::{self, Decision, DenyReason, NetworkPolicy, Verdict};
use super::script;
use super::store::{Scope, DEFAULT_MAX_ACTIONS};
use super::{EVENT_BLOCKED, EVENT_OPEN_PANE, EVENT_STATE, PANE_LABEL, STORE};

const MAX_TEXT_ARG: usize = 2_000;
const MAX_VALUE_ARG: usize = 200;
const EVAL_TIMEOUT: Duration = Duration::from_secs(10);
const OPEN_PANE_TIMEOUT: Duration = Duration::from_secs(8);
const OPEN_LOAD_TIMEOUT: Duration = Duration::from_secs(25);
const ACTION_LOAD_TIMEOUT: Duration = Duration::from_secs(10);

pub const TOOLS: &[&str] = &["open", "read_text", "snapshot", "click", "type", "press", "select"];

#[derive(Debug, Clone, Deserialize)]
pub struct CallRequest {
    /// `open`, `read_text`, `snapshot`, `click`, `type`, `press`, `select`.
    pub tool: String,
    /// The conversation or session, to group action counts and grants.
    #[serde(default)]
    pub run_id: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub clear: Option<bool>,
    #[serde(default)]
    pub max_chars: Option<usize>,
    /// The user confirmed a submit-like action that came back as
    /// `needs_confirmation`.
    #[serde(default)]
    pub confirmed: bool,
    /// The Settings switch for the agent browser.
    #[serde(default)]
    pub enabled: bool,
    /// No user is there to answer a prompt (auto mode, a scheduled run).
    #[serde(default)]
    pub unattended: bool,
    /// Actions this run may take; clamped.
    #[serde(default)]
    pub max_actions: Option<u32>,
    /// The project whose `agent.toml` domain lists apply.
    #[serde(default)]
    pub project_root: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct CallResponse {
    /// `ok`, `needs_permission`, `needs_confirmation`, `denied`, `paused`, `error`.
    pub status: &'static str,
    /// What the model reads. Page-derived text is inside the fence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// The page's full URL (shown in prompts and on the tool card).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// For `needs_permission`: the host a grant would cover.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    /// For `needs_confirmation`: the control and why it needs confirming.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions_used: Option<u32>,
}

impl CallResponse {
    fn ok(content: String, url: &str, title: Option<String>) -> Self {
        Self { status: "ok", content: Some(content), url: Some(url.to_string()), title, ..Default::default() }
    }
    fn error(message: impl Into<String>) -> Self {
        Self { status: "error", reason: Some(message.into()), ..Default::default() }
    }
    fn denied(reason: &DenyReason, url: Option<&str>) -> Self {
        Self { status: "denied", reason: Some(reason.message()), url: url.map(String::from), ..Default::default() }
    }
    fn permission(host: String, url: &str) -> Self {
        Self { status: "needs_permission", host: Some(host), url: Some(url.to_string()), ..Default::default() }
    }
}

// --- plumbing ----------------------------------------------------------------

fn ensure_store<R: Runtime>(app: &AppHandle<R>) {
    let dir = crate::core::app::commands::get_jan_data_folder_path(app.clone());
    STORE.open(&dir.join("browser-agent").join("rules.json"));
}

fn emit_to_main<R: Runtime, S: Serialize + Clone>(app: &AppHandle<R>, event: &str, payload: S) {
    let _ = app.emit_to(EventTarget::webview("main"), event, payload);
}

fn emit_state<R: Runtime>(app: &AppHandle<R>, host: Option<String>) {
    let lease = STORE.lease();
    emit_to_main(
        app,
        EVENT_STATE,
        json!({ "active": lease.is_some(), "paused": STORE.paused(), "host": host }),
    );
}

fn pane<R: Runtime>(app: &AppHandle<R>) -> Option<Webview<R>> {
    app.get_webview(PANE_LABEL)
}

fn network_for(project_root: Option<&str>) -> NetworkPolicy {
    let root = project_root.map(std::path::Path::new);
    tauri_plugin_agent_tools::policy::load(root, Some(true)).network
}

fn same_page(a: &Url, b: &Url) -> bool {
    let mut a = a.clone();
    let mut b = b.clone();
    a.set_fragment(None);
    b.set_fragment(None);
    a == b
}

/// Run the injected script and read what it returns.
async fn eval<R: Runtime>(wv: &Webview<R>, op: &str, args: Value) -> Result<Value, String> {
    let js = script::build(script::state_key(), op, &args);
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = std::sync::Mutex::new(Some(tx));
    wv.eval_with_callback(js, move |raw| {
        if let Some(tx) = tx.lock().ok().and_then(|mut g| g.take()) {
            let _ = tx.send(raw);
        }
    })
    .map_err(|e| format!("could not run in the page: {e}"))?;
    let raw = tokio::time::timeout(EVAL_TIMEOUT, rx)
        .await
        .map_err(|_| "the page did not answer in time (it may be loading or busy)".to_string())?
        .map_err(|_| "the page closed before answering".to_string())?;
    script::parse_result(&raw)
}

/// Wait for a navigation that follows an action, then for the page to settle.
async fn settle<R: Runtime>(wv: &Webview<R>, seq0: u64, start_wait: Duration, total: Duration) {
    let t0 = Instant::now();
    while super::load_seq() == seq0 && t0.elapsed() < start_wait {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    while super::loading() && t0.elapsed() < total {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    while t0.elapsed() < total {
        match eval(wv, "info", json!({})).await {
            Ok(v) if v["ready"] == "complete" => break,
            Ok(_) => tokio::time::sleep(Duration::from_millis(150)).await,
            // Mid-navigation the page cannot answer; try again shortly.
            Err(_) => tokio::time::sleep(Duration::from_millis(150)).await,
        }
    }
}

/// What the policy says about the pane's current page, for tools that read or act.
struct Guarded<R: Runtime> {
    wv: Webview<R>,
    url: Url,
}

enum Gate<R: Runtime> {
    Go(Guarded<R>),
    Stop(CallResponse),
}

fn decide_for(req: &CallRequest, network: &NetworkPolicy, url: &Url) -> Decision {
    STORE.with_inputs(req.enabled, network, req.unattended, |i| policy::decide(url, i))
}

async fn dns_block(url: &Url) -> Option<DenyReason> {
    let host = policy::host_key(url)?;
    if STORE.private_ok(&host) || host.parse::<std::net::IpAddr>().is_ok() {
        return None;
    }
    let port = url.port_or_known_default().unwrap_or(443);
    policy::resolved_block(&host, port)
        .await
        .map(|why| DenyReason::Blocked(policy::Block::Private(why)))
}

async fn guard<R: Runtime>(app: &AppHandle<R>, req: &CallRequest, network: &NetworkPolicy) -> Gate<R> {
    let Some(wv) = pane(app) else {
        return Gate::Stop(CallResponse::error(
            "The browser pane is not open. Call browser_open with a URL first.",
        ));
    };
    let url = match wv.url() {
        Ok(u) => u,
        Err(e) => return Gate::Stop(CallResponse::error(format!("could not read the pane's address: {e}"))),
    };
    if url.scheme() == "about" {
        return Gate::Stop(CallResponse::error("The browser pane is empty. Call browser_open with a URL first."));
    }
    match decide_for(req, network, &url) {
        Decision::Allow => {}
        Decision::Ask { host } => return Gate::Stop(CallResponse::permission(host, url.as_str())),
        Decision::Deny(reason) => return Gate::Stop(CallResponse::denied(&reason, Some(url.as_str()))),
    }
    if let Some(reason) = dns_block(&url).await {
        return Gate::Stop(CallResponse::denied(&reason, Some(url.as_str())));
    }
    Gate::Go(Guarded { wv, url })
}

fn blank<R: Runtime>(wv: &Webview<R>) {
    if let Ok(u) = Url::parse("about:blank") {
        let _ = wv.navigate(u);
    }
}

fn str_arg(v: &Option<String>, name: &str, max: usize) -> Result<String, CallResponse> {
    match v.as_deref() {
        Some(s) if s.chars().count() <= max => Ok(s.to_string()),
        Some(_) => Err(CallResponse::error(format!("'{name}' is longer than {max} characters"))),
        None => Err(CallResponse::error(format!("'{name}' is required"))),
    }
}

// --- the call ----------------------------------------------------------------

#[tauri::command]
pub async fn browser_agent_call<R: Runtime>(app: AppHandle<R>, request: CallRequest) -> CallResponse {
    ensure_store(&app);
    let req = request;
    if !TOOLS.contains(&req.tool.as_str()) {
        return CallResponse::error(format!("unknown browser tool '{}'", req.tool));
    }
    if !req.enabled {
        return CallResponse::denied(&DenyReason::FeatureOff, None);
    }
    if STORE.paused() {
        return CallResponse {
            status: "paused",
            reason: Some("The user took over the browser. Stop using it and tell the user what you were doing; they can hand it back.".into()),
            ..Default::default()
        };
    }
    let network = network_for(req.project_root.as_deref());
    if req.tool == "open" {
        return open(&app, &req, &network).await;
    }
    let Guarded { wv, url } = match guard(&app, &req, &network).await {
        Gate::Go(g) => g,
        Gate::Stop(r) => return r,
    };
    STORE.set_lease(&network, req.unattended, req.enabled);
    emit_state(&app, policy::host_key(&url));
    match req.tool.as_str() {
        "read_text" => read_text(&req, &wv, &url).await,
        "snapshot" => snapshot(&wv, &url).await,
        _ => act(&app, &req, &network, wv, url).await,
    }
}

async fn open<R: Runtime>(app: &AppHandle<R>, req: &CallRequest, network: &NetworkPolicy) -> CallResponse {
    let raw = match str_arg(&req.url, "url", policy::MAX_URL_LEN) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let target = match Url::parse(raw.trim()) {
        Ok(u) => u,
        Err(e) => return CallResponse::error(format!("not a valid URL: {e}")),
    };
    match decide_for(req, network, &target) {
        Decision::Allow => {}
        Decision::Ask { host } => return CallResponse::permission(host, target.as_str()),
        Decision::Deny(reason) => return CallResponse::denied(&reason, Some(target.as_str())),
    }
    if let Some(reason) = dns_block(&target).await {
        return CallResponse::denied(&reason, Some(target.as_str()));
    }
    if let Some(host) = policy::host_key(&target) {
        STORE.note_visit(&host);
    }
    // The lease goes up before the pane loads anything, so the navigation
    // handler already enforces the policy on this load and its redirects.
    STORE.set_lease(network, req.unattended, req.enabled);
    emit_state(app, policy::host_key(&target));

    let seq0 = super::load_seq();
    let existing = pane(app);
    let already_there = existing.as_ref().and_then(|w| w.url().ok()).is_some_and(|u| same_page(&u, &target));
    emit_to_main(app, EVENT_OPEN_PANE, json!({ "url": target.as_str() }));

    // The web side creates the webview when the pane opens; wait for it.
    let t0 = Instant::now();
    let wv = loop {
        if let Some(w) = pane(app) {
            break w;
        }
        if t0.elapsed() > OPEN_PANE_TIMEOUT {
            return CallResponse::error("The browser pane did not open. Make sure the Flint window is visible, then try again.");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let start_wait = if already_there { Duration::ZERO } else { Duration::from_secs(6) };
    settle(&wv, seq0, start_wait, OPEN_LOAD_TIMEOUT).await;

    // Where the page really is now: a redirect may have moved it.
    let now = match wv.url() {
        Ok(u) => u,
        Err(e) => return CallResponse::error(format!("could not read the pane's address: {e}")),
    };
    match decide_for(req, network, &now) {
        Decision::Allow => {}
        Decision::Ask { host } => {
            // Redirected to a site nobody approved. Nothing was read from it.
            return CallResponse::permission(host, now.as_str());
        }
        Decision::Deny(reason) => {
            blank(&wv);
            return CallResponse::denied(&reason, Some(now.as_str()));
        }
    }
    if let Some(reason) = dns_block(&now).await {
        blank(&wv);
        return CallResponse::denied(&reason, Some(now.as_str()));
    }
    let info = eval(&wv, "info", json!({})).await.unwrap_or(json!({}));
    let title = info["title"].as_str().unwrap_or("").to_string();
    let redirected = !same_page(&now, &target);
    let mut body = format!("Opened. Title: {title}\nAddress: {now}");
    if redirected {
        body.push_str(&format!("\nRedirected from {target}"));
    }
    body.push_str("\nCall browser_read_text to read the page or browser_snapshot to see its controls.");
    CallResponse::ok(fence::fence("status", now.as_str(), &body, fence::MAX_STATUS_CHARS), now.as_str(), Some(title))
}

async fn read_text<R: Runtime>(req: &CallRequest, wv: &Webview<R>, url: &Url) -> CallResponse {
    let max = req.max_chars.unwrap_or(fence::MAX_TEXT_CHARS).clamp(500, fence::MAX_TEXT_CHARS);
    let mut args = json!({ "max": max + 1 });
    if let Some(id) = req.id.as_deref().filter(|s| !s.is_empty()) {
        args["id"] = json!(id);
    }
    match eval(wv, "text", args).await {
        Ok(v) if v["ok"] == true => {
            let title = v["title"].as_str().unwrap_or("").to_string();
            let page = v["url"].as_str().unwrap_or(url.as_str()).to_string();
            let text = v["text"].as_str().unwrap_or("");
            let body = format!("Title: {title}\n\n{}", text.trim());
            CallResponse::ok(fence::fence("text", &page, &body, max), &page, Some(title))
        }
        Ok(v) => script_error(&v),
        Err(e) => CallResponse::error(e),
    }
}

async fn snapshot<R: Runtime>(wv: &Webview<R>, url: &Url) -> CallResponse {
    match eval(wv, "snapshot", json!({})).await {
        Ok(v) if v["ok"] == true => {
            let title = v["title"].as_str().unwrap_or("").to_string();
            let page = v["url"].as_str().unwrap_or(url.as_str()).to_string();
            let tree = v["snapshot"].as_str().unwrap_or("");
            let note = if v["truncated"] == true { "\n(The page is large: this is the first part.)" } else { "" };
            let body = format!(
                "Title: {title}\nNode ids like [3.12] work with browser_click, browser_type, browser_press and browser_select until the page changes or you take another snapshot.\n\n{tree}{note}"
            );
            CallResponse::ok(fence::fence("snapshot", &page, &body, fence::MAX_SNAPSHOT_CHARS), &page, Some(title))
        }
        Ok(v) => script_error(&v),
        Err(e) => CallResponse::error(e),
    }
}

fn script_error(v: &Value) -> CallResponse {
    CallResponse::error(v["error"].as_str().unwrap_or("the page refused the operation").to_string())
}

async fn act<R: Runtime>(app: &AppHandle<R>, req: &CallRequest, network: &NetworkPolicy, wv: Webview<R>, url: Url) -> CallResponse {
    let mut args = json!({ "confirmed": req.confirmed });
    match req.tool.as_str() {
        "click" => match str_arg(&req.id, "id", 16) {
            Ok(id) => args["id"] = json!(id),
            Err(r) => return r,
        },
        "type" => {
            match str_arg(&req.id, "id", 16) {
                Ok(id) => args["id"] = json!(id),
                Err(r) => return r,
            }
            match str_arg(&req.text, "text", MAX_TEXT_ARG) {
                Ok(t) => args["text"] = json!(t),
                Err(r) => return r,
            }
            if let Some(c) = req.clear {
                args["clear"] = json!(c);
            }
        }
        "press" => {
            match str_arg(&req.key, "key", 16) {
                Ok(k) => args["key"] = json!(k),
                Err(r) => return r,
            }
            if let Some(id) = req.id.as_deref().filter(|s| !s.is_empty()) {
                args["id"] = json!(id);
            }
        }
        "select" => {
            match str_arg(&req.id, "id", 16) {
                Ok(id) => args["id"] = json!(id),
                Err(r) => return r,
            }
            match str_arg(&req.value, "value", MAX_VALUE_ARG) {
                Ok(v) => args["value"] = json!(v),
                Err(r) => return r,
            }
        }
        _ => return CallResponse::error("unsupported action"),
    }

    // A dry run first: it validates the node id and says whether the control
    // is submit-like, without doing anything. A submit-like one is reported
    // back before it happens and costs no action; the web side asks the user
    // and calls again with `confirmed`.
    let mut dry = args.clone();
    dry["dry"] = json!(true);
    match eval(&wv, &req.tool, dry).await {
        Ok(v) if v["needs_confirm"] == true => return confirmation(&v, &url),
        Ok(v) if v["ok"] == true => {}
        Ok(v) => return script_error(&v),
        Err(e) => return CallResponse::error(e),
    }
    let cap = req.max_actions.unwrap_or(DEFAULT_MAX_ACTIONS);
    let run = if req.run_id.is_empty() { "default" } else { req.run_id.as_str() };
    let used = match STORE.take_action(run, cap) {
        Ok(n) => n,
        Err(n) => {
            return CallResponse::error(format!(
                "This run has used its {n} browser actions. Stop here and tell the user where you got to; they can continue in a new request."
            ));
        }
    };

    let seq0 = super::load_seq();
    let result = match eval(&wv, &req.tool, args).await {
        Ok(v) if v["needs_confirm"] == true => return confirmation(&v, &url),
        Ok(v) if v["ok"] == true => v,
        Ok(v) => return script_error(&v),
        Err(e) => return CallResponse::error(e),
    };
    settle(&wv, seq0, Duration::from_millis(700), ACTION_LOAD_TIMEOUT).await;

    // Where the page is after the action: it may have moved anywhere.
    let now = wv.url().unwrap_or(url.clone());
    let info = eval(&wv, "info", json!({})).await.unwrap_or(json!({}));
    let title = info["title"].as_str().unwrap_or("").to_string();
    let what = match req.tool.as_str() {
        "click" => format!("Clicked \"{}\".", result["clicked"].as_str().unwrap_or("")),
        "type" => format!("Typed {} characters into \"{}\".", result["typed"], result["field"].as_str().unwrap_or("")),
        "press" => format!("Pressed {}.", result["pressed"].as_str().unwrap_or("")),
        _ => format!("Selected \"{}\".", result["selected"].as_str().unwrap_or("")),
    };
    let mut body = format!("{what}
Page now: {title}
Address: {now}
Actions used this run: {used} of {}", cap.clamp(1, super::store::MAX_ACTIONS_CEILING));
    match decide_for(req, network, &now) {
        Decision::Allow => {}
        Decision::Ask { host } => {
            body.push_str(&format!(
                "
The page moved to {host}, which has not been approved. The next browser tool call will ask the user."
            ));
        }
        Decision::Deny(reason) => {
            blank(&wv);
            emit_to_main(app, EVENT_BLOCKED, json!({ "url": now.as_str(), "reason": reason.message() }));
            return CallResponse::denied(&reason, Some(now.as_str()));
        }
    }
    let mut resp = CallResponse::ok(fence::fence("status", now.as_str(), &body, fence::MAX_STATUS_CHARS), now.as_str(), Some(title));
    resp.actions_used = Some(used);
    resp
}

fn confirmation(v: &Value, url: &Url) -> CallResponse {
    CallResponse {
        status: "needs_confirmation",
        label: v["label"].as_str().map(String::from),
        reason: v["reason"].as_str().map(String::from),
        url: Some(url.to_string()),
        ..Default::default()
    }
}

// --- grants, rules, control ---------------------------------------------------

#[derive(Debug, Serialize)]
pub struct StateView {
    pub active: bool,
    pub paused: bool,
}

#[tauri::command]
pub fn browser_agent_status() -> StateView {
    StateView { active: STORE.lease().is_some(), paused: STORE.paused() }
}

/// The user answered the domain prompt. `scope` is `once`, `session` or `always`.
#[tauri::command]
pub fn browser_agent_grant<R: Runtime>(app: AppHandle<R>, pattern: String, scope: String) -> Result<String, String> {
    ensure_store(&app);
    let scope = Scope::parse(&scope).ok_or_else(|| "scope must be once, session or always".to_string())?;
    STORE.grant(&pattern, scope)
}

/// The user chose "never" for a site.
#[tauri::command]
pub fn browser_agent_block<R: Runtime>(app: AppHandle<R>, pattern: String) -> Result<policy::DomainRule, String> {
    ensure_store(&app);
    STORE.rule_set(&pattern, Verdict::Deny, false)
}

#[tauri::command]
pub fn browser_agent_rules<R: Runtime>(app: AppHandle<R>) -> Vec<policy::DomainRule> {
    ensure_store(&app);
    STORE.rules()
}

#[tauri::command]
pub fn browser_agent_rule_set<R: Runtime>(
    app: AppHandle<R>,
    pattern: String,
    verdict: String,
    private_ok: Option<bool>,
) -> Result<policy::DomainRule, String> {
    ensure_store(&app);
    let verdict = match verdict.as_str() {
        "allow" => Verdict::Allow,
        "deny" => Verdict::Deny,
        _ => return Err("verdict must be allow or deny".into()),
    };
    STORE.rule_set(&pattern, verdict, private_ok.unwrap_or(false))
}

#[tauri::command]
pub fn browser_agent_rule_remove<R: Runtime>(app: AppHandle<R>, pattern: String) -> Result<bool, String> {
    ensure_store(&app);
    STORE.rule_remove(&pattern)
}

/// Forget the "this session" and "once" grants.
#[tauri::command]
pub fn browser_agent_clear_grants() {
    STORE.clear_session_grants();
}

/// The user took the browser back: calls are refused until `resume`.
#[tauri::command]
pub fn browser_agent_stop<R: Runtime>(app: AppHandle<R>) {
    STORE.set_paused(true);
    emit_state(&app, None);
}

#[tauri::command]
pub fn browser_agent_resume<R: Runtime>(app: AppHandle<R>) {
    STORE.set_paused(false);
    emit_state(&app, None);
}
