//! Per-run settings read off the request body. Each reader is a pure function
//! of the body (and the default it falls back to), so the run start and the
//! turn cycle read one answer and the rules are testable on their own.

/// The run mode for this turn: the body's `run_mode` when it parses, else the
/// session default. The TUI toggles plan mode live this way.
pub(super) fn body_run_mode(
    json_body: &serde_json::Value,
    default: crate::core::agent::plan::RunMode,
) -> crate::core::agent::plan::RunMode {
    json_body
        .get("run_mode")
        .and_then(|v| serde_json::from_value::<crate::core::agent::plan::RunMode>(v.clone()).ok())
        .unwrap_or(default)
}

/// The assistant's instructions with `--append-system-prompt`
/// (`jan_append_system_prompt`) after them, separated by a blank line. A blank
/// addition adds nothing.
pub(super) fn with_appended_instructions(
    base: Option<String>,
    json_body: &serde_json::Value,
) -> Option<String> {
    let extra = json_body
        .get("jan_append_system_prompt")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|t| !t.is_empty());
    match (base, extra) {
        (Some(base), Some(extra)) => Some(format!("{base}\n\n{extra}")),
        (None, Some(extra)) => Some(extra.to_string()),
        (base, None) => base,
    }
}

/// The context window compaction measures against: the configured one, else
/// a window of at least 1 024 tokens the client reported on the body
/// (`jan_context_window`, a listed `max_model_len` or a loaded engine's n_ctx).
pub(super) fn body_context_window(configured: Option<u64>, json_body: &serde_json::Value) -> Option<u64> {
    configured.or_else(|| {
        json_body
            .get("jan_context_window")
            .and_then(|v| v.as_u64())
            .filter(|w| *w >= 1_024)
    })
}

/// The request's `allowed_tools`, when it set one. Present but empty means no
/// tools; absent means no allowlist. Non-string entries are skipped.
pub(super) fn body_allowed_tools(json_body: &serde_json::Value) -> Option<std::collections::HashSet<String>> {
    json_body
        .get("allowed_tools")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
}

/// The model the caller chose, before any running-session fallback: the
/// body's `model`, else the assistant's model hint unless it is blank or `*`.
pub(super) fn explicit_model_choice(
    json_body: &serde_json::Value,
    assistant_model_hint: Option<&str>,
) -> Option<String> {
    if let Some(model) = json_body.get("model").and_then(|v| v.as_str()) {
        return Some(model.to_string());
    }
    assistant_model_hint
        .map(str::trim)
        .filter(|h| !h.is_empty() && *h != "*")
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::agent::plan::RunMode;
    use serde_json::json;

    #[test]
    fn run_mode_comes_from_the_body_when_it_parses() {
        assert_eq!(body_run_mode(&json!({"run_mode": "plan"}), RunMode::Normal), RunMode::Plan);
        assert_eq!(body_run_mode(&json!({"run_mode": "normal"}), RunMode::Plan), RunMode::Normal);
        assert_eq!(body_run_mode(&json!({}), RunMode::Plan), RunMode::Plan);
        assert_eq!(body_run_mode(&json!({"run_mode": "bogus"}), RunMode::Normal), RunMode::Normal);
        assert_eq!(body_run_mode(&json!({"run_mode": 3}), RunMode::Plan), RunMode::Plan);
    }

    #[test]
    fn appended_instructions_follow_the_assistant_after_a_blank_line() {
        let add = |t: &str| json!({ "jan_append_system_prompt": t });
        assert_eq!(
            with_appended_instructions(Some("base".into()), &add("  more  ")),
            Some("base\n\nmore".into())
        );
        assert_eq!(with_appended_instructions(None, &add("more")), Some("more".into()));
        assert_eq!(with_appended_instructions(Some("base".into()), &add("   ")), Some("base".into()));
        assert_eq!(with_appended_instructions(None, &json!({})), None);
        assert_eq!(with_appended_instructions(Some(" base ".into()), &json!({})), Some(" base ".into()));
    }

    #[test]
    fn context_window_prefers_config_then_a_plausible_body_value() {
        let body = json!({ "jan_context_window": 32_768 });
        assert_eq!(body_context_window(Some(8_192), &body), Some(8_192));
        assert_eq!(body_context_window(None, &body), Some(32_768));
        assert_eq!(body_context_window(None, &json!({ "jan_context_window": 1_024 })), Some(1_024));
        assert_eq!(body_context_window(None, &json!({ "jan_context_window": 1_023 })), None);
        assert_eq!(body_context_window(None, &json!({ "jan_context_window": "32768" })), None);
        assert_eq!(body_context_window(None, &json!({})), None);
    }

    #[test]
    fn allowed_tools_absent_empty_and_mixed() {
        assert_eq!(body_allowed_tools(&json!({})), None);
        assert_eq!(body_allowed_tools(&json!({ "allowed_tools": "read" })), None);
        assert_eq!(body_allowed_tools(&json!({ "allowed_tools": [] })), Some(Default::default()));
        let got = body_allowed_tools(&json!({ "allowed_tools": ["read", 3, "bash", "read"] })).unwrap();
        let mut got: Vec<_> = got.into_iter().collect();
        got.sort();
        assert_eq!(got, vec!["bash".to_string(), "read".to_string()]);
    }

    #[test]
    fn explicit_model_is_the_body_then_a_real_assistant_hint() {
        assert_eq!(explicit_model_choice(&json!({"model": "a"}), Some("b")), Some("a".into()));
        assert_eq!(explicit_model_choice(&json!({"model": ""}), Some("b")), Some("".into()));
        assert_eq!(explicit_model_choice(&json!({}), Some("  b  ")), Some("b".into()));
        assert_eq!(explicit_model_choice(&json!({}), Some(" * ")), None);
        assert_eq!(explicit_model_choice(&json!({}), Some("   ")), None);
        assert_eq!(explicit_model_choice(&json!({"model": 7}), None), None);
    }

}
