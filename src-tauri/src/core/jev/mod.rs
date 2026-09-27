//! Jev (TypeSafe's System One model) as optional decision support.
//!
//! Two narrow judgments, each behind its own opt-in, both off by default:
//! - **skill suggestion**: given the user's message and the skills already
//!   eligible for the surface, suggest at most one -- or none;
//! - **retrieval reranking**: reorder a bounded embedding shortlist of
//!   attachment passages by relevance to the query.
//!
//! Each opt-in has three states: `off` (no TypeSafe request, ever), `shadow`
//! (the request is made and its decision recorded, but Flint's existing
//! behaviour is what the user gets -- for comparing before enabling), and
//! `on`. Whatever Jev says, Flint stays authoritative:
//! - it never authorizes, approves or blocks a tool, and is no security gate;
//! - the skill catalog, user-invoked skills (`/skill:x`) and every permission
//!   check are untouched -- a suggestion is a hint the user may take;
//! - reranking only reorders the passages retrieval already returned; their
//!   ids, text, file ids and scores are passed through exactly.
//!
//! Every call is bounded (input size, per-request tokens, a daily token
//! budget, a short timeout) and every failure -- timeout, HTTP error, bad
//! answer, abstention, no key, opt-in off -- falls back to Flint's existing
//! behaviour, recording why. The API key lives in the protected secret store
//! (`provider_secrets`) and is read only here: no command returns it, and it
//! is registered for log redaction the moment it is loaded.
//!
//! Receipts record the model version, the decision, latency, token usage and
//! any fallback reason -- never the key, and never the message or passage
//! text (only lengths, counts and skill names).

pub mod client;

use std::collections::VecDeque;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use client::{Answer, CallError, SystemOneResponse};

/// The TypeSafe System One endpoint.
pub const ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";
/// A pinned model version, never `jev-latest`: a decision recorded against a
/// version can be compared with the next only if the version is known.
pub const MODEL: &str = "jev-1.13.0";
/// Published price, input tokens (output is free), for the receipts' cost.
pub const USD_PER_M_INPUT_TOKENS: f64 = 0.042;

pub const SKILL_TIMEOUT: Duration = Duration::from_millis(1_500);
pub const RERANK_TIMEOUT: Duration = Duration::from_millis(2_500);

pub const MAX_MESSAGE_CHARS: usize = 2_000;
pub const MAX_SKILLS: usize = 24;
pub const MAX_SKILL_DESCRIPTION_CHARS: usize = 200;
pub const MAX_QUERY_CHARS: usize = 1_000;
pub const MAX_CANDIDATES: usize = 20;
pub const MAX_PASSAGE_CHARS: usize = 1_200;
/// Estimated input tokens one request may carry.
pub const MAX_REQUEST_TOKENS: u64 = 12_000;
/// Input tokens per day across both features (about $0.08 at list price).
pub const DAILY_TOKEN_BUDGET: u64 = 2_000_000;
/// A suggestion below this probability is an abstention.
pub const SKILL_MIN_PROBABILITY: f64 = 0.7;
/// A shortlist where no passage reaches this is an abstention.
pub const RERANK_MIN_RELEVANCE: f64 = 0.1;

/// The secret-store record the key lives under.
const KEY_RECORD: &str = "typesafe-api-key";
/// The settings-store entry the web app's opt-ins persist to.
pub const SETTINGS_KEY: &str = "flint-jev";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    #[default]
    Off,
    Shadow,
    On,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Modes {
    pub skills: Mode,
    pub rerank: Mode,
}

/// The opt-ins, as the web app persisted them (`{"state":{...}}`). Anything
/// unreadable is `off`.
pub fn modes_from_settings(raw: Option<&str>) -> Modes {
    #[derive(Deserialize, Default)]
    #[serde(rename_all = "camelCase")]
    struct State {
        #[serde(default)]
        skill_mode: Mode,
        #[serde(default)]
        rerank_mode: Mode,
    }
    #[derive(Deserialize, Default)]
    struct Persisted {
        #[serde(default)]
        state: State,
    }
    let p: Persisted = raw.and_then(|r| serde_json::from_str(r).ok()).unwrap_or_default();
    Modes { skills: p.state.skill_mode, rerank: p.state.rerank_mode }
}

// --- receipts and budget ------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Feature {
    Skill,
    Rerank,
}

/// Why Flint's existing behaviour was used instead.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Fallback {
    Disabled,
    NoKey,
    UserInvokedSkill,
    NothingToDecide,
    OverRequestBudget,
    OverDailyBudget,
    Timeout,
    HttpError,
    BadResponse,
    Abstained,
    /// Shadow mode: the decision was recorded, not used.
    Shadow,
}

#[derive(Debug, Clone, Serialize)]
pub struct Receipt {
    pub at: String,
    pub feature: Feature,
    pub mode: Mode,
    /// The model version TypeSafe says answered, when a request was made.
    pub model: Option<String>,
    /// What Jev decided, without private text: a skill name or "none", or
    /// how the shortlist moved.
    pub decision: String,
    pub latency_ms: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
    pub fallback: Option<Fallback>,
    /// Characters and items sent, so the user can see the scale of it.
    pub sent_chars: usize,
    pub sent_items: usize,
}

const MAX_RECEIPTS: usize = 200;
static RECEIPTS: LazyLock<Mutex<VecDeque<Receipt>>> = LazyLock::new(|| Mutex::new(VecDeque::new()));
/// (UTC date, input tokens used that day).
static BUDGET: LazyLock<Mutex<(String, u64)>> = LazyLock::new(|| Mutex::new((String::new(), 0)));
/// Where the day's usage is kept, so a restart does not reset the budget.
/// Set once, from the data folder, by the first command.
static BUDGET_FILE: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

#[derive(Serialize, Deserialize, Default, PartialEq, Debug)]
pub(crate) struct BudgetRecord {
    pub date: String,
    pub input_tokens: u64,
}

/// The usage recorded at `path`, or none when missing or unreadable.
pub(crate) fn load_budget(path: &std::path::Path) -> BudgetRecord {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Write the day's usage beside a temporary file and rename it into place.
pub(crate) fn save_budget(path: &std::path::Path, record: &BudgetRecord) {
    let tmp = path.with_extension("json.tmp");
    let ok = serde_json::to_vec(record)
        .ok()
        .is_some_and(|b| std::fs::write(&tmp, b).is_ok());
    if ok {
        let _ = std::fs::rename(&tmp, path);
    }
}

/// Keep the budget in `path` from now on, starting from what it holds.
pub fn use_budget_file(path: std::path::PathBuf) {
    if BUDGET_FILE.set(path.clone()).is_err() {
        return;
    }
    let stored = load_budget(&path);
    let day = today();
    if stored.date != day {
        // Yesterday's count, or none: today starts from what is in memory.
        return;
    }
    if let Ok(mut b) = BUDGET.lock() {
        let in_memory = if b.0 == day { b.1 } else { 0 };
        // Whichever is further along: nothing already counted is dropped.
        *b = (day, stored.input_tokens.max(in_memory));
    }
}

fn persist(b: &(String, u64)) {
    if let Some(path) = BUDGET_FILE.get() {
        save_budget(path, &BudgetRecord { date: b.0.clone(), input_tokens: b.1 });
    }
}

fn record(receipt: Receipt) {
    log::info!(
        "jev: feature={:?} mode={:?} model={} decision={} latency_ms={} input_tokens={} output_tokens={} fallback={:?}",
        receipt.feature,
        receipt.mode,
        receipt.model.as_deref().unwrap_or("-"),
        receipt.decision,
        receipt.latency_ms,
        receipt.input_tokens,
        receipt.output_tokens,
        receipt.fallback,
    );
    if let Ok(mut r) = RECEIPTS.lock() {
        r.push_front(receipt);
        r.truncate(MAX_RECEIPTS);
    }
}

pub fn receipts() -> Vec<Receipt> {
    RECEIPTS.lock().map(|r| r.iter().cloned().collect()).unwrap_or_default()
}

fn today() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

/// Reserve `tokens` of today's budget; false when that would exceed it.
fn reserve(tokens: u64) -> bool {
    let Ok(mut b) = BUDGET.lock() else { return false };
    let day = today();
    if b.0 != day {
        *b = (day, 0);
    }
    if b.1 + tokens > DAILY_TOKEN_BUDGET {
        return false;
    }
    b.1 += tokens;
    persist(&b);
    true
}

/// Put back the difference between what was reserved and what was billed.
fn settle(reserved: u64, billed: u64) {
    if let Ok(mut b) = BUDGET.lock() {
        b.1 = b.1.saturating_sub(reserved).saturating_add(billed);
        persist(&b);
    }
}

pub fn tokens_used_today() -> u64 {
    BUDGET.lock().ok().filter(|b| b.0 == today()).map(|b| b.1).unwrap_or(0)
}

/// A rough input-token estimate: four characters a token, plus framing.
pub fn estimate_tokens(body: &Value) -> u64 {
    (body.to_string().chars().count() as u64) / 4 + 64
}

fn clip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

// --- the key -----------------------------------------------------------------

/// Store the key in the protected secret store. Never returned by anything.
pub fn set_key(key: &str) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() || key.len() > 512 || key.chars().any(char::is_whitespace) {
        return Err("that does not look like a TypeSafe API key".to_string());
    }
    crate::core::secret_values::register(key);
    crate::core::server::provider_secrets::store_secret_record(KEY_RECORD, key)
}

pub fn clear_key() -> Result<(), String> {
    crate::core::server::provider_secrets::delete_secret_record(KEY_RECORD)
}

fn load_key() -> Option<String> {
    let key = crate::core::server::provider_secrets::load_secret_record(KEY_RECORD)?;
    crate::core::secret_values::register(&key);
    Some(key)
}

pub fn key_configured() -> bool {
    crate::core::server::provider_secrets::load_secret_record(KEY_RECORD).is_some()
}

// --- the two decisions ---------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SkillOption {
    pub name: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SkillDecision {
    /// A skill to suggest to the user. Set only when the opt-in is `on` and
    /// Jev chose one of the given skills with enough probability.
    pub skill: Option<String>,
    pub probability: Option<f64>,
    pub fallback: Option<Fallback>,
    pub model: Option<String>,
}

/// The TypeSafe request for a skill suggestion. Skills are named by position
/// (`s0`, `s1`, ...) so a skill name can never become a question key; `none`
/// is always an option, so abstaining is a first-class answer.
pub fn skill_request(message: &str, skills: &[SkillOption]) -> Value {
    let mut criteria = Map::new();
    criteria.insert(
        "none".into(),
        Value::String("No listed skill fits this request; answer normally.".into()),
    );
    for (i, s) in skills.iter().enumerate() {
        criteria.insert(
            format!("s{i}"),
            Value::String(format!(
                "{}: {}",
                clip(&s.name, 80),
                clip(&s.description, MAX_SKILL_DESCRIPTION_CHARS)
            )),
        );
    }
    json!({
        "model": MODEL,
        "state": { "request": clip(message, MAX_MESSAGE_CHARS) },
        "questions": {
            "skill": {
                "type": "choice",
                "instructions": "Which one skill, if any, should an assistant load to handle this request? Choose none unless a skill clearly applies.",
                "criteria": criteria,
            }
        }
    })
}

/// Read a skill answer back to one of `skills`, or an abstention.
pub fn read_skill_answer(
    resp: &SystemOneResponse,
    skills: &[SkillOption],
) -> Result<(Option<String>, f64), Fallback> {
    let Some(Answer::Choice { choice, probabilities, .. }) = resp.answers.get("skill") else {
        return Err(Fallback::BadResponse);
    };
    let p = probabilities.get(choice).copied().unwrap_or(0.0);
    if choice == "none" {
        return Ok((None, p));
    }
    let idx: usize = choice
        .strip_prefix('s')
        .and_then(|n| n.parse().ok())
        .ok_or(Fallback::BadResponse)?;
    let skill = skills.get(idx).ok_or(Fallback::BadResponse)?;
    if p < SKILL_MIN_PROBABILITY {
        return Ok((None, p));
    }
    Ok((Some(skill.name.clone()), p))
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Candidate {
    /// The citation id, passed back exactly as given.
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RerankDecision {
    /// Every candidate id, most relevant first -- set only when the opt-in is
    /// `on` and Jev answered for every candidate.
    pub order: Option<Vec<String>>,
    pub fallback: Option<Fallback>,
    pub model: Option<String>,
}

pub fn rerank_request(query: &str, candidates: &[Candidate]) -> Value {
    let mut passages = Map::new();
    let mut questions = Map::new();
    for (i, c) in candidates.iter().enumerate() {
        let key = format!("p{i}");
        passages.insert(key.clone(), Value::String(clip(&c.text, MAX_PASSAGE_CHARS)));
        questions.insert(
            key.clone(),
            json!({
                "type": "noul",
                "instructions": format!("Does passage {key} contain information that helps answer the query?"),
            }),
        );
    }
    json!({
        "model": MODEL,
        "state": { "query": clip(query, MAX_QUERY_CHARS), "passages": passages },
        "questions": questions,
    })
}

/// Candidate ids ordered by Jev's relevance, ties kept in retrieval order.
pub fn read_rerank_answer(
    resp: &SystemOneResponse,
    candidates: &[Candidate],
) -> Result<Vec<String>, Fallback> {
    let mut scored = Vec::with_capacity(candidates.len());
    for (i, c) in candidates.iter().enumerate() {
        match resp.answers.get(&format!("p{i}")) {
            Some(Answer::Noul { noul }) if noul.is_finite() => scored.push((i, *noul, c.id.clone())),
            _ => return Err(Fallback::BadResponse),
        }
    }
    if scored.iter().all(|(_, p, _)| *p < RERANK_MIN_RELEVANCE) {
        return Err(Fallback::Abstained);
    }
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
    Ok(scored.into_iter().map(|(_, _, id)| id).collect())
}

/// How a reranking moved the top `k`, for a receipt.
fn movement(before: &[Candidate], after: &[String], k: usize) -> String {
    let top_before: Vec<&str> = before.iter().take(k).map(|c| c.id.as_str()).collect();
    let top_after: Vec<&str> = after.iter().take(k).map(String::as_str).collect();
    let kept = top_after.iter().filter(|id| top_before.contains(id)).count();
    format!("top{k}: kept {kept}, replaced {}; reordered {}", k.min(top_after.len()) - kept, top_before != top_after)
}

/// What a decision needs besides its inputs; a seam so tests can stand in
/// for the network and the secret store.
pub struct Deps<'a> {
    pub modes: Modes,
    pub key: Option<String>,
    pub post: &'a (dyn Fn(Value, String, Duration) -> futures_util::future::BoxFuture<'static, Result<SystemOneResponse, CallError>>
             + Send
             + Sync),
}

struct Outcome {
    resp: Option<SystemOneResponse>,
    fallback: Option<Fallback>,
    latency_ms: u64,
    reserved: u64,
}

/// Make one bounded request, or say why not.
async fn ask(deps: &Deps<'_>, mode: Mode, body: Value, timeout: Duration) -> Outcome {
    let none = |f| Outcome { resp: None, fallback: Some(f), latency_ms: 0, reserved: 0 };
    if mode == Mode::Off {
        return none(Fallback::Disabled);
    }
    let Some(key) = deps.key.clone() else { return none(Fallback::NoKey) };
    let tokens = estimate_tokens(&body);
    if tokens > MAX_REQUEST_TOKENS {
        return none(Fallback::OverRequestBudget);
    }
    if !reserve(tokens) {
        return none(Fallback::OverDailyBudget);
    }
    let t0 = Instant::now();
    let result = (deps.post)(body, key, timeout).await;
    let latency_ms = t0.elapsed().as_millis() as u64;
    match result {
        Ok(resp) => {
            settle(tokens, resp.usage.input_tokens);
            Outcome { resp: Some(resp), fallback: None, latency_ms, reserved: tokens }
        }
        Err(e) => {
            // Billed or not is unknown; keep the reservation.
            let f = match e {
                CallError::Timeout => Fallback::Timeout,
                CallError::Http(_) => Fallback::HttpError,
                CallError::Decode(_) => Fallback::BadResponse,
            };
            Outcome { resp: None, fallback: Some(f), latency_ms, reserved: tokens }
        }
    }
}

fn receipt(
    feature: Feature,
    mode: Mode,
    o: &Outcome,
    decision: String,
    fallback: Option<Fallback>,
    sent_chars: usize,
    sent_items: usize,
) -> Receipt {
    let usage = o.resp.as_ref().map(|r| r.usage.clone()).unwrap_or_default();
    Receipt {
        at: chrono::Utc::now().to_rfc3339(),
        feature,
        mode,
        model: o.resp.as_ref().map(|r| r.model.clone()),
        decision,
        latency_ms: o.latency_ms,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cost_usd: usage.input_tokens as f64 * USD_PER_M_INPUT_TOKENS / 1_000_000.0,
        fallback,
        sent_chars,
        sent_items: if o.resp.is_some() || o.reserved > 0 { sent_items } else { 0 },
    }
}

/// Suggest at most one of `skills` for `message`, or none.
pub async fn suggest_skill(deps: &Deps<'_>, message: &str, skills: &[SkillOption]) -> SkillDecision {
    let mode = deps.modes.skills;
    let quick = |f: Fallback| SkillDecision { skill: None, probability: None, fallback: Some(f), model: None };
    // A skill the user named is theirs; nothing is asked. Neither is anything
    // asked when the opt-in is off, or there is nothing to choose from.
    let trimmed = message.trim_start();
    let early = if mode == Mode::Off {
        Some(Fallback::Disabled)
    } else if trimmed.starts_with('/') {
        Some(Fallback::UserInvokedSkill)
    } else if skills.is_empty() || trimmed.is_empty() {
        Some(Fallback::NothingToDecide)
    } else {
        None
    };
    if let Some(f) = early {
        if mode != Mode::Off {
            record(receipt(Feature::Skill, mode, &Outcome { resp: None, fallback: Some(f), latency_ms: 0, reserved: 0 }, "none".into(), Some(f), 0, 0));
        }
        return quick(f);
    }
    let skills: Vec<SkillOption> = skills.iter().take(MAX_SKILLS).cloned().collect();
    let body = skill_request(message, &skills);
    let sent_chars = body.to_string().chars().count();
    let o = ask(deps, mode, body, SKILL_TIMEOUT).await;
    let (decision, fallback, skill, probability) = match (&o.resp, o.fallback) {
        (Some(resp), _) => match read_skill_answer(resp, &skills) {
            Ok((Some(name), p)) => (name.clone(), None, Some(name), Some(p)),
            Ok((None, p)) => ("none".to_string(), Some(Fallback::Abstained), None, Some(p)),
            Err(f) => ("none".to_string(), Some(f), None, None),
        },
        (None, f) => ("none".to_string(), f, None, None),
    };
    let (skill, fallback) = match (mode, fallback) {
        (Mode::Shadow, None) => (None, Some(Fallback::Shadow)),
        (_, f) => (skill.filter(|_| f.is_none()), f),
    };
    record(receipt(Feature::Skill, mode, &o, decision, fallback, sent_chars, skills.len()));
    SkillDecision { skill, probability, fallback, model: o.resp.map(|r| r.model) }
}

/// Rerank a retrieval shortlist. `k` is how many the caller will keep.
pub async fn rerank(deps: &Deps<'_>, query: &str, candidates: &[Candidate], k: usize) -> RerankDecision {
    let mode = deps.modes.rerank;
    let quick = |f| RerankDecision { order: None, fallback: Some(f), model: None };
    if mode == Mode::Off {
        return quick(Fallback::Disabled);
    }
    let mut ids = std::collections::HashSet::new();
    let unique = candidates.iter().all(|c| ids.insert(c.id.as_str()));
    if candidates.len() < 2 || query.trim().is_empty() || !unique {
        return quick(Fallback::NothingToDecide);
    }
    let shortlist: Vec<Candidate> = candidates.iter().take(MAX_CANDIDATES).cloned().collect();
    let body = rerank_request(query, &shortlist);
    let sent_chars = body.to_string().chars().count();
    let o = ask(deps, mode, body, RERANK_TIMEOUT).await;
    let (order, decision, fallback) = match (&o.resp, o.fallback) {
        (Some(resp), _) => match read_rerank_answer(resp, &shortlist) {
            Ok(mut order) => {
                // Anything past the shortlist keeps its place after it.
                order.extend(candidates.iter().skip(MAX_CANDIDATES).map(|c| c.id.clone()));
                let d = movement(candidates, &order, k);
                (Some(order), d, None)
            }
            Err(f) => (None, "kept retrieval order".to_string(), Some(f)),
        },
        (None, f) => (None, "kept retrieval order".to_string(), f),
    };
    let (order, fallback) = match (mode, fallback) {
        (Mode::Shadow, None) => (None, Some(Fallback::Shadow)),
        (_, f) => (order.filter(|_| f.is_none()), f),
    };
    record(receipt(Feature::Rerank, mode, &o, decision, fallback, sent_chars, shortlist.len()));
    RerankDecision { order, fallback, model: o.resp.map(|r| r.model) }
}

// --- commands ------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub skill_mode: Mode,
    pub rerank_mode: Mode,
    pub key_configured: bool,
    pub model: &'static str,
    pub tokens_used_today: u64,
    pub daily_token_budget: u64,
}

fn current_modes() -> Modes {
    modes_from_settings(crate::core::app::settings_store::settings_get(SETTINGS_KEY.to_string()).as_deref())
}

fn live_post() -> impl Fn(Value, String, Duration) -> futures_util::future::BoxFuture<'static, Result<SystemOneResponse, CallError>>
       + Send
       + Sync {
    |body, key, timeout| Box::pin(async move { client::post(ENDPOINT, &key, &body, timeout).await })
}

pub mod commands {
    use super::*;

    /// Name the budget file in the data folder, once.
    fn budget_file(app: &tauri::AppHandle) {
        if BUDGET_FILE.get().is_none() {
            let data = crate::core::app::commands::get_jan_data_folder_path(app.clone());
            use_budget_file(data.join("jev_budget.json"));
        }
    }

    /// Store the TypeSafe key. Write-only: nothing returns it.
    #[tauri::command]
    pub async fn jev_key_set(key: String) -> Result<(), String> {
        tokio::task::spawn_blocking(move || set_key(&key)).await.map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub async fn jev_key_clear() -> Result<(), String> {
        tokio::task::spawn_blocking(clear_key).await.map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub async fn jev_status(app: tauri::AppHandle) -> Status {
        budget_file(&app);
        let modes = current_modes();
        let key_configured = tokio::task::spawn_blocking(key_configured).await.unwrap_or(false);
        Status {
            skill_mode: modes.skills,
            rerank_mode: modes.rerank,
            key_configured,
            model: MODEL,
            tokens_used_today: tokens_used_today(),
            daily_token_budget: DAILY_TOKEN_BUDGET,
        }
    }

    #[tauri::command]
    pub fn jev_receipts() -> Vec<Receipt> {
        receipts()
    }

    async fn deps_key(modes: Modes, needed: Mode) -> Option<String> {
        if needed == Mode::Off || modes == Modes::default() {
            return None;
        }
        tokio::task::spawn_blocking(load_key).await.ok().flatten()
    }

    /// A suggested skill for the message, or none. Never touches tools.
    #[tauri::command]
    pub async fn jev_suggest_skill(
        app: tauri::AppHandle,
        message: String,
        skills: Vec<SkillOption>,
    ) -> SkillDecision {
        budget_file(&app);
        let modes = current_modes();
        let post = live_post();
        let deps = Deps { modes, key: deps_key(modes, modes.skills).await, post: &post };
        suggest_skill(&deps, &message, &skills).await
    }

    /// A relevance order for a retrieval shortlist, or none.
    #[tauri::command]
    pub async fn jev_rerank(
        app: tauri::AppHandle,
        query: String,
        candidates: Vec<Candidate>,
        k: usize,
    ) -> RerankDecision {
        budget_file(&app);
        let modes = current_modes();
        let post = live_post();
        let deps = Deps { modes, key: deps_key(modes, modes.rerank).await, post: &post };
        rerank(&deps, &query, &candidates, k).await
    }
}

#[cfg(test)]
mod tests;
