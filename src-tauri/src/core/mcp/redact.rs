//! Keeping MCP secrets out of the renderer.
//!
//! `mcp_config.json` carries env values and HTTP headers that are credentials.
//! The desktop UI only needs to know *which* of them are set, so what
//! `get_mcp_configs` hands the renderer has those values replaced by [`MASK`].
//! The file on disk is never rewritten with a mask: when the renderer saves a
//! config back, [`restore_masked_secrets`] puts the stored real value in place
//! of every value that is still the mask, so an untouched secret survives a
//! round trip and only a value the user typed replaces it.

use serde_json::{Map, Value};

/// What a hidden secret value looks like in the UI.
pub const MASK: &str = "\u{2022}\u{2022}\u{2022}\u{2022}";

/// The per-server maps whose values can be credentials.
const SECRET_BEARING_FIELDS: [&str; 2] = ["env", "headers"];

/// Substrings that mark a key as holding a secret. `key` also covers
/// `*_KEY`, `x-api-key` and the like; `auth` covers `Authorization`,
/// `Proxy-Authorization` and `X-Auth-*`.
const SECRET_MARKERS: [&str; 10] = [
    "token",
    "secret",
    "password",
    "passwd",
    "key",
    "auth",
    "bearer",
    "credential",
    "cookie",
    "session",
];

/// Does an env var or header named `key` look like it holds a secret?
pub fn is_secret_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    SECRET_MARKERS.iter().any(|m| lower.contains(m))
}

/// A value that is a credential whatever its key is called (`CUSTOM=sk-...`,
/// `X-Thing: Bearer ...`), by the detector the audit log and transcripts use.
fn looks_like_secret(value: &Value) -> bool {
    match value {
        Value::String(s) => {
            s != MASK
                && (tauri_plugin_agent_tools::secrets::redact_secrets(s) != *s
                    || s.to_ascii_lowercase().starts_with("bearer "))
        }
        _ => false,
    }
}

fn mask_map(map: &Map<String, Value>) -> Map<String, Value> {
    map.iter()
        .map(|(k, v)| {
            let hidden = (is_secret_key(k) || looks_like_secret(v))
                && !matches!(v, Value::String(s) if s.is_empty());
            let v = if hidden {
                Value::String(MASK.to_string())
            } else {
                v.clone()
            };
            (k.clone(), v)
        })
        .collect()
}

/// A copy of one server entry with its secret env/header values masked.
fn redact_server(server: &Value) -> Value {
    let Some(obj) = server.as_object() else {
        return server.clone();
    };
    let mut out = obj.clone();
    for field in SECRET_BEARING_FIELDS {
        if let Some(Value::Object(map)) = obj.get(field) {
            out.insert(field.to_string(), Value::Object(mask_map(map)));
        }
    }
    Value::Object(out)
}

/// A copy of a `mcpServers` map with every server redacted.
pub fn redact_mcp_servers(servers: &Map<String, Value>) -> Map<String, Value> {
    servers
        .iter()
        .map(|(name, server)| (name.clone(), redact_server(server)))
        .collect()
}

/// A copy of a whole `mcp_config.json` value with every server's secret env
/// and header values masked. Key names stay, so the UI still shows which are
/// set; an empty value stays empty so it still reads as unset. Idempotent.
pub fn redact_mcp_config(config: &Value) -> Value {
    let mut out = config.clone();
    if let Some(Value::Object(servers)) = out.get_mut("mcpServers") {
        *servers = redact_mcp_servers(servers);
    }
    out
}

/// Replace every value in `config` that is still [`MASK`] with the real value
/// `real_servers` (the file as it is on disk) holds for the same server, field
/// and key. A mask with nothing to restore from (a renamed or new server) is
/// left as it is: there is no real value to put back.
pub fn restore_masked_secrets(config: &mut Value, real_servers: &Map<String, Value>) {
    let Some(Value::Object(servers)) = config.get_mut("mcpServers") else {
        return;
    };
    for (name, server) in servers.iter_mut() {
        let (Some(server), Some(real)) = (server.as_object_mut(), real_servers.get(name)) else {
            continue;
        };
        for field in SECRET_BEARING_FIELDS {
            let (Some(Value::Object(map)), Some(Value::Object(real_map))) =
                (server.get_mut(field), real.get(field))
            else {
                continue;
            };
            for (key, value) in map.iter_mut() {
                if value.as_str() == Some(MASK) {
                    if let Some(real_value) = real_map.get(key) {
                        *value = real_value.clone();
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config() -> Value {
        json!({
            "mcpSettings": { "toolCallTimeout": 30 },
            "mcpServers": {
                "github": {
                    "command": "npx",
                    "args": ["-y", "server-github"],
                    "env": {
                        "GITHUB_TOKEN": "ghp_real",
                        "API_KEY": "k-real",
                        "LOG_LEVEL": "debug",
                        "EMPTY_SECRET": ""
                    },
                    "active": true
                },
                "remote": {
                    "type": "http",
                    "url": "https://example.com/mcp",
                    "headers": {
                        "Authorization": "Bearer abc",
                        "X-Api-Key": "xyz",
                        "Cookie": "sid=1",
                        "Accept": "application/json"
                    }
                }
            }
        })
    }

    #[test]
    fn secret_keys_are_recognised() {
        for k in [
            "GITHUB_TOKEN", "api_key", "MY_SECRET", "DB_PASSWORD", "Authorization",
            "Proxy-Authorization", "X-Api-Key", "Cookie", "SESSION_ID", "Bearer",
            "AWS_CREDENTIALS", "STRIPE_KEY",
        ] {
            assert!(is_secret_key(k), "{k}");
        }
        for k in ["LOG_LEVEL", "PATH", "Accept", "Content-Type", "HOME"] {
            assert!(!is_secret_key(k), "{k}");
        }
    }

    #[test]
    fn masks_env_and_header_secrets_but_keeps_names_and_the_rest() {
        let red = redact_mcp_config(&config());
        let gh = &red["mcpServers"]["github"];
        assert_eq!(gh["env"]["GITHUB_TOKEN"], MASK);
        assert_eq!(gh["env"]["API_KEY"], MASK);
        assert_eq!(gh["env"]["LOG_LEVEL"], "debug");
        assert_eq!(gh["env"]["EMPTY_SECRET"], "", "an unset value must still read as unset");
        assert_eq!(gh["command"], "npx");
        assert_eq!(gh["args"], json!(["-y", "server-github"]));
        let remote = &red["mcpServers"]["remote"];
        assert_eq!(remote["headers"]["Authorization"], MASK);
        assert_eq!(remote["headers"]["X-Api-Key"], MASK);
        assert_eq!(remote["headers"]["Cookie"], MASK);
        assert_eq!(remote["headers"]["Accept"], "application/json");
        assert_eq!(remote["url"], "https://example.com/mcp");
        assert_eq!(red["mcpSettings"], config()["mcpSettings"]);
        assert!(!red.to_string().contains("ghp_real"));
        assert!(!red.to_string().contains("Bearer abc"));
    }

    #[test]
    fn a_credential_value_is_masked_whatever_its_key_is_called() {
        let cfg = json!({"mcpServers": {"s": {
            "env": { "CUSTOM": "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", "MODE": "fast" },
            "headers": { "X-Thing": "Bearer abc.def.ghi", "Accept": "text/plain" }
        }}});
        let red = redact_mcp_config(&cfg);
        let s = &red["mcpServers"]["s"];
        assert_eq!(s["env"]["CUSTOM"], MASK);
        assert_eq!(s["env"]["MODE"], "fast");
        assert_eq!(s["headers"]["X-Thing"], MASK);
        assert_eq!(s["headers"]["Accept"], "text/plain");
    }

    #[test]
    fn redaction_is_idempotent_and_does_not_touch_the_input() {
        let original = config();
        let once = redact_mcp_config(&original);
        assert_eq!(redact_mcp_config(&once), once);
        assert_eq!(original, config());
    }

    #[test]
    fn odd_shapes_pass_through() {
        assert_eq!(redact_mcp_config(&json!({})), json!({}));
        assert_eq!(redact_mcp_config(&json!([1, 2])), json!([1, 2]));
        let odd = json!({"mcpServers": {"a": "not an object", "b": {"env": "nope"}}});
        assert_eq!(redact_mcp_config(&odd), odd);
    }

    #[test]
    fn a_mask_coming_back_restores_the_stored_secret() {
        let disk = config();
        let disk_servers = disk["mcpServers"].as_object().unwrap().clone();
        let mut sent_back = redact_mcp_config(&disk);
        restore_masked_secrets(&mut sent_back, &disk_servers);
        assert_eq!(sent_back, disk);
    }

    #[test]
    fn a_value_the_user_typed_replaces_the_secret_and_masks_around_it_still_restore() {
        let disk = config();
        let disk_servers = disk["mcpServers"].as_object().unwrap().clone();
        let mut sent_back = redact_mcp_config(&disk);
        sent_back["mcpServers"]["github"]["env"]["GITHUB_TOKEN"] = json!("ghp_new");
        restore_masked_secrets(&mut sent_back, &disk_servers);
        let gh = &sent_back["mcpServers"]["github"]["env"];
        assert_eq!(gh["GITHUB_TOKEN"], "ghp_new");
        assert_eq!(gh["API_KEY"], "k-real");
        assert_eq!(sent_back["mcpServers"]["remote"]["headers"]["Authorization"], "Bearer abc");
    }

    #[test]
    fn a_mask_with_nothing_stored_is_left_alone() {
        let disk = config();
        let disk_servers = disk["mcpServers"].as_object().unwrap().clone();
        let mut sent_back = json!({"mcpServers": {"renamed": {"env": {"API_KEY": MASK}}}});
        restore_masked_secrets(&mut sent_back, &disk_servers);
        assert_eq!(sent_back["mcpServers"]["renamed"]["env"]["API_KEY"], MASK);
    }

    #[cfg(not(feature = "cli"))]
    #[test]
    fn a_full_desktop_save_keeps_the_real_secrets_on_disk() {
        use crate::core::mcp::commands::merge_mcp_servers;
        let disk = config();
        let disk_servers = disk["mcpServers"].as_object().unwrap().clone();
        // The renderer loaded the redacted view and toggles one server.
        let base = redact_mcp_servers(&disk_servers);
        let mut ours = base.clone();
        ours.get_mut("github").unwrap()["active"] = json!(false);
        let merged = merge_mcp_servers(&base, &ours, &disk_servers);
        let mut saved = json!({ "mcpServers": Value::Object(merged) });
        restore_masked_secrets(&mut saved, &disk_servers);
        assert_eq!(saved["mcpServers"]["github"]["active"], json!(false));
        assert_eq!(saved["mcpServers"]["github"]["env"]["GITHUB_TOKEN"], "ghp_real");
        assert_eq!(saved["mcpServers"]["remote"], disk["mcpServers"]["remote"]);
        assert!(!saved.to_string().contains(MASK));
    }
}
