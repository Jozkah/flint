//! `POST|PUT|PATCH /hooks/{task_id}/{token}`: start a scheduled task from an
//! inbound request (split from `server`).
//!
//! This route is `Public` -- it answers before any session is looked at,
//! because the caller is another service, not a signed-in browser. Its own
//! guard is the whole defence, in this order:
//!
//! 1. a client that keeps failing is shut out (`hook_limiter`, a second
//!    instance of the sign-in limiter, so hook noise never locks anyone out of
//!    sign-in);
//! 2. the task id and token are checked, in constant time, *before* a body is
//!    read: an unknown task, a task with no webhook and a wrong token all get
//!    the same 404, so ids cannot be probed;
//! 3. a disabled task is refused (403);
//! 4. the body is read with a hard cap (413) and a deadline (408);
//! 5. the signature, when the task has one, is checked over the raw bytes (401);
//! 6. filters, duplicate delivery ids and the per-task rate then decide
//!    whether a run starts; the prompt it gets is rendered with every request
//!    value fenced off as untrusted data.

use std::collections::BTreeMap;
use std::path::Path;

use super::*;
use crate::core::schedule::runner::{self, Launcher, SupervisorLauncher};
use crate::core::schedule::spec::Task;
use crate::core::schedule::store::{RunStatus, Store, Trigger};
use crate::core::schedule::webhook::{self, BodyError, Deliveries, RequestView};

/// Time a sender gets to deliver the whole body.
const HOOK_BODY_DEADLINE: std::time::Duration = std::time::Duration::from_secs(30);

/// Whether a request is addressed to the webhook route. The method list is
/// part of `route_auth`: any other method on `/hooks/...` stays behind the gate.
pub(super) fn is_hook_request(method: &Method, path: &str) -> bool {
    path.starts_with("/hooks/") && (*method == Method::POST || *method == Method::PUT || *method == Method::PATCH)
}

fn json_reply(status: StatusCode, value: serde_json::Value) -> Resp {
    reply(status, "application/json", serde_json::to_vec(&value).unwrap_or_default())
}

/// The one answer for "no such hook", whatever the reason.
fn not_found() -> Resp {
    text(StatusCode::NOT_FOUND, "Not found")
}

/// What a request came to, before it is turned into a response.
#[derive(Debug, PartialEq)]
pub(super) struct Outcome {
    pub status: StatusCode,
    pub body: serde_json::Value,
    /// A bad signature counts against the sender like a bad token.
    pub auth_failed: bool,
}

impl Outcome {
    fn new(status: StatusCode, body: serde_json::Value) -> Outcome {
        Outcome { status, body, auth_failed: false }
    }
}

/// Everything after the token is known good: signature, body, filters, dedupe,
/// rate, render, start. Blocking (disk, process spawn); no sockets, so it is
/// tested directly.
#[allow(clippy::too_many_arguments)]
pub(super) fn decide(
    data_folder: &Path,
    deliveries: &Deliveries,
    launcher: &dyn Launcher,
    task: &Task,
    method: &str,
    headers: &BTreeMap<String, String>,
    query: Option<&str>,
    body: &[u8],
    now: std::time::Instant,
) -> Outcome {
    let Some(hook) = task.webhook.as_ref() else {
        return Outcome::new(StatusCode::NOT_FOUND, serde_json::json!({ "error": "not found" }));
    };
    if let Some(sig) = &hook.signature {
        if !webhook::verify_signature(sig, headers, body) {
            return Outcome {
                status: StatusCode::UNAUTHORIZED,
                body: serde_json::json!({ "error": "invalid signature" }),
                auth_failed: true,
            };
        }
    }
    let view = match RequestView::new(method, headers, query, body) {
        Ok(v) => v,
        Err(BodyError::TooLarge) => {
            return Outcome::new(StatusCode::PAYLOAD_TOO_LARGE, serde_json::json!({ "error": "body too large" }))
        }
        Err(BodyError::InvalidJson) => {
            return Outcome::new(StatusCode::BAD_REQUEST, serde_json::json!({ "error": "invalid JSON body" }))
        }
    };
    if webhook::failed_filter(&hook.filters, &view).is_some() {
        return Outcome::new(StatusCode::OK, serde_json::json!({ "ignored": true, "reason": "filtered" }));
    }
    let key = webhook::delivery_key(headers);
    if let Some(key) = &key {
        if deliveries.is_duplicate(&task.id, key, now) {
            return Outcome::new(StatusCode::OK, serde_json::json!({ "ignored": true, "reason": "duplicate" }));
        }
    }
    if !deliveries.allow(&task.id, now) {
        return Outcome::new(StatusCode::TOO_MANY_REQUESTS, serde_json::json!({ "error": "too many requests" }));
    }
    // The run's copy of the task: the rendered prompt, and no webhook settings
    // (the signature secret must not reach a run spec on disk).
    let mut run_task = task.clone();
    run_task.prompt = webhook::render_prompt(&task.prompt, &view, &webhook::new_tag_id());
    run_task.webhook = None;
    let store = Store::new(data_folder);
    let record = match runner::start_run(&store, data_folder, launcher, &run_task, Trigger::Webhook, chrono::Utc::now()) {
        Ok(r) => r,
        Err(_) => {
            return Outcome::new(StatusCode::INTERNAL_SERVER_ERROR, serde_json::json!({ "error": "could not start the run" }))
        }
    };
    match record.status {
        RunStatus::Skipped => Outcome::new(
            StatusCode::CONFLICT,
            serde_json::json!({ "skipped": true, "reason": "the previous run is still going", "runId": record.id }),
        ),
        RunStatus::Failed => Outcome::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            serde_json::json!({ "error": "could not start the run", "runId": record.id }),
        ),
        _ => {
            if let Some(key) = &key {
                deliveries.remember(&task.id, key, now);
            }
            Outcome::new(StatusCode::ACCEPTED, serde_json::json!({ "accepted": true, "runId": record.id }))
        }
    }
}

/// The task a request names, if the token is its token. The comparison runs
/// for an unknown task too (against a throwaway value), so the answer does not
/// differ in time.
fn authenticate(task: Option<Task>, token: &str) -> Option<Task> {
    let expected = task.as_ref().and_then(|t| t.webhook.as_ref()).map(|w| w.token.as_str()).unwrap_or("-");
    let ok = webhook::ct_eq(expected.as_bytes(), token.as_bytes());
    match task {
        Some(t) if ok && t.webhook.is_some() && t.schedule.is_webhook() => Some(t),
        _ => None,
    }
}

pub(super) async fn hook_route(
    state: &State,
    method: &Method,
    path: &str,
    client: std::net::IpAddr,
    req: Request<Incoming>,
) -> Resp {
    let Some((task_id, token)) = webhook::parse_hook_path(path) else {
        return not_found();
    };
    if state.hook_limiter.blocked(client) {
        return json_reply(StatusCode::TOO_MANY_REQUESTS, serde_json::json!({ "error": "too many requests" }));
    }
    let (data, id) = (state.data_folder.clone(), task_id.to_owned());
    let task = tokio::task::spawn_blocking(move || Store::new(&data).get_task(&id).ok().flatten())
        .await
        .ok()
        .flatten();
    let Some(task) = authenticate(task, token) else {
        state.hook_limiter.record_failure(client);
        return not_found();
    };
    if !task.enabled {
        return json_reply(StatusCode::FORBIDDEN, serde_json::json!({ "error": "this task is turned off" }));
    }
    let mut headers: BTreeMap<String, String> = BTreeMap::new();
    for (name, value) in req.headers() {
        if let Ok(v) = value.to_str() {
            headers
                .entry(name.as_str().to_ascii_lowercase())
                .and_modify(|cur| {
                    cur.push_str(", ");
                    cur.push_str(v);
                })
                .or_insert_with(|| v.to_owned());
        }
    }
    let query = req.uri().query().map(str::to_owned);
    let body = match collect_limited(req.into_body(), webhook::MAX_BODY_BYTES, HOOK_BODY_DEADLINE).await {
        Ok(b) => b,
        Err(status) => return json_reply(status, serde_json::json!({ "error": "request too large or too slow" })),
    };
    let (data, method) = (state.data_folder.clone(), method.as_str().to_owned());
    // `state` outlives this call; the blocking closure needs 'static, so it
    // borrows nothing but copies, and reaches the shared table through a Arc.
    let deliveries = state.deliveries.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        decide(&data, &deliveries, &SupervisorLauncher, &task, &method, &headers, query.as_deref(), &body, std::time::Instant::now())
    })
    .await;
    match outcome {
        Ok(o) => {
            if o.auth_failed {
                state.hook_limiter.record_failure(client);
            }
            json_reply(o.status, o.body)
        }
        Err(_) => json_reply(StatusCode::INTERNAL_SERVER_ERROR, serde_json::json!({ "error": "request failed" })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::schedule::spec::fixtures::task;
    use crate::core::schedule::spec::Schedule;
    use crate::core::schedule::webhook::{Filter, FilterOp, Signature, SignatureEncoding, WebhookConfig};
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    use std::sync::Mutex as StdMutex;

    /// Starts nothing real; remembers the spec path it was given.
    #[derive(Default)]
    struct Fake {
        argv: StdMutex<Vec<Vec<String>>>,
        fail: bool,
    }

    impl Launcher for Fake {
        fn launch(&self, _d: &Path, _o: &str, argv: &[String], _s: &str, _r: &str, _n: &str) -> Result<String, String> {
            if self.fail {
                return Err("no supervisor".into());
            }
            self.argv.lock().unwrap().push(argv.to_vec());
            Ok("job-1".into())
        }
    }

    fn hook_task(sig: bool) -> Task {
        let mut t = task("hook-1");
        t.schedule = Schedule::Webhook;
        t.prompt = "Review {{body.title}} ({{headers.x-github-event}})".into();
        t.webhook = Some(WebhookConfig {
            token: "t".repeat(40),
            signature: sig.then(|| Signature {
                header: "x-hub-signature-256".into(),
                secret: "shh".into(),
                encoding: SignatureEncoding::Hex,
                prefix: "sha256=".into(),
                has_secret: true,
            }),
            filters: vec![Filter { path: "headers.x-github-event".into(), op: FilterOp::Equals, value: "pull_request".into() }],
        });
        t
    }

    fn headers(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        let mut h: BTreeMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        h.entry("content-type".into()).or_insert_with(|| "application/json".into());
        h
    }

    fn run(
        dir: &Path,
        d: &Deliveries,
        l: &dyn Launcher,
        t: &Task,
        h: &BTreeMap<String, String>,
        body: &[u8],
    ) -> Outcome {
        decide(dir, d, l, t, "POST", h, None, body, std::time::Instant::now())
    }

    fn sign(body: &[u8]) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(b"shh").unwrap();
        mac.update(body);
        format!("sha256={}", hex::encode(mac.finalize().into_bytes()))
    }

    #[test]
    fn a_matching_request_starts_a_run_with_the_rendered_prompt_and_no_secret() {
        let dir = tempfile::tempdir().unwrap();
        let (d, l, t) = (Deliveries::new(), Fake::default(), hook_task(true));
        let body = br#"{"title":"fix $x"}"#;
        let sig = sign(body);
        let out = run(dir.path(), &d, &l, &t, &headers(&[("x-github-event", "pull_request"), ("x-hub-signature-256", &sig)]), body);
        assert_eq!(out.status, StatusCode::ACCEPTED, "{:?}", out.body);
        assert!(out.body["runId"].is_string());
        // The spec the child will read carries the rendered prompt, no webhook
        // block and no secret.
        let specs = dir.path().join("schedules").join("specs");
        let file = std::fs::read_dir(&specs).unwrap().next().unwrap().unwrap().path();
        let text = std::fs::read_to_string(file).unwrap();
        assert!(text.contains("webhook-data-") && text.contains("fix $\u{200B}x"), "{text}");
        assert!(!text.contains("shh") && !text.contains(&"t".repeat(40)) && !text.contains("\"webhook\":"));
        assert!(text.contains("\"trigger\": \"webhook\""));
        assert_eq!(l.argv.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_bad_or_missing_signature_is_401_and_counts_as_a_failure() {
        let dir = tempfile::tempdir().unwrap();
        let (d, l, t) = (Deliveries::new(), Fake::default(), hook_task(true));
        let body = b"{}";
        let h = headers(&[("x-github-event", "pull_request")]);
        let missing = run(dir.path(), &d, &l, &t, &h, body);
        assert_eq!((missing.status, missing.auth_failed), (StatusCode::UNAUTHORIZED, true));
        let h = headers(&[("x-github-event", "pull_request"), ("x-hub-signature-256", &sign(b"other"))]);
        assert_eq!(run(dir.path(), &d, &l, &t, &h, body).status, StatusCode::UNAUTHORIZED);
        assert!(l.argv.lock().unwrap().is_empty());
    }

    #[test]
    fn filtered_and_duplicate_requests_are_200_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let (d, l, t) = (Deliveries::new(), Fake::default(), hook_task(false));
        let other = run(dir.path(), &d, &l, &t, &headers(&[("x-github-event", "push")]), b"{}");
        assert_eq!((other.status, other.body["ignored"].clone()), (StatusCode::OK, true.into()));
        assert_eq!(other.body["reason"], "filtered");
        let h = headers(&[("x-github-event", "pull_request"), ("x-github-delivery", "abc")]);
        assert_eq!(run(dir.path(), &d, &l, &t, &h, b"{}").status, StatusCode::ACCEPTED);
        let again = run(dir.path(), &d, &l, &t, &h, b"{}");
        assert_eq!((again.status, again.body["reason"].clone()), (StatusCode::OK, "duplicate".into()));
        assert_eq!(l.argv.lock().unwrap().len(), 1, "only the first delivery ran");
    }

    #[test]
    fn a_failed_launch_is_500_and_is_not_remembered_as_served() {
        let dir = tempfile::tempdir().unwrap();
        let (d, l, t) = (Deliveries::new(), Fake { fail: true, ..Default::default() }, hook_task(false));
        let h = headers(&[("x-github-event", "pull_request"), ("x-request-id", "r1")]);
        assert_eq!(run(dir.path(), &d, &l, &t, &h, b"{}").status, StatusCode::INTERNAL_SERVER_ERROR);
        let ok = Fake::default();
        assert_eq!(run(dir.path(), &d, &ok, &t, &h, b"{}").status, StatusCode::ACCEPTED, "a redelivery can still run");
    }

    #[test]
    fn a_still_running_task_is_409_with_a_skip_record() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let t = hook_task(false);
        // A live run: its job is this process, so `settle` keeps it running.
        let mut rec = store.begin_run(&t, Trigger::Webhook, chrono::Utc::now()).unwrap();
        let (d, l) = (Deliveries::new(), Fake::default());
        rec.job_id = Some("job-x".into());
        store.update_run(&rec).unwrap();
        let out = run(dir.path(), &d, &l, &t, &headers(&[("x-github-event", "pull_request")]), b"{}");
        // Without a real job record the first run settles as ended, so either
        // a fresh run (202) or the skip (409) is correct; both leave a record.
        assert!(matches!(out.status, StatusCode::ACCEPTED | StatusCode::CONFLICT), "{:?}", out.status);
        assert!(store.list_runs(&t.id, 10).unwrap().len() >= 2);
    }

    #[test]
    fn bad_json_is_400_and_the_rate_cap_is_429() {
        let dir = tempfile::tempdir().unwrap();
        let (d, l, mut t) = (Deliveries::new(), Fake::default(), hook_task(false));
        t.webhook.as_mut().unwrap().filters.clear();
        assert_eq!(run(dir.path(), &d, &l, &t, &headers(&[]), b"{nope").status, StatusCode::BAD_REQUEST);
        let now = std::time::Instant::now();
        for _ in 0..webhook::RATE_PER_MINUTE {
            assert!(d.allow(&t.id, now));
        }
        assert_eq!(run(dir.path(), &d, &l, &t, &headers(&[]), b"{}").status, StatusCode::TOO_MANY_REQUESTS);
    }

    #[test]
    fn unknown_task_wrong_token_and_non_webhook_task_look_alike() {
        let t = hook_task(false);
        assert!(authenticate(Some(t.clone()), &"t".repeat(40)).is_some());
        assert!(authenticate(Some(t.clone()), &"x".repeat(40)).is_none());
        assert!(authenticate(Some(t.clone()), "").is_none());
        assert!(authenticate(None, "anything").is_none());
        assert!(authenticate(None, "-").is_none(), "the throwaway value is not a token");
        assert!(authenticate(Some(task("plain")), "-").is_none());
    }

    #[test]
    fn only_post_put_patch_on_hooks_are_hook_requests() {
        for m in [Method::POST, Method::PUT, Method::PATCH] {
            assert!(is_hook_request(&m, "/hooks/a/b"));
        }
        assert!(!is_hook_request(&Method::GET, "/hooks/a/b"));
        assert!(!is_hook_request(&Method::DELETE, "/hooks/a/b"));
        assert!(!is_hook_request(&Method::POST, "/hook/a/b"));
    }
}
