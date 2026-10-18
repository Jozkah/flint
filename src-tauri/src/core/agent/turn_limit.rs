//! A closing answer when a run hits its turn limit (`[agent]
//! final_answer_on_limit`).
//!
//! A run with a finite `max_turns` that is still calling tools on its last
//! turn ends today with a `BudgetExhausted` error and no answer. With
//! `final_answer_on_limit = true` a top-level run instead makes one more
//! request with tool use withheld and a note telling the model it is out of
//! turns, and returns that reply as the run's answer with
//! `finish_reason: "turn_limit_exceeded"` -- named like the cost ceiling's
//! `budget_exceeded`: the run was stopped by a limit, not failed, and the
//! answer may describe unfinished work.
//!
//! Subagent children never get it: their parent turns the turn-limit error
//! into a status of its own, so a child keeps today's error whatever the
//! project says. Off by default; when off nothing here touches the run.
//!
//! The tools stay in the closing request with `tool_choice: "none"` rather
//! than being dropped, because some providers refuse a history that holds
//! tool calls when the request declares no tools. Any tool call the model
//! emits anyway is dropped from the answer: nothing will run it.

use serde_json::Value;

/// Body key the orchestration layer sets on a top-level run that opted in.
/// Private to the loop like the other `jan_` keys; never forwarded upstream.
pub(crate) const BODY_FINAL_ANSWER_ON_LIMIT: &str = "jan_final_answer_on_limit";

/// The `finish_reason` of an answer produced at the turn limit.
pub(crate) const FINISH_REASON: &str = "turn_limit_exceeded";

/// What the model is told on the closing request.
pub(crate) const OUT_OF_TURNS_NOTE: &str =
    "You are out of turns. Say what you did, what is unfinished and what to do next.";

/// Set or clear the body key for this run: only a top-level run whose project
/// enabled it gets the closing answer. A child's key is always cleared, so it
/// cannot inherit one from a body it was built from.
pub(crate) fn annotate(body: &mut Value, enabled: bool, is_child: bool) {
    let Some(obj) = body.as_object_mut() else { return };
    if enabled && !is_child {
        obj.insert(BODY_FINAL_ANSWER_ON_LIMIT.to_string(), Value::Bool(true));
    } else {
        obj.remove(BODY_FINAL_ANSWER_ON_LIMIT);
    }
}

/// Whether this run asked for a closing answer at the turn limit.
pub(crate) fn enabled(body: &Value) -> bool {
    body.get(BODY_FINAL_ANSWER_ON_LIMIT).and_then(Value::as_bool).unwrap_or(false)
}

/// The closing request: the ordinary request with tool use switched off.
pub(crate) fn without_tool_use(mut request: Value) -> Value {
    if let Some(obj) = request.as_object_mut() {
        obj.insert("tool_choice".to_string(), Value::String("none".to_string()));
    }
    request
}

/// The closing reply as the run's terminal answer: no tool calls, and the
/// turn-limit finish reason.
pub(crate) fn as_final_answer(mut completion: Value) -> Value {
    if let Some(choice) = completion
        .get_mut("choices")
        .and_then(|c| c.as_array_mut())
        .and_then(|choices| choices.first_mut())
    {
        if let Some(message) = choice.get_mut("message").and_then(|m| m.as_object_mut()) {
            message.remove("tool_calls");
        }
        choice["finish_reason"] = Value::String(FINISH_REASON.to_string());
    }
    completion
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_an_enabled_top_level_run_is_annotated() {
        let mut body = json!({ "model": "m" });
        annotate(&mut body, false, false);
        assert_eq!(body, json!({ "model": "m" }), "off leaves the body as it was");
        annotate(&mut body, true, true);
        assert!(!enabled(&body), "a child never gets it");
        annotate(&mut body, true, false);
        assert!(enabled(&body));
        // A child built from a top-level body loses the key.
        annotate(&mut body, true, true);
        assert!(!enabled(&body));
    }

    #[test]
    fn the_closing_reply_has_no_tool_calls_and_the_limit_reason() {
        let reply = json!({ "choices": [{
            "message": { "content": "did a, b is left", "tool_calls": [{ "id": "x" }] },
            "finish_reason": "tool_calls"
        }]});
        let out = as_final_answer(reply);
        assert_eq!(out["choices"][0]["finish_reason"], "turn_limit_exceeded");
        assert!(out["choices"][0]["message"].get("tool_calls").is_none());
        assert_eq!(out["choices"][0]["message"]["content"], "did a, b is left");
        let req = without_tool_use(json!({ "tool_choice": "auto", "tools": [1] }));
        assert_eq!(req["tool_choice"], "none");
        assert_eq!(req["tools"], json!([1]));
    }
}
