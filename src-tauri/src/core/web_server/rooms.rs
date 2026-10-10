//! Discussion rooms for the browser client: the same store the desktop app's
//! `rooms_list`, `room_get`, `room_save`, ... commands use, answered over the
//! server's RPC so the Rooms page works in a browser too.
//!
//! A failure is returned as `code: message`, which the page already knows how to
//! read (`toRoomError`).

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::core::rooms::store::{parse_record, parse_room, RoomStore};

pub fn handles(command: &str) -> bool {
    matches!(
        command,
        "rooms_list"
            | "room_get"
            | "room_save"
            | "room_append"
            | "room_clear_journal"
            | "room_delete"
            | "room_delete_permanently"
    )
}

fn room_id(args: &Value) -> Result<&str, String> {
    args.get("roomId")
        .and_then(Value::as_str)
        .ok_or_else(|| "invalid_id: roomId is required".to_string())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn to_value<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| format!("unknown: {e}"))
}

pub fn call(data_folder: &Path, command: &str, args: &Value) -> Result<Value, String> {
    let store = RoomStore::for_data_folder(data_folder);
    let fail = |e: crate::core::rooms::store::RoomError| e.to_string();
    match command {
        "rooms_list" => to_value(store.list().map_err(fail)?),
        "room_get" => to_value(store.get(room_id(args)?).map_err(fail)?),
        "room_save" => {
            let room = args
                .get("room")
                .cloned()
                .ok_or_else(|| "invalid_room: room is required".to_string())?;
            to_value(store.save(parse_room(room).map_err(fail)?, now_ms()).map_err(fail)?)
        }
        "room_append" => {
            let record = args
                .get("record")
                .cloned()
                .ok_or_else(|| "invalid_room: record is required".to_string())?;
            let id = room_id(args)?.to_owned();
            to_value(store.append(&id, parse_record(record).map_err(fail)?).map_err(fail)?)
        }
        "room_clear_journal" => {
            store.clear_journal(room_id(args)?).map_err(fail)?;
            Ok(json!(null))
        }
        "room_delete" => {
            let id = room_id(args)?;
            if crate::core::archive::store::read_settings(data_folder).enabled {
                store.archive(data_folder, id).map_err(fail)?;
            } else {
                store.delete(id).map_err(fail)?;
            }
            Ok(json!(null))
        }
        "room_delete_permanently" => {
            store.delete(room_id(args)?).map_err(fail)?;
            Ok(json!(null))
        }
        other => Err(format!("unknown: unhandled room command {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("flint-rooms-rpc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn handles_exactly_the_room_commands() {
        for c in [
            "rooms_list",
            "room_get",
            "room_save",
            "room_append",
            "room_clear_journal",
            "room_delete",
            "room_delete_permanently",
        ] {
            assert!(handles(c), "{c}");
        }
        assert!(!handles("agent_resolve_extensions"));
        assert!(!handles("room"));
    }

    #[test]
    fn an_empty_data_folder_lists_no_rooms() {
        let dir = temp();
        let value = call(&dir, "rooms_list", &json!({})).unwrap();
        assert_eq!(value, json!([]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn failures_read_as_code_and_message() {
        let dir = temp();
        let missing = call(&dir, "room_get", &json!({ "roomId": "nope" })).unwrap_err();
        assert!(missing.starts_with("not_found"), "{missing}");
        let no_id = call(&dir, "room_get", &json!({})).unwrap_err();
        assert!(no_id.starts_with("invalid_id"), "{no_id}");
        let bad = call(&dir, "room_save", &json!({ "room": { "id": "x" } })).unwrap_err();
        assert!(bad.starts_with("invalid_room"), "{bad}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
