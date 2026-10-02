use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use futures_util::future::BoxFuture;

type Post = Box<dyn Fn(Value, String, Duration) -> BoxFuture<'static, Result<SystemOneResponse, CallError>> + Send + Sync>;

type Seen = Arc<Mutex<Vec<(Value, String)>>>;

/// A stand-in for TypeSafe that counts calls and answers with `reply`.
fn fake(reply: Result<Value, CallError>) -> (Post, Arc<AtomicUsize>, Seen) {
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (c, s) = (calls.clone(), seen.clone());
    let post: Post = Box::new(move |body, key, _timeout| {
        c.fetch_add(1, Ordering::SeqCst);
        s.lock().unwrap().push((body, key));
        let reply = reply.clone();
        Box::pin(async move { reply.and_then(|v| client::parse(v.to_string().as_bytes())) })
    });
    (post, calls, seen)
}

fn modes(skills: Mode, rerank: Mode) -> Modes {
    Modes { skills, rerank }
}

fn skills() -> Vec<SkillOption> {
    vec![
        SkillOption { name: "pdf-forms".into(), description: "Fill and read PDF forms".into() },
        SkillOption { name: "release-notes".into(), description: "Draft release notes from git history".into() },
    ]
}

fn choice(choice: &str, p: f64) -> Value {
    json!({
        "model": "jev-1.13.0",
        "answers": { "skill": { "type": "choice", "choice": choice, "confidence": p,
                                 "probabilities": { choice: p } } },
        "usage": { "input_tokens": 300, "output_tokens": 20 }
    })
}

const PRIVATE: &str = "fill in the NDA for ACME-SECRET-7731";

#[test]
fn the_opt_ins_default_to_off_and_unreadable_settings_are_off() {
    assert_eq!(modes_from_settings(None), Modes::default());
    assert_eq!(modes_from_settings(Some("not json")), Modes::default());
    assert_eq!(
        modes_from_settings(Some(r#"{"state":{"skillMode":"shadow","rerankMode":"on"},"version":0}"#)),
        modes(Mode::Shadow, Mode::On)
    );
    assert_eq!(
        modes_from_settings(Some(r#"{"state":{"skillMode":"yes"}}"#)),
        Modes::default(),
        "an unknown value is not an opt-in"
    );
}

#[tokio::test]
async fn off_means_no_typesafe_request_for_either_feature() {
    let (post, calls, _) = fake(Ok(choice("s0", 0.99)));
    let deps = Deps { modes: Modes::default(), key: Some("ts-key".into()), post: &post };
    let d = suggest_skill(&deps, PRIVATE, &skills()).await;
    assert_eq!(d.skill, None);
    assert_eq!(d.fallback, Some(Fallback::Disabled));
    let cands = vec![
        Candidate { id: "a".into(), text: "x".into() },
        Candidate { id: "b".into(), text: "y".into() },
    ];
    let r = rerank(&deps, "q", &cands, 1).await;
    assert_eq!(r.order, None);
    assert_eq!(r.fallback, Some(Fallback::Disabled));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn one_feature_on_does_not_turn_the_other_on() {
    let (post, calls, _) = fake(Ok(choice("s0", 0.99)));
    let deps = Deps { modes: modes(Mode::On, Mode::Off), key: Some("k".into()), post: &post };
    let cands = vec![
        Candidate { id: "a".into(), text: "x".into() },
        Candidate { id: "b".into(), text: "y".into() },
    ];
    assert_eq!(rerank(&deps, "q", &cands, 1).await.fallback, Some(Fallback::Disabled));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn no_key_and_user_invoked_skills_ask_nothing() {
    let (post, calls, _) = fake(Ok(choice("s0", 0.99)));
    let deps = Deps { modes: modes(Mode::On, Mode::On), key: None, post: &post };
    assert_eq!(suggest_skill(&deps, PRIVATE, &skills()).await.fallback, Some(Fallback::NoKey));
    let deps = Deps { modes: modes(Mode::On, Mode::On), key: Some("k".into()), post: &post };
    let d = suggest_skill(&deps, "/skill:release-notes for v2", &skills()).await;
    assert_eq!(d.fallback, Some(Fallback::UserInvokedSkill));
    assert_eq!(d.skill, None);
    assert_eq!(suggest_skill(&deps, "hello", &[]).await.fallback, Some(Fallback::NothingToDecide));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn suggests_one_eligible_skill_when_confident() {
    let (post, calls, seen) = fake(Ok(choice("s0", 0.93)));
    let deps = Deps { modes: modes(Mode::On, Mode::Off), key: Some("ts-key".into()), post: &post };
    let d = suggest_skill(&deps, PRIVATE, &skills()).await;
    assert_eq!(d.skill.as_deref(), Some("pdf-forms"));
    assert_eq!(d.fallback, None);
    assert_eq!(d.model.as_deref(), Some("jev-1.13.0"));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let (body, key) = seen.lock().unwrap()[0].clone();
    assert_eq!(key, "ts-key");
    assert_eq!(body["model"], MODEL, "a pinned version is asked for");
    let criteria = body["questions"]["skill"]["criteria"].as_object().unwrap();
    // Positional keys, plus `none`: a skill name never becomes a key.
    let mut keys: Vec<&String> = criteria.keys().collect();
    keys.sort();
    assert_eq!(keys, ["none", "s0", "s1"]);
}

#[tokio::test]
async fn abstains_below_the_threshold_or_on_none() {
    for reply in [choice("s1", 0.55), choice("none", 0.9)] {
        let (post, _, _) = fake(Ok(reply));
        let deps = Deps { modes: modes(Mode::On, Mode::Off), key: Some("k".into()), post: &post };
        let d = suggest_skill(&deps, "write something", &skills()).await;
        assert_eq!(d.skill, None);
        assert_eq!(d.fallback, Some(Fallback::Abstained));
    }
}

#[tokio::test]
async fn an_answer_outside_the_given_skills_is_refused() {
    let (post, _, _) = fake(Ok(choice("s7", 0.99)));
    let deps = Deps { modes: modes(Mode::On, Mode::Off), key: Some("k".into()), post: &post };
    let d = suggest_skill(&deps, "x", &skills()).await;
    assert_eq!(d.skill, None);
    assert_eq!(d.fallback, Some(Fallback::BadResponse));
}

#[tokio::test]
async fn shadow_asks_and_records_but_changes_nothing() {
    let (post, calls, _) = fake(Ok(choice("s0", 0.95)));
    let deps = Deps { modes: modes(Mode::Shadow, Mode::Off), key: Some("k".into()), post: &post };
    let d = suggest_skill(&deps, "shadow-probe-7a", &skills()).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(d.skill, None);
    assert_eq!(d.fallback, Some(Fallback::Shadow));
    let r = receipts().into_iter().find(|r| r.mode == Mode::Shadow && r.feature == Feature::Skill).unwrap();
    assert_eq!(r.decision, "pdf-forms");
    assert_eq!(r.model.as_deref(), Some("jev-1.13.0"));
    assert_eq!(r.input_tokens, 300);
}

#[tokio::test]
async fn every_failure_falls_back_with_its_reason() {
    for (reply, why) in [
        (Err(CallError::Timeout), Fallback::Timeout),
        (Err(CallError::Http("HTTP 500".into())), Fallback::HttpError),
        (Ok(json!({"model":"jev-1.13.0","answers":{}})), Fallback::BadResponse),
    ] {
        let (post, _, _) = fake(reply);
        let deps = Deps { modes: modes(Mode::On, Mode::On), key: Some("k".into()), post: &post };
        let d = suggest_skill(&deps, "x", &skills()).await;
        assert_eq!((d.skill, d.fallback), (None, Some(why)));
        let cands = vec![
            Candidate { id: "a".into(), text: "x".into() },
            Candidate { id: "b".into(), text: "y".into() },
        ];
        let r = rerank(&deps, "q", &cands, 1).await;
        assert_eq!((r.order, r.fallback), (None, Some(why)));
    }
}

fn nouls(values: &[f64]) -> Value {
    let answers: Map<String, Value> = values
        .iter()
        .enumerate()
        .map(|(i, v)| (format!("p{i}"), json!({ "type": "noul", "noul": v })))
        .collect();
    json!({ "model": "jev-1.13.0", "answers": answers, "usage": { "input_tokens": 900, "output_tokens": 40 } })
}

fn citations() -> Vec<Candidate> {
    // Ids as retrieval returned them: opaque, not positions.
    ["chunk-9f3", "chunk-001", "chunk-a77", "chunk-4c2"]
        .iter()
        .map(|id| Candidate { id: id.to_string(), text: format!("passage {id}") })
        .collect()
}

#[tokio::test]
async fn reranking_returns_exactly_the_given_ids_reordered() {
    let (post, _, seen) = fake(Ok(nouls(&[0.2, 0.9, 0.9, 0.05])));
    let deps = Deps { modes: modes(Mode::Off, Mode::On), key: Some("k".into()), post: &post };
    let r = rerank(&deps, "how do refunds work", &citations(), 2).await;
    // Highest first; the tie (0.9, 0.9) keeps retrieval order.
    assert_eq!(r.order.unwrap(), ["chunk-001", "chunk-a77", "chunk-9f3", "chunk-4c2"]);
    let body = &seen.lock().unwrap()[0].0;
    assert_eq!(body["questions"].as_object().unwrap().len(), 4);
    assert_eq!(body["state"]["passages"]["p0"], "passage chunk-9f3");
    // No citation id is sent: TypeSafe sees positions only.
    assert!(!body.to_string().contains("\"chunk-9f3\""));
}

#[tokio::test]
async fn reranking_abstains_when_nothing_is_relevant() {
    let (post, _, _) = fake(Ok(nouls(&[0.01, 0.02, 0.0, 0.05])));
    let deps = Deps { modes: modes(Mode::Off, Mode::On), key: Some("k".into()), post: &post };
    let r = rerank(&deps, "q", &citations(), 2).await;
    assert_eq!((r.order, r.fallback), (None, Some(Fallback::Abstained)));
}

#[tokio::test]
async fn a_missing_answer_or_duplicate_ids_keep_retrieval_order() {
    let (post, calls, _) = fake(Ok(nouls(&[0.9, 0.8])));
    let deps = Deps { modes: modes(Mode::Off, Mode::On), key: Some("k".into()), post: &post };
    assert_eq!(rerank(&deps, "q", &citations(), 2).await.fallback, Some(Fallback::BadResponse));
    let dup = vec![
        Candidate { id: "a".into(), text: "x".into() },
        Candidate { id: "a".into(), text: "y".into() },
    ];
    assert_eq!(rerank(&deps, "q", &dup, 1).await.fallback, Some(Fallback::NothingToDecide));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn the_shortlist_and_the_text_sent_are_bounded() {
    let many: Vec<Candidate> = (0..30)
        .map(|i| Candidate { id: format!("c{i}"), text: "w".repeat(5_000) })
        .collect();
    let (post, _, seen) = fake(Ok(nouls(&[0.5; MAX_CANDIDATES])));
    let deps = Deps { modes: modes(Mode::Off, Mode::On), key: Some("k".into()), post: &post };
    let r = rerank(&deps, &"q".repeat(5_000), &many, 5).await;
    let order = r.order.unwrap();
    assert_eq!(order.len(), 30, "past the shortlist, candidates keep their place");
    assert_eq!(&order[MAX_CANDIDATES..], &many[MAX_CANDIDATES..].iter().map(|c| c.id.clone()).collect::<Vec<_>>()[..]);
    let body = &seen.lock().unwrap()[0].0;
    assert_eq!(body["questions"].as_object().unwrap().len(), MAX_CANDIDATES);
    assert_eq!(body["state"]["query"].as_str().unwrap().len(), MAX_QUERY_CHARS);
    assert_eq!(body["state"]["passages"]["p0"].as_str().unwrap().len(), MAX_PASSAGE_CHARS);
    assert!(estimate_tokens(body) <= MAX_REQUEST_TOKENS);
    let long = skill_request(&"m".repeat(9_000), &skills());
    assert_eq!(long["state"]["request"].as_str().unwrap().len(), MAX_MESSAGE_CHARS);
}

#[tokio::test]
async fn receipts_never_hold_the_key_or_the_private_text() {
    let (post, _, _) = fake(Ok(choice("s0", 0.95)));
    let deps = Deps { modes: modes(Mode::On, Mode::On), key: Some("ts-live-SECRETKEY-123".into()), post: &post };
    suggest_skill(&deps, PRIVATE, &skills()).await;
    let (post, _, _) = fake(Ok(nouls(&[0.1, 0.9, 0.3, 0.2])));
    let deps = Deps { modes: modes(Mode::On, Mode::On), key: Some("ts-live-SECRETKEY-123".into()), post: &post };
    rerank(&deps, "ACME-SECRET-7731 refunds", &citations(), 2).await;
    let all = serde_json::to_string(&receipts()).unwrap();
    assert!(!all.contains("SECRETKEY"));
    assert!(!all.contains("ACME-SECRET-7731"));
    assert!(!all.contains("passage chunk"));
    assert!(all.contains("\"feature\":\"rerank\""));
}

#[test]
fn a_malformed_key_is_refused_before_it_is_stored() {
    assert!(set_key("").is_err());
    assert!(set_key("two words").is_err());
    assert!(set_key(&"x".repeat(600)).is_err());
}

// --- the HTTP client against a local stand-in for TypeSafe -------------------

use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn one_shot_server(response: &'static str, delay: Duration) -> (String, tokio::task::JoinHandle<String>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        let (mut s, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 16 * 1024];
        let mut got = Vec::new();
        loop {
            let n = s.read(&mut buf).await.unwrap_or(0);
            got.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&got);
            if n == 0 {
                break;
            }
            if let Some(end) = text.find("\r\n\r\n") {
                let len = text
                    .lines()
                    .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                    .unwrap_or(0);
                if got.len() >= end + 4 + len {
                    break;
                }
            }
        }
        tokio::time::sleep(delay).await;
        let _ = s.write_all(response.as_bytes()).await;
        String::from_utf8_lossy(&got).into_owned()
    });
    (format!("http://{addr}/v1/systemone"), handle)
}

#[tokio::test]
async fn the_client_sends_a_bearer_key_and_reads_a_decision() {
    let body = r#"{"model":"jev-1.13.0","answers":{"skill":{"type":"choice","choice":"none","confidence":1.0,"probabilities":{"none":1.0}}},"usage":{"input_tokens":12,"output_tokens":3}}"#;
    let response: &'static str = Box::leak(
        format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
            .into_boxed_str(),
    );
    let (url, server) = one_shot_server(response, Duration::ZERO).await;
    let resp = client::post(&url, "ts-key-abc", &json!({"model": MODEL}), Duration::from_secs(5)).await.unwrap();
    assert_eq!(resp.model, "jev-1.13.0");
    assert_eq!(resp.usage.input_tokens, 12);
    let request = server.await.unwrap();
    assert!(request.starts_with("POST /v1/systemone"));
    assert!(request.to_ascii_lowercase().contains("authorization: bearer ts-key-abc"));
}

#[tokio::test]
async fn the_client_gives_up_at_its_timeout() {
    let (url, _server) = one_shot_server("HTTP/1.1 200 OK\r\n\r\n", Duration::from_secs(10)).await;
    let t0 = Instant::now();
    let r = client::post(&url, "k", &json!({}), Duration::from_millis(300)).await;
    assert_eq!(r, Err(CallError::Timeout));
    assert!(t0.elapsed() < Duration::from_secs(3));
}

#[tokio::test]
async fn the_client_never_follows_a_redirect_with_the_key() {
    let (url, _server) = one_shot_server(
        "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:9/steal\r\nContent-Length: 0\r\n\r\n",
        Duration::ZERO,
    )
    .await;
    let r = client::post(&url, "k", &json!({}), Duration::from_secs(5)).await;
    assert_eq!(r, Err(CallError::Http("HTTP 307".into())));
}

#[test]
fn the_daily_budget_survives_a_restart_and_resets_on_a_new_day() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("jev_budget.json");
    assert_eq!(load_budget(&path), BudgetRecord::default(), "missing file: nothing used");
    save_budget(&path, &BudgetRecord { date: today(), input_tokens: 1_234 });
    // What a restarted app reads back.
    assert_eq!(load_budget(&path), BudgetRecord { date: today(), input_tokens: 1_234 });
    std::fs::write(&path, b"not json").unwrap();
    assert_eq!(load_budget(&path), BudgetRecord::default());
    assert!(!dir.path().join("jev_budget.json.tmp").exists());
}

#[tokio::test]
async fn one_client_serves_consecutive_calls_with_their_own_timeouts() {
    let body = r#"{"model":"jev-1.13.0","answers":{},"usage":{}}"#;
    let response: &'static str = Box::leak(
        format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len())
            .into_boxed_str(),
    );
    let (url, _s) = one_shot_server(response, Duration::ZERO).await;
    assert!(client::post(&url, "k", &json!({}), Duration::from_secs(5)).await.is_ok());
    // A later call with a short timeout still times out on its own terms.
    let (slow, _s2) = one_shot_server("HTTP/1.1 200 OK\r\n\r\n", Duration::from_secs(10)).await;
    let t0 = Instant::now();
    assert_eq!(client::post(&slow, "k", &json!({}), Duration::from_millis(300)).await, Err(CallError::Timeout));
    assert!(t0.elapsed() < Duration::from_secs(3));
}

/// The eval harness builds the same requests (scripts/jev-eval/eval.mjs); both
/// sides are held to this one fixture so a measurement is of what the app sends.
#[test]
fn requests_match_the_shared_fixture_the_eval_harness_uses() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../scripts/jev-eval/request.fixture.json");
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let input = &fixture["input"];
    let skills: Vec<SkillOption> = serde_json::from_value(input["skill"]["skills"].clone()).unwrap();
    let message = input["skill"]["message"].as_str().unwrap();
    assert_eq!(skill_request(message, &skills), fixture["expected"]["skill"]);
    let candidates: Vec<Candidate> = serde_json::from_value(input["rerank"]["candidates"].clone()).unwrap();
    let query = input["rerank"]["query"].as_str().unwrap();
    assert_eq!(rerank_request(query, &candidates), fixture["expected"]["rerank"]);
}

fn models() -> Vec<SkillOption> {
    vec![
        SkillOption { name: "anthropic/claude-sonnet-5-5".into(), description: "Hosted. Best for code and long documents.".into() },
        SkillOption { name: "llamacpp/qwen3-8b".into(), description: "Runs on this computer. Quick questions.".into() },
    ]
}

fn current() -> SkillOption {
    SkillOption { name: "llamacpp/gemma-4".into(), description: "Runs on this computer.".into() }
}

fn model_choice(choice: &str, p: f64) -> Value {
    json!({
        "model": "jev-1.13.0",
        "answers": { "model": { "type": "choice", "choice": choice, "confidence": p,
                                 "probabilities": { choice: p } } },
        "usage": { "input_tokens": 300, "output_tokens": 20 }
    })
}

#[test]
fn a_model_request_names_models_by_position_and_always_offers_keeping_the_current_one() {
    let body = model_request("refactor this module", &current(), &models());
    let criteria = &body["questions"]["model"]["criteria"];
    assert!(criteria["none"].as_str().unwrap().contains("keep it"));
    assert!(criteria["m0"].as_str().unwrap().starts_with("anthropic/claude-sonnet-5-5:"));
    assert!(criteria["m1"].as_str().unwrap().starts_with("llamacpp/qwen3-8b:"));
    assert_eq!(body["state"]["request"], "refactor this module");
    assert!(body["state"]["current_model"].as_str().unwrap().starts_with("llamacpp/gemma-4:"));
    // A model's own name can never become a question key.
    assert!(criteria.as_object().unwrap().keys().all(|k| k == "none" || k.starts_with('m')));
}

#[tokio::test]
async fn a_clearly_better_model_is_named_and_a_weak_answer_keeps_the_current_one() {
    let (post, _, _) = fake(Ok(model_choice("m0", 0.93)));
    let deps = Deps { modes: modes(Mode::On, Mode::Off), key: Some("ts-key".into()), post: &post };
    let d = suggest_model(&deps, "refactor this module", &current(), &models()).await;
    assert_eq!(d.skill.as_deref(), Some("anthropic/claude-sonnet-5-5"));
    assert_eq!(d.fallback, None);

    let (post, _, _) = fake(Ok(model_choice("m0", 0.4)));
    let deps = Deps { modes: modes(Mode::On, Mode::Off), key: Some("ts-key".into()), post: &post };
    let d = suggest_model(&deps, "refactor this module", &current(), &models()).await;
    assert_eq!(d.skill, None, "under the probability bar the current model stays");
    assert_eq!(d.fallback, Some(Fallback::Abstained));

    let (post, _, _) = fake(Ok(model_choice("none", 0.95)));
    let deps = Deps { modes: modes(Mode::On, Mode::Off), key: Some("ts-key".into()), post: &post };
    assert_eq!(suggest_model(&deps, "hi there friend", &current(), &models()).await.skill, None);
}

#[tokio::test]
async fn model_routing_asks_nothing_when_off_or_without_a_list_and_rejects_a_bad_answer() {
    let (post, calls, _) = fake(Ok(model_choice("m0", 0.99)));
    let off = Deps { modes: Modes::default(), key: Some("ts-key".into()), post: &post };
    assert_eq!(suggest_model(&off, "write the tests", &current(), &models()).await.fallback, Some(Fallback::Disabled));
    let on = Deps { modes: modes(Mode::On, Mode::Off), key: Some("ts-key".into()), post: &post };
    assert_eq!(suggest_model(&on, "write the tests", &current(), &[]).await.fallback, Some(Fallback::NothingToDecide));
    assert_eq!(calls.load(Ordering::SeqCst), 0, "no request is made in either case");

    let (post, _, _) = fake(Ok(model_choice("m9", 0.99)));
    let deps = Deps { modes: modes(Mode::On, Mode::Off), key: Some("ts-key".into()), post: &post };
    let d = suggest_model(&deps, "write the tests", &current(), &models()).await;
    assert_eq!(d.skill, None);
    assert_eq!(d.fallback, Some(Fallback::BadResponse));
}
