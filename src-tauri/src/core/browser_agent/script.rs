//! The script the agent runs inside the browser pane, and how its answer is read.

use std::sync::OnceLock;

use serde_json::Value;

const AGENT_JS: &str = include_str!("agent.js");

/// Names the hidden property that holds snapshot state on the page's `window`.
/// Random per app start, so a page cannot be written to look for it ahead of
/// time (it can still enumerate its own properties; the state is just element
/// references the page already has).
pub fn state_key() -> &'static str {
    static KEY: OnceLock<String> = OnceLock::new();
    KEY.get_or_init(|| format!("__flint_{}", &super::fence::new_nonce()[..12]))
}

/// The JavaScript to evaluate for one operation. Every value is passed as a JSON
/// literal, never spliced as text, so page-derived or model-supplied strings
/// cannot break out of their argument.
pub fn build(key: &str, op: &str, args: &Value) -> String {
    format!(
        "{}({},{},{})",
        AGENT_JS.trim_end(),
        Value::String(key.to_string()),
        Value::String(op.to_string()),
        args
    )
}

/// The platform hands back the script's value as JSON text; a string result
/// arrives JSON-encoded a second time on some platforms.
pub fn parse_result(raw: &str) -> Result<Value, String> {
    let mut v: Value = serde_json::from_str(raw.trim()).map_err(|e| format!("the page returned something unreadable: {e}"))?;
    if let Value::String(inner) = &v {
        if let Ok(parsed) = serde_json::from_str::<Value>(inner) {
            v = parsed;
        }
    }
    match v {
        Value::Object(_) => Ok(v),
        Value::Null => Err("the page returned nothing (it may be navigating)".into()),
        other => Err(format!("unexpected result from the page: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn arguments_are_json_literals() {
        let hostile = "\"); alert(1); (\"";
        let js = build("k", "type", &json!({ "text": hostile, "id": "1.2" }));
        // The hostile text only ever appears inside a quoted, escaped JSON string.
        assert!(js.contains(r#"\"); alert(1); (\""#), "{}", &js[js.len().saturating_sub(120)..]);
        assert!(js.contains(r#"("k","type",{"#), "{}", &js[js.len().saturating_sub(120)..]);
    }

    #[test]
    fn the_script_is_an_uncalled_function_expression() {
        let t = AGENT_JS.trim_end();
        assert!(t.contains("(function (KEY, OP, ARGS)"));
        assert!(t.ends_with(")"), "must end with the closing paren so the call can follow");
    }

    #[test]
    fn state_key_is_stable_within_a_run_and_not_guessable() {
        assert_eq!(state_key(), state_key());
        assert!(state_key().starts_with("__flint_"));
        assert_eq!(state_key().len(), "__flint_".len() + 12);
    }

    #[test]
    fn results_parse_in_both_encodings() {
        assert_eq!(parse_result(r#"{"ok":true}"#).unwrap()["ok"], json!(true));
        assert_eq!(parse_result(r#""{\"ok\":true}""#).unwrap()["ok"], json!(true));
        assert!(parse_result("null").is_err());
        assert!(parse_result("").is_err());
        assert!(parse_result("42").is_err());
        assert!(parse_result("\"just text\"").is_err());
    }
}
