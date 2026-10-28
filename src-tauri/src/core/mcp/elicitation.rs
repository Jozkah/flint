//! MCP elicitation: a server asks the user for input in the middle of a call.
//!
//! Two modes (MCP 2025-11-25): a *form*, a flat set of primitive fields the
//! server describes with a JSON schema, and a *URL*, where the user is sent to a
//! page of the server's (an OAuth consent, a payment page) and the values never
//! pass through the client at all.
//!
//! This module is Tauri-free: the request/reply shapes, turning the server's
//! schema into the fields a form shows, validating what the user typed, and the
//! decision flow. Putting a question in front of a person is behind
//! [`ElicitationUi`]; the desktop app's implementation ([`EventUi`]) emits an
//! event the web app renders as a card and waits for [`respond`].
//!
//! What stays out of the transcript: nothing here reaches the model. The reply
//! goes back to the *server*, which may or may not echo it in its tool result.
//! Values are never logged, and fields that look like credentials are flagged
//! `secret` so the card masks them.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use rmcp::model::{ElicitRequestParams, ElicitResult, ElicitationAction};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::sync::oneshot;

/// How long a question waits for the user before it counts as cancelled.
pub const ELICITATION_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// Event the web app listens on for a pending question.
pub const MCP_ELICITATION_EVENT: &str = "mcp-elicitation";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElicitOption {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FieldKind {
    String,
    Number,
    Integer,
    Boolean,
    /// One of `options`.
    Choice,
    /// Any number of `options`.
    MultiChoice,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElicitField {
    pub name: String,
    pub title: String,
    pub description: Option<String>,
    pub kind: FieldKind,
    pub required: bool,
    /// Looks like a credential: the card masks it and it is never echoed.
    pub secret: bool,
    pub default: Option<Value>,
    pub options: Vec<ElicitOption>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum ElicitRequest {
    #[serde(rename_all = "camelCase")]
    Form {
        id: String,
        server: String,
        message: String,
        fields: Vec<ElicitField>,
    },
    #[serde(rename_all = "camelCase")]
    Url {
        id: String,
        server: String,
        message: String,
        url: String,
        host: String,
    },
}

/// Most fields one form may ask for, and the longest message shown.
const MAX_FORM_FIELDS: usize = 20;
const MAX_MESSAGE_CHARS: usize = 2000;

impl ElicitRequest {
    pub fn server(&self) -> &str {
        match self {
            ElicitRequest::Form { server, .. } | ElicitRequest::Url { server, .. } => server,
        }
    }

    pub fn id(&self) -> &str {
        match self {
            ElicitRequest::Form { id, .. } | ElicitRequest::Url { id, .. } => id,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReplyAction {
    Accept,
    Decline,
    Cancel,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElicitReply {
    pub action: ReplyAction,
    #[serde(default)]
    pub content: Option<Value>,
}

impl ElicitReply {
    pub fn cancel() -> Self {
        Self { action: ReplyAction::Cancel, content: None }
    }
}

/// Puts a question in front of the user and returns what they chose. An
/// implementation with no user to ask must answer `Decline`, never block.
#[async_trait::async_trait]
pub trait ElicitationUi: Send + Sync {
    async fn ask(&self, request: ElicitRequest) -> ElicitReply;
}

fn next_id() -> String {
    static N: AtomicU64 = AtomicU64::new(1);
    format!("elicit-{}", N.fetch_add(1, Ordering::Relaxed))
}

const SECRET_WORDS: &[&str] = &[
    "password", "passwd", "passphrase", "secret", "token", "api_key", "apikey", "api key",
    "credential", "private key",
];

fn looks_secret(name: &str, title: &str, format: Option<&str>) -> bool {
    if format == Some("password") {
        return true;
    }
    let hay = format!("{name} {title}").to_ascii_lowercase();
    SECRET_WORDS.iter().any(|w| hay.contains(w))
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// `enum` (with optional `enumNames`) or `oneOf`/`anyOf` of `{const, title}`.
fn options_of(def: &Value) -> Vec<ElicitOption> {
    if let Some(values) = def.get("enum").and_then(Value::as_array) {
        let names = def.get("enumNames").and_then(Value::as_array);
        return values
            .iter()
            .enumerate()
            .filter_map(|(i, v)| {
                let value = v.as_str()?.to_string();
                let label = names
                    .and_then(|n| n.get(i))
                    .and_then(Value::as_str)
                    .unwrap_or(&value)
                    .to_string();
                Some(ElicitOption { value, label })
            })
            .collect();
    }
    for key in ["oneOf", "anyOf"] {
        if let Some(items) = def.get(key).and_then(Value::as_array) {
            return items
                .iter()
                .filter_map(|o| {
                    let value = str_of(o, "const")?.to_string();
                    let label = str_of(o, "title").unwrap_or(&value).to_string();
                    Some(ElicitOption { value, label })
                })
                .collect();
        }
    }
    Vec::new()
}

/// The fields a server's `requestedSchema` describes, in schema order.
pub fn fields_from_schema(schema: &Value) -> Vec<ElicitField> {
    let required: Vec<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|r| r.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let Some(props) = schema.get("properties").and_then(Value::as_object) else {
        return Vec::new();
    };
    props
        .iter()
        .map(|(name, def)| {
            let ty = str_of(def, "type").unwrap_or("string");
            let (kind, options) = match ty {
                "boolean" => (FieldKind::Boolean, Vec::new()),
                "integer" => (FieldKind::Integer, Vec::new()),
                "number" => (FieldKind::Number, Vec::new()),
                "array" => {
                    let items = def.get("items").cloned().unwrap_or(Value::Null);
                    (FieldKind::MultiChoice, options_of(&items))
                }
                _ => {
                    let opts = options_of(def);
                    if opts.is_empty() {
                        (FieldKind::String, opts)
                    } else {
                        (FieldKind::Choice, opts)
                    }
                }
            };
            let title = str_of(def, "title").unwrap_or(name).to_string();
            ElicitField {
                name: name.clone(),
                secret: looks_secret(name, &title, str_of(def, "format")),
                title,
                description: str_of(def, "description").map(str::to_string),
                kind,
                required: required.contains(&name.as_str()),
                default: def.get("default").cloned(),
                options,
            }
        })
        .collect()
}

/// Check what the user submitted against the fields shown: object shape, every
/// required field present, types right, choices among the offered options.
/// Returns only the declared fields. The error names fields, never values.
pub fn validate_form(fields: &[ElicitField], content: &Value) -> Result<Value, String> {
    let given = content
        .as_object()
        .ok_or_else(|| "the form answer was not an object".to_string())?;
    let mut out = Map::new();
    for f in fields {
        let Some(v) = given.get(&f.name).filter(|v| !v.is_null()) else {
            if f.required {
                return Err(format!("required field '{}' is missing", f.name));
            }
            continue;
        };
        let ok = match f.kind {
            FieldKind::String => v.is_string(),
            FieldKind::Number => v.is_number(),
            FieldKind::Integer => v.is_i64() || v.is_u64(),
            FieldKind::Boolean => v.is_boolean(),
            FieldKind::Choice => v
                .as_str()
                .is_some_and(|s| f.options.iter().any(|o| o.value == s)),
            FieldKind::MultiChoice => v.as_array().is_some_and(|a| {
                a.iter()
                    .all(|x| x.as_str().is_some_and(|s| f.options.iter().any(|o| o.value == s)))
            }),
        };
        if !ok {
            return Err(format!("field '{}' has an invalid value", f.name));
        }
        out.insert(f.name.clone(), v.clone());
    }
    Ok(Value::Object(out))
}

/// A URL elicitation may only send the user to an http(s) page. Returns the host.
pub fn checked_url(url: &str) -> Result<String, String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("invalid URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("unsupported URL scheme '{}'", parsed.scheme()));
    }
    parsed
        .host_str()
        .map(str::to_string)
        .ok_or_else(|| "URL has no host".to_string())
}

fn decline() -> ElicitResult {
    ElicitResult::new(ElicitationAction::Decline)
}

/// Answer one server request. With no `ui` (a headless run) the request is
/// declined and the reason logged, so the server carries on without the input.
pub async fn handle_request(
    ui: Option<&dyn ElicitationUi>,
    server: &str,
    params: ElicitRequestParams,
) -> ElicitResult {
    let Some(ui) = ui else {
        log::warn!(
            "MCP server '{server}' asked the user for input; declined automatically because this run has no interface to ask on"
        );
        return decline();
    };
    match params {
        ElicitRequestParams::FormElicitationParams { message, requested_schema, .. } => {
            let schema = serde_json::to_value(&requested_schema).unwrap_or(Value::Null);
            let fields = fields_from_schema(&schema);
            if fields.len() > MAX_FORM_FIELDS {
                log::warn!("MCP server '{server}' asked for {} fields; declined", fields.len());
                return decline();
            }
            let message: String = message.chars().take(MAX_MESSAGE_CHARS).collect();
            let reply = ui
                .ask(ElicitRequest::Form {
                    id: next_id(),
                    server: server.to_string(),
                    message,
                    fields: fields.clone(),
                })
                .await;
            match reply.action {
                ReplyAction::Accept => {
                    match validate_form(&fields, &reply.content.unwrap_or(Value::Null)) {
                        Ok(content) => {
                            ElicitResult::new(ElicitationAction::Accept).with_content(content)
                        }
                        Err(why) => {
                            log::warn!("MCP server '{server}' form answer rejected: {why}");
                            decline()
                        }
                    }
                }
                ReplyAction::Decline => decline(),
                ReplyAction::Cancel => ElicitResult::new(ElicitationAction::Cancel),
            }
        }
        ElicitRequestParams::UrlElicitationParams { message, url, .. } => {
            let host = match checked_url(&url) {
                Ok(h) => h,
                Err(why) => {
                    log::warn!("MCP server '{server}' sent a URL elicitation that was refused: {why}");
                    return decline();
                }
            };
            let reply = ui
                .ask(ElicitRequest::Url {
                    id: next_id(),
                    server: server.to_string(),
                    message,
                    url,
                    host,
                })
                .await;
            match reply.action {
                ReplyAction::Accept => ElicitResult::new(ElicitationAction::Accept),
                ReplyAction::Decline => decline(),
                ReplyAction::Cancel => ElicitResult::new(ElicitationAction::Cancel),
            }
        }
        // `ElicitRequestParams` is non-exhaustive.
        _ => decline(),
    }
}

// ---- desktop: ask through the web app --------------------------------------

/// Request id -> (asking server, answer channel).
type Pending = Mutex<HashMap<String, (String, oneshot::Sender<ElicitReply>)>>;

fn pending() -> &'static Pending {
    static P: OnceLock<Pending> = OnceLock::new();
    P.get_or_init(Default::default)
}

static UI_READY: AtomicBool = AtomicBool::new(false);

/// The web app says whether it is listening. With no listener a question would
/// wait out its timeout for nobody, so it is declined at once instead.
pub fn set_ui_ready(ready: bool) {
    UI_READY.store(ready, Ordering::SeqCst);
    if !ready {
        // Whatever was waiting on a window that is gone is cancelled.
        let waiting: Vec<_> = pending().lock().unwrap_or_else(|p| p.into_inner()).drain().collect();
        for (_, (_, tx)) in waiting {
            let _ = tx.send(ElicitReply::cancel());
        }
    }
}

/// Deliver the user's answer to the waiting request. `false` when it already
/// settled (timed out, cancelled) or never existed.
pub fn respond(id: &str, reply: ElicitReply) -> bool {
    let tx = pending().lock().unwrap_or_else(|p| p.into_inner()).remove(id);
    match tx {
        Some((_, tx)) => tx.send(reply).is_ok(),
        None => false,
    }
}

/// Asks by emitting an event; the answer arrives through [`respond`].
pub struct EventUi {
    emit: Arc<dyn Fn(&ElicitRequest) + Send + Sync>,
    timeout: Duration,
}

impl EventUi {
    pub fn new(emit: Arc<dyn Fn(&ElicitRequest) + Send + Sync>) -> Self {
        Self { emit, timeout: ELICITATION_TIMEOUT }
    }
}

#[async_trait::async_trait]
impl ElicitationUi for EventUi {
    async fn ask(&self, request: ElicitRequest) -> ElicitReply {
        if !UI_READY.load(Ordering::SeqCst) {
            log::warn!("MCP elicitation declined automatically: no interface is listening");
            return ElicitReply { action: ReplyAction::Decline, content: None };
        }
        let id = request.id().to_string();
        let (tx, rx) = oneshot::channel();
        {
            // One open question per server: a chatty server cannot stack cards.
            let mut open = pending().lock().unwrap_or_else(|p| p.into_inner());
            let server = request.server().to_string();
            if open.values().any(|(s, _)| *s == server) {
                log::warn!("MCP elicitation from '{server}' declined: it already has a question open");
                return ElicitReply { action: ReplyAction::Decline, content: None };
            }
            open.insert(id.clone(), (server, tx));
        }
        (self.emit)(&request);
        match tokio::time::timeout(self.timeout, rx).await {
            Ok(Ok(reply)) => reply,
            _ => {
                pending().lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
                ElicitReply::cancel()
            }
        }
    }
}

#[cfg(not(feature = "cli"))]
#[tauri::command]
pub fn mcp_elicitation_ready(ready: bool) {
    set_ui_ready(ready);
}

#[cfg(not(feature = "cli"))]
#[tauri::command]
pub fn mcp_elicitation_respond(id: String, action: ReplyAction, content: Option<Value>) -> bool {
    respond(&id, ElicitReply { action, content })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "name": {"type": "string", "title": "Your name"},
                "api_token": {"type": "string"},
                "age": {"type": "integer"},
                "agree": {"type": "boolean", "default": true},
                "color": {"type": "string", "enum": ["red", "blue"], "enumNames": ["Red", "Blue"]},
                "tags": {"type": "array", "items": {"enum": ["a", "b"]}},
                "pw": {"type": "string", "format": "password"}
            },
            "required": ["name", "color"]
        })
    }

    fn field<'a>(fs: &'a [ElicitField], n: &str) -> &'a ElicitField {
        fs.iter().find(|f| f.name == n).unwrap()
    }

    #[test]
    fn schema_becomes_fields_with_kinds_required_and_secrets() {
        let fs = fields_from_schema(&schema());
        assert_eq!(fs.len(), 7);
        assert_eq!(field(&fs, "name").title, "Your name");
        assert!(field(&fs, "name").required && !field(&fs, "age").required);
        assert_eq!(field(&fs, "age").kind, FieldKind::Integer);
        assert_eq!(field(&fs, "color").kind, FieldKind::Choice);
        assert_eq!(field(&fs, "color").options[0].label, "Red");
        assert_eq!(field(&fs, "tags").kind, FieldKind::MultiChoice);
        assert_eq!(field(&fs, "agree").default, Some(json!(true)));
        assert!(field(&fs, "api_token").secret);
        assert!(field(&fs, "pw").secret);
        assert!(!field(&fs, "name").secret);
    }

    #[test]
    fn validation_keeps_declared_fields_and_rejects_bad_ones() {
        let fs = fields_from_schema(&schema());
        let ok = validate_form(&fs, &json!({"name": "A", "color": "red", "extra": 1})).unwrap();
        assert_eq!(ok, json!({"name": "A", "color": "red"}));
        assert!(validate_form(&fs, &json!({"name": "A"})).unwrap_err().contains("'color'"));
        assert!(validate_form(&fs, &json!({"name": "A", "color": "green"})).is_err());
        assert!(validate_form(&fs, &json!({"name": "A", "color": "red", "age": 1.5})).is_err());
        assert!(validate_form(&fs, &json!({"name": "A", "color": "red", "tags": ["z"]})).is_err());
        assert!(validate_form(&fs, &json!("nope")).is_err());
    }

    #[test]
    fn a_validation_error_never_contains_the_value() {
        let fs = fields_from_schema(&schema());
        let err = validate_form(&fs, &json!({"name": "A", "color": "red", "pw": 12345})).unwrap_err();
        assert!(!err.contains("12345"), "{err}");
    }

    #[test]
    fn url_elicitation_only_allows_http_pages() {
        assert_eq!(checked_url("https://auth.example.com/x?y=1").unwrap(), "auth.example.com");
        assert!(checked_url("file:///etc/passwd").is_err());
        assert!(checked_url("javascript:alert(1)").is_err());
        assert!(checked_url("not a url").is_err());
    }

    struct Scripted(ElicitReply);

    #[async_trait::async_trait]
    impl ElicitationUi for Scripted {
        async fn ask(&self, _: ElicitRequest) -> ElicitReply {
            self.0.clone()
        }
    }

    fn form_params() -> ElicitRequestParams {
        let schema: rmcp::model::ElicitationSchema =
            serde_json::from_value(json!({
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"]
            }))
            .unwrap();
        ElicitRequestParams::FormElicitationParams {
            meta: None,
            message: "who?".into(),
            requested_schema: schema,
        }
    }

    #[tokio::test]
    async fn headless_run_declines() {
        let r = handle_request(None, "srv", form_params()).await;
        assert_eq!(r.action, ElicitationAction::Decline);
        assert!(r.content.is_none());
    }

    #[tokio::test]
    async fn accepted_form_returns_validated_content() {
        let ui = Scripted(ElicitReply {
            action: ReplyAction::Accept,
            content: Some(json!({"name": "Ada", "stray": "x"})),
        });
        let r = handle_request(Some(&ui), "srv", form_params()).await;
        assert_eq!(r.action, ElicitationAction::Accept);
        assert_eq!(r.content, Some(json!({"name": "Ada"})));
    }

    #[tokio::test]
    async fn invalid_accept_is_declined_and_cancel_is_cancel() {
        let bad = Scripted(ElicitReply { action: ReplyAction::Accept, content: Some(json!({})) });
        assert_eq!(handle_request(Some(&bad), "s", form_params()).await.action, ElicitationAction::Decline);
        let cancel = Scripted(ElicitReply::cancel());
        assert_eq!(handle_request(Some(&cancel), "s", form_params()).await.action, ElicitationAction::Cancel);
    }

    #[tokio::test]
    async fn url_mode_accept_carries_no_content_and_bad_scheme_is_declined() {
        let ui = Scripted(ElicitReply { action: ReplyAction::Accept, content: None });
        let ok = ElicitRequestParams::UrlElicitationParams {
            meta: None,
            message: "sign in".into(),
            url: "https://auth.example.com/consent".into(),
            elicitation_id: "e1".into(),
        };
        let r = handle_request(Some(&ui), "srv", ok).await;
        assert_eq!(r.action, ElicitationAction::Accept);
        assert!(r.content.is_none());
        let bad = ElicitRequestParams::UrlElicitationParams {
            meta: None,
            message: "x".into(),
            url: "file:///c:/secret".into(),
            elicitation_id: "e2".into(),
        };
        assert_eq!(handle_request(Some(&ui), "srv", bad).await.action, ElicitationAction::Decline);
    }

    /// The event path: declines with no listener, delivers an answer through
    /// `respond`, and cancels on timeout. One test: the ready flag is global.
    #[tokio::test]
    async fn event_ui_round_trip_and_timeout() {
        set_ui_ready(false);
        let seen: Arc<Mutex<Vec<String>>> = Default::default();
        let sink = seen.clone();
        let mut ui = EventUi::new(Arc::new(move |r| sink.lock().unwrap().push(r.id().to_string())));
        let url_req = |id: &str| ElicitRequest::Url {
            id: id.into(),
            server: "s".into(),
            message: "m".into(),
            url: "https://a.example".into(),
            host: "a.example".into(),
        };
        assert_eq!(ui.ask(url_req("t-0")).await.action, ReplyAction::Decline);
        assert!(seen.lock().unwrap().is_empty());

        set_ui_ready(true);
        let answered = tokio::spawn({
            let seen = seen.clone();
            async move {
                loop {
                    if seen.lock().unwrap().iter().any(|i| i == "t-1") {
                        return respond("t-1", ElicitReply { action: ReplyAction::Accept, content: None });
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            }
        });
        let reply = ui.ask(url_req("t-1")).await;
        assert!(answered.await.unwrap());
        assert_eq!(reply.action, ReplyAction::Accept);
        assert!(!respond("t-1", ElicitReply::cancel()), "already settled");

        ui.timeout = Duration::from_millis(30);
        assert_eq!(ui.ask(url_req("t-2")).await.action, ReplyAction::Cancel);
        assert!(!respond("t-2", ElicitReply::cancel()));

        // One open question per server: a second is declined while the first waits.
        ui.timeout = Duration::from_secs(5);
        let ui = Arc::new(ui);
        let first = tokio::spawn({
            let ui = ui.clone();
            async move { ui.ask(url_req("t-3")).await }
        });
        while !seen.lock().unwrap().iter().any(|i| i == "t-3") {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(ui.ask(url_req("t-4")).await.action, ReplyAction::Decline);
        assert!(respond("t-3", ElicitReply::cancel()));
        assert_eq!(first.await.unwrap().action, ReplyAction::Cancel);
        set_ui_ready(false);
    }
}
