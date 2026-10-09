//! `flint cli archive ...` and the thread edits that go with it: the Archive
//! page and the thread list's rename, favourite and delete, from the terminal.
//!
//! Deleting a thread moves it to the archive (the same default as the desktop);
//! `--permanent` skips it. Restoring brings back directory items (threads,
//! rooms). Items kept as payloads (Cowork sessions, projects, assistants,
//! Studio results) are re-registered by the desktop app, so the CLI lists and
//! purges them but cannot restore them.

use std::path::Path;

use serde_json::{json, Value};

use crate::core::archive::store::{self, ArchiveMeta, Kind, Storage};
use crate::core::threads::storage as thread_store;
use crate::core::threads::utils::validate_thread_id;

fn data_folder() -> std::path::PathBuf {
    crate::core::app::commands::resolve_jan_data_folder()
}

fn parse_kind(kind: Option<&str>) -> Result<Option<Kind>, String> {
    kind.map(Kind::parse).transpose()
}

fn stamp(ms: u64) -> String {
    chrono::DateTime::from_timestamp_millis(ms as i64)
        .map(|t| t.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| "-".to_string())
}

/// What destroying an archived item also destroys, run before its directory is
/// removed. A refusal keeps the item.
fn purge_cleanup(data: &Path, meta: &ArchiveMeta, _dir: &Path) -> Result<(), String> {
    match meta.kind {
        Kind::Thread | Kind::Cowork => {
            if meta.kind == Kind::Cowork {
                let extra = meta.extra.as_ref();
                let discard = extra
                    .and_then(|e| e.get("discardOnPurge"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let has_worktree = extra.and_then(|e| e.get("worktree")).is_some_and(|v| !v.is_null());
                if discard && has_worktree {
                    return Err(format!(
                        "\"{}\" asked for its worktree to be removed with it; purge it in the Flint app, which checks for unmerged work first",
                        meta.title
                    ));
                }
            }
            if let Err(e) = tauri_plugin_agent_tools::retention::delete_session(data, &meta.id) {
                log::warn!("could not remove the records of a purged item: {e}");
            }
            if meta.kind == Kind::Thread {
                if let Some(scratch) = crate::core::threads::utils::thread_scratch_dir(&meta.id) {
                    let _ = std::fs::remove_dir_all(scratch);
                }
            }
            Ok(())
        }
        Kind::Room | Kind::Project | Kind::Assistant | Kind::Studio => Ok(()),
    }
}

/// `archive list [--kind K] [--json]`
pub fn list(kind: Option<&str>, json: bool) -> Result<(), String> {
    let kind = parse_kind(kind)?;
    let data = data_folder();
    let items: Vec<_> = store::list(&data)
        .into_iter()
        .filter(|i| kind.map_or(true, |k| k == i.meta.kind))
        .collect();
    if json {
        println!("{}", serde_json::to_string_pretty(&items).map_err(|e| e.to_string())?);
        return Ok(());
    }
    if items.is_empty() {
        println!("The archive is empty.");
        return Ok(());
    }
    for i in &items {
        println!(
            "{:<9} {}  {}  {:>9} B  {}",
            i.meta.kind.as_str(),
            i.archive_id,
            stamp(i.meta.archived_at),
            i.size_bytes,
            i.meta.title
        );
    }
    println!("{} item(s), {} bytes", items.len(), store::disk_usage(&data));
    Ok(())
}

/// `archive restore <kind> <archive-id>`
pub fn restore(kind: &str, archive_id: &str) -> Result<(), String> {
    let kind = Kind::parse(kind)?;
    let data = data_folder();
    // A payload item comes back as data for the app to re-register; doing that
    // here would only drop it from the archive without putting it anywhere.
    let item = store::list(&data)
        .into_iter()
        .find(|i| i.meta.kind == kind && i.archive_id == archive_id)
        .ok_or_else(|| format!("archived {} {archive_id} not found", kind.as_str()))?;
    if item.meta.storage != Storage::Dir {
        return Err(format!(
            "a {} is restored by the Flint app (it re-registers the item); it stays in the archive",
            kind.as_str()
        ));
    }
    let restored = store::restore(&data, kind, archive_id)?;
    println!("{}", json!({ "restored": true, "kind": restored.kind.as_str(), "id": restored.id, "title": restored.title }));
    Ok(())
}

/// `archive purge <kind> <archive-id> --yes`: delete one item for good.
pub fn purge(kind: &str, archive_id: &str, yes: bool) -> Result<(), String> {
    if !yes {
        return Err("this deletes the item for good; run again with --yes".to_string());
    }
    let kind = Kind::parse(kind)?;
    let data = data_folder();
    let mut hook = |m: &ArchiveMeta, d: &Path| purge_cleanup(&data, m, d);
    store::purge_with(&data, kind, archive_id, &mut hook)?;
    println!("{}", json!({ "purged": true, "id": archive_id }));
    Ok(())
}

/// `archive empty [--kind K] --yes`: delete everything (or one kind) for good.
/// Items a guard refuses stay, with the reason.
pub fn empty(kind: Option<&str>, yes: bool) -> Result<(), String> {
    if !yes {
        return Err("this deletes archived items for good; run again with --yes".to_string());
    }
    let kind = parse_kind(kind)?;
    let data = data_folder();
    let mut hook = |m: &ArchiveMeta, d: &Path| purge_cleanup(&data, m, d);
    let report = store::purge_matching(&data, kind, None, &mut hook);
    println!("{}", serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?);
    Ok(())
}

/// `archive settings [--enabled B] [--auto-delete-days N] [--auto-archive-days N]`
pub fn settings(enabled: Option<bool>, auto_delete_days: Option<u32>, auto_archive_days: Option<u32>) -> Result<(), String> {
    let data = data_folder();
    let mut s = store::read_settings(&data);
    if enabled.is_some() || auto_delete_days.is_some() || auto_archive_days.is_some() {
        if let Some(v) = enabled {
            s.enabled = v;
        }
        if let Some(v) = auto_delete_days {
            s.auto_delete_days = v;
        }
        if let Some(v) = auto_archive_days {
            s.auto_archive_thread_days = v;
        }
        store::write_settings(&data, &s)?;
    }
    println!("{}", serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?);
    Ok(())
}

// ---- threads ----

fn read_thread(data: &Path, id: &str) -> Result<Value, String> {
    validate_thread_id(id)?;
    crate::core::cli::cli_get_thread_in(data, id)
}

/// `threads create [--title T]`
pub fn create_thread(title: Option<&str>) -> Result<Value, String> {
    let data = data_folder();
    let now = chrono::Utc::now().timestamp() as f64;
    let thread = json!({
        "title": title.unwrap_or("New Thread"),
        "assistants": [],
        "created": now,
        "updated": now,
        "metadata": {},
    });
    thread_store::create_thread_in(&data, thread)
}

fn modify(id: &str, change: impl FnOnce(&mut Value)) -> Result<Value, String> {
    let data = data_folder();
    let mut thread = read_thread(&data, id)?;
    change(&mut thread);
    thread["updated"] = json!(chrono::Utc::now().timestamp() as f64);
    thread_store::modify_thread_in(&data, thread.clone())?;
    Ok(thread)
}

/// `threads rename <id> <title>`
pub fn rename_thread(id: &str, title: &str) -> Result<Value, String> {
    if title.trim().is_empty() {
        return Err("give the thread a title".to_string());
    }
    modify(id, |t| t["title"] = json!(title.trim()))
}

/// `threads favorite <id>` / `unfavorite`
pub fn favorite_thread(id: &str, on: bool) -> Result<Value, String> {
    modify(id, |t| t["isFavorite"] = json!(on))
}

/// `threads delete <id>`: into the archive unless it is off or `permanent`.
pub async fn delete_thread(id: &str, permanent: bool) -> Result<bool, String> {
    let data = data_folder();
    validate_thread_id(id)?;
    // Without the archive, delete the way the CLI always did: that also drops
    // the snapshot ref and the run records.
    if permanent || !store::read_settings(&data).enabled {
        crate::core::cli::cli_delete_thread(id)?;
        return Ok(false);
    }
    thread_store::delete_thread_in(&data, id, false).await?;
    Ok(true)
}

/// `threads delete-message <thread> <message>`
pub async fn delete_message(thread_id: &str, message_id: &str) -> Result<(), String> {
    thread_store::delete_message_in(&data_folder(), thread_id, message_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delete_archives_then_restore_and_purge() {
        crate::core::app::commands::with_temp_data_folder(|data| {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            let created = create_thread(Some("Keep me")).unwrap();
            let id = created["id"].as_str().unwrap().to_string();
            assert_eq!(rename_thread(&id, "Renamed").unwrap()["title"], "Renamed");
            assert_eq!(favorite_thread(&id, true).unwrap()["isFavorite"], true);

            assert!(rt.block_on(delete_thread(&id, false)).unwrap(), "archived by default");
            assert!(!data.join("threads").join(&id).exists());
            let items = store::list(data);
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].meta.title, "Renamed");
            let archive_id = items[0].archive_id.clone();

            restore("thread", &archive_id).unwrap();
            assert!(data.join("threads").join(&id).join("thread.json").exists());
            assert!(store::list(data).is_empty());

            rt.block_on(delete_thread(&id, false)).unwrap();
            let archive_id = store::list(data)[0].archive_id.clone();
            assert!(purge("thread", &archive_id, false).is_err(), "needs --yes");
            purge("thread", &archive_id, true).unwrap();
            assert!(store::list(data).is_empty());

            let again = create_thread(None).unwrap();
            let id2 = again["id"].as_str().unwrap().to_string();
            assert!(!rt.block_on(delete_thread(&id2, true)).unwrap(), "permanent skips the archive");
            assert!(store::list(data).is_empty());
            assert!(!data.join("threads").join(&id2).exists());
        });
    }

    #[test]
    fn archive_off_deletes_outright_and_unknown_kind_is_refused() {
        crate::core::app::commands::with_temp_data_folder(|data| {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            settings(Some(false), None, None).unwrap();
            let id = create_thread(None).unwrap()["id"].as_str().unwrap().to_string();
            assert!(!rt.block_on(delete_thread(&id, false)).unwrap());
            assert!(store::list(data).is_empty());
            assert!(list(Some("bogus"), true).is_err());
        });
    }
}
