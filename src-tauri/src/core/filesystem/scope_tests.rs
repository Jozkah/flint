//! Scope enforcement for the legacy frontend filesystem commands.
//!
//! `rm`, `write_yaml`, `read_yaml` and `decompress` have always resolved their
//! arguments through `resolve_app_path_within_jan_data_folder`. `mkdir`, `mv`
//! and `write_file_sync` did not, so any caller reaching the IPC surface — a
//! compromised renderer, an extension, a crafted payload — could create
//! directories, move files and overwrite files anywhere the Flint process could
//! write. These tests pin the guard in place.
//!
//! Reported upstream as janhq/jan#8067.

use super::commands::*;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::test::mock_app;

fn unique_outside_dir(label: &str) -> PathBuf {
    use std::time::{SystemTime, UNIX_EPOCH};

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("jan-scope-escape-{label}-{unique}"))
}

fn assert_out_of_scope(result: &Result<(), String>, path: &Path) {
    let message = result
        .as_ref()
        .expect_err(&format!("expected {} to be refused", path.display()));
    assert!(
        message.contains("jan data folder") || message.contains("Jan data folder"),
        "refusal should name the scope guard, got: {message}"
    );
}

#[test]
fn mkdir_refuses_absolute_path_outside_data_folder() {
    let app = mock_app();
    let target = unique_outside_dir("mkdir");

    let result = mkdir(
        app.handle().clone(),
        vec![target.to_string_lossy().to_string()],
    );

    assert_out_of_scope(&result, &target);
    assert!(
        !target.exists(),
        "refused mkdir must not create {}",
        target.display()
    );
}

#[test]
fn mkdir_refuses_parent_traversal_out_of_data_folder() {
    let app = mock_app();

    let result = mkdir(
        app.handle().clone(),
        vec!["file://../jan-scope-escape-traversal".to_string()],
    );

    assert!(
        result.is_err(),
        "expected ../ traversal to be refused, got {result:?}"
    );
}

#[test]
fn write_file_sync_refuses_absolute_path_outside_data_folder() {
    let app = mock_app();
    let dir = unique_outside_dir("write");
    fs::create_dir_all(&dir).unwrap();
    let target = dir.join("victim.txt");
    fs::write(&target, "original").unwrap();

    let result = write_file_sync(
        app.handle().clone(),
        vec![
            target.to_string_lossy().to_string(),
            "overwritten".to_string(),
        ],
    );

    assert_out_of_scope(&result, &target);
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "original",
        "refused write must leave the file untouched"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn mv_refuses_destination_outside_data_folder() {
    let app = mock_app();
    let data = crate::core::app::commands::get_jan_data_folder_path(app.handle().clone());
    let source = data.join("jan-scope-escape-mv-source.txt");
    fs::create_dir_all(&data).unwrap();
    fs::write(&source, "payload").unwrap();
    let dir = unique_outside_dir("mv-dest");
    fs::create_dir_all(&dir).unwrap();
    let destination = dir.join("exfil.txt");

    let result = mv(
        app.handle().clone(),
        vec![
            "file://jan-scope-escape-mv-source.txt".to_string(),
            destination.to_string_lossy().to_string(),
        ],
    );

    assert_out_of_scope(&result, &destination);
    assert!(
        !destination.exists(),
        "refused mv must not write outside the data folder"
    );
    assert!(source.exists(), "refused mv must leave the source in place");

    let _ = fs::remove_file(&source);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn mv_refuses_source_outside_data_folder() {
    let app = mock_app();
    let dir = unique_outside_dir("mv-source");
    fs::create_dir_all(&dir).unwrap();
    let source = dir.join("secret.txt");
    fs::write(&source, "secret").unwrap();

    let result = mv(
        app.handle().clone(),
        vec![
            source.to_string_lossy().to_string(),
            "file://stolen.txt".to_string(),
        ],
    );

    assert_out_of_scope(&result, &source);
    assert!(source.exists(), "refused mv must leave the source in place");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn mv_still_moves_within_the_data_folder() {
    let app = mock_app();
    let data = crate::core::app::commands::get_jan_data_folder_path(app.handle().clone());
    fs::create_dir_all(&data).unwrap();
    let source = data.join("jan-scope-ok-source.txt");
    let destination = data.join("jan-scope-ok-dest.txt");
    let _ = fs::remove_file(&destination);
    fs::write(&source, "payload").unwrap();

    let result = mv(
        app.handle().clone(),
        vec![
            "file://jan-scope-ok-source.txt".to_string(),
            "file://jan-scope-ok-dest.txt".to_string(),
        ],
    );

    assert!(result.is_ok(), "in-scope move should succeed: {result:?}");
    assert_eq!(fs::read_to_string(&destination).unwrap(), "payload");

    let _ = fs::remove_file(&source);
    let _ = fs::remove_file(&destination);
}

#[test]
fn write_file_sync_still_writes_within_the_data_folder() {
    let app = mock_app();
    let data = crate::core::app::commands::get_jan_data_folder_path(app.handle().clone());
    fs::create_dir_all(&data).unwrap();
    let target = data.join("jan-scope-ok-write.txt");
    let _ = fs::remove_file(&target);

    let result = write_file_sync(
        app.handle().clone(),
        vec![
            "file://jan-scope-ok-write.txt".to_string(),
            "hello".to_string(),
        ],
    );

    assert!(result.is_ok(), "in-scope write should succeed: {result:?}");
    assert_eq!(fs::read_to_string(&target).unwrap(), "hello");

    let _ = fs::remove_file(&target);
}
