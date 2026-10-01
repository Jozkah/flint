use super::commands::*;
use super::constants::{MESSAGES_FILE, THREADS_DIR, THREADS_FILE};
use super::helpers::{
    get_lock_for_thread, read_messages_from_file, should_use_sqlite, update_thread_metadata,
    write_messages_to_file,
};
use super::utils::{
    ensure_data_dirs, ensure_thread_dir_exists, get_data_dir, get_messages_path, get_thread_dir,
    get_thread_metadata_path,
};
use crate::core::app::commands::get_jan_data_folder_path;
use futures_util::future;
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use tauri::test::{mock_app, MockRuntime};

// RAII guard that removes the test data dir on drop (panic-safe cleanup).
struct DataDirGuard(PathBuf);
impl Drop for DataDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
impl std::ops::Deref for DataDirGuard {
    type Target = PathBuf;
    fn deref(&self) -> &PathBuf {
        &self.0
    }
}

// Helper to create a mock app handle with a temp data dir.
// The returned guard removes the directory when dropped, so the test is
// panic-safe and will not leak `test-data-*` directories into the workspace.
fn mock_app_with_temp_data_dir() -> (tauri::App<MockRuntime>, DataDirGuard) {
    let app = mock_app();
    // Get the actual data dir that will be used by storage code
    let data_dir = get_jan_data_folder_path(app.handle().clone());
    println!("Mock app data dir: {}", data_dir.display());
    (app, DataDirGuard(data_dir))
}

// Helper to create a basic thread
fn create_test_thread(title: &str) -> serde_json::Value {
    json!({
        "object": "thread",
        "title": title,
        "assistants": [],
        "created": 123,
        "updated": 123,
        "metadata": null
    })
}

// Helper to create a basic message
fn create_test_message(thread_id: &str, content_text: &str) -> serde_json::Value {
    json!({
        "object": "message",
        "thread_id": thread_id,
        "role": "user",
        "content": [{"type": "text", "text": content_text}],
        "status": "sent",
        "created_at": 123,
        "completed_at": 123,
        "metadata": null
    })
}

#[tokio::test]
async fn test_create_and_list_threads() {
    let (app, _data_dir) = mock_app_with_temp_data_dir();
    // Create a thread
    let thread = json!({
        "object": "thread",
        "title": "Test Thread",
        "assistants": [],
        "created": 1234567890,
        "updated": 1234567890,
        "metadata": null
    });
    let created = create_thread(app.handle().clone(), thread.clone())
        .await
        .unwrap();
    assert_eq!(created["title"], "Test Thread");

    // List threads
    let threads = list_threads(app.handle().clone()).await.unwrap();
    assert!(!threads.is_empty());

    // Clean up
}

#[tokio::test]
async fn list_threads_skips_a_thread_file_it_cannot_read() {
    let (app, data_folder) = mock_app_with_temp_data_dir();
    let created = create_thread(app.handle().clone(), create_test_thread("Readable"))
        .await
        .unwrap();
    // A thread.json that exists but cannot be read as a file.
    let broken = get_data_dir(&data_folder)
        .join(format!("unreadable-{}", uuid::Uuid::new_v4()))
        .join(THREADS_FILE);
    fs::create_dir_all(&broken).unwrap();

    let threads = list_threads(app.handle().clone())
        .await
        .expect("one unreadable thread must not fail the whole listing");
    assert!(threads.iter().any(|t| t["id"] == created["id"]));
    let _ = fs::remove_dir_all(broken.parent().unwrap());
}

#[tokio::test]
async fn test_create_and_list_messages() {
    let (app, _data_dir) = mock_app_with_temp_data_dir();
    // Create a thread first
    let thread = json!({
        "object": "thread",
        "title": "Msg Thread",
        "assistants": [],
        "created": 123,
        "updated": 123,
        "metadata": null
    });
    let created = create_thread(app.handle().clone(), thread.clone())
        .await
        .unwrap();
    let thread_id = created["id"].as_str().unwrap().to_string();

    // Create a message
    let message = json!({
        "object": "message",
        "thread_id": thread_id,
        "assistant_id": null,
        "attachments": null,
        "role": "user",
        "content": [],
        "status": "sent",
        "created_at": 123,
        "completed_at": 123,
        "metadata": null,
        "type_": null,
        "error_code": null,
        "tool_call_id": null
    });
    let created_msg = create_message(app.handle().clone(), message).await.unwrap();
    assert_eq!(created_msg["role"], "user");

    // List messages
    let messages = list_messages(app.handle().clone(), thread_id.clone())
        .await
        .unwrap();
    assert!(
        !messages.is_empty(),
        "Expected at least one message, but got none. Thread ID: {thread_id}"
    );
    assert_eq!(messages[0]["role"], "user");

    // Clean up
}

#[tokio::test]
async fn test_create_and_get_thread_assistant() {
    let (app, _data_dir) = mock_app_with_temp_data_dir();
    // Create a thread
    let thread = json!({
        "object": "thread",
        "title": "Assistant Thread",
        "assistants": [],
        "created": 1,
        "updated": 1,
        "metadata": null
    });
    let created = create_thread(app.handle().clone(), thread.clone())
        .await
        .unwrap();
    let thread_id = created["id"].as_str().unwrap().to_string();

    // Add assistant
    let assistant = json!({
        "id": "assistant-1",
        "assistant_name": "Test Assistant",
        "model": {
            "id": "model-1",
            "name": "Test Model",
            "settings": json!({})
        },
        "instructions": null,
        "tools": null
    });
    let _ = create_thread_assistant(app.handle().clone(), thread_id.clone(), assistant.clone())
        .await
        .unwrap();

    // Get assistant
    let got = get_thread_assistant(app.handle().clone(), thread_id.clone())
        .await
        .unwrap();
    assert_eq!(got["assistant_name"], "Test Assistant");

    // Clean up
}

#[test]
fn test_should_use_sqlite_platform_detection() {
    // Test that should_use_sqlite returns correct value based on platform
    // On desktop platforms (macOS, Linux, Windows), it should return false
    // On mobile platforms (Android, iOS), it should return true

    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        assert!(
            should_use_sqlite(),
            "should_use_sqlite should return true on mobile platforms"
        );
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        assert!(
            !should_use_sqlite(),
            "should_use_sqlite should return false on desktop platforms"
        );
    }
}

#[tokio::test]
async fn test_desktop_storage_backend() {
    // This test verifies that on desktop platforms, the file-based storage is used
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let (app, _data_dir) = mock_app_with_temp_data_dir();

        // Create a thread
        let thread = json!({
            "object": "thread",
            "title": "Desktop Test Thread",
            "assistants": [],
            "created": 1234567890,
            "updated": 1234567890,
            "metadata": null
        });

        let created = create_thread(app.handle().clone(), thread.clone())
            .await
            .unwrap();
        let thread_id = created["id"].as_str().unwrap().to_string();

        // Verify we can retrieve the thread (which proves file storage works)
        let threads = list_threads(app.handle().clone()).await.unwrap();
        let found = threads.iter().any(|t| t["id"] == thread_id);
        assert!(
            found,
            "Thread should be retrievable from file-based storage"
        );

        // Create a message
        let message = json!({
            "object": "message",
            "thread_id": thread_id,
            "role": "user",
            "content": [],
            "status": "sent",
            "created_at": 123,
            "completed_at": 123,
            "metadata": null
        });

        let _created_msg = create_message(app.handle().clone(), message).await.unwrap();

        // Verify we can retrieve the message (which proves file storage works)
        let messages = list_messages(app.handle().clone(), thread_id.clone())
            .await
            .unwrap();
        assert_eq!(
            messages.len(),
            1,
            "Message should be retrievable from file-based storage"
        );

        // Clean up
    }
}

#[test]
fn a_thread_id_must_be_one_plain_path_component() {
    // Jozkah/jan#35.
    use super::utils::validate_thread_id;
    for ok in ["3f0c9a52-1b7e-4d8e-9a3c-2f1d7e6b5a40", "aaaa1111", "cowork-thread.v2"] {
        assert!(validate_thread_id(ok).is_ok(), "{ok}");
    }
    for bad in [
        "", ".", "..", "../x", "a/b", r"a\b", r"..\x", "/etc", r"C:\Windows", "C:x", "x\0y",
    ] {
        assert!(validate_thread_id(bad).is_err(), "{bad:?} must be refused");
    }
}

#[tokio::test]
async fn thread_commands_refuse_an_id_that_escapes_the_threads_directory() {
    // Jozkah/jan#35: `delete_thread("../victim")` removed a sibling of the
    // threads directory, and `modify_thread` planted a thread.json there.
    let (app, _data_dir) = mock_app_with_temp_data_dir();
    let jan_data = get_jan_data_folder_path(app.handle().clone());
    ensure_data_dirs(&jan_data).unwrap();
    let victim = jan_data.join("victim");
    fs::create_dir_all(&victim).unwrap();
    fs::write(victim.join("keep.txt"), "x").unwrap();

    for id in ["../victim", r"..\victim"] {
        assert!(delete_thread(app.handle().clone(), id.to_string()).await.is_err());
        assert!(victim.join("keep.txt").exists(), "{id} deleted outside threads/");

        let planted = json!({ "id": id, "title": "x" });
        assert!(modify_thread(app.handle().clone(), planted).await.is_err());
        assert!(!victim.join(THREADS_FILE).exists(), "{id} wrote outside threads/");

        assert!(list_messages(app.handle().clone(), id.to_string()).await.is_err());
        let message = json!({ "thread_id": id, "role": "user", "content": [] });
        assert!(create_message(app.handle().clone(), message).await.is_err());
        assert!(!victim.join(MESSAGES_FILE).exists(), "{id} wrote messages outside threads/");
    }
    let _ = fs::remove_dir_all(&victim);
}

#[tokio::test]
async fn test_modify_and_delete_thread() {
    let (app, data_dir) = mock_app_with_temp_data_dir();

    // Create a thread
    let thread = json!({
        "object": "thread",
        "title": "Original Title",
        "assistants": [],
        "created": 1234567890,
        "updated": 1234567890,
        "metadata": null
    });

    let created = create_thread(app.handle().clone(), thread.clone())
        .await
        .unwrap();
    let thread_id = created["id"].as_str().unwrap().to_string();

    // Modify the thread
    let mut modified_thread = created.clone();
    modified_thread["title"] = json!("Modified Title");

    modify_thread(app.handle().clone(), modified_thread.clone())
        .await
        .unwrap();

    // Verify modification by listing threads
    let threads = list_threads(app.handle().clone()).await.unwrap();
    let found_thread = threads.iter().find(|t| t["id"] == thread_id);
    assert!(found_thread.is_some(), "Modified thread should exist");
    assert_eq!(found_thread.unwrap()["title"], "Modified Title");

    // Requests this thread sent, and one from another thread that must survive.
    let jan_data = get_jan_data_folder_path(app.handle().clone());
    for session in [thread_id.as_str(), "some-other-thread"] {
        let snap = tauri_plugin_agent_tools::snapshot::capture(
            &json!({ "model": "m", "messages": [{ "role": "user", "content": "hi" }] }),
            &tauri_plugin_agent_tools::snapshot::Identity {
                session: session.to_string(),
                ..Default::default()
            },
        );
        tauri_plugin_agent_tools::snapshot::append(&jan_data, &snap);
    }

    // An agent tool call made the thread a scratch dir (Jozkah/jan#186).
    let scratch = tauri_plugin_agent_tools::workspace::ensure_scratch_dir(&thread_id)
        .await
        .unwrap();
    fs::write(scratch.join("work.txt"), b"x").unwrap();

    // Delete the thread for good (the archive is skipped).
    delete_thread_permanently(app.handle().clone(), thread_id.clone())
        .await
        .unwrap();
    assert!(!scratch.exists(), "a deleted thread's scratch dir must go with it");

    // Verify deletion
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let thread_dir = data_dir.join(&thread_id);
        assert!(!thread_dir.exists(), "Thread directory should be deleted");
        assert!(
            tauri_plugin_agent_tools::snapshot::by_session(&jan_data, &thread_id).is_empty(),
            "a deleted thread's request snapshots must go with it"
        );
        assert_eq!(
            tauri_plugin_agent_tools::snapshot::by_session(&jan_data, "some-other-thread").len(),
            1,
            "another thread's snapshots must survive"
        );
    }

    // Clean up
}

// With the archive on, delete moves the thread aside and keeps what was
// recorded about it; restoring returns it, and only a purge destroys it.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tokio::test]
async fn test_delete_thread_archives_and_keeps_records_until_purge() {
    use crate::core::archive::{self, store};

    let (app, _data_dir) = mock_app_with_temp_data_dir();
    let jan_data = get_jan_data_folder_path(app.handle().clone());
    assert!(store::read_settings(&jan_data).enabled, "archive is on by default");

    let created = create_thread(app.handle().clone(), create_test_thread("Keep me"))
        .await
        .unwrap();
    let thread_id = created["id"].as_str().unwrap().to_string();
    let snap = tauri_plugin_agent_tools::snapshot::capture(
        &json!({ "model": "m", "messages": [{ "role": "user", "content": "hi" }] }),
        &tauri_plugin_agent_tools::snapshot::Identity {
            session: thread_id.clone(),
            ..Default::default()
        },
    );
    tauri_plugin_agent_tools::snapshot::append(&jan_data, &snap);
    let scratch = tauri_plugin_agent_tools::workspace::ensure_scratch_dir(&thread_id)
        .await
        .unwrap();

    delete_thread(app.handle().clone(), thread_id.clone())
        .await
        .unwrap();

    // Gone from the list, present in the archive, records and scratch kept.
    let listed = list_threads(app.handle().clone()).await.unwrap();
    assert!(listed.iter().all(|t| t["id"] != thread_id));
    let items = store::list(&jan_data);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].meta.title, "Keep me");
    assert!(scratch.exists(), "scratch dir is removed only at purge");
    assert_eq!(
        tauri_plugin_agent_tools::snapshot::by_session(&jan_data, &thread_id).len(),
        1,
        "request records are removed only at purge"
    );

    // Restore puts it back.
    store::restore(&jan_data, store::Kind::Thread, &items[0].archive_id).unwrap();
    let listed = list_threads(app.handle().clone()).await.unwrap();
    assert!(listed.iter().any(|t| t["id"] == thread_id));

    // Archive again, then purge: now everything goes.
    delete_thread(app.handle().clone(), thread_id.clone())
        .await
        .unwrap();
    let mut hook = |m: &store::ArchiveMeta, d: &std::path::Path| {
        archive::purge_cleanup(&jan_data, m, d)
    };
    store::purge_with(&jan_data, store::Kind::Thread, &thread_id, &mut hook).unwrap();
    assert!(store::list(&jan_data).is_empty());
    assert!(!scratch.exists());
    assert!(tauri_plugin_agent_tools::snapshot::by_session(&jan_data, &thread_id).is_empty());
}

// Turned off, delete is the old delete.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tokio::test]
async fn test_delete_thread_with_archive_off_destroys() {
    use crate::core::archive::store;

    let (app, _data_dir) = mock_app_with_temp_data_dir();
    let jan_data = get_jan_data_folder_path(app.handle().clone());
    store::write_settings(
        &jan_data,
        &store::ArchiveSettings { enabled: false, ..Default::default() },
    )
    .unwrap();
    let created = create_thread(app.handle().clone(), create_test_thread("Gone"))
        .await
        .unwrap();
    let thread_id = created["id"].as_str().unwrap().to_string();
    delete_thread(app.handle().clone(), thread_id.clone())
        .await
        .unwrap();
    assert!(store::list(&jan_data).is_empty());
    assert!(!get_thread_dir(&jan_data, &thread_id).exists());
}

#[tokio::test]
async fn test_modify_and_delete_message() {
    let (app, _data_dir) = mock_app_with_temp_data_dir();

    // Create a thread
    let thread = json!({
        "object": "thread",
        "title": "Message Test Thread",
        "assistants": [],
        "created": 123,
        "updated": 123,
        "metadata": null
    });

    let created = create_thread(app.handle().clone(), thread.clone())
        .await
        .unwrap();
    let thread_id = created["id"].as_str().unwrap().to_string();

    // Create a message
    let message = json!({
        "object": "message",
        "thread_id": thread_id,
        "role": "user",
        "content": [{"type": "text", "text": "Original content"}],
        "status": "sent",
        "created_at": 123,
        "completed_at": 123,
        "metadata": null
    });

    let created_msg = create_message(app.handle().clone(), message).await.unwrap();
    let message_id = created_msg["id"].as_str().unwrap().to_string();

    // Modify the message
    let mut modified_msg = created_msg.clone();
    modified_msg["content"] = json!([{"type": "text", "text": "Modified content"}]);

    modify_message(app.handle().clone(), modified_msg.clone())
        .await
        .unwrap();

    // Verify modification
    let messages = list_messages(app.handle().clone(), thread_id.clone())
        .await
        .unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["content"][0]["text"], "Modified content");

    // Delete the message
    delete_message(app.handle().clone(), thread_id.clone(), message_id.clone())
        .await
        .unwrap();

    // Verify deletion
    let messages = list_messages(app.handle().clone(), thread_id.clone())
        .await
        .unwrap();
    assert_eq!(messages.len(), 0, "Message should be deleted");

    // Clean up
}

#[tokio::test]
async fn test_delete_message_keeps_the_tail_of_a_branched_thread_reachable() {
    let (app, _data_dir) = mock_app_with_temp_data_dir();
    let created = create_thread(app.handle().clone(), create_test_thread("Branched"))
        .await
        .unwrap();
    let thread_id = created["id"].as_str().unwrap().to_string();

    // u1 -> a1b -> u2, with a1 an older version of the reply.
    let lines = [
        ("u1", 1, json!({"parentId": null})),
        ("a1", 2, json!({"parentId": "u1"})),
        ("a1b", 3, json!({"parentId": "u1"})),
        ("u2", 4, json!({"parentId": "a1b"})),
    ];
    for (id, at, metadata) in lines {
        let message = json!({
            "id": id,
            "object": "message",
            "thread_id": thread_id,
            "role": "user",
            "content": [],
            "status": "sent",
            "created_at": at,
            "completed_at": at,
            "metadata": metadata
        });
        create_message(app.handle().clone(), message).await.unwrap();
    }

    delete_message(app.handle().clone(), thread_id.clone(), "a1b".to_string())
        .await
        .unwrap();

    let messages = list_messages(app.handle().clone(), thread_id.clone())
        .await
        .unwrap();
    let ids: Vec<_> = messages.iter().map(|m| m["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["u1", "a1", "u2"]);
    let u2 = messages.iter().find(|m| m["id"] == "u2").unwrap();
    assert_eq!(u2["metadata"]["parentId"], "u1");
    let u1 = messages.iter().find(|m| m["id"] == "u1").unwrap();
    assert_eq!(u1["metadata"]["activeChildId"], "u2");
}

#[tokio::test]
async fn test_modify_thread_assistant() {
    let (app, _data_dir) = mock_app_with_temp_data_dir();
    let app_handle = app.handle().clone();

    let created = create_thread(
        app_handle.clone(),
        create_test_thread("Assistant Mod Thread"),
    )
    .await
    .unwrap();
    let thread_id = created["id"].as_str().unwrap();

    let assistant = json!({
        "id": "assistant-1",
        "assistant_name": "Original Assistant",
        "model": {"id": "model-1", "name": "Test Model"}
    });

    create_thread_assistant(app_handle.clone(), thread_id.to_string(), assistant.clone())
        .await
        .unwrap();

    let mut modified_assistant = assistant;
    modified_assistant["assistant_name"] = json!("Modified Assistant");

    modify_thread_assistant(
        app_handle.clone(),
        thread_id.to_string(),
        modified_assistant,
    )
    .await
    .unwrap();

    let retrieved = get_thread_assistant(app_handle, thread_id.to_string())
        .await
        .unwrap();
    assert_eq!(retrieved["assistant_name"], "Modified Assistant");
}

#[tokio::test]
async fn test_thread_not_found_errors() {
    let (app, _data_dir) = mock_app_with_temp_data_dir();
    let app_handle = app.handle().clone();
    let fake_thread_id = "non-existent-thread-id".to_string();
    let assistant = json!({"id": "assistant-1", "assistant_name": "Test Assistant"});

    assert!(
        get_thread_assistant(app_handle.clone(), fake_thread_id.clone())
            .await
            .is_err()
    );
    assert!(create_thread_assistant(
        app_handle.clone(),
        fake_thread_id.clone(),
        assistant.clone()
    )
    .await
    .is_err());
    assert!(
        modify_thread_assistant(app_handle, fake_thread_id, assistant)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn test_message_without_id_gets_generated() {
    let (app, _data_dir) = mock_app_with_temp_data_dir();
    let app_handle = app.handle().clone();

    let created = create_thread(app_handle.clone(), create_test_thread("Message ID Test"))
        .await
        .unwrap();
    let thread_id = created["id"].as_str().unwrap();

    let message = json!({"object": "message", "thread_id": thread_id, "role": "user", "content": [], "status": "sent"});
    let created_msg = create_message(app_handle, message).await.unwrap();

    assert!(created_msg["id"].as_str().is_some_and(|id| !id.is_empty()));
}

#[tokio::test]
async fn test_concurrent_message_operations() {
    let (app, _data_dir) = mock_app_with_temp_data_dir();
    let app_handle = app.handle().clone();

    let created = create_thread(app_handle.clone(), create_test_thread("Concurrent Test"))
        .await
        .unwrap();
    let thread_id = created["id"].as_str().unwrap().to_string();

    let handles: Vec<_> = (0..5)
        .map(|i| {
            let app_h = app_handle.clone();
            let tid = thread_id.clone();
            tokio::spawn(async move {
                create_message(app_h, create_test_message(&tid, &format!("Message {i}"))).await
            })
        })
        .collect();

    let results = future::join_all(handles).await;
    assert!(results
        .iter()
        .all(|r| r.is_ok() && r.as_ref().unwrap().is_ok()));

    let messages = list_messages(app_handle, thread_id).await.unwrap();
    assert_eq!(messages.len(), 5);
}

#[tokio::test]
async fn test_empty_thread_list() {
    let (app, _data_dir) = mock_app_with_temp_data_dir();
    let threads = list_threads(app.handle().clone()).await.unwrap();
    assert_eq!(threads.len(), 0);
}

#[tokio::test]
async fn test_empty_message_list() {
    let (app, _data_dir) = mock_app_with_temp_data_dir();
    let app_handle = app.handle().clone();

    let created = create_thread(
        app_handle.clone(),
        create_test_thread("Empty Messages Test"),
    )
    .await
    .unwrap();
    let thread_id = created["id"].as_str().unwrap();

    let messages = list_messages(app_handle, thread_id.to_string())
        .await
        .unwrap();
    assert_eq!(messages.len(), 0);
}

// ---------- constants.rs ----------

#[test]
fn test_constants_values() {
    assert_eq!(THREADS_DIR, "threads");
    assert_eq!(THREADS_FILE, "thread.json");
    assert_eq!(MESSAGES_FILE, "messages.jsonl");
}

// ---------- utils.rs ----------

#[test]
fn test_get_data_dir_appends_threads_subdir() {
    let base = PathBuf::from("/tmp/jandata");
    assert_eq!(get_data_dir(&base), base.join("threads"));
}

#[test]
fn test_get_thread_dir_includes_thread_id() {
    let base = PathBuf::from("/tmp/jandata");
    let dir = get_thread_dir(&base, "abc-123");
    assert_eq!(dir, base.join("threads").join("abc-123"));
}

#[test]
fn test_get_thread_metadata_path_layout() {
    let base = PathBuf::from("/tmp/jandata");
    let path = get_thread_metadata_path(&base, "tid");
    assert!(path.ends_with("threads/tid/thread.json"));
}

#[test]
fn test_get_messages_path_layout() {
    let base = PathBuf::from("/tmp/jandata");
    let path = get_messages_path(&base, "tid");
    assert!(path.ends_with("threads/tid/messages.jsonl"));
}

#[test]
fn test_ensure_data_dirs_creates_directory() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path();
    let target = get_data_dir(base);
    assert!(!target.exists());
    ensure_data_dirs(base).unwrap();
    assert!(target.exists() && target.is_dir());
    // Idempotent
    ensure_data_dirs(base).unwrap();
    assert!(target.exists());
}

#[test]
fn test_ensure_thread_dir_exists_creates_nested_dirs() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path();
    ensure_thread_dir_exists(base, "thread-xyz").unwrap();
    let dir = get_thread_dir(base, "thread-xyz");
    assert!(dir.exists() && dir.is_dir());
    // Idempotent on second call
    ensure_thread_dir_exists(base, "thread-xyz").unwrap();
    assert!(dir.exists());
}

// ---------- helpers.rs ----------

#[test]
fn test_should_use_sqlite_matches_target_cfg() {
    let expected = cfg!(any(target_os = "android", target_os = "ios"));
    assert_eq!(should_use_sqlite(), expected);
}

#[test]
fn test_write_and_read_messages_round_trip() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path();
    ensure_thread_dir_exists(base, "trip").unwrap();
    let path = get_messages_path(base, "trip");

    let msgs = vec![
        json!({"id": "m1", "role": "user", "content": "hello"}),
        json!({"id": "m2", "role": "assistant", "content": "hi"}),
    ];
    write_messages_to_file(&msgs, &path).unwrap();
    assert!(path.exists());

    let read = read_messages_from_file(base, "trip").unwrap();
    assert_eq!(read.len(), 2);
    assert_eq!(read[0]["id"], "m1");
    assert_eq!(read[1]["role"], "assistant");
}

/// A message's provider usage, cache breakdown included, is stored verbatim:
/// messages.jsonl keeps metadata as opaque JSON, so neither a cache count nor
/// its absence is rewritten on the way through. AH-211.
#[test]
fn test_message_usage_cache_breakdown_survives_the_round_trip() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path();
    ensure_thread_dir_exists(base, "usage").unwrap();
    let path = get_messages_path(base, "usage");

    let cached = json!({
        "inputTokens": 5974, "outputTokens": 8, "totalTokens": 5982,
        "cachedInputTokens": 5957, "uncachedInputTokens": 17,
        "cacheSource": "openai-chat"
    });
    let legacy = json!({ "inputTokens": 10, "outputTokens": 5, "totalTokens": 15 });
    let msgs = vec![
        json!({"id": "m1", "role": "assistant", "metadata": {"usage": cached}}),
        json!({"id": "m2", "role": "assistant", "metadata": {"usage": legacy}}),
    ];
    write_messages_to_file(&msgs, &path).unwrap();

    let read = read_messages_from_file(base, "usage").unwrap();
    assert_eq!(read[0]["metadata"]["usage"], cached);
    assert_eq!(read[1]["metadata"]["usage"], legacy);
    assert!(read[1]["metadata"]["usage"].get("cachedInputTokens").is_none());
}

#[test]
fn test_read_messages_missing_file_returns_empty() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path();
    let read = read_messages_from_file(base, "no-such-thread").unwrap();
    assert!(read.is_empty());
}

#[test]
fn test_write_messages_empty_creates_empty_file() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path();
    ensure_thread_dir_exists(base, "empty").unwrap();
    let path = get_messages_path(base, "empty");
    write_messages_to_file(&[], &path).unwrap();
    assert!(path.exists());
    let contents = fs::read_to_string(&path).unwrap();
    assert!(contents.is_empty());
}

#[test]
fn test_write_messages_overwrites_existing() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path();
    ensure_thread_dir_exists(base, "ow").unwrap();
    let path = get_messages_path(base, "ow");

    write_messages_to_file(&[json!({"id": "first"})], &path).unwrap();
    write_messages_to_file(&[json!({"id": "second"})], &path).unwrap();

    let read = read_messages_from_file(base, "ow").unwrap();
    assert_eq!(read.len(), 1);
    assert_eq!(read[0]["id"], "second");
}

#[test]
fn test_write_messages_jsonl_format_one_per_line() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path();
    ensure_thread_dir_exists(base, "lines").unwrap();
    let path = get_messages_path(base, "lines");

    let msgs = vec![json!({"id": "a"}), json!({"id": "b"}), json!({"id": "c"})];
    write_messages_to_file(&msgs, &path).unwrap();

    let contents = fs::read_to_string(&path).unwrap();
    let lines: Vec<&str> = contents.lines().collect();
    assert_eq!(lines.len(), 3);
    for line in &lines {
        let _: serde_json::Value = serde_json::from_str(line).unwrap();
    }
}

#[test]
fn test_read_messages_invalid_json_errors() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path();
    ensure_thread_dir_exists(base, "bad").unwrap();
    let path = get_messages_path(base, "bad");
    fs::write(&path, "this is not json\n").unwrap();
    assert!(read_messages_from_file(base, "bad").is_err());
}

#[test]
fn test_update_thread_metadata_writes_pretty_json() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path();
    ensure_thread_dir_exists(base, "meta").unwrap();

    let thread = json!({"id": "meta", "title": "Hello", "assistants": []});
    update_thread_metadata(base, "meta", &thread).unwrap();

    let path = get_thread_metadata_path(base, "meta");
    assert!(path.exists());
    let contents = fs::read_to_string(&path).unwrap();
    // Pretty-printed JSON contains newlines
    assert!(contents.contains('\n'));
    let parsed: serde_json::Value = serde_json::from_str(&contents).unwrap();
    assert_eq!(parsed["title"], "Hello");
    assert_eq!(parsed["id"], "meta");
}

#[test]
fn test_update_thread_metadata_overwrites() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path();
    ensure_thread_dir_exists(base, "ovr").unwrap();

    update_thread_metadata(base, "ovr", &json!({"title": "v1"})).unwrap();
    update_thread_metadata(base, "ovr", &json!({"title": "v2"})).unwrap();

    let contents = fs::read_to_string(get_thread_metadata_path(base, "ovr")).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&contents).unwrap();
    assert_eq!(parsed["title"], "v2");
}

#[tokio::test]
async fn test_get_lock_for_thread_same_id_returns_same_lock() {
    let l1 = get_lock_for_thread("lock-thread-a").await;
    let l2 = get_lock_for_thread("lock-thread-a").await;
    assert!(std::sync::Arc::ptr_eq(&l1, &l2));
}

#[tokio::test]
async fn test_get_lock_for_thread_distinct_ids_distinct_locks() {
    let l1 = get_lock_for_thread("lock-thread-x").await;
    let l2 = get_lock_for_thread("lock-thread-y").await;
    assert!(!std::sync::Arc::ptr_eq(&l1, &l2));
}

/// Jozkah/jan#179: a lock nobody holds is evicted, so the map does not keep
/// one entry per thread ever touched; a held lock is never evicted.
#[tokio::test]
async fn test_idle_thread_locks_are_evicted() {
    let held = get_lock_for_thread("evict-held").await;
    drop(get_lock_for_thread("evict-idle").await);
    let _other = get_lock_for_thread("evict-trigger").await;
    let map = super::helpers::MESSAGE_LOCKS.get().unwrap().lock().await;
    assert!(!map.contains_key("evict-idle"), "an idle lock was kept");
    assert!(map.contains_key("evict-held"), "a held lock was evicted");
    drop(map);
    let again = get_lock_for_thread("evict-held").await;
    assert!(std::sync::Arc::ptr_eq(&held, &again));
}

#[tokio::test]
async fn test_get_lock_for_thread_provides_mutual_exclusion() {
    let lock = get_lock_for_thread("mutex-test").await;
    let _g = lock.lock().await;
    // try_lock on the same Arc should fail while we hold it
    let lock2 = get_lock_for_thread("mutex-test").await;
    assert!(lock2.try_lock().is_err());
}
