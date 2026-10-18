//! Rules about the order and number of a run's tool calls, from `agent.toml`.
//!
//! Some policy is about how tools are used together rather than about any one
//! call: "read before you edit", "no more than twenty shell commands", "do not
//! run the same command twice in a row". A project writes those as
//! `[[tool_rules]]` and the loop applies them before a call runs:
//!
//! ```toml
//! [[tool_rules]]
//! tool = "edit"
//! after = "read"
//! reason = "Read the file before editing it."
//!
//! [[tool_rules]]
//! tool = "bash"
//! max_calls = 20
//! no_repeat = true
//!
//! [[tool_rules]]
//! tool = "bash"
//! max_failures = 3
//! ```
//!
//! `max_failures` is a retry budget: once the tool has failed that many times
//! in the run (see [`failure_stats`](super::failure_stats) for what counts as
//! a failure, refusals included), further calls of it are refused with "it
//! failed N times in this run; try a different approach". A batch's failures
//! are counted when its results are in, so like the other rules it only sees
//! earlier batches.
//!
//! A refused call is answered with the rule's reason as the tool result, so the
//! model learns what to do first instead of seeing a bare refusal. A rule can
//! only refuse: it never grants a call the permission gate would not.
//!
//! Calls in one batch run side by side, so a rule is checked against the calls
//! of earlier batches only: `after = "read"` is met by a read from a previous
//! turn, not by one listed next to the edit.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::Value;

/// One `[[tool_rules]]` entry as written.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct ToolRuleSpec {
    /// The tool the rule is about.
    pub tool: String,
    /// Another tool that must have been called earlier in the run.
    pub after: Option<String>,
    /// The most times the tool may be called in the run.
    pub max_calls: Option<u32>,
    /// Refuse a call whose arguments equal the tool's previous call.
    pub no_repeat: bool,
    /// Refuse the tool once this many of its calls have failed in the run.
    pub max_failures: Option<u32>,
    /// What the model is told when the rule refuses a call.
    pub reason: Option<String>,
}

/// The longest reason handed to the model.
const MAX_REASON_CHARS: usize = 300;

/// What the run has called so far.
#[derive(Debug, Default)]
pub struct CallLog {
    counts: HashMap<String, u32>,
    last_args: HashMap<String, String>,
    failures: crate::core::agent::failure_stats::FailureStats,
}

impl CallLog {
    /// Why `tool` called with `args` may not run now, if a rule says so.
    pub fn refusal(&self, rules: &[ToolRuleSpec], tool: &str, args: &Value) -> Option<String> {
        for rule in rules.iter().filter(|r| r.tool == tool) {
            let why = |default: String| -> String {
                let text = rule
                    .reason
                    .as_deref()
                    .map(str::trim)
                    .filter(|r| !r.is_empty())
                    .map(|r| r.chars().take(MAX_REASON_CHARS).collect::<String>())
                    .unwrap_or(default);
                format!("ERROR: tool '{tool}' was not run: {text}")
            };
            if let Some(before) = rule.after.as_deref() {
                if self.counts.get(before).copied().unwrap_or(0) == 0 {
                    return Some(why(format!("call '{before}' first")));
                }
            }
            if let Some(max) = rule.max_calls {
                if self.counts.get(tool).copied().unwrap_or(0) >= max {
                    return Some(why(format!("this run may call it at most {max} times")));
                }
            }
            if let Some(max) = rule.max_failures {
                let failed = self.failures.count(tool);
                if failed >= max {
                    return Some(why(format!(
                        "it failed {failed} times in this run; try a different approach"
                    )));
                }
            }
            if rule.no_repeat && self.last_args.get(tool).is_some_and(|last| *last == canonical(args)) {
                return Some(why("it was just called with the same arguments".to_string()));
            }
        }
        None
    }

    /// Note that `tool` was called with `args`.
    pub fn record(&mut self, tool: &str, args: &Value) {
        *self.counts.entry(tool.to_string()).or_insert(0) += 1;
        self.last_args.insert(tool.to_string(), canonical(args));
    }

    /// Note that a call of `tool` failed.
    pub fn record_failure(&mut self, tool: &str) {
        self.failures.record(tool);
    }
}

/// Arguments in a form two equal calls share: keys sorted, no spacing.
fn canonical(args: &Value) -> String {
    fn sorted(value: &Value) -> Value {
        match value {
            Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                Value::Object(keys.into_iter().map(|k| (k.clone(), sorted(&map[k]))).collect())
            }
            Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
            other => other.clone(),
        }
    }
    sorted(args).to_string()
}

/// The rules worth keeping: a rule with no tool, or that asks for nothing, says
/// nothing and is dropped rather than guessed at.
pub fn usable(specs: Vec<ToolRuleSpec>) -> Vec<ToolRuleSpec> {
    specs
        .into_iter()
        .filter(|r| {
            !r.tool.trim().is_empty() && (r.after.is_some() || r.max_calls.is_some() || r.no_repeat || r.max_failures.is_some())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rule(tool: &str) -> ToolRuleSpec {
        ToolRuleSpec { tool: tool.to_string(), ..Default::default() }
    }

    #[test]
    fn after_holds_a_call_until_the_other_tool_has_been_called() {
        let rules = vec![ToolRuleSpec {
            after: Some("read".into()),
            reason: Some("Read the file before editing it.".into()),
            ..rule("edit")
        }];
        let mut log = CallLog::default();
        let refused = log.refusal(&rules, "edit", &json!({})).unwrap();
        assert!(refused.contains("Read the file before editing it."), "{refused}");
        assert!(log.refusal(&rules, "write", &json!({})).is_none(), "other tools are untouched");
        log.record("read", &json!({ "path": "a.rs" }));
        assert!(log.refusal(&rules, "edit", &json!({})).is_none());
    }

    #[test]
    fn max_calls_stops_the_tool_at_its_limit() {
        let rules = vec![ToolRuleSpec { max_calls: Some(2), ..rule("bash") }];
        let mut log = CallLog::default();
        for n in 0..2 {
            assert!(log.refusal(&rules, "bash", &json!({ "n": n })).is_none());
            log.record("bash", &json!({ "n": n }));
        }
        let refused = log.refusal(&rules, "bash", &json!({ "n": 9 })).unwrap();
        assert!(refused.contains("at most 2 times"), "{refused}");
    }

    #[test]
    fn max_failures_refuses_the_tool_once_it_has_failed_that_often() {
        let rules = vec![ToolRuleSpec { max_failures: Some(2), ..rule("bash") }];
        let mut log = CallLog::default();
        log.record_failure("bash");
        assert!(log.refusal(&rules, "bash", &json!({})).is_none(), "one failure is under the budget");
        log.record_failure("read");
        assert!(log.refusal(&rules, "bash", &json!({})).is_none(), "another tool's failure does not count");
        log.record_failure("bash");
        let refused = log.refusal(&rules, "bash", &json!({})).unwrap();
        assert_eq!(
            refused,
            "ERROR: tool 'bash' was not run: it failed 2 times in this run; try a different approach"
        );
        assert!(log.refusal(&rules, "read", &json!({})).is_none(), "the rule is only about bash");
        let parsed: ToolRuleSpec = toml::from_str("tool = \"bash\"
max_failures = 3
").unwrap();
        assert_eq!(parsed.max_failures, Some(3));
        assert_eq!(usable(vec![parsed]).len(), 1, "max_failures alone is a usable rule");
    }

    #[test]
    fn no_repeat_refuses_only_an_identical_call_straight_after() {
        let rules = vec![ToolRuleSpec { no_repeat: true, ..rule("bash") }];
        let mut log = CallLog::default();
        log.record("bash", &json!({ "command": "ls", "cwd": "." }));
        // Key order does not make it a different call.
        assert!(log.refusal(&rules, "bash", &json!({ "cwd": ".", "command": "ls" })).is_some());
        assert!(log.refusal(&rules, "bash", &json!({ "command": "pwd", "cwd": "." })).is_none());
        log.record("bash", &json!({ "command": "pwd", "cwd": "." }));
        assert!(log.refusal(&rules, "bash", &json!({ "command": "ls", "cwd": "." })).is_none());
    }

    #[test]
    fn the_reason_is_capped_and_a_missing_one_gets_a_plain_default() {
        let long = "x".repeat(900);
        let rules = vec![ToolRuleSpec { max_calls: Some(0), reason: Some(long), ..rule("bash") }];
        let text = CallLog::default().refusal(&rules, "bash", &json!({})).unwrap();
        assert!(text.chars().count() < 400, "{}", text.chars().count());
        let plain = vec![ToolRuleSpec { max_calls: Some(0), ..rule("bash") }];
        assert!(CallLog::default().refusal(&plain, "bash", &json!({})).unwrap().contains("at most 0"));
    }

    #[test]
    fn rules_that_ask_for_nothing_are_dropped_and_unknown_keys_refused() {
        let kept = usable(vec![rule("bash"), ToolRuleSpec { no_repeat: true, ..rule("bash") }, ToolRuleSpec { no_repeat: true, ..rule("") }]);
        assert_eq!(kept.len(), 1);
        let parsed: Result<ToolRuleSpec, _> = toml::from_str("tool = \"edit\"\nafter = \"read\"\n");
        assert_eq!(parsed.unwrap().after.as_deref(), Some("read"));
        // A misspelt key must not take the project's other policy down with
        // it, so it parses; the rule then has nothing to ask for and is dropped.
        let typo: ToolRuleSpec = toml::from_str("tool = \"edit\"\nafer = \"read\"\n").unwrap();
        assert!(usable(vec![typo]).is_empty());
    }
}
