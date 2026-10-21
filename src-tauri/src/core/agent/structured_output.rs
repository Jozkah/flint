//! Structured final output (`agent run --json-schema`): the run's final answer
//! must be one JSON value that validates against a JSON Schema, with a bounded
//! repair loop that feeds the validation error back to the model.
//!
//! The validator covers the subset of JSON Schema that output contracts use:
//! `type`, `enum`, `const`, `properties`, `required`, `additionalProperties`,
//! `items`, `minItems`/`maxItems`, `minLength`/`maxLength`, `pattern`,
//! `minimum`/`maximum` (and the exclusive forms), `oneOf`, `anyOf`, `allOf`.
//! A schema that uses a keyword outside it (`$ref`, `if`, `patternProperties`,
//! ...) is refused when it is loaded, never silently treated as passing.

use serde_json::Value;

/// Repair attempts a run gets by default.
pub const DEFAULT_ATTEMPTS: u64 = 3;

const UNSUPPORTED: &[&str] = &[
    "$ref",
    "$defs",
    "definitions",
    "if",
    "then",
    "else",
    "not",
    "patternProperties",
    "dependentSchemas",
    "dependentRequired",
    "propertyNames",
    "contains",
    "uniqueItems",
    "multipleOf",
    "prefixItems",
    "unevaluatedProperties",
    "unevaluatedItems",
];

/// Check a schema can be enforced here, and return it.
pub fn load(schema: Value) -> Result<Value, String> {
    fn walk(v: &Value, at: &str) -> Result<(), String> {
        match v {
            Value::Bool(_) => Ok(()),
            Value::Object(map) => {
                for key in map.keys() {
                    if UNSUPPORTED.contains(&key.as_str()) {
                        return Err(format!("the schema uses `{key}` (at {at}), which is not supported"));
                    }
                }
                for (key, child) in map {
                    match key.as_str() {
                        "properties" => {
                            if let Some(props) = child.as_object() {
                                for (name, sub) in props {
                                    walk(sub, &format!("{at}/properties/{name}"))?;
                                }
                            }
                        }
                        "items" | "additionalProperties" => walk(child, &format!("{at}/{key}"))?,
                        "oneOf" | "anyOf" | "allOf" => {
                            for (i, sub) in child.as_array().into_iter().flatten().enumerate() {
                                walk(sub, &format!("{at}/{key}/{i}"))?;
                            }
                        }
                        _ => {}
                    }
                }
                if let Some(Value::String(p)) = map.get("pattern") {
                    regex::Regex::new(p).map_err(|e| format!("invalid `pattern` at {at}: {e}"))?;
                }
                Ok(())
            }
            _ => Err(format!("a schema must be an object or a boolean (at {at})")),
        }
    }
    walk(&schema, "#")?;
    Ok(schema)
}

/// The JSON value in a model's answer: the whole text, a fenced block, or the
/// first complete object/array in it.
pub fn extract_json(text: &str) -> Option<Value> {
    let t = text.trim();
    if let Ok(v) = serde_json::from_str::<Value>(t) {
        return Some(v);
    }
    if let Some(start) = t.find("```") {
        let after = &t[start + 3..];
        let body = after.split_once('\n').map_or(after, |(_, rest)| rest);
        if let Some(end) = body.find("```") {
            if let Ok(v) = serde_json::from_str::<Value>(body[..end].trim()) {
                return Some(v);
            }
        }
    }
    for (i, c) in t.char_indices() {
        if c != '{' && c != '[' {
            continue;
        }
        let mut de = serde_json::Deserializer::from_str(&t[i..]).into_iter::<Value>();
        if let Some(Ok(v)) = de.next() {
            return Some(v);
        }
    }
    None
}

/// Validate `value` against `schema`; the error lists up to five problems.
pub fn validate(schema: &Value, value: &Value) -> Result<(), String> {
    let mut errors = Vec::new();
    check(schema, value, "$", &mut errors);
    if errors.is_empty() {
        Ok(())
    } else {
        errors.truncate(5);
        Err(errors.join("; "))
    }
}

/// The answer's JSON, validated; or why it is not.
pub fn check_answer(schema: &Value, answer: &str) -> Result<Value, String> {
    let value = extract_json(answer).ok_or_else(|| "the answer contains no JSON value".to_string())?;
    validate(schema, &value)?;
    Ok(value)
}

fn type_ok(ty: &str, v: &Value) -> bool {
    match ty {
        "string" => v.is_string(),
        "boolean" => v.is_boolean(),
        "null" => v.is_null(),
        "array" => v.is_array(),
        "object" => v.is_object(),
        "number" => v.is_number(),
        "integer" => v.is_i64() || v.is_u64() || v.as_f64().is_some_and(|f| f.fract() == 0.0),
        _ => false,
    }
}

fn check(schema: &Value, v: &Value, at: &str, errors: &mut Vec<String>) {
    let map = match schema {
        Value::Bool(true) => return,
        Value::Bool(false) => {
            errors.push(format!("{at}: no value is allowed here"));
            return;
        }
        Value::Object(m) => m,
        _ => return,
    };
    if let Some(ty) = map.get("type") {
        let ok = match ty {
            Value::String(t) => type_ok(t, v),
            Value::Array(ts) => ts.iter().filter_map(Value::as_str).any(|t| type_ok(t, v)),
            _ => true,
        };
        if !ok {
            errors.push(format!("{at}: expected type {ty}"));
            return;
        }
    }
    if let Some(Value::Array(options)) = map.get("enum") {
        if !options.contains(v) {
            errors.push(format!("{at}: not one of the allowed values"));
        }
    }
    if let Some(c) = map.get("const") {
        if c != v {
            errors.push(format!("{at}: must equal {c}"));
        }
    }
    if let Some(s) = v.as_str() {
        let len = s.chars().count() as u64;
        if let Some(min) = map.get("minLength").and_then(Value::as_u64) {
            if len < min {
                errors.push(format!("{at}: shorter than {min} characters"));
            }
        }
        if let Some(max) = map.get("maxLength").and_then(Value::as_u64) {
            if len > max {
                errors.push(format!("{at}: longer than {max} characters"));
            }
        }
        if let Some(p) = map.get("pattern").and_then(Value::as_str) {
            if regex::Regex::new(p).is_ok_and(|re| !re.is_match(s)) {
                errors.push(format!("{at}: does not match pattern {p}"));
            }
        }
    }
    if let (true, Some(n)) = (v.is_number(), v.as_f64()) {
        let bound = |k: &str| map.get(k).and_then(Value::as_f64);
        if let Some(m) = bound("minimum").filter(|m| n < *m) {
            errors.push(format!("{at}: below the minimum {m}"));
        }
        if let Some(m) = bound("maximum").filter(|m| n > *m) {
            errors.push(format!("{at}: above the maximum {m}"));
        }
        if let Some(m) = bound("exclusiveMinimum").filter(|m| n <= *m) {
            errors.push(format!("{at}: must be above {m}"));
        }
        if let Some(m) = bound("exclusiveMaximum").filter(|m| n >= *m) {
            errors.push(format!("{at}: must be below {m}"));
        }
    }
    if let Some(items) = v.as_array() {
        let n = items.len() as u64;
        if let Some(m) = map.get("minItems").and_then(Value::as_u64).filter(|m| n < *m) {
            errors.push(format!("{at}: fewer than {m} items"));
        }
        if let Some(m) = map.get("maxItems").and_then(Value::as_u64).filter(|m| n > *m) {
            errors.push(format!("{at}: more than {m} items"));
        }
        if let Some(sub) = map.get("items") {
            for (i, item) in items.iter().enumerate() {
                check(sub, item, &format!("{at}[{i}]"), errors);
            }
        }
    }
    if let Some(obj) = v.as_object() {
        for name in map.get("required").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            if !obj.contains_key(name) {
                errors.push(format!("{at}: missing required property `{name}`"));
            }
        }
        let props = map.get("properties").and_then(Value::as_object);
        for (name, val) in obj {
            match props.and_then(|p| p.get(name)) {
                Some(sub) => check(sub, val, &format!("{at}.{name}"), errors),
                None => match map.get("additionalProperties") {
                    Some(Value::Bool(false)) => errors.push(format!("{at}: unexpected property `{name}`")),
                    Some(sub @ Value::Object(_)) => check(sub, val, &format!("{at}.{name}"), errors),
                    _ => {}
                },
            }
        }
    }
    let sub_ok = |s: &Value| {
        let mut e = Vec::new();
        check(s, v, at, &mut e);
        e.is_empty()
    };
    if let Some(Value::Array(all)) = map.get("allOf") {
        for s in all {
            check(s, v, at, errors);
        }
    }
    if let Some(Value::Array(any)) = map.get("anyOf") {
        if !any.iter().any(sub_ok) {
            errors.push(format!("{at}: matches none of the anyOf alternatives"));
        }
    }
    if let Some(Value::Array(one)) = map.get("oneOf") {
        let hits = one.iter().filter(|s| sub_ok(s)).count();
        if hits != 1 {
            errors.push(format!("{at}: must match exactly one oneOf alternative (matches {hits})"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn schema() -> Value {
        load(json!({
            "type": "object",
            "required": ["name", "age"],
            "additionalProperties": false,
            "properties": {
                "name": {"type": "string", "minLength": 1},
                "age": {"type": "integer", "minimum": 0},
                "tags": {"type": "array", "items": {"enum": ["a", "b"]}, "maxItems": 2}
            }
        }))
        .unwrap()
    }

    #[test]
    fn a_conforming_value_passes_and_a_bad_one_names_each_problem() {
        assert!(validate(&schema(), &json!({"name": "x", "age": 3, "tags": ["a"]})).is_ok());
        let err = validate(&schema(), &json!({"name": "", "age": -1, "tags": ["z"], "extra": 1})).unwrap_err();
        for part in ["shorter than 1", "below the minimum", "not one of the allowed", "unexpected property `extra`"] {
            assert!(err.contains(part), "{err}");
        }
        assert!(validate(&schema(), &json!({"name": "x"})).unwrap_err().contains("missing required property `age`"));
        assert!(validate(&schema(), &json!([1])).unwrap_err().contains("expected type"));
    }

    #[test]
    fn json_is_found_in_prose_and_in_a_fence() {
        assert_eq!(extract_json("{\"a\":1}"), Some(json!({"a": 1})));
        assert_eq!(extract_json("Here:\n```json\n{\"a\": 2}\n```\nDone"), Some(json!({"a": 2})));
        assert_eq!(extract_json("The result is {\"a\": 3} as asked"), Some(json!({"a": 3})));
        assert_eq!(extract_json("no json here"), None);
    }

    #[test]
    fn check_answer_returns_the_parsed_value_or_the_reason() {
        let ok = check_answer(&schema(), "```\n{\"name\":\"n\",\"age\":1}\n```").unwrap();
        assert_eq!(ok["age"], 1);
        assert!(check_answer(&schema(), "nothing").unwrap_err().contains("no JSON"));
        assert!(check_answer(&schema(), "{\"name\":\"n\"}").unwrap_err().contains("age"));
    }

    #[test]
    fn unsupported_keywords_are_refused_not_ignored() {
        assert!(load(json!({"properties": {"a": {"$ref": "#/x"}}})).unwrap_err().contains("$ref"));
        assert!(load(json!({"pattern": "("})).is_err());
        assert!(load(json!(3)).is_err());
        assert!(load(json!(true)).is_ok());
    }

    #[test]
    fn one_of_counts_matches() {
        let s = load(json!({"oneOf": [{"type": "string"}, {"type": "integer"}]})).unwrap();
        assert!(validate(&s, &json!("x")).is_ok() && validate(&s, &json!(2)).is_ok());
        assert!(validate(&s, &json!(true)).is_err());
    }
}
