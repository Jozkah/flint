//! The security identity of an MCP server definition.
//!
//! A server *name* is a label the user can reuse, rename or retype. It says
//! nothing about which program runs or which endpoint receives tool arguments,
//! so a permission recorded against a name alone would silently carry over to
//! whatever is configured under that name next. This module defines what an
//! approval is actually about: the parts of a definition that decide what runs
//! and what it is handed.
//!
//! Implemented once, here, and reused by the desktop crate (registration
//! decisions, the trust gate, the renderer's fingerprint command) so no two
//! places can disagree about whether a definition changed.
//!
//! # What is in the identity
//!
//! * transport (`type`; an untyped definition with a command is `stdio`)
//! * `command` and `args`, in order
//! * `url`, normalized: scheme and host lowercased, default port dropped, a
//!   trailing slash dropped, query parameter *names* only (sorted), no
//!   fragment, and user info reduced to a marker
//! * `cwd`, when present
//! * environment variable *names* (sorted)
//! * header *names* (lowercased, sorted)
//! * whether Jan imported the server from a repository, and the confinement it
//!   runs under (workspace, repository, writable repository, attached read
//!   roots, allowed environment names), because those decide what the program
//!   can reach
//!
//! # What is deliberately not in it
//!
//! * the server name -- trust keys on name *and* fingerprint separately, so a
//!   rename is caught by the name and an edit by the fingerprint
//! * environment variable values, header values, URL query values and URL
//!   user info -- these are where secrets live, and rotating a token is not a
//!   different program
//! * presentation and runtime switches: `active`, `description`,
//!   `capabilities`, `official`, `timeout`

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

/// Version of the identity material, so a future change to what is hashed
/// produces fingerprints that can never collide with today's.
pub const IDENTITY_VERSION: u32 = 1;

/// The canonical, secret-free description of what a definition runs.
///
/// Returned as JSON so callers that compare definitions without hashing (and
/// tests) can see exactly what went in. Serializing it is deterministic:
/// `serde_json` keeps object keys sorted, and every list here is either
/// order-significant (`args`) or sorted.
pub fn identity_material(config: &Value) -> Value {
    let empty = Map::new();
    let obj = config.as_object().unwrap_or(&empty);
    let text = |key: &str| {
        obj.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string()
    };

    let command = text("command");
    let url = text("url");
    let mut transport = text("type").to_ascii_lowercase();
    if transport.is_empty() {
        transport = if !command.is_empty() {
            "stdio".to_string()
        } else if !url.is_empty() {
            "http".to_string()
        } else {
            String::new()
        };
    }

    let args: Vec<String> = obj
        .get("args")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| match item {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .collect()
        })
        .unwrap_or_default();

    let cwd = obj
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let confinement = obj
        .get("janConfinement")
        .and_then(Value::as_object)
        .map(|c| {
            let path = |key: &str| c.get(key).and_then(Value::as_str).map(String::from);
            let read_roots: Vec<String> = c
                .get("readRoots")
                .and_then(Value::as_array)
                .map(|roots| {
                    roots
                        .iter()
                        .filter_map(Value::as_str)
                        .map(String::from)
                        .collect()
                })
                .unwrap_or_default();
            json!({
                "workspace": path("workspace"),
                "repository": path("repository"),
                "writableRepository": path("writableRepository"),
                // The attached read roots are part of what the server may reach,
                // so a change to them is a change to the definition.
                "readRoots": read_roots,
                "allowedEnv": sorted_names(c.get("allowedEnv"), false),
            })
        });

    json!({
        "v": IDENTITY_VERSION,
        "transport": transport,
        "command": command,
        "args": args,
        "url": if url.is_empty() { String::new() } else { normalize_url(&url) },
        "cwd": cwd,
        "env": key_names(obj.get("env"), false),
        "headers": key_names(obj.get("headers"), true),
        "imported": obj.get("janImported").and_then(Value::as_bool).unwrap_or(false),
        "confinement": confinement,
    })
}

/// `sha256:<hex>` of [`identity_material`].
pub fn fingerprint(config: &Value) -> String {
    let material = identity_material(config).to_string();
    let digest = Sha256::digest(material.as_bytes());
    let mut out = String::with_capacity(7 + digest.len() * 2);
    out.push_str("sha256:");
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// A short form for logs and audit reasons. Never used for comparison.
pub fn short(fingerprint: &str) -> String {
    let hex = fingerprint.strip_prefix("sha256:").unwrap_or(fingerprint);
    hex.chars().take(12).collect()
}

/// Object keys, sorted, optionally lowercased. Values are never read.
fn key_names(value: Option<&Value>, lowercase: bool) -> Vec<String> {
    let mut names: Vec<String> = value
        .and_then(Value::as_object)
        .map(|m| {
            m.keys()
                .map(|k| {
                    let k = k.trim();
                    if lowercase {
                        k.to_ascii_lowercase()
                    } else {
                        k.to_string()
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names.dedup();
    names
}

/// A string array, sorted.
fn sorted_names(value: Option<&Value>, lowercase: bool) -> Vec<String> {
    let mut names: Vec<String> = value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|s| {
                    if lowercase {
                        s.to_ascii_lowercase()
                    } else {
                        s.to_string()
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names.dedup();
    names
}

/// Normalize an endpoint so two spellings of the same URL agree, without
/// keeping anything that is a credential.
///
/// Hand-rolled rather than adding a URL crate for one function. Anything that
/// does not look like `scheme://authority...` is kept trimmed as written, which
/// is the conservative answer: an unusual spelling can only make a fingerprint
/// differ, never make two different endpoints match.
pub fn normalize_url(raw: &str) -> String {
    let raw = raw.trim();
    let Some((scheme, rest)) = raw.split_once("://") else {
        return raw.to_string();
    };
    let scheme = scheme.to_ascii_lowercase();
    // Fragment never reaches the server.
    let rest = rest.split('#').next().unwrap_or_default();
    let (before_query, query) = match rest.split_once('?') {
        Some((b, q)) => (b, Some(q)),
        None => (rest, None),
    };
    let (authority, path) = match before_query.find('/') {
        Some(i) => (&before_query[..i], &before_query[i..]),
        None => (before_query, ""),
    };
    let (userinfo, hostport) = match authority.rsplit_once('@') {
        Some((_, h)) => (true, h),
        None => (false, authority),
    };
    let mut hostport = hostport.to_ascii_lowercase();
    let default_port = match scheme.as_str() {
        "http" | "ws" => Some(":80"),
        "https" | "wss" => Some(":443"),
        _ => None,
    };
    if let Some(port) = default_port {
        if hostport.ends_with(port) {
            hostport.truncate(hostport.len() - port.len());
        }
    }
    let path = if path.len() > 1 {
        path.trim_end_matches('/')
    } else {
        ""
    };
    let path = if path.is_empty() { "/" } else { path };

    let mut out = format!("{scheme}://");
    if userinfo {
        out.push_str("[userinfo]@");
    }
    out.push_str(&hostport);
    out.push_str(path);
    if let Some(query) = query {
        let mut names: Vec<&str> = query
            .split('&')
            .filter(|p| !p.is_empty())
            .map(|pair| pair.split('=').next().unwrap_or_default())
            .collect();
        names.sort_unstable();
        names.dedup();
        if !names.is_empty() {
            out.push('?');
            out.push_str(&names.join("&"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio() -> Value {
        json!({
            "command": "npx",
            "args": ["-y", "notes-mcp"],
            "env": { "API_TOKEN": "sk-live-one" },
        })
    }

    fn http() -> Value {
        json!({
            "type": "http",
            "url": "https://mcp.example.com/v1",
            "headers": { "Authorization": "Bearer first" },
        })
    }

    #[test]
    fn a_fingerprint_is_a_sha256_and_stable() {
        let fp = fingerprint(&stdio());
        assert!(fp.starts_with("sha256:"));
        assert_eq!(fp.len(), 7 + 64);
        assert_eq!(fp, fingerprint(&stdio()));
    }

    #[test]
    fn secret_values_never_reach_the_identity_input() {
        let material = identity_material(&json!({
            "type": "http",
            "url": "https://user:hunter2@mcp.example.com/v1?key=sk-live-query",
            "headers": { "Authorization": "Bearer sk-live-header" },
            "env": { "API_TOKEN": "sk-live-env" },
        }))
        .to_string();
        for secret in ["hunter2", "sk-live-query", "sk-live-header", "sk-live-env", "user:"] {
            assert!(!material.contains(secret), "{secret} leaked into {material}");
        }
        assert!(material.contains("API_TOKEN"));
        assert!(material.contains("authorization"));
    }

    #[test]
    fn changing_a_header_or_env_value_does_not_change_the_fingerprint() {
        let mut rotated = http();
        rotated["headers"]["Authorization"] = json!("Bearer second");
        assert_eq!(fingerprint(&http()), fingerprint(&rotated));

        let mut rotated = stdio();
        rotated["env"]["API_TOKEN"] = json!("sk-live-two");
        assert_eq!(fingerprint(&stdio()), fingerprint(&rotated));
    }

    #[test]
    fn changing_a_header_or_env_name_changes_the_fingerprint() {
        let renamed = json!({
            "type": "http",
            "url": "https://mcp.example.com/v1",
            "headers": { "X-Api-Key": "Bearer first" },
        });
        assert_ne!(fingerprint(&http()), fingerprint(&renamed));

        let mut extra = stdio();
        extra["env"]["AWS_SECRET_ACCESS_KEY"] = json!("x");
        assert_ne!(fingerprint(&stdio()), fingerprint(&extra));
    }

    #[test]
    fn what_runs_is_part_of_the_identity() {
        let base = fingerprint(&stdio());
        let mut changed = stdio();
        changed["command"] = json!("uvx");
        assert_ne!(base, fingerprint(&changed), "executable");

        let mut changed = stdio();
        changed["args"] = json!(["-y", "evil-mcp"]);
        assert_ne!(base, fingerprint(&changed), "arguments");

        let mut changed = stdio();
        changed["args"] = json!(["notes-mcp", "-y"]);
        assert_ne!(base, fingerprint(&changed), "argument order");

        let mut changed = stdio();
        changed["cwd"] = json!("/elsewhere");
        assert_ne!(base, fingerprint(&changed), "working directory");

        let mut changed = http();
        changed["url"] = json!("https://attacker.example.net/v1");
        assert_ne!(fingerprint(&http()), fingerprint(&changed), "endpoint");

        let mut changed = http();
        changed["type"] = json!("sse");
        assert_ne!(fingerprint(&http()), fingerprint(&changed), "transport");
    }

    #[test]
    fn confinement_is_part_of_the_identity() {
        let mut confined = stdio();
        confined["janImported"] = json!(true);
        confined["janConfinement"] = json!({ "workspace": "/w", "allowedEnv": ["A"] });
        assert_ne!(fingerprint(&stdio()), fingerprint(&confined));

        let mut writable = confined.clone();
        writable["janConfinement"]["writableRepository"] = json!("/repo");
        assert_ne!(fingerprint(&confined), fingerprint(&writable));
    }

    #[test]
    fn presentation_and_runtime_switches_are_not() {
        let mut annotated = stdio();
        annotated["active"] = json!(false);
        annotated["description"] = json!("notes");
        annotated["capabilities"] = json!(["notes"]);
        annotated["official"] = json!(true);
        annotated["timeout"] = json!(90);
        assert_eq!(fingerprint(&stdio()), fingerprint(&annotated));
    }

    #[test]
    fn an_untyped_command_is_stdio() {
        let mut typed = stdio();
        typed["type"] = json!("stdio");
        assert_eq!(fingerprint(&stdio()), fingerprint(&typed));
    }

    #[test]
    fn equivalent_url_spellings_agree() {
        for spelling in [
            "https://mcp.example.com/v1",
            "HTTPS://MCP.Example.com/v1/",
            "https://mcp.example.com:443/v1",
            "https://mcp.example.com/v1#section",
            "  https://mcp.example.com/v1  ",
        ] {
            assert_eq!(
                normalize_url(spelling),
                "https://mcp.example.com/v1",
                "{spelling}"
            );
        }
        assert_eq!(normalize_url("http://localhost:80"), "http://localhost/");
        assert_eq!(
            normalize_url("http://localhost:8080/mcp?b=2&a=1"),
            "http://localhost:8080/mcp?a&b"
        );
        // A path is case-sensitive and a different port is a different server.
        assert_ne!(
            normalize_url("https://mcp.example.com/V1"),
            normalize_url("https://mcp.example.com/v1")
        );
        assert_ne!(
            normalize_url("https://mcp.example.com:8443/v1"),
            normalize_url("https://mcp.example.com/v1")
        );
    }
}
