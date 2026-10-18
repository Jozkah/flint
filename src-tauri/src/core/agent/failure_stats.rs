//! How many of a run's tool calls failed, per tool.
//!
//! A call counts as failed when the loop's one classification says so
//! (`tool_outcome_failed`, AH-009): a result starting with `ERROR` -- which is
//! also how every refusal (a `[[tool_rules]]` rule, the permission gate, an
//! unknown tool) is worded -- or a `bash` call whose command exited non-zero.
//! That is the same `is_error` the `tool_result` event carries, so a count
//! taken from the event stream and a count taken where the calls are
//! dispatched agree by construction.
//!
//! Two readers: `[[tool_rules]] max_failures` refuses a tool once it has
//! failed that often in the run, and the headless run's result envelope
//! reports `tool_failures` / `completed_with_failures`.

use std::collections::BTreeMap;

/// Failed tool calls so far, by tool name. A `BTreeMap` so the envelope
/// prints tools in a stable order.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct FailureStats {
    by_tool: BTreeMap<String, u32>,
}

impl FailureStats {
    /// Note one failed call of `tool`.
    pub fn record(&mut self, tool: &str) {
        *self.by_tool.entry(tool.to_string()).or_insert(0) += 1;
    }

    /// How many calls of `tool` have failed.
    pub fn count(&self, tool: &str) -> u32 {
        self.by_tool.get(tool).copied().unwrap_or(0)
    }

    /// Whether no call has failed.
    pub fn is_empty(&self) -> bool {
        self.by_tool.is_empty()
    }

    /// The counts, by tool name.
    pub fn by_tool(&self) -> &BTreeMap<String, u32> {
        &self.by_tool
    }
}

/// The names of the calls in `tool_calls` whose outcome failed, matched to
/// their outcome by call id. A call with no outcome is not counted.
pub(crate) fn failed_tools(
    tool_calls: &[serde_json::Value],
    outcomes: &[crate::core::agent::r#loop::ToolOutcome],
) -> Vec<String> {
    outcomes
        .iter()
        .filter_map(|outcome| {
            let call = tool_calls
                .iter()
                .find(|tc| tc.get("id").and_then(|v| v.as_str()) == Some(outcome.id.as_str()))?;
            let name = call
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or_default();
            let failed = outcome.refusal.is_some()
                || crate::core::agent::r#loop::tool_outcome_failed(name, &outcome.content);
            failed.then(|| name.to_string())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::agent::r#loop::ToolOutcome;
    use serde_json::json;

    fn call(id: &str, name: &str) -> serde_json::Value {
        json!({ "id": id, "type": "function", "function": { "name": name, "arguments": "{}" } })
    }

    #[test]
    fn counts_accumulate_per_tool() {
        let mut stats = FailureStats::default();
        assert!(stats.is_empty());
        stats.record("bash");
        stats.record("bash");
        stats.record("read");
        assert_eq!(stats.count("bash"), 2);
        assert_eq!(stats.count("read"), 1);
        assert_eq!(stats.count("edit"), 0);
        assert_eq!(stats.by_tool().keys().collect::<Vec<_>>(), ["bash", "read"]);
    }

    fn outcome(id: &str, content: &str) -> ToolOutcome {
        ToolOutcome {
            id: id.to_string(),
            content: content.to_string(),
            diff: None,
            images: Vec::new(),
            parts: None,
            details: None,
            refusal: None,
        }
    }

    #[test]
    fn only_failed_outcomes_are_named() {
        let calls = [call("a", "read"), call("b", "bash"), call("c", "ls")];
        let outcomes = [
            outcome("a", "ERROR: no such file"),
            outcome("b", "hello"),
            outcome("c", "a.txt"),
        ];
        assert_eq!(failed_tools(&calls, &outcomes), ["read"]);
    }
}
