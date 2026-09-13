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
///
/// `lastUsage` is deliberately *not* here. It is the provider's own count for
/// the session's last request, cache breakdown included (AH-211): no path, no
/// authority, nothing this machine granted -- and dropping it made an imported
/// session's token counter come back empty.
const DROPPED_SESSION_KEYS: [&str; 8] = [
    "folder",
    "access",
    "editConsent",
    "continuity",
    "codePanel",
    "runBudget",
    "messages",
    "history",
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

/// A folder as another computer can recognise it: its name and, for a git
/// checkout, the branch and commit it is on. Never its path. AH-210.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct FolderIdentity {
    pub name: String,
    pub branch: Option<String>,
    pub head: Option<String>,
}

pub fn folder_identity(folder: &std::path::Path) -> FolderIdentity {
    let git = |args: &[&str]| -> Option<String> {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(folder)
            .args(args)
            .stdin(std::process::Stdio::null())
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (out.status.success() && !text.is_empty()).then_some(text)
    };
    FolderIdentity {
        name: folder
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        // A detached HEAD has no branch to name.
        branch: git(&["rev-parse", "--abbrev-ref", "HEAD"]).filter(|b| b != "HEAD"),
        head: git(&["rev-parse", "HEAD"]),
    }
}

/// Every way `path` may have been spelled into a transcript: as given and
/// canonical, without Windows' verbatim prefix, with either separator.
fn spellings(path: &std::path::Path) -> Vec<String> {
    let mut forms = vec![path.to_string_lossy().to_string()];
    if let Ok(canonical) = path.canonicalize() {
        forms.push(canonical.to_string_lossy().to_string());
    }
    let mut out = Vec::new();
    for form in forms {
        let plain = form.trim_start_matches(r"\\?\").to_string();
        for variant in [plain.clone(), plain.replace('\\', "/"), plain.replace('/', "\\")] {
            let variant = variant.trim_end_matches(['/', '\\']).to_string();
            if variant.len() > 3 && !out.contains(&variant) {
                out.push(variant);
            }
        }
    }
    out
}

/// Replace `needle` in `text` wherever it occurs, ignoring ASCII case on
/// Windows, where a path is the same path in any case.
fn replace_path(text: &str, needle: &str, with: &str) -> String {
    if !cfg!(windows) {
        return text.replace(needle, with);
    }
    let lower = text.to_ascii_lowercase();
    let target = needle.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    let mut from = 0;
    while let Some(found) = lower[from..].find(&target) {
        let at = from + found;
        out.push_str(&text[last..at]);
        out.push_str(with);
        last = at + needle.len();
        from = last;
    }
    out.push_str(&text[last..]);
    out
}

fn scrub_paths(value: &mut Value, places: &[(String, &str)]) {
    match value {
        Value::String(text) => {
            for (needle, with) in places {
                if text.len() >= needle.len() {
                    *text = replace_path(text, needle, with);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|v| scrub_paths(v, places)),
        Value::Object(map) => map.values_mut().for_each(|v| scrub_paths(v, places)),
        _ => {}
    }
}

/// Ready a session for another computer. AH-210.
///
/// Everything [`prepare_export`] does, and then: every absolute path that only
/// means something on this machine is replaced by what it means -- the
/// session's folder becomes `<folder>`, Jan's data folder `<jan-data>`, the
/// home folder `~` -- and a `handoff` block says which folder that was (by
/// name, branch and commit) and which model the session used (provider and
/// id only; nothing else the renderer sent under `handoff` survives).
pub fn prepare_handoff(
    bundle: Value,
    folder: Option<&std::path::Path>,
    data_folder: &std::path::Path,
    home: Option<&std::path::Path>,
) -> Result<(Value, usize), String> {
    let model = bundle
        .get("handoff")
        .and_then(|h| h.get("model"))
        .and_then(|m| {
            let provider = m.get("provider")?.as_str()?;
            let id = m.get("id")?.as_str()?;
            Some(serde_json::json!({ "provider": provider, "id": id }))
        })
        .unwrap_or(Value::Null);
    let (mut out, redactions) = prepare_export(bundle)?;
    if let Some(map) = out.as_object_mut() {
        map.remove("handoff");
    }
    let mut places: Vec<(String, &str)> = Vec::new();
    if let Some(folder) = folder {
        places.extend(spellings(folder).into_iter().map(|p| (p, "<folder>")));
    }
    places.extend(spellings(data_folder).into_iter().map(|p| (p, "<jan-data>")));
    if let Some(home) = home {
        places.extend(spellings(home).into_iter().map(|p| (p, "~")));
    }
    // Longest first, so a folder inside the home folder is named as the
    // folder rather than as `~/...`.
    places.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    scrub_paths(&mut out, &places);
    out["handoff"] = serde_json::json!({
        "folder": folder.map(folder_identity),
        "model": model,
    });
    Ok((out, redactions))
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

    /// AH-211: the session's provider usage is data, not authority, and an
    /// export that dropped it brought the session back with an empty counter.
    #[test]
    fn the_provider_usage_is_carried_with_its_cache_breakdown() {
        let mut b = bundle();
        let usage = json!({
            "prompt_tokens": 5900, "completion_tokens": 32, "total_tokens": 5932,
            "cached_prompt_tokens": 5863, "uncached_prompt_tokens": 37,
            "cache_source": "openai-chat"
        });
        b["session"]["lastUsage"] = usage.clone();
        let (out, _) = prepare_export(b).unwrap();
        assert_eq!(out["session"]["lastUsage"], usage);
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

    fn git(dir: &std::path::Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.invalid")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.invalid")
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
    }

    fn temp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "jan-handoff-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// AH-210: the other computer is told which folder, not where it was.
    #[test]
    fn a_handoff_names_the_folder_and_carries_no_path_from_this_machine() {
        let home = temp("home");
        let folder = home.join("widget");
        std::fs::create_dir_all(&folder).unwrap();
        git(&folder, &["init", "-q", "-b", "main"]);
        std::fs::write(folder.join("a.txt"), "a").unwrap();
        git(&folder, &["add", "."]);
        git(&folder, &["commit", "-q", "-m", "base"]);
        let data = home.join("jan-data");
        let f = folder.to_string_lossy().to_string();
        let mut b = bundle();
        b["session"]["turns"] = json!([
            { "role": "tool", "name": "write", "args": { "path": format!("{f}{}src{}a.ts", std::path::MAIN_SEPARATOR, std::path::MAIN_SEPARATOR) } },
            { "role": "tool", "name": "read", "args": { "path": f.replace('\\', "/") + "/README.md" } },
            { "role": "assistant", "content": format!("the sandbox is {}", data.join("agent-workspace").display()) },
            { "role": "assistant", "content": format!("notes live in {}", home.join("notes.txt").display()) },
        ]);
        b["handoff"] = json!({ "model": { "provider": "openrouter", "id": "gpt-x", "api_key": "sk-live-abcdefghijklmnopqrstuvwxyz0123" } });

        let (out, _) = prepare_handoff(b, Some(&folder), &data, Some(&home)).unwrap();
        let text = out.to_string();
        let home_s = home.to_string_lossy().to_string();
        assert!(!text.contains(&home_s), "{text}");
        assert!(!text.contains(&home_s.replace('\\', "/")), "{text}");
        assert!(text.contains("<folder>"), "{text}");
        assert!(text.contains("<jan-data>"), "{text}");
        assert!(text.contains("~"), "{text}");
        assert_eq!(out["handoff"]["folder"]["name"], "widget");
        assert_eq!(out["handoff"]["folder"]["branch"], "main");
        assert_eq!(out["handoff"]["folder"]["head"].as_str().unwrap().len(), 40);
        // Only the provider and the id: a key sent along is never written.
        assert_eq!(out["handoff"]["model"], json!({ "provider": "openrouter", "id": "gpt-x" }));
        assert!(!text.contains("sk-live"), "{text}");
        // Still an export this and older builds read.
        assert!(parse_import(text.as_bytes()).is_ok());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_handoff_without_a_folder_says_so() {
        let data = temp("data-only");
        let (out, _) = prepare_handoff(bundle(), None, &data, None).unwrap();
        assert!(out["handoff"]["folder"].is_null());
        assert!(out["handoff"]["model"].is_null());
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn a_folder_that_is_not_a_checkout_is_named_without_a_branch() {
        let dir = temp("plain");
        let id = folder_identity(&dir);
        assert!(id.name.starts_with("jan-handoff-plain"));
        assert_eq!(id.branch, None);
        assert_eq!(id.head, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_valid_export_round_trips() {
        let (out, _) = prepare_export(bundle()).unwrap();
        let back = parse_import(out.to_string().as_bytes()).unwrap();
        assert_eq!(back["exportId"], "exp-1");
    }
}
