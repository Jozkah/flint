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
#[allow(dead_code)]
pub fn expand_config(server: &str, config: &Value) -> Result<Value, String> {
    expand_config_for(server, config, None)
}

/// Like [`expand_config`], but with `allowed` set only those variable names may
/// be expanded; any other `${NAME}` (even with a fallback) is an error naming
/// the variable. `None` keeps full expansion.
pub fn expand_config_for(
    server: &str,
    config: &Value,
    allowed: Option<&[String]>,
) -> Result<Value, String> {
    expand_config_gated(server, config, allowed, &|name| std::env::var(name).ok())
}

fn expand_config_gated(
    server: &str,
    config: &Value,
    allowed: Option<&[String]>,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<Value, String> {
    let Some(allowed) = allowed else {
        return expand_config_with(server, config, lookup);
    };
    let denied = std::cell::RefCell::new(None::<String>);
    let gated = |name: &str| {
        if allowed.iter().any(|a| a == name) {
            lookup(name)
        } else {
            denied.borrow_mut().get_or_insert_with(|| name.to_string());
            None
        }
    };
    let result = expand_config_with(server, config, &gated);
    if let Some(name) = denied.into_inner() {
        return Err(format!(
            "MCP server '{server}' reads host variable {name} which it is not approved for. Add {name} to the server's approved environment variables to allow it."
        ));
    }
    result
}

/// The variable names a repository-imported server may expand: its approved
/// `allowedEnv`. `None` for a user-configured server (full expansion).
pub fn expansion_allowlist(config: &Value) -> Option<Vec<String>> {
    if config.get("janImported").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    Some(
        config
            .get("janConfinement")
            .and_then(|c| c.get("allowedEnv"))
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
            .unwrap_or_default(),
    )
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

    fn approved(allowed: &[&str]) -> Vec<String> {
        allowed.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn envexpand_imported_rejects_unapproved_var() {
        let cfg = json!({"args": ["--key", "${TOKEN:-fallback}"]});
        let a = approved(&["HOST"]);
        let err = expand_config_gated("r", &cfg, Some(&a), &lookup).unwrap_err();
        assert!(err.contains("TOKEN") && err.contains("not approved"), "{err}");
        assert!(!err.contains("s3cret-value"), "{err}");
    }

    #[test]
    fn envexpand_imported_allows_approved_env_name() {
        let cfg = json!({"env": {"H": "${HOST}"}});
        let a = approved(&["HOST"]);
        let out = expand_config_gated("r", &cfg, Some(&a), &lookup).unwrap();
        assert_eq!(out["env"]["H"], "api.example.com");
    }

    #[test]
    fn envexpand_user_server_unchanged() {
        let cfg = json!({"args": ["${TOKEN}"]});
        assert_eq!(expansion_allowlist(&cfg), None);
        let out = expand_config_gated("u", &cfg, None, &lookup).unwrap();
        assert_eq!(out["args"], json!(["s3cret-value"]));
        let imp = json!({"janImported": true, "janConfinement": {"allowedEnv": ["HOST"]}});
        assert_eq!(expansion_allowlist(&imp), Some(approved(&["HOST"])));
    }

    #[test]
    fn envexpand_imported_env_value_placeholder_rejected() {
        let cfg = json!({"env": {"LOG_LEVEL": "${TOKEN}"}});
        let a = approved(&["LOG_LEVEL"]);
        let err = expand_config_gated("r", &cfg, Some(&a), &lookup).unwrap_err();
        assert!(err.contains("TOKEN"), "{err}");
    }
}
