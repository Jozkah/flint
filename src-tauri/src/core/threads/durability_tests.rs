//! What an interrupted write leaves behind must not cost the whole thread.
//!
//! `messages.jsonl` is rewritten on every edit and delete, and appended to on
//! every new message. Both used to be able to leave a torn file: the rewrite
//! truncated first and wrote second, and an append interrupted mid-line leaves
//! half a JSON object with no newline. The reader then failed on that one line
//! and the entire conversation became unreadable. Reported upstream as
//! janhq/jan#8019.

use super::helpers::{
    append_message_line, read_messages_from_file, update_thread_metadata, write_messages_to_file,
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

#[test]
fn a_failed_rewrite_leaves_the_existing_file_intact() {
    let (tmp, path) = thread("failed-rewrite");
    write_messages_to_file(&[json!({"id": "keep"})], &path).unwrap();
    // Block the staging file the rewrite goes through, so the rewrite fails
    // before it could have touched the real file.
    let staging = path.with_extension("jsonl.tmp");
    fs::create_dir_all(&staging).unwrap();

    let result = write_messages_to_file(&[json!({"id": "replacement"})], &path);

    assert!(result.is_err(), "the blocked rewrite must report failure");
    let read = read_messages_from_file(tmp.path(), "failed-rewrite").unwrap();
    assert_eq!(read.len(), 1);
    assert_eq!(read[0]["id"], "keep");
}

#[test]
fn a_failed_thread_metadata_write_leaves_the_existing_file_intact() {
    let tmp = tempfile::tempdir().unwrap();
    ensure_thread_dir_exists(tmp.path(), "meta").unwrap();
    update_thread_metadata(tmp.path(), "meta", &json!({"id": "meta", "title": "keep"})).unwrap();
    let path = get_thread_metadata_path(tmp.path(), "meta");
    fs::create_dir_all(path.with_file_name("thread.json.tmp")).unwrap();

    let result = update_thread_metadata(tmp.path(), "meta", &json!({"id": "meta", "title": "new"}));

    assert!(result.is_err());
    let kept: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(kept["title"], "keep");
}

#[test]
fn a_successful_rewrite_leaves_no_staging_file_behind() {
    let (_tmp, path) = thread("clean");
    write_messages_to_file(&[json!({"id": "a"}), json!({"id": "b"})], &path).unwrap();
    assert!(!path.with_extension("jsonl.tmp").exists());
    assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), 2);
}
