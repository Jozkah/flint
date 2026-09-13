//! `stop_session` rules, against a real mailbox folder.

use super::*;
use std::sync::atomic::AtomicUsize;

static COUNTER: AtomicUsize = AtomicUsize::new(0);

struct Fixture {
    base: PathBuf,
    data: PathBuf,
    project: PathBuf,
    other: PathBuf,
}

impl Fixture {
    fn new(tag: &str) -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let base = std::env::temp_dir().join(format!("jan_stop_{tag}_{}_{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let data = base.join("data");
        let project = base.join("project");
        let other = base.join("other");
        for d in [&data, &project, &other] {
            std::fs::create_dir_all(d).unwrap();
        }
        Self {
            base,
            data,
            project,
            other,
        }
    }
    fn folder(&self) -> Option<&str> {
        self.project.to_str()
    }
    fn other(&self) -> Option<&str> {
        self.other.to_str()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

const T0: i64 = 1_700_000_000_000;

/// A mailbox on a fixed clock, with `a` and `b` running in one project and
/// `c` running in another.
fn setup(fx: &Fixture) -> (Mailbox, Arc<AtomicI64>) {
    let clock = Arc::new(AtomicI64::new(T0));
    let mb = Mailbox::open(&fx.data).with_clock(clock.clone());
    mb.register("a", "Alpha", fx.folder()).unwrap();
    mb.register("b", "Beta", fx.folder()).unwrap();
    mb.register("c", "Gamma", fx.other()).unwrap();
    mb.set_status("a", true, Some("run-a")).unwrap();
    mb.set_status("b", true, Some("run-b1")).unwrap();
    mb.set_status("c", true, Some("run-c")).unwrap();
    (mb, clock)
}

fn code_of<T: std::fmt::Debug>(r: Result<T>) -> &'static str {
    r.expect_err("expected a refusal").code
}

fn approve(mb: &Mailbox, call: &str, target: &str, reason: &str) {
    mb.approve_stop("a", call, target, reason).unwrap();
}

#[test]
fn a_running_peer_in_the_same_project_is_stopped_by_its_current_run() {
    let fx = Fixture::new("ok");
    let (mb, _) = setup(&fx);
    approve(&mb, "call-1", "b", "we both own src/x.ts");
    let req = mb.request_stop("a", "b", "we both own src/x.ts", "call-1").unwrap();
    assert_eq!(req.status, StopStatus::Requested);
    assert_eq!(req.target_run_id, "run-b1");
    assert_eq!(req.from.display_name, "Alpha");
    assert_eq!(req.to.display_name, "Beta");

    // Durable, typed, under the mailbox folder.
    let on_disk: serde_json::Value =
        serde_json::from_slice(&std::fs::read(fx.data.join("mailbox/stops.json")).unwrap()).unwrap();
    let rec = &on_disk[&req.id];
    assert_eq!(rec["status"], "requested");
    assert_eq!(rec["targetRunId"], "run-b1");
    assert_eq!(rec["from"]["sessionId"], "a");
    assert_eq!(rec["to"]["sessionId"], "b");
    assert!(rec["project"].as_str().unwrap().starts_with("proj-"));
    assert!(rec["createdAt"].as_i64().is_some());

    let pending = mb.pending_stop("b", &req.id).unwrap().expect("pending for b");
    assert_eq!(pending.id, req.id);
    let done = mb.resolve_stop("b", &req.id, true, Some("run-b1")).unwrap();
    assert_eq!(done.status, StopStatus::Applied);
    // Resolving again keeps the first outcome.
    let again = mb.resolve_stop("b", &req.id, false, None).unwrap();
    assert_eq!(again.status, StopStatus::Applied);
    assert!(mb.pending_stop("b", &req.id).unwrap().is_none());
}

#[test]
fn another_project_is_refused_exactly_like_an_unknown_session() {
    let fx = Fixture::new("project");
    let (mb, _) = setup(&fx);
    approve(&mb, "call-c", "c", "stop");
    let other = mb.request_stop("a", "c", "stop", "call-c").unwrap_err();
    approve(&mb, "call-z", "zzz", "stop");
    let unknown = mb.request_stop("a", "zzz", "stop", "call-z").unwrap_err();
    assert_eq!(other.code, code::UNKNOWN_SESSION);
    // Same code and words: the refusal does not reveal that `c` exists.
    assert_eq!(other, unknown);
    assert!(!other.message.contains("Gamma"));
    // Nothing was recorded for the other project's session.
    assert!(mb.read_stops().unwrap().is_empty());
}

#[test]
fn self_deleted_unknown_idle_and_unavailable_targets_are_refused() {
    let fx = Fixture::new("targets");
    let (mb, clock) = setup(&fx);
    approve(&mb, "s", "a", "r");
    assert_eq!(code_of(mb.request_stop("a", "a", "r", "s")), code::SELF_TARGET);
    assert_eq!(code_of(mb.request_stop("a", "../b", "r", "s")), code::UNKNOWN_SESSION);

    mb.register("idle", "Idle", fx.folder()).unwrap();
    approve(&mb, "i", "idle", "r");
    assert_eq!(
        code_of(mb.request_stop("a", "idle", "r", "i")),
        stop_code::TARGET_NOT_RUNNING
    );

    mb.register("gone", "Gone", fx.folder()).unwrap();
    mb.set_status("gone", true, Some("g1")).unwrap();
    mb.remove("gone").unwrap();
    approve(&mb, "g", "gone", "r");
    assert_eq!(code_of(mb.request_stop("a", "gone", "r", "g")), code::SESSION_DELETED);

    // Running in another process epoch: unavailable, not running.
    let foreign = Mailbox::open(&fx.data).with_clock(clock.clone()).with_epoch("other-epoch");
    foreign.register("ghost", "Ghost", fx.folder()).unwrap();
    foreign.set_status("ghost", true, Some("h1")).unwrap();
    approve(&mb, "h", "ghost", "r");
    assert_eq!(
        code_of(mb.request_stop("a", "ghost", "r", "h")),
        stop_code::TARGET_NOT_RUNNING
    );

    // A stale heartbeat is unavailable too. Keep `a` fresh.
    clock.store(T0 + STALE_AFTER_MS + 1, Ordering::SeqCst);
    mb.heartbeat("a", "run-a").unwrap();
    approve(&mb, "b", "b", "r");
    assert_eq!(
        code_of(mb.request_stop("a", "b", "r", "b")),
        stop_code::TARGET_NOT_RUNNING
    );
    assert!(mb.read_stops().unwrap().is_empty());
}

#[test]
fn the_caller_must_itself_be_a_registered_running_session() {
    let fx = Fixture::new("caller");
    let (mb, _) = setup(&fx);
    mb.set_status("a", false, Some("run-a")).unwrap();
    approve(&mb, "call", "b", "r");
    assert_eq!(
        code_of(mb.request_stop("a", "b", "r", "call")),
        stop_code::CALLER_NOT_RUNNING
    );
    assert_eq!(code_of(mb.request_stop("nobody", "b", "r", "call")), code::NO_PROJECT);
}

#[test]
fn a_request_for_an_older_run_never_stops_the_newer_one() {
    let fx = Fixture::new("stale");
    let (mb, _) = setup(&fx);
    approve(&mb, "call", "b", "r");
    let req = mb.request_stop("a", "b", "r", "call").unwrap();
    // B's run ends and a new one starts before the renderer acts.
    mb.set_status("b", false, Some("run-b1")).unwrap();
    mb.set_status("b", true, Some("run-b2")).unwrap();
    assert!(mb.pending_stop("b", &req.id).unwrap().is_none());
    let rec = mb.stop_request(&req.id).unwrap().unwrap();
    assert_eq!(rec.status, StopStatus::IgnoredStale);
    // A late "applied" cannot turn it into a stop.
    let late = mb.resolve_stop("b", &req.id, true, Some("run-b1")).unwrap();
    assert_eq!(late.status, StopStatus::IgnoredStale);
    assert_eq!(mb.session("b").unwrap().run_id.as_deref(), Some("run-b2"));
}

#[test]
fn applied_needs_the_named_run_and_an_unapplied_request_expires() {
    let fx = Fixture::new("expire");
    let (mb, clock) = setup(&fx);
    approve(&mb, "c1", "b", "r");
    let wrong_run = mb.request_stop("a", "b", "r", "c1").unwrap();
    let out = mb.resolve_stop("b", &wrong_run.id, true, Some("run-b9")).unwrap();
    assert_eq!(out.status, StopStatus::IgnoredStale);

    approve(&mb, "c2", "b", "r");
    let old = mb.request_stop("a", "b", "r", "c2").unwrap();
    clock.store(T0 + STOP_REQUEST_TTL_MS, Ordering::SeqCst);
    mb.heartbeat("b", "run-b1").unwrap();
    assert!(mb.pending_stop("b", &old.id).unwrap().is_none());
    assert_eq!(
        mb.stop_request(&old.id).unwrap().unwrap().status,
        StopStatus::IgnoredStale
    );
}

#[test]
fn stop_requests_are_rate_limited_per_sender_and_per_pair() {
    let fx = Fixture::new("rate");
    let (mb, clock) = setup(&fx);
    mb.register("d", "Delta", fx.folder()).unwrap();
    mb.set_status("d", true, Some("run-d")).unwrap();
    for (i, target) in ["b", "b"].iter().enumerate() {
        let call = format!("p{i}");
        approve(&mb, &call, target, "r");
        mb.request_stop("a", target, "r", &call).unwrap();
    }
    approve(&mb, "p2", "b", "r");
    assert_eq!(
        code_of(mb.request_stop("a", "b", "r", "p2")),
        code::PAIR_LIMIT_EXCEEDED
    );
    // The refused call did not spend its approval.
    approve(&mb, "p3", "d", "r");
    mb.request_stop("a", "d", "r", "p3").unwrap();
    approve(&mb, "p4", "d", "r");
    assert_eq!(code_of(mb.request_stop("a", "d", "r", "p4")), code::RATE_LIMITED);

    // Limits come from disk, so a new handle sees them too.
    let reopened = Mailbox::open(&fx.data).with_clock(clock.clone());
    assert_eq!(code_of(reopened.request_stop("a", "d", "r", "p4")), code::RATE_LIMITED);

    // A window later the sender may ask again.
    clock.store(T0 + STOP_RATE_WINDOW_MS + 1, Ordering::SeqCst);
    for s in ["a", "b", "d"] {
        let run = mb.session(s).unwrap().run_id.unwrap();
        mb.heartbeat(s, &run).unwrap();
    }
    approve(&mb, "p5", "d", "r");
    mb.request_stop("a", "d", "r", "p5").unwrap();
}

#[test]
fn every_request_needs_an_approval_for_that_call_target_and_reason() {
    let fx = Fixture::new("approval");
    let (mb, _) = setup(&fx);
    mb.register("d", "Delta", fx.folder()).unwrap();
    mb.set_status("d", true, Some("run-d")).unwrap();
    assert_eq!(
        code_of(mb.request_stop("a", "b", "r", "never-approved")),
        stop_code::APPROVAL_REQUIRED
    );
    approve(&mb, "call", "b", "because");
    // Another call, another target, another reason: none match.
    assert_eq!(code_of(mb.request_stop("a", "b", "because", "other")), stop_code::APPROVAL_REQUIRED);
    assert_eq!(code_of(mb.request_stop("a", "d", "because", "call")), stop_code::APPROVAL_REQUIRED);
    assert_eq!(code_of(mb.request_stop("a", "b", "changed", "call")), stop_code::APPROVAL_REQUIRED);
    // Approved for another session's call: not this caller's.
    mb.approve_stop("d", "dcall", "b", "because").unwrap();
    assert_eq!(code_of(mb.request_stop("a", "b", "because", "dcall")), stop_code::APPROVAL_REQUIRED);
    // The matching approval works once.
    mb.request_stop("a", "b", "because", "call").unwrap();
    assert_eq!(
        code_of(mb.request_stop("a", "b", "because", "call")),
        stop_code::APPROVAL_REQUIRED
    );
    assert!(mb.read_stops().unwrap().len() == 1);
}

#[test]
fn the_reason_is_bounded_and_scrubbed() {
    let fx = Fixture::new("reason");
    let (mb, _) = setup(&fx);
    assert_eq!(code_of(mb.approve_stop("a", "c", "b", "  ")), stop_code::INVALID_REASON);
    let long = "x".repeat(MAX_STOP_REASON_CHARS + 1);
    assert_eq!(code_of(mb.approve_stop("a", "c", "b", &long)), stop_code::INVALID_REASON);
    assert_eq!(code_of(mb.request_stop("a", "b", &long, "c")), stop_code::INVALID_REASON);

    let secret = "stop: key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA leaked";
    approve(&mb, "c", "b", secret);
    let req = mb.request_stop("a", "b", secret, "c").unwrap();
    assert!(!req.reason.contains("AAAAAAAAAAAAAAAAAAAAAAAA"), "{}", req.reason);
    let raw = std::fs::read_to_string(fx.data.join("mailbox/stops.json")).unwrap();
    assert!(!raw.contains("AAAAAAAAAAAAAAAAAAAAAAAA"));
}

#[test]
fn a_request_is_only_visible_to_and_resolvable_by_its_target() {
    let fx = Fixture::new("forged");
    let (mb, _) = setup(&fx);
    approve(&mb, "call", "b", "r");
    let req = mb.request_stop("a", "b", "r", "call").unwrap();
    // A forged or misrouted event naming another session finds nothing.
    assert!(mb.pending_stop("a", &req.id).unwrap().is_none());
    assert!(mb.pending_stop("c", &req.id).unwrap().is_none());
    assert!(mb.pending_stop("b", "stop-made-up").unwrap().is_none());
    assert_eq!(
        code_of(mb.resolve_stop("c", &req.id, true, Some("run-b1"))),
        stop_code::UNKNOWN_STOP_REQUEST
    );
    assert_eq!(
        code_of(mb.resolve_stop("b", "stop-made-up", true, None)),
        stop_code::UNKNOWN_STOP_REQUEST
    );
    // Still pending for its real target.
    assert!(mb.pending_stop("b", &req.id).unwrap().is_some());
}

fn tool_ctx<'a>(root: &'a Path, session: Option<&'a str>, data: Option<&'a Path>, call: Option<&'a str>) -> crate::tools::ToolContext<'a> {
    let mut ctx = crate::tools::ToolContext::new(root, root, &[]).in_session(session, false);
    if let Some(d) = data {
        ctx = ctx.with_mailbox(d);
    }
    if let Some(c) = call {
        ctx = ctx.with_call_id(c);
    }
    ctx
}

async fn call_tool(args: serde_json::Value, ctx: &crate::tools::ToolContext<'_>) -> String {
    let tool = crate::tools::lookup("stop_session").unwrap();
    crate::tools::handlers::execute_builtin(tool, &args, ctx).await.0
}

fn error_code(out: &str) -> String {
    let body = out.strip_prefix("ERROR: ").unwrap_or_else(|| panic!("not an error: {out}"));
    let v: serde_json::Value = serde_json::from_str(body).unwrap();
    v["error"]["code"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn the_tool_refuses_without_a_session_scope_or_an_approval_and_reports_the_outcome() {
    let fx = Fixture::new("tool");
    // Wall clock: the tool opens its own mailbox.
    let mb = Mailbox::open(&fx.data);
    mb.register("a", "Alpha", fx.folder()).unwrap();
    mb.register("b", "Beta", fx.folder()).unwrap();
    mb.set_status("a", true, Some("run-a")).unwrap();
    mb.set_status("b", true, Some("run-b")).unwrap();
    let root = fx.project.clone();
    let args = serde_json::json!({ "session_id": "b", "reason": "same file" });

    // A chat thread (no session, no mailbox) and a subagent child: not available.
    let thread = tool_ctx(&root, None, None, Some("t1"));
    assert_eq!(error_code(&call_tool(args.clone(), &thread).await), code::NOT_AVAILABLE);
    let child = tool_ctx(&root, Some("a"), None, Some("t1"));
    assert_eq!(error_code(&call_tool(args.clone(), &child).await), code::NOT_AVAILABLE);

    // Session scope with no approval recorded: refused, nothing written.
    let unapproved = tool_ctx(&root, Some("a"), Some(&fx.data), Some("t1"));
    assert_eq!(
        error_code(&call_tool(args.clone(), &unapproved).await),
        stop_code::APPROVAL_REQUIRED
    );
    let no_call = tool_ctx(&root, Some("a"), Some(&fx.data), None);
    assert_eq!(
        error_code(&call_tool(args.clone(), &no_call).await),
        stop_code::APPROVAL_REQUIRED
    );
    assert!(!fx.data.join("mailbox/stops.json").exists());
    let bad = tool_ctx(&root, Some("a"), Some(&fx.data), Some("t1"));
    assert_eq!(
        error_code(&call_tool(serde_json::json!({ "session_id": "b" }), &bad).await),
        code::INVALID_ARGUMENTS
    );

    // Approved: the target's side applies it while the tool waits.
    mb.approve_stop("a", "t2", "b", "same file").unwrap();
    let resolver = {
        let mb = mb.clone();
        tokio::spawn(async move {
            for _ in 0..200 {
                if let Ok(stops) = mb.read_stops() {
                    if let Some(req) = stops.values().next() {
                        let pending = mb.pending_stop("b", &req.id).unwrap().unwrap();
                        mb.resolve_stop("b", &pending.id, true, Some(&pending.target_run_id))
                            .unwrap();
                        return;
                    }
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
    };
    let approved = tool_ctx(&root, Some("a"), Some(&fx.data), Some("t2"));
    let out = call_tool(args, &approved).await;
    resolver.await.unwrap();
    let v: serde_json::Value = serde_json::from_str(&out).unwrap_or_else(|_| panic!("{out}"));
    assert_eq!(v["status"], "applied");
    assert_eq!(v["target"]["session_id"], "b");
    assert_eq!(v["target"]["display_name"], "Beta");
}

#[test]
fn stop_session_is_a_session_only_write_tool_the_gate_does_not_prompt_for() {
    let t = crate::tools::lookup("stop_session").unwrap();
    assert_eq!(t.capability, crate::tools::Capability::Write);
    assert!(t.path_args.is_empty());
    assert!(crate::tools::is_mailbox_tool("stop_session"));
    assert!(!crate::tools::advertised_in_scope("stop_session", false));
    assert!(crate::tools::advertised_in_scope("stop_session", true));
    assert_eq!(
        crate::readiness::required_capabilities("stop_session"),
        vec![crate::readiness::capability::FS_WRITE]
    );
}
