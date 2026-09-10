//! A Cowork session as one portable, self-describing file. AH-203.
//!
//! The renderer assembles the bundle from its stores; this module is the
//! boundary it crosses on the way to disk and back:
//!
//! * **Out.** The header is checked, every field that carries authority or a
//!   path that only makes sense on this machine is dropped, and the whole
//!   document goes through the same credential redaction as prompt snapshots
//!   before a byte is written.
//! * **In.** The size is capped, the header is checked, and a schema version
//!   this build does not understand is refused by name rather than guessed at.

use serde_json::Value;

pub const FORMAT: &str = "jan.cowork-session";
pub const SCHEMA_VERSION: u64 = 1;
pub const MAX_BYTES: u64 = 32 * 1024 * 1024;

/// Session fields that are never exported: authority (access, consent,
/// continuity), machine paths (folder, code panel), in-flight state (run
/// budget), and what is rebuilt from the turns on import (messages).
const DROPPED_SESSION_KEYS: [&str; 9] = [
    "folder",
    "access",
    "editConsent",
    "continuity",
    "codePanel",
    "runBudget",
    "messages",
    "history",
    "lastUsage",
];

pub fn check_header(bundle: &Value) -> Result<(), String> {
    if bundle.get("format").and_then(Value::as_str) != Some(FORMAT) {
        return Err("this file is not a Jan session export".into());
    }
    match bundle.get("schemaVersion").and_then(Value::as_u64) {
        Some(SCHEMA_VERSION) => {}
        Some(other) => {
            return Err(format!(
                "this export uses schema version {other}, which this version of Jan does not understand"
            ))
        }
        None => return Err("this export does not say which schema version it uses".into()),
    }
    if bundle.get("exportId").and_then(Value::as_str).map_or(true, str::is_empty) {
        return Err("this export has no id, so importing it twice could not be detected".into());
    }
    if !bundle
        .get("session")
        .and_then(|s| s.get("turns"))
        .is_some_and(Value::is_array)
    {
        return Err("this export carries no conversation".into());
    }
    Ok(())
}

/// Ready a bundle for disk. Returns it and how many credentials were removed.
pub fn prepare_export(mut bundle: Value) -> Result<(Value, usize), String> {
    check_header(&bundle)?;
    if let Some(session) = bundle.get_mut("session").and_then(Value::as_object_mut) {
        for key in DROPPED_SESSION_KEYS {
            session.remove(key);
        }
    }
    let (mut redacted, found) = tauri_plugin_agent_tools::snapshot::redact_payload(&bundle);
    // The payload pass knows credential-named fields. A conversation also
    // carries credentials in prose -- "use Authorization: Bearer ..." typed
    // into a turn -- so every string gets the text pass as well.
    let mut in_text = 0;
    scrub_strings(&mut redacted, &mut in_text);
    Ok((redacted, found.len() + in_text))
}

fn scrub_strings(value: &mut Value, count: &mut usize) {
    match value {
        Value::String(text) => {
            let cleaned = tauri_plugin_agent_tools::secrets::redact_secrets(text);
            // Compared line by line: the text pass rebuilds lines, and a
            // trailing newline alone is not a redaction.
            if cleaned.lines().ne(text.lines()) {
                *text = cleaned;
                *count += 1;
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|v| scrub_strings(v, count)),
        Value::Object(map) => map.values_mut().for_each(|v| scrub_strings(v, count)),
        _ => {}
    }
}

/// Read a bundle from bytes that came off disk.
pub fn parse_import(bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() as u64 > MAX_BYTES {
        return Err("this file is too large to be a Jan session export".into());
    }
    let bundle: Value =
        serde_json::from_slice(bytes).map_err(|_| "this file is not valid JSON".to_string())?;
    check_header(&bundle)?;
    Ok(bundle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bundle() -> Value {
        json!({
            "format": FORMAT,
            "schemaVersion": 1,
            "exportId": "exp-1",
            "exportedAt": "2026-09-10T00:00:00Z",
            "session": {
                "id": "s1",
                "title": "Trip",
                "folder": "C:/Users/someone/project",
                "access": "edit-folder",
                "editConsent": { "folder": "C:/Users/someone/project" },
                "messages": [{ "id": "m1" }],
                "turns": [
                    { "role": "user", "content": "use Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789" },
                    { "role": "tool", "name": "bash", "args": { "api_key": "sk-live-abcdefghijklmnopqrstuvwxyz0123" } }
                ]
            },
            "toolActivity": [],
            "fileActivity": []
        })
    }

    #[test]
    fn authority_and_machine_paths_are_not_exported() {
        let (out, _) = prepare_export(bundle()).unwrap();
        let session = out["session"].as_object().unwrap();
        for key in ["folder", "access", "editConsent", "messages"] {
            assert!(!session.contains_key(key), "{key} was exported");
        }
        assert_eq!(out["session"]["turns"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn credentials_are_redacted_before_anything_is_written() {
        let (out, found) = prepare_export(bundle()).unwrap();
        let text = out.to_string();
        assert!(found >= 2, "{found} redactions: {text}");
        assert!(!text.contains("sk-live-abcdefghijklmnopqrstuvwxyz0123"), "{text}");
        assert!(!text.contains("abcdefghijklmnopqrstuvwxyz0123456789"), "{text}");
    }

    #[test]
    fn an_unknown_schema_version_is_refused_by_name() {
        let mut b = bundle();
        b["schemaVersion"] = json!(7);
        let err = parse_import(b.to_string().as_bytes()).unwrap_err();
        assert!(err.contains("schema version 7"), "{err}");
    }

    #[test]
    fn something_that_is_not_an_export_is_refused() {
        assert!(parse_import(b"not json").is_err());
        assert!(parse_import(br#"{"format":"other"}"#).is_err());
        let mut b = bundle();
        b["exportId"] = json!("");
        assert!(parse_import(b.to_string().as_bytes()).is_err());
        let mut b = bundle();
        b["session"]["turns"] = json!("nope");
        assert!(parse_import(b.to_string().as_bytes()).is_err());
    }

    #[test]
    fn a_valid_export_round_trips() {
        let (out, _) = prepare_export(bundle()).unwrap();
        let back = parse_import(out.to_string().as_bytes()).unwrap();
        assert_eq!(back["exportId"], "exp-1");
    }
}
