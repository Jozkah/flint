//! Guest links: share ONE thread with one person through a link, no account.
//!
//! The guest follows the thread live and can send messages, which wait here
//! until the owner sends or dismisses them. Everything a guest can do is behind
//! the `flint serve` web server (`web_server/server/guest_api.rs`); this module
//! is the part both the server and the desktop app use: the share store, what a
//! guest may see, and the owner's commands.
//!
//! Opt-in: the whole feature is off until the owner turns it on, because a
//! share exposes a thread outside this machine.

pub mod store;
pub mod view;

#[cfg(not(feature = "cli"))]
pub mod commands;

use std::path::Path;

use serde_json::{json, Value};

use store::{now_ms, Store};

/// The owner's commands, answered by the desktop app and by `flint serve`'s RPC.
pub fn handles(command: &str) -> bool {
    matches!(
        command,
        "guest_share_settings_get"
            | "guest_share_settings_set"
            | "guest_share_create"
            | "guest_share_list"
            | "guest_share_stop"
            | "guest_share_extend"
            | "guest_share_pending"
            | "guest_share_resolve"
    )
}

/// A file name for display inside the guest message fence.
pub fn sanitize_label(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ' | '(' | ')') { c } else { '_' })
        .take(128)
        .collect()
}

/// Ends every share of a deleted or archived thread. Best effort: a failure is
/// not a reason to keep a thread from being deleted, and a share whose thread is
/// gone refuses every request anyway.
pub fn end_thread(root: &Path, thread_id: &str) {
    let _ = Store::new(root).end_thread(thread_id, now_ms());
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| format!("{key} is required"))
}

pub fn call(root: &Path, command: &str, args: &Value) -> Result<Value, String> {
    let store = Store::new(root);
    let now = now_ms();
    match command {
        "guest_share_settings_get" => Ok(json!({ "enabled": store.enabled() })),
        "guest_share_settings_set" => {
            let on = args.get("enabled").and_then(Value::as_bool).ok_or("enabled is required")?;
            store.set_enabled(on, now)?;
            Ok(json!({ "enabled": on }))
        }
        "guest_share_create" => {
            let thread = str_arg(args, "threadId")?;
            let ttl = args.get("ttlHours").and_then(Value::as_u64);
            let reasoning = args.get("includeReasoning").and_then(Value::as_bool).unwrap_or(false);
            let (share, token) = store.create(thread, ttl, reasoning, now)?;
            Ok(json!({ "share": share, "token": token, "path": format!("/g/{token}") }))
        }
        "guest_share_list" => {
            let thread = args.get("threadId").and_then(Value::as_str);
            serde_json::to_value(store.list(thread, now)?).map_err(|e| e.to_string())
        }
        "guest_share_stop" => {
            let stopped = store.stop(str_arg(args, "shareId")?, now)?;
            Ok(json!({ "stopped": stopped }))
        }
        "guest_share_extend" => {
            let hours = args.get("ttlHours").and_then(Value::as_u64).ok_or("ttlHours is required")?;
            let share = store.set_expiry(str_arg(args, "shareId")?, hours, now)?;
            serde_json::to_value(share).map_err(|e| e.to_string())
        }
        "guest_share_pending" => {
            let thread = str_arg(args, "threadId")?;
            serde_json::to_value(store.pending(thread, now)?).map_err(|e| e.to_string())
        }
        "guest_share_resolve" => {
            let (share, id) = (str_arg(args, "shareId")?, str_arg(args, "pendingId")?);
            match str_arg(args, "action")? {
                // The wrapped text goes back to the caller, which puts it in the
                // thread as an ordinary user turn. Nothing runs from here.
                "send" => {
                    let taken = store.take_pending(share, id, true, now)?;
                    let text = view::wrap_for_model(&taken.id, &taken.text, &taken.attachments);
                    Ok(json!({ "text": text }))
                }
                "dismiss" => {
                    store.take_pending(share, id, false, now)?;
                    Ok(json!({ "dismissed": true }))
                }
                _ => Err("action must be send or dismiss".into()),
            }
        }
        _ => Err(format!("unknown guest command {command}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let thread = dir.path().join("threads").join("t1");
        std::fs::create_dir_all(&thread).unwrap();
        std::fs::write(thread.join("thread.json"), r#"{"id":"t1","title":"Hi"}"#).unwrap();
        dir
    }

    #[test]
    fn owner_commands_round_trip() {
        let dir = data();
        let root = dir.path();
        assert_eq!(call(root, "guest_share_settings_get", &json!({})).unwrap()["enabled"], false);
        assert!(call(root, "guest_share_create", &json!({"threadId": "t1"})).is_err());
        call(root, "guest_share_settings_set", &json!({"enabled": true})).unwrap();
        let made = call(root, "guest_share_create", &json!({"threadId": "t1", "ttlHours": 2})).unwrap();
        let token = made["token"].as_str().unwrap().to_owned();
        assert_eq!(made["path"], format!("/g/{token}"));
        let share_id = made["share"]["id"].as_str().unwrap().to_owned();
        let listed = call(root, "guest_share_list", &json!({"threadId": "t1"})).unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 1);
        assert!(!listed.to_string().contains(&token));
        let id = Store::new(root).queue_message(&share_id, "do $x".into(), vec![], now_ms()).unwrap();
        let pending = call(root, "guest_share_pending", &json!({"threadId": "t1"})).unwrap();
        assert_eq!(pending[0]["id"], id.as_str());
        // Send hands back wrapped, neutralised text and removes it from the queue.
        let sent = call(root, "guest_share_resolve", &json!({"shareId": share_id, "pendingId": id, "action": "send"})).unwrap();
        let text = sent["text"].as_str().unwrap();
        assert!(text.contains("Guest: ") && !text.contains("$x"));
        assert!(call(root, "guest_share_pending", &json!({"threadId": "t1"})).unwrap().as_array().unwrap().is_empty());
        assert!(call(root, "guest_share_resolve", &json!({"shareId": share_id, "pendingId": id, "action": "send"})).is_err());
        // Dismiss drops it without text.
        let id2 = Store::new(root).queue_message(&share_id, "nope".into(), vec![], now_ms() + 5_000).unwrap();
        let d = call(root, "guest_share_resolve", &json!({"shareId": share_id, "pendingId": id2, "action": "dismiss"})).unwrap();
        assert_eq!(d["dismissed"], true);
        assert!(call(root, "guest_share_resolve", &json!({"shareId": share_id, "pendingId": id2, "action": "bogus"})).is_err());
        call(root, "guest_share_extend", &json!({"shareId": share_id, "ttlHours": 48})).unwrap();
        assert_eq!(call(root, "guest_share_stop", &json!({"shareId": share_id})).unwrap()["stopped"], true);
        assert!(call(root, "guest_share_list", &json!({})).unwrap().as_array().unwrap().is_empty());
        assert!(call(root, "guest_share_nope", &json!({})).is_err());
        assert!(handles("guest_share_stop") && !handles("guest_share_nope"));
    }
}
