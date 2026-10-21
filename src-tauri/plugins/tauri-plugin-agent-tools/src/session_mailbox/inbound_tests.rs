use super::*;
use std::sync::atomic::AtomicUsize;

static COUNTER: AtomicUsize = AtomicUsize::new(0);

struct Fx {
    base: PathBuf,
    data: PathBuf,
    project: PathBuf,
}

impl Fx {
    fn new(tag: &str) -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let base = std::env::temp_dir().join(format!(
            "jan_mailbox_inb_{tag}_{}_{}",
            std::process::id(),
            n
        ));
        let _ = std::fs::remove_dir_all(&base);
        let data = base.join("data");
        let project = base.join("project");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        Self { base, data, project }
    }

    fn folder(&self) -> Option<&str> {
        self.project.to_str()
    }

    /// A mailbox on a clock the test moves, with `a` (asker) and `b` (target).
    fn mailbox(&self) -> (Mailbox, Arc<AtomicI64>) {
        let t = Arc::new(AtomicI64::new(1_000_000));
        let mb = Mailbox::open(&self.data).with_clock(t.clone());
        mb.register("a", "Alpha", self.folder()).unwrap();
        mb.register("b", "Beta", self.folder()).unwrap();
        (mb, t)
    }
}

impl Drop for Fx {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

fn hold(mb: &Mailbox, fx: &Fx, id: &str) {
    mb.register_inbound(id, id, fx.folder(), None, Some(Inbound::Hold), None, None)
        .unwrap();
}

fn notices(mb: &Mailbox, id: &str) -> Vec<MailEnvelope> {
    mb.pending(id)
        .unwrap()
        .into_iter()
        .filter(|e| e.origin == Origin::Notice)
        .collect()
}

#[test]
fn legacy_accept_flag_maps_to_accept_and_refuse() {
    let fx = Fx::new("legacy");
    let (mb, _) = fx.mailbox();
    assert_eq!(mb.session("b").unwrap().inbound_mode(), Inbound::Accept);
    mb.register_with("b", "Beta", fx.folder(), Some(false)).unwrap();
    assert_eq!(mb.session("b").unwrap().inbound_mode(), Inbound::Refuse);
    assert_eq!(
        mb.send("a", "b", "hi", None, Origin::Agent).unwrap_err().code,
        code::RECIPIENT_OPTED_OUT
    );
    mb.register_with("b", "Beta", fx.folder(), Some(true)).unwrap();
    assert_eq!(mb.session("b").unwrap().inbound_mode(), Inbound::Accept);
}

#[test]
fn a_record_written_before_inbound_existed_behaves_as_before() {
    let on: SessionRecord = serde_json::from_str(
        r#"{"id":"x","displayName":"X","project":null,"status":"idle","updatedAt":1}"#,
    )
    .unwrap();
    assert_eq!(on.inbound_mode(), Inbound::Accept);
    let off: SessionRecord = serde_json::from_str(
        r#"{"id":"x","displayName":"X","project":null,"acceptsMessages":false,"status":"idle","updatedAt":1}"#,
    )
    .unwrap();
    assert_eq!(off.inbound_mode(), Inbound::Refuse);
}

#[test]
fn an_accepting_flag_leaves_a_hold_alone_and_refusal_replaces_it() {
    let fx = Fx::new("flag_vs_hold");
    let (mb, _) = fx.mailbox();
    hold(&mb, &fx, "b");
    mb.register_with("b", "Beta", fx.folder(), Some(true)).unwrap();
    assert_eq!(mb.session("b").unwrap().inbound_mode(), Inbound::Hold);
    mb.register_with("b", "Beta", fx.folder(), Some(false)).unwrap();
    assert_eq!(mb.session("b").unwrap().inbound_mode(), Inbound::Refuse);
    mb.register_with("b", "Beta", fx.folder(), Some(true)).unwrap();
    assert_eq!(mb.session("b").unwrap().inbound_mode(), Inbound::Accept);
}

#[test]
fn a_held_message_is_stored_but_not_delivered_until_approved() {
    let fx = Fx::new("approve");
    let (mb, _) = fx.mailbox();
    hold(&mb, &fx, "b");
    let sent = mb.send("a", "b", "please look", None, Origin::Agent).unwrap();
    assert!(sent.held);
    assert!(mb.pending("b").unwrap().is_empty());
    assert!(mb.take_for_delivery("b").unwrap().is_empty());
    assert!(mb.read_messages("b", true).unwrap().is_empty());
    let held = mb.held_messages("b").unwrap();
    assert_eq!(held.len(), 1);
    assert!(held[0].inbound_hold);

    assert!(mb.approve_held("b", &sent.message_id).unwrap());
    let taken = mb.take_for_delivery("b").unwrap();
    assert_eq!(taken.len(), 1);
    assert_eq!(taken[0].id, sent.message_id);
    // Once: a second approval finds nothing held, and nothing is redelivered.
    assert!(!mb.approve_held("b", &sent.message_id).unwrap());
    assert!(mb.take_for_delivery("b").unwrap().is_empty());
    assert!(mb.held_messages("b").unwrap().is_empty());
}

#[test]
fn a_denied_message_is_dropped_and_never_delivered() {
    let fx = Fx::new("deny");
    let (mb, _) = fx.mailbox();
    hold(&mb, &fx, "b");
    let sent = mb.send("a", "b", "do it", None, Origin::Agent).unwrap();
    assert!(mb.deny_held("b", &sent.message_id).unwrap());
    assert!(mb.held_messages("b").unwrap().is_empty());
    assert!(mb.pending("b").unwrap().is_empty());
    assert!(!mb.approve_held("b", &sent.message_id).unwrap());
    assert!(mb.take_for_delivery("b").unwrap().is_empty());
}

#[test]
fn an_unanswered_held_message_expires_and_the_sender_is_told() {
    let fx = Fx::new("expire");
    let (mb, t) = fx.mailbox();
    hold(&mb, &fx, "b");
    let sent = mb.send("a", "b", "hello?", None, Origin::Agent).unwrap();
    t.fetch_add(HELD_TTL_MS - 1, Ordering::SeqCst);
    assert_eq!(mb.held_messages("b").unwrap().len(), 1);
    assert!(notices(&mb, "a").is_empty());

    t.fetch_add(1, Ordering::SeqCst);
    assert!(mb.held_messages("b").unwrap().is_empty());
    assert!(!mb.approve_held("b", &sent.message_id).unwrap());
    let told = notices(&mb, "a");
    assert_eq!(told.len(), 1);
    assert!(told[0].text.contains(&sent.message_id));
    assert!(told[0].text.contains("expired"));
    assert_eq!(told[0].from.session_id, "b");
}

#[test]
fn an_expired_notice_is_not_announced_again() {
    let fx = Fx::new("notice_expire");
    let (mb, t) = fx.mailbox();
    hold(&mb, &fx, "a");
    hold(&mb, &fx, "b");
    // b's message to a is held; when it expires, b gets one notice, which a's
    // hold does not matter for, and b's hold keeps that notice waiting.
    mb.send("b", "a", "ping", None, Origin::Agent).unwrap();
    t.fetch_add(HELD_TTL_MS, Ordering::SeqCst);
    assert!(mb.held_messages("a").unwrap().is_empty());
    assert_eq!(mb.held_messages("b").unwrap().len(), 1);
    t.fetch_add(HELD_TTL_MS, Ordering::SeqCst);
    // The notice itself expires without a notice of its own.
    assert!(mb.held_messages("b").unwrap().is_empty());
    assert!(mb.held_messages("a").unwrap().is_empty());
}

#[test]
fn at_most_100_are_held_and_the_oldest_is_dropped() {
    let fx = Fx::new("cap");
    let (mb, t) = fx.mailbox();
    hold(&mb, &fx, "b");
    let mut first = None;
    for i in 0..=MAX_HELD_PER_SESSION {
        let id = format!("s{i}");
        mb.register(&id, &id, fx.folder()).unwrap();
        t.fetch_add(10, Ordering::SeqCst);
        let r = mb.send(&id, "b", "x", None, Origin::Agent).unwrap();
        if i == 0 {
            first = Some(r.message_id);
        }
    }
    let held = mb.held_messages("b").unwrap();
    assert_eq!(held.len(), MAX_HELD_PER_SESSION);
    assert!(held.iter().all(|e| Some(&e.id) != first.as_ref()));
    let told = notices(&mb, "s0");
    assert_eq!(told.len(), 1);
    assert!(told[0].text.contains("dropped"));
}

#[test]
fn a_held_reply_does_not_satisfy_wait_for_reply() {
    let fx = Fx::new("held_reply");
    let (mb, _) = fx.mailbox();
    let asked = mb.send("a", "b", "q", None, Origin::Agent).unwrap();
    hold(&mb, &fx, "a");
    mb.send("b", "a", "answer", Some(&asked.message_id), Origin::Agent)
        .unwrap();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let outcome = rt
        .block_on(mb.wait_for_reply("a", &asked.message_id, Duration::from_millis(300), None))
        .unwrap();
    assert!(matches!(outcome, WaitOutcome::Timeout | WaitOutcome::TargetUnavailable));
    let held = mb.held_messages("a").unwrap();
    assert_eq!(held.len(), 1);
    mb.approve_held("a", &held[0].id).unwrap();
    let outcome = rt
        .block_on(mb.wait_for_reply("a", &asked.message_id, Duration::from_millis(300), None))
        .unwrap();
    assert!(matches!(outcome, WaitOutcome::Reply(_)));
}

#[test]
fn a_notice_is_never_answered_automatically() {
    let fx = Fx::new("notice_noreply");
    let (mb, _) = fx.mailbox();
    mb.subscribe_idle("a", "b").unwrap();
    mb.set_status("b", true, Some("r1")).unwrap();
    mb.set_status("b", false, Some("r1")).unwrap();
    let n = notices(&mb, "a").pop().unwrap();
    assert!(mb.auto_reply("a", &n.id, "thanks").unwrap().is_none());
}

#[test]
fn a_subscription_fires_once_when_the_target_finishes_a_turn() {
    let fx = Fx::new("sub_idle");
    let (mb, _) = fx.mailbox();
    let sub = mb.subscribe_idle("a", "b").unwrap();
    assert!(sub.expires_at > 1_000_000);
    mb.set_status("b", true, Some("r1")).unwrap();
    assert!(notices(&mb, "a").is_empty());
    mb.set_status("b", false, Some("r1")).unwrap();
    let got = notices(&mb, "a");
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].origin, Origin::Notice);
    assert_eq!(got[0].from.session_id, "b");
    assert!(got[0].text.contains("idle"));
    // One notice only.
    mb.set_status("b", true, Some("r2")).unwrap();
    mb.set_status("b", false, Some("r2")).unwrap();
    assert_eq!(notices(&mb, "a").len(), 1);
    assert!(mb.idle_subscriptions("a").is_empty());
}

#[test]
fn a_turn_that_ends_with_mail_queued_does_not_fire() {
    let fx = Fx::new("sub_queued");
    let (mb, _) = fx.mailbox();
    mb.subscribe_idle("a", "b").unwrap();
    mb.set_status("b", true, Some("r1")).unwrap();
    mb.send("a", "b", "more work", None, Origin::Agent).unwrap();
    mb.set_status("b", false, Some("r1")).unwrap();
    assert!(notices(&mb, "a").is_empty());
    assert_eq!(mb.idle_subscriptions("a").len(), 1);
    // The next turn takes the mail and finishes with nothing queued.
    mb.take_for_delivery("b").unwrap();
    mb.set_status("b", true, Some("r2")).unwrap();
    mb.set_status("b", false, Some("r2")).unwrap();
    assert_eq!(notices(&mb, "a").len(), 1);
}

#[test]
fn a_deleted_target_fires_its_subscription() {
    let fx = Fx::new("sub_deleted");
    let (mb, _) = fx.mailbox();
    mb.subscribe_idle("a", "b").unwrap();
    mb.remove("b").unwrap();
    let got = notices(&mb, "a");
    assert_eq!(got.len(), 1);
    assert!(got[0].text.contains("deleted"));
}

#[test]
fn a_subscription_lapses_after_12_hours_and_the_asker_is_told() {
    let fx = Fx::new("sub_expire");
    let (mb, t) = fx.mailbox();
    mb.subscribe_idle("a", "b").unwrap();
    t.fetch_add(IDLE_SUB_TTL_MS - 1, Ordering::SeqCst);
    mb.pending("a").unwrap();
    assert!(notices(&mb, "a").is_empty());
    t.fetch_add(1, Ordering::SeqCst);
    let got = notices(&mb, "a");
    assert_eq!(got.len(), 1);
    assert!(got[0].text.contains("expired"));
    assert!(mb.idle_subscriptions("a").is_empty());
    // A turn ending now sends nothing more.
    mb.set_status("b", true, Some("r1")).unwrap();
    mb.set_status("b", false, Some("r1")).unwrap();
    assert_eq!(notices(&mb, "a").len(), 1);
}

#[test]
fn a_notice_for_an_asker_that_holds_mail_waits_for_approval() {
    let fx = Fx::new("sub_hold");
    let (mb, _) = fx.mailbox();
    hold(&mb, &fx, "a");
    mb.subscribe_idle("a", "b").unwrap();
    mb.set_status("b", true, Some("r1")).unwrap();
    mb.set_status("b", false, Some("r1")).unwrap();
    assert!(notices(&mb, "a").is_empty());
    let held = mb.held_messages("a").unwrap();
    assert_eq!(held.len(), 1);
    assert_eq!(held[0].origin, Origin::Notice);
}

#[test]
fn subscriptions_are_bounded_and_never_target_the_asker() {
    let fx = Fx::new("sub_limits");
    let (mb, _) = fx.mailbox();
    assert_eq!(mb.subscribe_idle("a", "a").unwrap_err().code, code::SELF_TARGET);
    assert_eq!(
        mb.subscribe_idle("a", "nobody").unwrap_err().code,
        code::UNKNOWN_SESSION
    );
    for i in 0..MAX_IDLE_SUBS_PER_SESSION {
        let id = format!("t{i}");
        mb.register(&id, &id, fx.folder()).unwrap();
        mb.subscribe_idle("a", &id).unwrap();
    }
    mb.register("extra", "extra", fx.folder()).unwrap();
    assert_eq!(
        mb.subscribe_idle("a", "extra").unwrap_err().code,
        code::RATE_LIMITED
    );
    // Asking again about a known target restarts it rather than counting twice.
    mb.subscribe_idle("a", "t0").unwrap();
}

#[test]
fn an_idle_target_with_nothing_queued_reports_idle_now() {
    let fx = Fx::new("idle_now");
    let (mb, _) = fx.mailbox();
    assert!(mb.idle_now("b"));
    mb.send("a", "b", "x", None, Origin::Agent).unwrap();
    assert!(!mb.idle_now("b"));
    mb.take_for_delivery("b").unwrap();
    assert!(mb.idle_now("b"));
    mb.set_status("b", true, Some("r")).unwrap();
    assert!(!mb.idle_now("b"));
}
