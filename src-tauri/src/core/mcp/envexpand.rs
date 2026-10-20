//! `${VAR}` expansion in an MCP server's launch configuration.
//!
//! A config can keep a secret out of `mcp_config.json` by naming it:
//! `"env": {"API_KEY": "${GITHUB_TOKEN}"}`, `"url": "https://${HOST}/mcp"`,
//! `"headers": {"Authorization": "Bearer ${TOKEN}"}`. `${VAR:-fallback}` uses
//! the fallback when `VAR` is unset or empty.
//!
//! Expansion happens on a copy made at launch. The stored config, and the
//! fingerprint a trust grant is made against, keep the placeholder, so a
//! resolved secret is never written back and never part of server identity.
//! Errors name the variable and the field, never a resolved value.

use serde_json::Value;

/// The fields that may hold a placeholder.
const EXPANDED_FIELDS: &[&str] = &["command", "args", "env", "url", "headers"];

/// Expand `text`, resolving names through `lookup`. `Err` carries the name of
/// the first variable that is unset (and has no fallback).
fn expand_text(text: &str, lookup: &dyn Fn(&str) -> Option<String>) -> Result<String, String> {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            // No closing brace: not a placeholder, keep the text as written.
            out.push_str(&rest[start..]);
            return Ok(out);
        };
        let body = &after[..end];
        let (name, fallback) = match body.split_once(":-") {
            Some((n, f)) => (n, Some(f)),
            None => (body, None),
        };
        match lookup(name).filter(|v| !v.is_empty()).or_else(|| fallback.map(str::to_string)) {
            Some(v) => out.push_str(&v),
            None => return Err(name.to_string()),
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

fn expand_value(
    value: &Value,
    field: &str,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<Value, (String, String)> {
    match value {
        Value::String(s) => expand_text(s, lookup)
            .map(Value::String)
            .map_err(|var| (var, field.to_string())),
        Value::Array(items) => items
            .iter()
            .map(|v| expand_value(v, field, lookup))
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (k, v) in map {
                out.insert(k.clone(), expand_value(v, &format!("{field}.{k}"), lookup)?);
            }
            Ok(Value::Object(out))
        }
        other => Ok(other.clone()),
    }
}

/// A copy of `config` with `${VAR}` expanded in command, args, env, url and
/// headers, resolving names through `lookup`.
pub fn expand_config_with(
    server: &str,
    config: &Value,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<Value, String> {
    let mut out = config.clone();
    let Some(map) = out.as_object_mut() else {
        return Ok(out);
    };
    for field in EXPANDED_FIELDS {
        let Some(v) = map.get(*field) else { continue };
        let expanded = expand_value(v, field, lookup).map_err(|(var, at)| {
            format!(
                "MCP server '{server}': environment variable {var} is not set (used in {at}). Set it, or write ${{{var}:-default}} to give it a default."
            )
        })?;
        map.insert((*field).to_string(), expanded);
    }
    Ok(out)
}

/// [`expand_config_with`] against the app's own environment.
pub fn expand_config(server: &str, config: &Value) -> Result<Value, String> {
    expand_config_with(server, config, &|name| std::env::var(name).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn lookup(name: &str) -> Option<String> {
        match name {
            "TOKEN" => Some("s3cret-value".into()),
            "HOST" => Some("api.example.com".into()),
            "EMPTY" => Some(String::new()),
            _ => None,
        }
    }

    #[test]
    fn expands_every_launch_field() {
        let cfg = json!({
            "command": "${HOST}-bin",
            "args": ["--key", "${TOKEN}"],
            "env": {"K": "x-${TOKEN}-y"},
            "url": "https://${HOST}/mcp",
            "headers": {"Authorization": "Bearer ${TOKEN}"},
            "note": "${TOKEN} stays in untouched fields"
        });
        let out = expand_config_with("s", &cfg, &lookup).unwrap();
        assert_eq!(out["command"], "api.example.com-bin");
        assert_eq!(out["args"], json!(["--key", "s3cret-value"]));
        assert_eq!(out["env"]["K"], "x-s3cret-value-y");
        assert_eq!(out["url"], "https://api.example.com/mcp");
        assert_eq!(out["headers"]["Authorization"], "Bearer s3cret-value");
        assert_eq!(out["note"], "${TOKEN} stays in untouched fields");
        // The input is not modified.
        assert_eq!(cfg["env"]["K"], "x-${TOKEN}-y");
    }

    #[test]
    fn unset_variable_is_a_clear_error_that_does_not_leak_values() {
        let cfg = json!({"env": {"K": "${TOKEN}-${MISSING}"}});
        let err = expand_config_with("gh", &cfg, &lookup).unwrap_err();
        assert!(err.contains("MISSING") && err.contains("env.K") && err.contains("'gh'"), "{err}");
        assert!(!err.contains("s3cret-value"), "{err}");
    }

    #[test]
    fn fallback_applies_to_unset_and_empty() {
        let cfg = json!({"args": ["${MISSING:-a}", "${EMPTY:-b}", "${TOKEN:-c}"]});
        let out = expand_config_with("s", &cfg, &lookup).unwrap();
        assert_eq!(out["args"], json!(["a", "b", "s3cret-value"]));
    }

    #[test]
    fn an_empty_variable_without_fallback_is_unset() {
        let cfg = json!({"command": "${EMPTY}"});
        assert!(expand_config_with("s", &cfg, &lookup).is_err());
    }

    #[test]
    fn text_without_a_placeholder_is_unchanged() {
        let cfg = json!({"args": ["$HOME", "${unterminated", "plain", 5, true]});
        let out = expand_config_with("s", &cfg, &lookup).unwrap();
        assert_eq!(out, cfg);
    }
}
