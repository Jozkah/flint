//! `{{name}}` session variables in an MCP server's configuration.
//!
//! Some servers need per-project data: IntelliJ's MCP server wants the
//! project path in a header, an Obsidian server listens on a different port
//! per vault, a filesystem server exposes a different folder. Rather than one
//! copy of the server per project, its config names a variable --
//! `"url": "http://127.0.0.1:{{obsidian_port}}/mcp"` -- and each chat, cowork
//! session or room supplies its own value.
//!
//! A config holding a placeholder is a *template*. It is never started as
//! written. Each distinct set of values runs as its own *instance*, under a
//! derived name ([`instance_name`]) that carries the template's name plus a
//! short hash of its definition and the values it uses. Two sessions with the
//! same values share one instance; different values get different processes or
//! connections, so one session can never reach another session's project.
//!
//! Substitution covers `args`, `env`, `url` and `headers` -- the per-project
//! data. Never `command`: a session value must not be able to change which
//! program the user approved. Trust, budgets and approvals stay with the
//! template's name and definition ([`base_name`]), so approving the template
//! approves every instance of it, and editing it invalidates them all.
//!
//! Substitution runs before `${VAR}` environment expansion, on a launch-time
//! copy; the stored config keeps its placeholders.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde_json::Value;
use sha2::{Digest, Sha256};

/// The fields that may hold a session placeholder.
const TEMPLATED_FIELDS: &[&str] = &["args", "env", "url", "headers"];

/// Separates a template's name from the hash of an instance's values.
const INSTANCE_MARK: &str = "#vars-";
/// Hex digits of the hash in an instance name.
const INSTANCE_HASH_LEN: usize = 10;

/// A placeholder name: a letter or `_`, then letters, digits, `_`, `.`, `-`.
fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

/// Walk `text`, handing each `{{ name }}` to `on_placeholder` and each run of
/// plain text to `on_text`. Braces that do not form a valid placeholder are
/// plain text.
fn scan(text: &str, on_text: &mut dyn FnMut(&str), on_placeholder: &mut dyn FnMut(&str, &str)) {
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else { break };
        let name = after[..end].trim();
        if valid_name(name) {
            on_text(&rest[..start]);
            on_placeholder(name, &rest[start..start + 2 + end + 2]);
            rest = &after[end + 2..];
        } else {
            on_text(&rest[..start + 2]);
            rest = after;
        }
    }
    on_text(rest);
}

fn collect_strings<'a>(value: &'a Value, out: &mut Vec<&'a str>) {
    match value {
        Value::String(s) => out.push(s),
        Value::Array(items) => items.iter().for_each(|v| collect_strings(v, out)),
        Value::Object(map) => map.values().for_each(|v| collect_strings(v, out)),
        _ => {}
    }
}

/// Every placeholder `config` uses, sorted and without repeats.
pub fn placeholders(config: &Value) -> Vec<String> {
    let mut names = BTreeSet::new();
    let Some(map) = config.as_object() else {
        return Vec::new();
    };
    for field in TEMPLATED_FIELDS {
        let Some(v) = map.get(*field) else { continue };
        let mut strings = Vec::new();
        collect_strings(v, &mut strings);
        for s in strings {
            scan(s, &mut |_| {}, &mut |name, _| {
                names.insert(name.to_string());
            });
        }
    }
    names.into_iter().collect()
}

/// Is `config` a template, needing session values before it can start?
pub fn is_templated(config: &Value) -> bool {
    !placeholders(config).is_empty()
}

/// A variable counts as set when it has a non-blank value.
fn value_of<'a>(vars: &'a HashMap<String, String>, name: &str) -> Option<&'a str> {
    vars.get(name)
        .map(String::as_str)
        .filter(|v| !v.trim().is_empty())
}

/// The placeholders of `config` that `vars` leaves unset.
pub fn missing(config: &Value, vars: &HashMap<String, String>) -> Vec<String> {
    placeholders(config)
        .into_iter()
        .filter(|name| value_of(vars, name).is_none())
        .collect()
}

fn substitute_value(value: &Value, vars: &HashMap<String, String>) -> Value {
    match value {
        Value::String(s) => {
            let out = String::with_capacity(s.len());
            let out = std::cell::RefCell::new(out);
            scan(
                s,
                &mut |text| out.borrow_mut().push_str(text),
                &mut |name, raw| match value_of(vars, name) {
                    Some(v) => out.borrow_mut().push_str(v),
                    None => out.borrow_mut().push_str(raw),
                },
            );
            Value::String(out.into_inner())
        }
        Value::Array(items) => {
            Value::Array(items.iter().map(|v| substitute_value(v, vars)).collect())
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), substitute_value(v, vars)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// A copy of `config` with every placeholder replaced by its value in `vars`.
/// `Err` lists the placeholders left unset; nothing is substituted then.
pub fn resolve(config: &Value, vars: &HashMap<String, String>) -> Result<Value, Vec<String>> {
    let unset = missing(config, vars);
    if !unset.is_empty() {
        return Err(unset);
    }
    let mut out = config.clone();
    if let Some(map) = out.as_object_mut() {
        for field in TEMPLATED_FIELDS {
            if let Some(v) = map.get(*field) {
                let substituted = substitute_value(v, vars);
                map.insert((*field).to_string(), substituted);
            }
        }
    }
    Ok(out)
}

/// The name the instance of template `base` for `vars` runs under.
///
/// The hash covers the template's definition and only the values it uses, so
/// unrelated variables in a session do not split instances, and an edited
/// template never reuses an instance started from the old definition.
pub fn instance_name(base: &str, config: &Value, vars: &HashMap<String, String>) -> String {
    let used: BTreeMap<String, String> = placeholders(config)
        .into_iter()
        .map(|name| {
            let value = value_of(vars, &name).unwrap_or_default().to_string();
            (name, value)
        })
        .collect();
    let mut hasher = Sha256::new();
    hasher.update(config.to_string().as_bytes());
    hasher.update([0]);
    hasher.update(serde_json::to_string(&used).unwrap_or_default().as_bytes());
    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("{base}{INSTANCE_MARK}{}", &hex[..INSTANCE_HASH_LEN])
}

/// The template an instance name belongs to, or `None` for a plain name.
pub fn template_of(name: &str) -> Option<&str> {
    let idx = name.rfind(INSTANCE_MARK)?;
    let hash = &name[idx + INSTANCE_MARK.len()..];
    (idx > 0
        && hash.len() == INSTANCE_HASH_LEN
        && hash
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()))
    .then(|| &name[..idx])
}

/// Is `name` a session instance of a template?
pub fn is_instance(name: &str) -> bool {
    template_of(name).is_some()
}

/// The user-facing server an instance belongs to: its template's name, or
/// `name` itself for an ordinary server. Trust, budgets and the names shown
/// to the user and the model are all keyed by this.
pub fn base_name(name: &str) -> &str {
    template_of(name).unwrap_or(name)
}

/// The error a tool call or a start gets when a session leaves variables unset.
pub fn missing_message(server: &str, missing: &[String]) -> String {
    let list = missing
        .iter()
        .map(|n| format!("{{{{{n}}}}}"))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "MCP server '{server}' needs session variables that are not set: {list}. Set them in this session's MCP variables, then try again."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn vars(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn finds_placeholders_in_args_env_url_and_headers() {
        let config = json!({
            "command": "npx {{not_here}}",
            "args": ["-y", "server", "{{docs_dir}}"],
            "env": {"PORT": "{{ port }}"},
            "url": "http://127.0.0.1:{{obsidian_port}}/mcp",
            "headers": {"IJ_MCP_SERVER_PROJECT_PATH": "{{project_path}}"},
            "description": "{{ignored}}"
        });
        assert_eq!(
            placeholders(&config),
            vec!["docs_dir", "obsidian_port", "port", "project_path"]
        );
        assert!(is_templated(&config));
        assert!(!is_templated(
            &json!({"command": "npx", "args": ["${HOME}"]})
        ));
    }

    #[test]
    fn braces_that_are_not_placeholders_stay_text() {
        let config = json!({"args": ["{{}}", "{{ 1bad }}", "{\"a\":1}", "{{open"]});
        assert!(placeholders(&config).is_empty());
        let resolved = resolve(&config, &HashMap::new()).unwrap();
        assert_eq!(resolved, config);
    }

    #[test]
    fn resolves_every_field_and_keeps_the_rest() {
        let config = json!({
            "type": "http",
            "command": "",
            "url": "http://127.0.0.1:{{obsidian_port}}/mcp",
            "headers": {"X-Path": "{{project_path}}/src"},
            "args": ["--root={{project_path}}"],
            "env": {"P": "{{obsidian_port}}"}
        });
        let resolved = resolve(
            &config,
            &vars(&[("obsidian_port", "27124"), ("project_path", "/p")]),
        )
        .unwrap();
        assert_eq!(resolved["url"], "http://127.0.0.1:27124/mcp");
        assert_eq!(resolved["headers"]["X-Path"], "/p/src");
        assert_eq!(resolved["args"][0], "--root=/p");
        assert_eq!(resolved["env"]["P"], "27124");
        assert_eq!(resolved["type"], "http");
    }

    #[test]
    fn unset_or_blank_values_are_missing() {
        let config = json!({"args": ["{{a}}", "{{b}}", "{{c}}"]});
        let err = resolve(&config, &vars(&[("a", "1"), ("b", "  ")])).unwrap_err();
        assert_eq!(err, vec!["b", "c"]);
        assert_eq!(
            missing(&config, &vars(&[("a", "1"), ("b", "2"), ("c", "3")])),
            Vec::<String>::new()
        );
    }

    #[test]
    fn instance_names_split_by_used_values_only() {
        let config = json!({"url": "http://127.0.0.1:{{port}}/mcp"});
        let a = instance_name("obsidian", &config, &vars(&[("port", "1"), ("other", "x")]));
        let a2 = instance_name("obsidian", &config, &vars(&[("port", "1"), ("other", "y")]));
        let b = instance_name("obsidian", &config, &vars(&[("port", "2")]));
        assert_eq!(a, a2);
        assert_ne!(a, b);
        assert!(a.starts_with("obsidian#vars-"));
        // An edited template never shares an instance with the old one.
        let edited = json!({"url": "https://127.0.0.1:{{port}}/mcp"});
        assert_ne!(
            a,
            instance_name("obsidian", &edited, &vars(&[("port", "1")]))
        );
    }

    #[test]
    fn base_name_maps_instances_back_to_their_template() {
        let config = json!({"args": ["{{x}}"]});
        let name = instance_name("my server", &config, &vars(&[("x", "1")]));
        assert!(is_instance(&name));
        assert_eq!(base_name(&name), "my server");
        assert_eq!(base_name("plain"), "plain");
        assert!(!is_instance("tag#vars-xyz"));
        assert!(!is_instance("#vars-0123456789"));
    }

    #[test]
    fn missing_message_names_each_variable() {
        let msg = missing_message("idea", &["project_path".to_string()]);
        assert!(msg.contains("'idea'"));
        assert!(msg.contains("{{project_path}}"));
    }
}
