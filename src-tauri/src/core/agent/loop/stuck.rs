use super::*;

/// Why the loop decided the model is stuck.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StuckReason {
    /// The same tool calls, with the same arguments, `count` turns in a row.
    RepeatedCalls { count: usize, calls: String },
    /// Every tool call failed, `count` turns in a row.
    RepeatedErrors { count: usize, last_error: String },
}

impl StuckReason {
    pub(crate) fn summary(&self) -> String {
        match self {
            StuckReason::RepeatedCalls { count, calls } => format!(
                "The agent has made the same tool call {count} times in a row without progress: {calls}"
            ),
            StuckReason::RepeatedErrors { count, last_error } => format!(
                "The agent's tool calls have failed {count} turns in a row. Latest error: {last_error}"
            ),
        }
    }
}

/// Tracks executed tool-call turns to notice a model going around in circles.
#[derive(Debug, Default)]
pub(crate) struct StuckDetector {
    pub(super) last_signature: Option<String>,
    pub(super) repeats: usize,
    pub(super) error_turns: usize,
}

impl StuckDetector {
    /// Canonical identity of a turn's calls: name plus parsed arguments, sorted
    /// so call order does not matter.
    pub(crate) fn signature(calls: &[serde_json::Value]) -> String {
        let mut parts: Vec<String> = calls
            .iter()
            .map(|tc| {
                let f = tc.get("function");
                let name = f
                    .and_then(|f| f.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let args = match f.and_then(|f| f.get("arguments")) {
                    Some(serde_json::Value::String(s)) => {
                        serde_json::from_str::<serde_json::Value>(s)
                            .map(|v| canonical_json(&v))
                            .unwrap_or_else(|_| s.clone())
                    }
                    Some(v) => canonical_json(v),
                    None => String::new(),
                };
                format!("{name}({args})")
            })
            .collect();
        parts.sort();
        parts.join(", ")
    }

    /// Record one turn. Returns a reason once a limit is reached.
    pub(crate) fn observe(
        &mut self,
        signature: String,
        all_failed: bool,
        last_error: &str,
    ) -> Option<StuckReason> {
        if self.last_signature.as_deref() == Some(signature.as_str()) {
            self.repeats += 1;
        } else {
            self.repeats = 1;
        }
        self.error_turns = if all_failed { self.error_turns + 1 } else { 0 };
        let reason = if self.repeats >= STUCK_TURN_LIMIT {
            Some(StuckReason::RepeatedCalls {
                count: self.repeats,
                calls: truncate_chars(&signature, 300),
            })
        } else if self.error_turns >= STUCK_TURN_LIMIT {
            Some(StuckReason::RepeatedErrors {
                count: self.error_turns,
                last_error: truncate_chars(last_error, 300),
            })
        } else {
            None
        };
        self.last_signature = Some(signature);
        reason
    }

    /// Forget history, e.g. after the user has given guidance.
    pub(crate) fn reset(&mut self) {
        *self = Self::default();
    }
}

/// JSON text with object keys sorted at every level, so two argument objects
/// that differ only in key order compare equal.
pub(super) fn canonical_json(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let body: Vec<String> = keys
                .into_iter()
                .map(|k| {
                    let key = serde_json::Value::String(k.clone());
                    format!("{key}:{}", canonical_json(&map[k]))
                })
                .collect();
            format!("{{{}}}", body.join(","))
        }
        serde_json::Value::Array(items) => {
            let body: Vec<String> = items.iter().map(canonical_json).collect();
            format!("[{}]", body.join(","))
        }
        other => other.to_string(),
    }
}

pub(super) fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let head: String = s.chars().take(max).collect();
        format!("{head}...")
    }
}

/// Result of asking the user for guidance outside of a model `ask` call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum UserGuidance {
    /// No interactive UI is attached.
    Unavailable,
    /// The user dismissed the question or chose to stop.
    Stop,
    /// The user's answer, to hand to the model.
    Answer(String),
}

/// Option label the user picks to end a stuck run.
pub(super) const STUCK_STOP_LABEL: &str = "Stop the run";
/// Option label the user picks to let a stuck run continue.
pub(super) const STUCK_CONTINUE_LABEL: &str = "Try a different approach";
