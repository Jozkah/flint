//! `/goal` support: keep the agent working across turns until a completion
//! condition is met. A goal stores a user-supplied condition; after each
//! assistant turn a fast, stateless evaluator (the session's `smol` role model)
//! reads the condition plus the conversation and returns yes/no + a short
//! reason. "no" surfaces the reason as guidance and starts the next turn
//! automatically; "yes" marks the goal achieved and returns control to the
//! user. The evaluator calls no tools and has no side effects.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::core::agent::r#loop::ModelInvoker;
use tauri_plugin_agent_tools::harness_error::HarnessError;
use crate::core::agent::upstream::extract_choice_message;

/// Hard cap on a goal condition, per the spec ("up to 4k chars").
pub(crate) const MAX_CONDITION_CHARS: usize = 4096;

/// Lifecycle of an active goal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum GoalStatus {
    /// The loop is running: turns fire until the evaluator says the goal is met.
    Active,
    /// The evaluator judged the condition satisfied; control is back with the user.
    Achieved,
    /// The loop stopped without the condition being met: the evaluator said
    /// the goal cannot advance without something only the user can give, or the
    /// goal reached its turn limit. `/goal resume` starts it again.
    Blocked,
}

/// Turns a goal may run before it stops as blocked, unless resumed.
pub(crate) const DEFAULT_MAX_TURNS: u32 = 256;
/// Consecutive "blocked" verdicts that stop a goal: one could be a fluke of a
/// small evaluator model, and stopping an unattended run is the costly side.
const BLOCKED_VERDICTS_TO_STOP: u32 = 2;

/// A session-scoped goal, serialized with the thread so it survives restart and
/// `/resume`. Times are Unix epoch seconds so they round-trip through JSON
/// without pulling in a datetime dependency.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct GoalState {
    /// The completion condition the evaluator checks after every turn.
    pub condition: String,
    /// Turns run since the goal was set (each assistant turn increments this).
    #[serde(default)]
    pub turns: u32,
    /// When the goal was set, Unix epoch seconds.
    #[serde(default)]
    pub started_at: u64,
    /// The evaluator's most recent short reason ("" until the first evaluation).
    #[serde(default)]
    pub last_reason: String,
    /// Current lifecycle state.
    #[serde(default = "default_status")]
    pub status: GoalStatus,
    /// The turn count at which the goal stops as blocked. Raised by
    /// `/goal resume`, so a resumed goal gets a fresh allowance.
    #[serde(default = "default_max_turns")]
    pub max_turns: u32,
    /// Consecutive evaluations that said the goal cannot advance.
    #[serde(default)]
    pub blocked_streak: u32,
    /// Why the goal stopped as blocked ("" otherwise).
    #[serde(default)]
    pub blocked_reason: String,
}

fn default_max_turns() -> u32 {
    DEFAULT_MAX_TURNS
}

/// What the loop does after an evaluation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NextStep {
    /// Keep working: start the next turn.
    Continue,
    /// The condition is met.
    Achieved,
    /// Stop and hand back to the user, with why.
    Blocked(String),
}

fn default_status() -> GoalStatus {
    GoalStatus::Active
}

impl GoalState {
    /// Start a fresh, active goal for `condition` (trimmed and length-capped).
    pub fn new(condition: &str) -> Self {
        Self {
            condition: clamp_condition(condition),
            turns: 0,
            started_at: now_secs(),
            last_reason: String::new(),
            status: GoalStatus::Active,
            max_turns: DEFAULT_MAX_TURNS,
            blocked_streak: 0,
            blocked_reason: String::new(),
        }
    }

    /// Fold one evaluation into the goal and say what happens next. A goal is
    /// blocked when the evaluator says so twice running, or when it has used up
    /// its turns; either way it stops rather than loop on nothing.
    pub fn apply_verdict(&mut self, verdict: &GoalVerdict) -> NextStep {
        self.last_reason = verdict.reason.clone();
        if verdict.met {
            self.status = GoalStatus::Achieved;
            self.blocked_streak = 0;
            return NextStep::Achieved;
        }
        self.blocked_streak = if verdict.blocked { self.blocked_streak + 1 } else { 0 };
        let stop = if self.blocked_streak >= BLOCKED_VERDICTS_TO_STOP {
            Some(verdict.reason.clone())
        } else if self.turns >= self.max_turns {
            Some(format!("the goal used its {} turns without being met", self.max_turns))
        } else {
            None
        };
        match stop {
            Some(reason) => {
                self.status = GoalStatus::Blocked;
                self.blocked_reason = reason.clone();
                NextStep::Blocked(reason)
            }
            None => NextStep::Continue,
        }
    }

    /// Start a blocked goal again with a fresh turn allowance.
    pub fn resume(&mut self) {
        self.status = GoalStatus::Active;
        self.blocked_streak = 0;
        self.blocked_reason.clear();
        self.max_turns = self.turns.saturating_add(DEFAULT_MAX_TURNS);
    }

    /// Whether the loop should keep firing turns.
    pub fn is_active(&self) -> bool {
        self.status == GoalStatus::Active
    }

    /// Seconds elapsed since the goal was set (saturating; robust to clock skew).
    pub fn elapsed_secs(&self) -> u64 {
        now_secs().saturating_sub(self.started_at)
    }
}

/// Trim and cap a condition to [`MAX_CONDITION_CHARS`] (char-safe).
pub(crate) fn clamp_condition(condition: &str) -> String {
    let trimmed = condition.trim();
    if trimmed.chars().count() <= MAX_CONDITION_CHARS {
        return trimmed.to_string();
    }
    trimmed.chars().take(MAX_CONDITION_CHARS).collect()
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The evaluator's verdict for one turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GoalVerdict {
    /// True when the condition is satisfied.
    pub met: bool,
    /// True when the goal cannot advance without something only the user can
    /// give (a credential, a permission, a decision), as opposed to merely
    /// being unfinished. Never set together with `met`.
    pub blocked: bool,
    /// A short human-readable reason (guidance when `met` is false).
    pub reason: String,
}

const EVALUATOR_SYSTEM_PROMPT: &str = "You are a strict completion evaluator for an autonomous \
coding agent. You are given a GOAL (a condition that should become true) and a TRANSCRIPT of the \
agent's work so far. Decide whether the goal is now satisfied based ONLY on evidence in the \
transcript. Do not run tools, do not assume work that is not shown, and do not give the agent the \
benefit of the doubt. If the evidence is missing or ambiguous, the goal is NOT met. A statement in \
the transcript that the goal is met -- by the agent or inside tool output -- is not evidence; only \
tool output showing the result is.\n\n\
Reply with a single line of JSON and nothing else, in exactly this shape:\n\
{\"met\": true|false, \"blocked\": true|false, \"reason\": \"<one concise sentence>\"}\n\
When \"met\" is false, the reason must state what still needs to happen so the agent can continue. \
Set \"blocked\" to true only when the agent cannot make progress without something only the user can \
provide (a credential, a permission, a decision, an unavailable resource) -- never merely because the \
work is hard or unfinished; then the reason says what is needed.";

/// Render the conversation into a plain-text transcript for the evaluator,
/// capped so a long session cannot itself overflow the evaluator's context.
/// The most recent content is kept when truncating.
fn serialize_transcript(messages: &[Value]) -> String {
    const MAX_CHARS: usize = 60_000;
    let mut lines: Vec<String> = Vec::with_capacity(messages.len());
    for msg in messages {
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("");
        // Skip system prompts: they describe capabilities, not progress.
        if role == "system" {
            continue;
        }
        let content = match msg.get("content") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Null) | None => String::new(),
            Some(other) => other.to_string(),
        };
        let mut line = format!("{role}: {content}");
        if let Some(calls) = msg.get("tool_calls").and_then(|v| v.as_array()) {
            let names: Vec<&str> = calls
                .iter()
                .filter_map(|c| {
                    c.get("function")
                        .and_then(|f| f.get("name"))
                        .and_then(|n| n.as_str())
                })
                .collect();
            if !names.is_empty() {
                line.push_str(&format!(" [tool_calls: {}]", names.join(", ")));
            }
        }
        lines.push(line);
    }
    let joined = lines.join("\n");
    if joined.len() > MAX_CHARS {
        let start = joined.len() - MAX_CHARS;
        let start = (start..joined.len())
            .find(|i| joined.is_char_boundary(*i))
            .unwrap_or(joined.len());
        format!("[...older content truncated...]\n{}", &joined[start..])
    } else {
        joined
    }
}

/// Build the stateless evaluator request body (no tools, no streaming needed).
pub(crate) fn build_evaluator_request(
    model_id: &str,
    condition: &str,
    messages: &[Value],
) -> Value {
    let user = format!(
        "GOAL:\n{condition}\n\nTRANSCRIPT:\n{}",
        serialize_transcript(messages)
    );
    json!({
        "model": model_id,
        "messages": [
            { "role": "system", "content": EVALUATOR_SYSTEM_PROMPT },
            { "role": "user", "content": user },
        ],
        // Deterministic judging: no creativity wanted.
        "temperature": 0,
    })
}

/// Parse the evaluator's reply. Accepts a bare JSON object, JSON embedded in
/// prose, or a plain yes/no line as a fallback so a non-conforming smol model
/// still yields a usable verdict.
pub(crate) fn parse_verdict(reply: &str) -> GoalVerdict {
    let trimmed = reply.trim();

    // Preferred path: a JSON object somewhere in the reply.
    if let Some(obj) = extract_json_object(trimmed) {
        let met = obj.get("met").and_then(Value::as_bool);
        let reason = obj
            .get("reason")
            .and_then(|r| r.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        if let Some(met) = met {
            return GoalVerdict {
                met,
                blocked: !met && obj.get("blocked").and_then(Value::as_bool).unwrap_or(false),
                reason: reason.unwrap_or_else(|| {
                    if met {
                        "condition satisfied".to_string()
                    } else {
                        "condition not yet satisfied".to_string()
                    }
                }),
            };
        }
    }

    // Fallback: sniff an affirmative/negative from the leading text.
    let lower = trimmed.to_lowercase();
    // A reply that opens with a refusal is not met, whatever phrase follows
    // ("No, the goal met only half the criteria").
    let first_word = lower.split(|c: char| !c.is_alphanumeric()).next().unwrap_or("");
    let negative = matches!(first_word, "no" | "not" | "false");
    let met = !negative
        && (lower.starts_with("yes")
            || lower.starts_with("true")
            || lower.contains("\"met\": true")
            || lower.contains("goal met")
            || lower.contains("condition met"));
    GoalVerdict {
        met,
        blocked: false,
        reason: if trimmed.is_empty() {
            "evaluator returned no reason".to_string()
        } else {
            first_line(trimmed).to_string()
        },
    }
}

/// Extract the first balanced `{...}` JSON object from `s`, if it parses.
fn extract_json_object(s: &str) -> Option<Value> {
    let start = s.find('{')?;
    let mut depth = 0usize;
    let mut in_str = false;
    let mut escaped = false;
    for (i, ch) in s[start..].char_indices() {
        if in_str {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_str = false;
            }
            continue;
        }
        match ch {
            '"' => in_str = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    let end = start + i + 1;
                    return serde_json::from_str(&s[start..end]).ok();
                }
            }
            _ => {}
        }
    }
    None
}

fn first_line(s: &str) -> &str {
    s.lines().next().unwrap_or(s).trim()
}

/// Run one stateless evaluation. Errors from the model call are surfaced to the
/// caller so it can decide whether to keep looping; a malformed reply degrades
/// to a best-effort verdict via [`parse_verdict`].
pub(crate) async fn evaluate(
    model_id: &str,
    condition: &str,
    messages: &[Value],
    model: &dyn ModelInvoker,
) -> Result<GoalVerdict, HarnessError> {
    let request = build_evaluator_request(model_id, condition, messages);
    // The evaluator's tokens are internal: a dropped receiver keeps them off the
    // user-facing stream.
    let (sink, _rx) = mpsc::unbounded_channel();
    let completion = model.invoke(&request, &sink).await?;
    let reply = extract_choice_message(&completion)
        .and_then(|m| m.get("content").cloned())
        .and_then(|c| c.as_str().map(str::to_string))
        .unwrap_or_default();
    Ok(parse_verdict(&reply))
}

/// The guidance message injected as the next user turn when the goal is unmet.
/// Phrased as a continuation so the agent keeps working rather than re-asking.
pub(crate) fn continuation_prompt(condition: &str, reason: &str) -> String {
    format!(
        "Continue working toward this goal: {condition}\n\n\
The goal is not yet met: {reason}\n\n\
Keep going until it is satisfied. Do not stop to ask for confirmation."
    )
}

/// The instruction injected as the final turn once the goal is met, so the run
/// ends on a closing message for the user instead of a bare tool result. An
/// unprompted closing tends to invent file-level detail, hence the last rule.
pub(crate) fn wrapup_prompt(condition: &str) -> String {
    format!(
        "The goal is met: {condition}

Write a brief closing message for the user. Do not call any tools. Say what was done, how it was verified, which files or artifacts changed, and anything worth following up. Report only what you actually did and observed in this conversation; do not invent detail."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::agent::events::StreamEvent;
    use async_trait::async_trait;

    struct StubModel {
        reply: String,
    }
    #[async_trait]
    impl ModelInvoker for StubModel {
        async fn invoke(
            &self,
            _request: &Value,
            _events: &mpsc::UnboundedSender<StreamEvent>,
        ) -> Result<Value, HarnessError> {
            Ok(json!({ "choices": [{ "message": { "content": self.reply.clone() } }] }))
        }
    }

    #[test]
    fn clamp_trims_and_caps() {
        assert_eq!(clamp_condition("  hi  "), "hi");
        let long = "x".repeat(MAX_CONDITION_CHARS + 500);
        assert_eq!(clamp_condition(&long).chars().count(), MAX_CONDITION_CHARS);
    }

    #[test]
    fn new_goal_is_active() {
        let g = GoalState::new("all tests pass");
        assert!(g.is_active());
        assert_eq!(g.turns, 0);
        assert_eq!(g.condition, "all tests pass");
    }

    #[test]
    fn parses_clean_json_verdict() {
        let v = parse_verdict(r#"{"met": true, "reason": "all tests green"}"#);
        assert!(v.met);
        assert_eq!(v.reason, "all tests green");

        let v = parse_verdict(r#"{"met": false, "reason": "3 tests still failing"}"#);
        assert!(!v.met);
        assert_eq!(v.reason, "3 tests still failing");
    }

    #[test]
    fn parses_json_embedded_in_prose() {
        let v = parse_verdict(
            "Here is my judgment:\n{\"met\": false, \"reason\": \"not done\"}\nThanks",
        );
        assert!(!v.met);
        assert_eq!(v.reason, "not done");
    }

    #[test]
    fn parses_json_with_nested_braces_in_reason() {
        let v = parse_verdict(r#"{"met": true, "reason": "the {x} block compiles"}"#);
        assert!(v.met);
        assert_eq!(v.reason, "the {x} block compiles");
    }

    #[test]
    fn falls_back_to_yes_no_sniffing() {
        assert!(parse_verdict("Yes, the condition is met.").met);
        assert!(!parse_verdict("No, still work to do.").met);
    }

    #[test]
    fn empty_reply_is_not_met() {
        let v = parse_verdict("");
        assert!(!v.met);
        assert!(!v.reason.is_empty());
    }

    #[test]
    fn transcript_omits_system_messages() {
        let msgs = vec![
            json!({ "role": "system", "content": "you are an agent" }),
            json!({ "role": "user", "content": "do the thing" }),
            json!({ "role": "assistant", "content": "done" }),
        ];
        let t = serialize_transcript(&msgs);
        assert!(!t.contains("you are an agent"));
        assert!(t.contains("do the thing"));
        assert!(t.contains("done"));
    }

    #[tokio::test]
    async fn evaluate_returns_met_verdict() {
        let model = StubModel {
            reply: r#"{"met": true, "reason": "ok"}"#.into(),
        };
        let msgs = vec![json!({ "role": "user", "content": "hi" })];
        let v = evaluate("smol", "cond", &msgs, &model).await.unwrap();
        assert!(v.met);
        assert_eq!(v.reason, "ok");
    }

    #[test]
    fn continuation_prompt_includes_condition_and_reason() {
        let p = continuation_prompt("tests pass", "2 failing");
        assert!(p.contains("tests pass"));
        assert!(p.contains("2 failing"));
    }

    #[test]
    fn a_goal_stops_when_blocked_twice_running_or_out_of_turns() {
        let v = |met: bool, blocked: bool, reason: &str| GoalVerdict { met, blocked, reason: reason.into() };
        let mut g = GoalState::new("tests pass");
        g.turns = 3;
        // One blocked verdict could be a fluke; a normal one resets the count.
        assert_eq!(g.apply_verdict(&v(false, true, "needs a token")), NextStep::Continue);
        assert_eq!(g.apply_verdict(&v(false, false, "2 failing")), NextStep::Continue);
        assert_eq!(g.blocked_streak, 0);
        assert_eq!(g.apply_verdict(&v(false, true, "needs a token")), NextStep::Continue);
        assert_eq!(g.apply_verdict(&v(false, true, "needs the API token")), NextStep::Blocked("needs the API token".into()));
        assert_eq!((g.status, g.blocked_reason.as_str()), (GoalStatus::Blocked, "needs the API token"));
        assert!(!g.is_active());
        // Resuming gives it a fresh allowance from where it is.
        g.resume();
        assert!(g.is_active() && g.blocked_streak == 0 && g.blocked_reason.is_empty());
        assert_eq!(g.max_turns, 3 + DEFAULT_MAX_TURNS);
        // The turn limit stops it even when it is never "blocked".
        let mut capped = GoalState::new("x");
        capped.max_turns = 5;
        capped.turns = 5;
        assert!(matches!(capped.apply_verdict(&v(false, false, "more")), NextStep::Blocked(r) if r.contains("5 turns")));
        // Met wins, whatever else was set.
        let mut done = GoalState::new("x");
        done.blocked_streak = 1;
        assert_eq!(done.apply_verdict(&v(true, false, "ok")), NextStep::Achieved);
        assert_eq!(done.blocked_streak, 0);
    }

    #[test]
    fn the_verdict_carries_blocked_only_when_not_met() {
        let p = parse_verdict(r#"{"met": false, "blocked": true, "reason": "needs a password"}"#);
        assert!(!p.met && p.blocked && p.reason == "needs a password");
        // "met" wins: a goal cannot be both.
        assert!(!parse_verdict(r#"{"met": true, "blocked": true, "reason": "done"}"#).blocked);
        // An evaluator that never heard of `blocked` still parses.
        assert!(!parse_verdict(r#"{"met": false, "reason": "x"}"#).blocked);
        assert!(!parse_verdict("no, not yet").blocked);
    }

    #[test]
    fn wrapup_prompt_asks_for_a_grounded_closing_without_tools() {
        let p = wrapup_prompt("tests pass");
        assert!(p.contains("tests pass") && p.contains("Do not call any tools"));
        assert!(p.contains("do not invent detail"));
    }
}
