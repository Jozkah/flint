//! What an interrupted write leaves behind must not cost the whole thread.
//!
//! `messages.jsonl` is rewritten on every edit and delete, and appended to on
//! every new message. Both used to be able to leave a torn file: the rewrite
//! truncated first and wrote second, and an append interrupted mid-line leaves
//! half a JSON object with no newline. The reader then failed on that one line
//! and the entire conversation became unreadable. Reported upstream as
//! janhq/jan#8019.

use super::helpers::{
    append_message_line, append_message_line_if_new, read_messages_from_file, read_messages_lossy, update_thread_metadata,
    write_messages_to_file,
};
use super::utils::{ensure_thread_dir_exists, get_messages_path, get_thread_metadata_path};
use serde_json::json;
use std::fs;

fn thread(label: &str) -> (tempfile::TempDir, std::path::PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    ensure_thread_dir_exists(tmp.path(), label).unwrap();
    let path = get_messages_path(tmp.path(), label);
    (tmp, path)
}

#[test]
fn append_if_new_skips_a_known_id_and_still_settles_a_torn_tail() {
    let (tmp, path) = thread("dedupe");
    fs::write(&path, "{\"id\":\"m1\",\"role\":\"user\"}\n{\"id\":\"m2\",\"ro").unwrap();

    // Already present: nothing written, not even the tail repair.
    let m1 = json!({"id": "m1", "role": "user"});
    assert!(!append_message_line_if_new(&path, &m1, Some("m1")).unwrap());

    // A new id whose text only appears inside another message is still new.
    let m3 = json!({"id": "m3", "role": "assistant", "note": "\"m1\""});
    assert!(append_message_line_if_new(&path, &m3, Some("m3")).unwrap());
    let raw = fs::read_to_string(&path).unwrap();
    assert!(raw.ends_with('\n'));
    let messages = read_messages_from_file(tmp.path(), "dedupe");
    let ids: Vec<_> = messages
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ids, ["m1", "m3"]);
}

#[test]
fn a_torn_final_line_does_not_make_the_thread_unreadable() {
    let (tmp, path) = thread("torn");
    // Two complete messages, then the half-written third a crash leaves.
    fs::write(
        &path,
        "{\"id\":\"m1\",\"role\":\"user\"}\n{\"id\":\"m2\",\"role\":\"assistant\"}\n{\"id\":\"m3\",\"ro",
    )
    .unwrap();

    let read = read_messages_from_file(tmp.path(), "torn").expect("thread stays readable");

    assert_eq!(read.len(), 2);
    assert_eq!(read[0]["id"], "m1");
    assert_eq!(read[1]["id"], "m2");
}

#[test]
fn a_complete_final_line_missing_only_its_newline_is_kept() {
    let (tmp, path) = thread("no-newline");
    fs::write(&path, "{\"id\":\"m1\"}\n{\"id\":\"m2\"}").unwrap();

    let read = read_messages_from_file(tmp.path(), "no-newline").unwrap();

    assert_eq!(read.len(), 2);
    assert_eq!(read[1]["id"], "m2");
}

#[test]
fn corruption_in_the_middle_is_still_reported() {
    // A torn tail is the one shape an interrupted write produces. A bad line
    // with good lines after it is something else, and silently dropping it
    // would hide real damage.
    let (tmp, path) = thread("middle");
    fs::write(&path, "{\"id\":\"m1\"}\nnot json\n{\"id\":\"m3\"}\n").unwrap();

    assert!(read_messages_from_file(tmp.path(), "middle").is_err());
}

#[test]
fn an_append_after_a_torn_tail_is_not_swallowed_by_it() {
    let (tmp, path) = thread("append");
    fs::write(&path, "{\"id\":\"m1\"}\n{\"id\":\"m2\",\"ro").unwrap();

    append_message_line(&path, &json!({"id": "m3", "role": "user"})).unwrap();

    let read = read_messages_from_file(tmp.path(), "append").unwrap();
    let ids: Vec<_> = read.iter().map(|m| m["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["m1", "m3"]);
}

#[test]
fn an_append_keeps_a_complete_tail_that_only_lacked_a_newline() {
    let (tmp, path) = thread("append-complete");
    fs::write(&path, "{\"id\":\"m1\"}").unwrap();

    append_message_line(&path, &json!({"id": "m2"})).unwrap();

    let read = read_messages_from_file(tmp.path(), "append-complete").unwrap();
    let ids: Vec<_> = read.iter().map(|m| m["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["m1", "m2"]);
}

#[test]
fn an_append_creates_the_file_when_there_is_none() {
    let (tmp, path) = thread("fresh");
    append_message_line(&path, &json!({"id": "m1"})).unwrap();
    let read = read_messages_from_file(tmp.path(), "fresh").unwrap();
    assert_eq!(read.len(), 1);
}

/// Every `*.tmp` staging file in `dir`.
fn staging_files(dir: &std::path::Path) -> Vec<String> {
    fs::read_dir(dir)
        .unwrap()
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".tmp"))
        .collect()
}

#[test]
fn a_failed_rewrite_reports_failure_and_leaves_no_staging_file() {
    let (tmp, path) = thread("failed-rewrite");
    // A destination that cannot be replaced by a file: a directory with
    // something in it. The staging file is written, the rename is refused.
    fs::create_dir_all(&path).unwrap();
    fs::write(path.join("occupant"), "x").unwrap();

    let result = write_messages_to_file(&[json!({"id": "replacement"})], &path);

    assert!(result.is_err(), "the blocked rewrite must report failure");
    assert!(path.join("occupant").is_file(), "the destination is untouched");
    assert!(staging_files(path.parent().unwrap()).is_empty(), "the staging file is cleaned up");
    drop(tmp);
}

#[test]
fn a_failed_thread_metadata_write_reports_failure_and_leaves_no_staging_file() {
    let tmp = tempfile::tempdir().unwrap();
    ensure_thread_dir_exists(tmp.path(), "meta").unwrap();
    let path = get_thread_metadata_path(tmp.path(), "meta");
    fs::create_dir_all(&path).unwrap();
    fs::write(path.join("occupant"), "x").unwrap();

    let result = update_thread_metadata(tmp.path(), "meta", &json!({"id": "meta", "title": "new"}));

    assert!(result.is_err());
    assert!(path.join("occupant").is_file());
    assert!(staging_files(path.parent().unwrap()).is_empty());
}

#[test]
fn writers_to_one_file_never_share_a_staging_file() {
    let tmp = tempfile::tempdir().unwrap();
    ensure_thread_dir_exists(tmp.path(), "busy").unwrap();
    let path = get_thread_metadata_path(tmp.path(), "busy");
    let handles: Vec<_> = (0..24)
        .map(|i| {
            let root = tmp.path().to_path_buf();
            std::thread::spawn(move || {
                update_thread_metadata(&root, "busy", &json!({"id": "busy", "title": format!("t{i}")})).unwrap();
            })
        })
        .collect();
    for handle in handles {
        handle.join().unwrap();
    }
    let kept: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert!(kept["title"].as_str().unwrap().starts_with('t'));
    assert!(staging_files(path.parent().unwrap()).is_empty());
}

#[test]
fn a_successful_rewrite_leaves_no_staging_file_behind() {
    let (_tmp, path) = thread("clean");
    write_messages_to_file(&[json!({"id": "a"}), json!({"id": "b"})], &path).unwrap();
    assert!(staging_files(path.parent().unwrap()).is_empty());
    assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), 2);
}

#[test]
fn middle_corrupt_line_is_skipped_and_reported() {
    let (tmp, path) = thread("lossy");
    fs::write(&path, "{\"id\":\"m1\"}
not json
{\"id\":\"m3\"}
").unwrap();
    let read = read_messages_lossy(tmp.path(), "lossy").unwrap();
    let ids: Vec<_> = read.messages.iter().map(|m| m["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["m1", "m3"]);
    assert_eq!(read.bad_lines, vec!["not json".to_string()]);
}

#[test]
fn lossy_reader_ignores_a_torn_tail_without_reporting_it() {
    let (tmp, path) = thread("lossy-torn");
    fs::write(&path, "{\"id\":\"m1\"}
{\"id\":\"m2\",\"ro").unwrap();
    let read = read_messages_lossy(tmp.path(), "lossy-torn").unwrap();
    assert_eq!(read.messages.len(), 1);
    assert!(read.bad_lines.is_empty());
}

#[tokio::test]
async fn delete_message_works_on_thread_with_bad_line_and_keeps_it_in_the_sidecar() {
    let (tmp, path) = thread("lossy-delete");
    fs::write(&path, "{\"id\":\"m1\"}
not json
{\"id\":\"m3\"}
").unwrap();
    super::storage::delete_message_in(tmp.path(), "lossy-delete", "m1").await.unwrap();
    super::storage::delete_message_in(tmp.path(), "lossy-delete", "zzz").await.unwrap();
    let read = read_messages_lossy(tmp.path(), "lossy-delete").unwrap();
    assert_eq!(read.messages.len(), 1);
    assert!(read.bad_lines.is_empty());
    let sidecar = fs::read_to_string(tmp.path().join("threads/lossy-delete/messages.jsonl.corrupt")).unwrap();
    assert_eq!(sidecar, "not json
", "kept once, not duplicated");
}

#[tokio::test]
async fn modify_thread_keeps_the_backend_owned_active_root() {
    let (tmp, _path) = thread("keep-root");
    update_thread_metadata(tmp.path(), "keep-root", &json!({"id":"keep-root","metadata":{"activeRootId":"r2"}})).unwrap();
    super::storage::modify_thread_in(tmp.path(), json!({"id":"keep-root","title":"T","metadata":{"activeRootId":"stale"}}))
        .await
        .unwrap();
    let raw = fs::read_to_string(get_thread_metadata_path(tmp.path(), "keep-root")).unwrap();
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(v["metadata"]["activeRootId"], "r2");
    assert_eq!(v["title"], "T");

fn append_dedupes_via_cache() {
    let (_tmp, path) = thread("cache-dedupe");
    assert!(append_message_line_if_new(&path, &json!({"id": "a"}), Some("a")).unwrap());
    assert!(!append_message_line_if_new(&path, &json!({"id": "a"}), Some("a")).unwrap());
    assert!(append_message_line_if_new(&path, &json!({"id": "b"}), Some("b")).unwrap());
    assert!(!append_message_line_if_new(&path, &json!({"id": "b"}), Some("b")).unwrap());
    assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), 2);
}

#[test]
fn cache_rebuilds_when_file_changed_externally() {
    let (_tmp, path) = thread("cache-external");
    assert!(append_message_line_if_new(&path, &json!({"id": "a"}), Some("a")).unwrap());
    // Another writer (the CLI) appends a message this process never saw.
    let mut raw = fs::read_to_string(&path).unwrap();
    raw.push_str("{\"id\":\"ext\"}\n");
    fs::write(&path, raw).unwrap();
    assert!(!append_message_line_if_new(&path, &json!({"id": "ext"}), Some("ext")).unwrap());
    assert!(append_message_line_if_new(&path, &json!({"id": "c"}), Some("c")).unwrap());
}

#[test]
fn torn_tail_settled_with_tail_read_only() {
    // A short torn tail and one longer than the 64 KiB tail window.
    for (label, filler) in [("tail-short", 10usize), ("tail-long", 200 * 1024)] {
        let (tmp, path) = thread(label);
        let mut raw = String::from("{\"id\":\"m1\"}\n");
        raw.push_str("{\"id\":\"torn\",\"text\":\"");
        raw.push_str(&"x".repeat(filler));
        fs::write(&path, raw).unwrap();
        assert!(append_message_line_if_new(&path, &json!({"id": "m2"}), Some("m2")).unwrap());
        let read = read_messages_from_file(tmp.path(), label).unwrap();
        let ids: Vec<_> = read.iter().map(|m| m["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["m1", "m2"]);
    }
}

#[test]
fn cache_dropped_on_rewrite() {
    let (_tmp, path) = thread("cache-rewrite");
    assert!(append_message_line_if_new(&path, &json!({"id": "a"}), Some("a")).unwrap());
    // Rewriting without "a" must make "a" appendable again.
    write_messages_to_file(&[json!({"id": "z"})], &path).unwrap();
    assert!(append_message_line_if_new(&path, &json!({"id": "a"}), Some("a")).unwrap());
}
