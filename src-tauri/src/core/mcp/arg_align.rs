//! Renames a model's argument keys to the names an MCP tool's schema declares.
//!
//! Models carry the argument names of the tool they use most. Flint's own
//! `edit` takes `old_string`/`new_string`; the reference filesystem server's
//! `edit_file` takes `oldText`/`newText` in the same `path` + `edits[]` shape,
//! so a call written for one is rejected by the other with "expected string,
//! received undefined" and the model repeats it. A key the schema does not
//! declare is renamed only when exactly one declared key is its spelling
//! variant; nothing is ever dropped, and keys the schema knows are untouched.

use serde_json::{Map, Value};

/// Spelling-insensitive form of a key: case, `_` and `-` are ignored, and
/// `string`/`text` and `filepath`/`path` are treated as one word.
fn canonical(key: &str) -> String {
    let flat: String = key
        .chars()
        .filter(|c| *c != '_' && *c != '-')
        .flat_map(char::to_lowercase)
        .collect();
    match flat.as_str() {
        "filepath" | "filename" => "path".to_string(),
        _ => flat.replace("string", "text"),
    }
}

fn align_value(value: Value, schema: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(align_object(map, schema)),
        Value::Array(items) => match schema.get("items") {
            Some(item_schema) => Value::Array(
                items
                    .into_iter()
                    .map(|item| align_value(item, item_schema))
                    .collect(),
            ),
            None => Value::Array(items),
        },
        other => other,
    }
}

fn align_object(map: Map<String, Value>, schema: &Value) -> Map<String, Value> {
    let Some(props) = schema.get("properties").and_then(Value::as_object) else {
        return map;
    };
    let mut by_canonical: Map<String, Value> = Map::new();
    for key in props.keys() {
        // Two declared keys that spell alike make a rename ambiguous.
        let slot = canonical(key);
        if by_canonical.contains_key(&slot) {
            by_canonical.insert(slot, Value::Null);
        } else {
            by_canonical.insert(slot, Value::String(key.clone()));
        }
    }
    let originals: Vec<String> = map.keys().cloned().collect();
    let mut out = Map::new();
    for (key, value) in map {
        let target = if props.contains_key(&key) {
            key.clone()
        } else {
            match by_canonical.get(&canonical(&key)).and_then(Value::as_str) {
                Some(declared)
                    if !originals.iter().any(|k| k == declared) && !out.contains_key(declared) =>
                {
                    declared.to_string()
                }
                _ => key.clone(),
            }
        };
        let aligned = match props.get(&target) {
            Some(child_schema) => align_value(value, child_schema),
            None => value,
        };
        out.insert(target, aligned);
    }
    out
}

/// `args` with undeclared keys renamed to the schema's own, nested objects and
/// arrays of objects included. Returns the input unchanged when it already fits.
pub fn align_arguments(args: Map<String, Value>, schema: &Map<String, Value>) -> Map<String, Value> {
    align_object(args, &Value::Object(schema.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn schema(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    fn filesystem_edit_file() -> Map<String, Value> {
        schema(json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "edits": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "oldText": { "type": "string" },
                            "newText": { "type": "string" }
                        },
                        "required": ["oldText", "newText"]
                    }
                }
            },
            "required": ["path", "edits"]
        }))
    }

    #[test]
    fn flint_edit_arguments_are_renamed_for_the_filesystem_server() {
        let args = schema(json!({
            "path": "a.tsx",
            "edits": [{ "old_string": "x", "new_string": "y" }]
        }));
        let out = align_arguments(args, &filesystem_edit_file());
        assert_eq!(
            Value::Object(out),
            json!({ "path": "a.tsx", "edits": [{ "oldText": "x", "newText": "y" }] })
        );
    }

    #[test]
    fn declared_keys_are_left_alone() {
        let args = schema(json!({
            "path": "a.tsx",
            "edits": [{ "oldText": "x", "newText": "y" }]
        }));
        let out = align_arguments(args.clone(), &filesystem_edit_file());
        assert_eq!(out, args);
    }

    #[test]
    fn unknown_keys_are_kept_not_dropped() {
        let args = schema(json!({ "path": "a", "edits": [], "replace_all": true }));
        let out = align_arguments(args.clone(), &filesystem_edit_file());
        assert_eq!(out, args);
    }

    #[test]
    fn file_path_becomes_path() {
        let args = schema(json!({ "file_path": "a", "edits": [] }));
        let out = align_arguments(args, &filesystem_edit_file());
        assert_eq!(out.get("path"), Some(&json!("a")));
        assert!(!out.contains_key("file_path"));
    }

    #[test]
    fn a_rename_never_overwrites_a_key_the_caller_set() {
        let args = schema(json!({ "path": "a", "file_path": "b", "edits": [] }));
        let out = align_arguments(args.clone(), &filesystem_edit_file());
        assert_eq!(out, args);
    }

    #[test]
    fn ambiguous_spellings_are_not_guessed() {
        let s = schema(json!({
            "type": "object",
            "properties": { "old_text": {}, "oldText": {} }
        }));
        let args = schema(json!({ "old_string": "x" }));
        assert_eq!(align_arguments(args.clone(), &s), args);
    }

    #[test]
    fn a_schema_without_properties_changes_nothing() {
        let args = schema(json!({ "anything": 1 }));
        assert_eq!(align_arguments(args.clone(), &schema(json!({}))), args);
    }
}
