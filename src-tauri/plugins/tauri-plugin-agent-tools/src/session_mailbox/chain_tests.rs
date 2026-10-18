//! The chain guard (live test 8: a ring of sessions relaying fresh messages
//! woke more than one lap) and the archive / self-name refusals.

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
            "jan_chain_{tag}_{}_{}",
            std::process::id(),
            n
        ));
        let _ = std::fs::remove_dir_all(&base);
        let data = base.join("data");
        let project = base.join("project");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        Self {
            base,
            data,
            project,
        }
    }

    fn folder(&self) -> Option<&str> {
        self.project.to_str()
    }
}

impl Drop for Fx {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

/// What the renderer does when it wakes an idle session for its mail: claim
/// every unread envelope into the conversation, then start a run.
fn wake(mb: &Mailbox, sid: &str, run: &str) -> Vec<MailEnvelope> {
    let pending = mb.pending(sid).unwrap();
    let ids: Vec<String> = pending.iter().map(|e| e.id.clone()).collect();
    mb.claim(sid, &ids).unwrap();
    mb.set_status(sid, true, Some(run)).unwrap();
    pending
}

fn end(mb: &Mailbox, sid: &str, run: &str) {
    mb.set_status(sid, false, Some(run)).unwrap();
}

fn envelope(mb: &Mailbox, to: &str, id: &str) -> MailEnvelope {
    mb.pending(to)
        .unwrap()
        .into_iter()
        .find(|e| e.id == id)
        .expect("the envelope")
}

/// The ring from the live test, with every session forwarding as soon as it is
/// woken. Returns how many sessions were woken by relayed mail.
fn run_ring(mb: &Mailbox, ring: &[&str]) -> usize {
    // A user-started run in the first session sends the first message.
    mb.set_status(ring[0], true, Some("user-run")).unwrap();
    mb.send(ring[0], ring[1], "pass it on", None, Origin::Agent)
        .unwrap();
    end(mb, ring[0], "user-run");
    let mut wakes = 0;
    let mut at = 1;
    for lap in 0..20 {
        let sid = ring[at % ring.len()];
        let next = ring[(at + 1) % ring.len()];
        let mail = mb.pending(sid).unwrap();
        // Held mail does not wake its session.
        if mail.is_empty() || mail.iter().all(|e| e.hold.is_some()) {
            break;
        }
        let run = format!("wake-{lap}");
        wake(mb, sid, &run);
        wakes += 1;
        let sent = mb.send(sid, next, "pass it on", None, Origin::Agent);
        end(mb, sid, &run);
        match sent {
            Ok(_) => at += 1,
            Err(e) => {
                assert_eq!(e.code, code::CHAIN_LIMIT, "{e:?}");
                assert!(e.message.contains("ask"), "{}", e.message);
                break;
            }
        }
    }
    wakes
}

fn ring_mailbox(fx: &Fx, n: usize) -> (Mailbox, Vec<String>) {
    let mb = Mailbox::open(&fx.data).with_clock(Arc::new(AtomicI64::new(1_000_000)));
    let ids: Vec<String> = (1..=n).map(|i| format!("r{i}")).collect();
    for id in &ids {
        mb.register(id, &format!("Ring{}", &id[1..]), fx.folder())
            .unwrap();
    }
    (mb, ids)
}

#[test]
fn a_ring_of_five_never_wakes_more_than_max_hops_sessions() {
    let fx = Fx::new("ring");
    let (mb, ids) = ring_mailbox(&fx, 5);
    let ring: Vec<&str> = ids.iter().map(String::as_str).collect();
    let wakes = run_ring(&mb, &ring);
    assert_eq!(wakes, usize::from(DEFAULT_MAX_HOPS));
    // Nothing went round the ring a second time.
    assert!(mb.pending("r1").unwrap().is_empty());
}

#[test]
fn hops_and_chain_id_are_stamped_along_the_chain() {
    let fx = Fx::new("stamp");
    let (mb, _) = ring_mailbox(&fx, 3);
    mb.set_status("r1", true, Some("u")).unwrap();
    let first = mb.send("r1", "r2", "go", None, Origin::Agent).unwrap();
    let e1 = envelope(&mb, "r2", &first.message_id);
    assert_eq!((e1.hops, e1.chain_id.as_str()), (0, first.message_id.as_str()));
    assert_eq!(e1.chain_path, vec!["r1".to_string()]);

    wake(&mb, "r2", "w");
    let second = mb.send("r2", "r3", "go on", None, Origin::Agent).unwrap();
    let e2 = envelope(&mb, "r3", &second.message_id);
    assert_eq!(e2.hops, 1);
    assert_eq!(e2.chain_id, first.message_id);
    assert_eq!(e2.chain_path, vec!["r1".to_string(), "r2".to_string()]);
}

#[test]
fn a_user_message_or_a_user_run_starts_a_new_chain() {
    let fx = Fx::new("reset");
    let (mb, _) = ring_mailbox(&fx, 3);
    mb.set_status("r1", true, Some("u")).unwrap();
    mb.send("r1", "r2", "go", None, Origin::Agent).unwrap();
    wake(&mb, "r2", "w");
    let relayed = mb.send("r2", "r3", "relay", None, Origin::Agent).unwrap();
    assert_eq!(envelope(&mb, "r3", &relayed.message_id).hops, 1);
    end(&mb, "r2", "w");

    // The next run in r2 was started by the user (nothing handed to it).
    mb.set_status("r2", true, Some("typed")).unwrap();
    let fresh = mb.send("r2", "r3", "my own", None, Origin::Agent).unwrap();
    let e = envelope(&mb, "r3", &fresh.message_id);
    assert_eq!((e.hops, e.chain_id.as_str()), (0, fresh.message_id.as_str()));
    end(&mb, "r2", "typed");

    // The Reply form (origin user) starts one too, even from a woken run.
    let woken = wake(&mb, "r3", "w3");
    let reply = mb.reply("r3", &woken[0].id, "from the person").unwrap();
    let e = envelope(&mb, "r2", &reply.message_id);
    assert_eq!(e.hops, 0);
    assert_eq!(e.origin, Origin::User);
}

#[test]
fn a_chain_that_comes_back_round_twice_is_held_not_woken() {
    let fx = Fx::new("cycle");
    let (mb, _) = ring_mailbox(&fx, 2);
    // The hop limit would stop a two-session loop first, so the chain is
    // seeded mid-way with the path it would have.
    let mut chained = MailEnvelope {
        v: 1,
        id: "msg-seed".into(),
        from: MailFrom {
            session_id: "r2".into(),
            display_name: "Ring2".into(),
        },
        to: MailTo {
            session_id: "r1".into(),
        },
        project: String::new(),
        text: "x".into(),
        created_at: 0,
        reply_to: None,
        depth: 0,
        origin: Origin::Agent,
        chain_id: "chain-1".into(),
        hops: 1,
        chain_path: vec!["r1".into(), "r2".into()],
        hold: None,
    };
    append_jsonl(&mb.inbox_path("r1"), &chained).unwrap();
    wake(&mb, "r1", "w1");
    // r1's run continues the chain; r2 is in the path once already, so this
    // is its second visit: still allowed.
    let second = mb.send("r1", "r2", "again", None, Origin::Agent).unwrap();
    assert_eq!(envelope(&mb, "r2", &second.message_id).hold, None);
    end(&mb, "r1", "w1");

    // A path that already visited r2 twice: the next visit is held.
    chained.id = "msg-seed-2".into();
    chained.chain_path = vec!["r1".into(), "r2".into(), "r1".into(), "r2".into()];
    chained.hops = 2;
    append_jsonl(&mb.inbox_path("r1"), &chained).unwrap();
    wake(&mb, "r1", "w2");
    let third = mb.send("r1", "r2", "and again", None, Origin::Agent).unwrap();
    assert_eq!(
        envelope(&mb, "r2", &third.message_id).hold.as_deref(),
        Some(hold::CHAIN_CYCLE)
    );
}

#[test]
fn one_chain_wakes_a_session_at_most_three_times_and_relays_six_a_minute() {
    let fx = Fx::new("wakecap");
    let mb = Mailbox::open(&fx.data).with_clock(Arc::new(AtomicI64::new(1_000_000)));
    for (id, name) in [("hub", "Hub"), ("t", "Target")] {
        mb.register(id, name, fx.folder()).unwrap();
    }
    for i in 0..8 {
        mb.register(&format!("s{i}"), &format!("S{i}"), fx.folder())
            .unwrap();
    }
    // One chain arms each sender in turn; each relays to `t`.
    mb.set_status("hub", true, Some("u")).unwrap();
    let seed = mb.send("hub", "s0", "seed", None, Origin::Agent).unwrap();
    wake(&mb, "s0", "w");
    let mut holds = Vec::new();
    for _ in 0..4 {
        let r = mb.send("s0", "t", "relay", None, Origin::Agent).unwrap();
        holds.push(envelope(&mb, "t", &r.message_id).hold);
    }
    assert_eq!(&holds[..3], &[None, None, None]);
    assert_eq!(holds[3].as_deref(), Some(hold::CHAIN_WAKES));
    let _ = seed;

    // Many chains, one target: the 7th relayed wake-up in a minute is held.
    let fx2 = Fx::new("wakerate");
    let mb2 = Mailbox::open(&fx2.data).with_clock(Arc::new(AtomicI64::new(1_000_000)));
    mb2.register("t", "Target", fx2.folder()).unwrap();
    let mut rate_holds = Vec::new();
    for i in 0..7 {
        let (u, s) = (format!("u{i}"), format!("s{i}"));
        mb2.register(&u, &u, fx2.folder()).unwrap();
        mb2.register(&s, &s, fx2.folder()).unwrap();
        mb2.set_status(&u, true, Some("u")).unwrap();
        mb2.send(&u, &s, "seed", None, Origin::Agent).unwrap();
        wake(&mb2, &s, "w");
        let r = mb2.send(&s, "t", "relay", None, Origin::Agent).unwrap();
        rate_holds.push(envelope(&mb2, "t", &r.message_id).hold);
    }
    assert!(rate_holds[..6].iter().all(Option::is_none), "{rate_holds:?}");
    assert_eq!(rate_holds[6].as_deref(), Some(hold::WAKE_RATE));
}

#[test]
fn max_hops_is_read_from_agent_toml_and_an_untrusted_folder_only_lowers_it() {
    let fx = Fx::new("cfg");
    let dir = fx.project.join(".jan").join("agent");
    std::fs::create_dir_all(&dir).unwrap();
    assert_eq!(max_hops_in(&fx.project, false), DEFAULT_MAX_HOPS);
    std::fs::write(dir.join("agent.toml"), "[messaging]\nmax_hops = 2\n").unwrap();
    assert_eq!(max_hops_in(&fx.project, false), 2);
    std::fs::write(dir.join("agent.toml"), "[messaging]\nmax_hops = 9\n").unwrap();
    assert_eq!(max_hops_in(&fx.project, true), 9);
    assert_eq!(max_hops_in(&fx.project, false), DEFAULT_MAX_HOPS);
    std::fs::write(dir.join("agent.toml"), "[messaging]\nmax_hops = 500\n").unwrap();
    assert_eq!(max_hops_in(&fx.project, true), MAX_HOPS_CEILING);
    std::fs::write(dir.join("agent.toml"), "[messaging]\nmax_hops = 0\n").unwrap();
    assert_eq!(max_hops_in(&fx.project, true), 1);

    // The send path reads it: a ring stops after two wake-ups.
    std::fs::write(dir.join("agent.toml"), "[messaging]\nmax_hops = 2\n").unwrap();
    let (mb, ids) = ring_mailbox(&fx, 5);
    let ring: Vec<&str> = ids.iter().map(String::as_str).collect();
    assert_eq!(run_ring(&mb, &ring), 2);
}

#[test]
fn chain_state_survives_a_restart() {
    let fx = Fx::new("restart");
    let (mb, _) = ring_mailbox(&fx, 3);
    mb.set_status("r1", true, Some("u")).unwrap();
    mb.send("r1", "r2", "go", None, Origin::Agent).unwrap();
    wake(&mb, "r2", "w");
    let sent = mb.send("r2", "r3", "relay", None, Origin::Agent).unwrap();

    // A new process: the envelope keeps its chain fields on disk.
    let again = Mailbox::open(&fx.data).with_epoch("after-restart");
    let e = envelope(&again, "r3", &sent.message_id);
    assert_eq!(e.hops, 1);
    assert_eq!(e.chain_path, vec!["r1".to_string(), "r2".to_string()]);
    assert_eq!(e.created_at, 1_000_000);
    // ...and an armed chain waits in the registry for the run it wakes.
    again.claim("r3", std::slice::from_ref(&sent.message_id)).unwrap();
    let after = Mailbox::open(&fx.data).with_epoch("third");
    let armed = after.session("r3").unwrap().armed_chain.expect("armed");
    assert_eq!(armed.hops, 1);
}

#[tokio::test]
async fn tool_arguments_cannot_forge_or_reset_the_chain() {
    let fx = Fx::new("forge");
    let (mb, _) = ring_mailbox(&fx, 3);
    mb.set_status("r1", true, Some("u")).unwrap();
    mb.send("r1", "r2", "go", None, Origin::Agent).unwrap();
    wake(&mb, "r2", "w");
    let root = fx.project.clone();
    let ctx = crate::tools::ToolContext::new(&root, &root, &[])
        .in_session(Some("r2"), false)
        .with_mailbox(&fx.data);
    let tool = crate::tools::lookup("send_message").unwrap();
    let args = serde_json::json!({
        "to": "Ring3",
        "message": "relay",
        "hops": 0,
        "chain_id": "fresh",
        "chainId": "fresh",
        "chain_path": [],
        "origin": "user",
    });
    let out = crate::tools::handlers::execute_builtin(tool, &args, &ctx)
        .await
        .0;
    let v: serde_json::Value = serde_json::from_str(&out).expect(&out);
    let id = v["message_id"].as_str().unwrap();
    let e = envelope(&mb, "r3", id);
    assert_eq!(e.hops, 1);
    assert_eq!(e.origin, Origin::Agent);
    assert_ne!(e.chain_id, "fresh");
}

#[test]
fn archived_sessions_get_no_mail_and_are_not_listed_until_restored() {
    let fx = Fx::new("archive");
    let (mb, _) = ring_mailbox(&fx, 2);
    mb.set_archived("r2", true).unwrap();
    assert_eq!(
        mb.send("r1", "r2", "hi", None, Origin::Agent)
            .unwrap_err()
            .code,
        code::SESSION_ARCHIVED
    );
    assert!(mb.list_sessions("r1").unwrap().is_empty());
    let all = mb.list_sessions_with("r1", true).unwrap();
    assert_eq!(all.len(), 1);
    assert!(all[0].archived);

    // A restore registers the session again.
    mb.register("r2", "Ring2", fx.folder()).unwrap();
    assert_eq!(mb.list_sessions("r1").unwrap().len(), 1);
    mb.send("r1", "r2", "hi", None, Origin::Agent).unwrap();
}
