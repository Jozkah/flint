//! Refusals that show the call they expected (transcript audit #12).
//!
//! "missing required argument 'path'" tells a model which word is wrong but
//! not what a right call looks like, and a model that sent `file_path` or put
//! the edits at the top level sends the same call again. A refusal of a
//! built-in tool's arguments is followed by the expected shape, built from the
//! tool's own schema, and by the keys that were actually sent.

use serde_json::{Map, Value};

fn schema_of(tool: &str) -> Option<Value> {
    super::schema::builtin_tool_schemas()
        .into_iter()
        .find(|s| s.pointer("/function/name").and_then(Value::as_str) == Some(tool))
        .and_then(|s| s.pointer("/function/parameters").cloned())
}

fn example_of(name: &str, schema: &Value) -> Value {
    match schema.get("type").and_then(Value::as_str) {
        Some("object") => {
            let mut out = Map::new();
            let props = schema.get("properties").and_then(Value::as_object);
            let required: Vec<&str> = schema
                .get("required")
                .and_then(Value::as_array)
                .map(|r| r.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            if let Some(props) = props {
                for key in &required {
                    if let Some(p) = props.get(*key) {
                        out.insert((*key).to_string(), example_of(key, p));
                    }
                }
            }
            Value::Object(out)
        }
        Some("array") => {
            let item = schema
                .get("items")
                .map(|i| example_of(name, i))
                .unwrap_or(Value::String("...".into()));
            Value::Array(vec![item])
        }
        Some("boolean") => Value::Bool(true),
        Some("integer") | Some("number") => Value::from(1),
        _ => {
            if let Some(first) = schema
                .get("enum")
                .and_then(Value::as_array)
                .and_then(|e| e.first())
            {
                return first.clone();
            }
            Value::String(format!("<{name}>"))
        }
    }
}

/// A one-line example of a valid call to `tool`: its required arguments with
/// placeholder values. `None` for a tool that is not built in, or that takes
/// no required arguments.
pub fn example(tool: &str) -> Option<String> {
    // `bash` is intentionally multi-mode: run a command, collect/inspect/cancel
    // one job, or list jobs. Its schema therefore has no globally-required key,
    // which used to make the generic repair return no example at all. Give the
    // most common valid shape here; `multi_mode_hint` below lists the rest.
    if tool == "bash" {
        return Some(r#"{"command":"<command>"}"#.to_string());
    }

    let schema = schema_of(tool)?;
    let ex = example_of(tool, &schema);
    if ex.as_object().is_some_and(|o| o.is_empty()) {
        return None;
    }
    serde_json::to_string(&ex).ok()
}

/// Extra valid shapes for tools whose contract is a union rather than one set
/// of globally-required arguments.
fn multi_mode_hint(tool: &str) -> &'static str {
    match tool {
        "bash" => {
            " Valid `bash` forms: {\"command\":\"...\"}; {\"action\":\"list\"}; {\"job_id\":\"ID\"}; {\"job_id\":\"ID\",\"action\":\"status\"}; or {\"job_id\":\"ID\",\"action\":\"cancel\"}. Do not send an empty object."
        }
        _ => "",
    }
}

/// Whether a tool's output is a refusal of its arguments (as opposed to a
/// failure of the work it was asked to do).
fn is_argument_refusal(output: &str) -> bool {
    let head = output.trim_start();
    let head = head.strip_prefix("ERROR:").unwrap_or(head).trim_start();
    head.starts_with("missing required argument")
        || head.starts_with("invalid argument")
        || head.contains("is not a valid call")
        || head.contains("must be a string")
        || head.contains("must be an array")
        || head.contains("must be an object")
}

/// Common wrong names for a built-in argument.
fn alias_hint(tool: &str, sent: &[&str]) -> Option<String> {
    let schema = schema_of(tool)?;
    let props = schema.get("properties")?.as_object()?;
    for (wrong, right) in [
        ("file_path", "path"),
        ("filepath", "path"),
        ("file", "path"),
        ("filename", "path"),
        ("dir", "path"),
        ("directory", "path"),
        ("text", "content"),
        ("contents", "content"),
        ("cmd", "command"),
        ("old_str", "old_string"),
        ("new_str", "new_string"),
    ] {
        if sent.contains(&wrong) && props.contains_key(right) && !sent.contains(&right) {
            return Some(format!(" `{wrong}` is not an argument of `{tool}`; it is called `{right}`."));
        }
    }
    if tool == "edit"
        && sent.contains(&"old_string")
        && !sent.contains(&"edits")
    {
        return Some(
            " `old_string`/`new_string` go inside `edits`, a list of replacements.".to_string(),
        );
    }
    None
}

/// `output` with the expected shape appended, when it is a refusal of the
/// call's arguments; otherwise `output` unchanged.
pub fn explain(tool: &str, args: &Value, output: String) -> String {
    if !is_argument_refusal(&output) || output.contains("Expected call shape:") {
        return output;
    }
    let Some(example) = example(tool) else {
        return output;
    };
    let sent: Vec<&str> = args
        .as_object()
        .map(|o| o.keys().map(String::as_str).collect())
        .unwrap_or_default();
    let sent_text = if sent.is_empty() {
        "no arguments".to_string()
    } else {
        sent.iter().map(|k| format!("`{k}`")).collect::<Vec<_>>().join(", ")
    };
    let hint = alias_hint(tool, &sent).unwrap_or_default();
    let modes = multi_mode_hint(tool);
    format!(
        "{}\nExpected call shape: {example} (required arguments; see the tool's schema for the optional ones). You sent: {sent_text}.{hint}{modes}",
        output.trim_end()
    )
}

fn distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut diag = prev[0];
        prev[0] = i + 1;
        for j in 1..=b.len() {
            let up = prev[j];
            prev[j] = (prev[j] + 1)
                .min(prev[j - 1] + 1)
                .min(diag + usize::from(ca != b[j - 1]));
            diag = up;
        }
    }
    prev[b.len()]
}

/// Up to five offered tool names close to `name`, closest first (transcript
/// audit #11): a typo or a half-remembered name gets the real one back.
pub fn close_matches<'a>(name: &str, offered: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let want = name.to_lowercase();
    let mut scored: Vec<(usize, &str)> = offered
        .into_iter()
        .filter_map(|c| {
            let low = c.to_lowercase();
            let d = distance(&want, &low);
            let near = d <= (want.chars().count() / 3).max(2);
            let contains = want.len() >= 3 && (low.contains(&want) || want.contains(&low));
            (near || contains).then_some((if contains { d.saturating_sub(1) } else { d }, c))
        })
        .collect();
    scored.sort();
    scored.into_iter().take(5).map(|(_, n)| n.to_string()).collect()
}

/// The sentence naming close matches, or an empty string.
pub fn did_you_mean<'a>(name: &str, offered: impl IntoIterator<Item = &'a str>) -> String {
    let near = close_matches(name, offered);
    if near.is_empty() {
        String::new()
    } else {
        format!(
            " Did you mean: {}? Call only tools from the list you were given.",
            near.iter().map(|n| format!("'{n}'")).collect::<Vec<_>>().join(", ")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_missing_path_on_edit_shows_the_whole_shape() {
        let out = explain(
            "edit",
            &json!({"file_path": "a.txt", "old_string": "x", "new_string": "y"}),
            "ERROR: missing required argument 'path'".into(),
        );
        assert!(out.starts_with("ERROR: missing required argument 'path'"), "{out}");
        assert!(out.contains(r#""path":"<path>""#), "{out}");
        assert!(out.contains(r#""edits":[{"#), "{out}");
        assert!(out.contains("`file_path`"), "{out}");
        assert!(out.contains("it is called `path`"), "{out}");
    }

    #[test]
    fn write_names_both_of_its_arguments() {
        let ex = example("write").unwrap();
        assert!(ex.contains("\"path\"") && ex.contains("\"content\""), "{ex}");
    }

    #[test]
    fn bash_argument_refusal_shows_every_valid_mode() {
        let out = explain(
            "bash",
            &json!({}),
            "ERROR: bash is not a valid call without a command, job_id or list action".into(),
        );
        assert!(out.contains(r#"{"command":"<command>"}"#), "{out}");
        assert!(out.contains(r#"{"action":"list"}"#), "{out}");
        assert!(out.contains(r#"{"job_id":"ID"}"#), "{out}");
        assert!(out.contains("Do not send an empty object"), "{out}");
    }

    #[test]
    fn a_failure_of_the_work_is_left_alone() {
        let out = explain("read", &json!({"path": "a"}), "ERROR: file not found: a".into());
        assert_eq!(out, "ERROR: file not found: a");
        let ok = explain("read", &json!({"path": "a"}), "hello".into());
        assert_eq!(ok, "hello");
    }

    #[test]
    fn a_misspelled_tool_gets_the_real_names_back() {
        let offered = ["read", "write", "edit", "ida_py_eval", "grep"];
        assert_eq!(close_matches("py_eval", offered), vec!["ida_py_eval"]);
        assert_eq!(close_matches("reed", offered)[0], "read");
        assert!(close_matches("close_instance", offered).is_empty());
        assert!(did_you_mean("edti", offered).contains("'edit'"));
    }

    #[test]
    fn an_unknown_tool_has_no_shape() {
        assert!(example("nope").is_none());
    }
}