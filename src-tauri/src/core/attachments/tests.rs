use super::commands::*;
use crate::core::app::commands::get_jan_data_folder_path;
use base64::Engine;
use std::fs;
use std::path::PathBuf;
use tauri::test::mock_app;

#[test]
fn file_name_keeps_only_the_file_name() {
    assert_eq!(attachment_file_name("report.pdf").unwrap(), "report.pdf");
    assert_eq!(attachment_file_name("../../etc/passwd").unwrap(), "passwd");
    assert_eq!(
        attachment_file_name(r"C:\Users\someone\notes.md").unwrap(),
        "notes.md"
    );
}

#[test]
fn file_name_rejects_names_without_a_file() {
    for raw in ["", "   ", ".", "..", "...", "dir/", r"dir\..", "x/ . "] {
        assert!(
            attachment_file_name(raw).is_err(),
            "{raw:?} should be rejected"
        );
    }
}

#[test]
fn file_name_replaces_characters_windows_forbids() {
    assert_eq!(attachment_file_name("a:b?c*.pdf").unwrap(), "a_b_c_.pdf");
    assert_eq!(
        attachment_file_name("tab\there.txt").unwrap(),
        "tab_here.txt"
    );
    // An NTFS alternate data stream name cannot survive the colon.
    assert_eq!(attachment_file_name("a.txt:stream").unwrap(), "a.txt_stream");
}

#[test]
fn file_name_avoids_windows_device_names_and_trailing_dots() {
    assert_eq!(attachment_file_name("CON.txt").unwrap(), "_CON.txt");
    assert_eq!(attachment_file_name("nul").unwrap(), "_nul");
    assert_eq!(attachment_file_name("report.pdf. .").unwrap(), "report.pdf");
}

#[test]
fn file_name_is_shortened_but_keeps_its_extension() {
    let long = format!("{}.pdf", "a".repeat(400));
    let name = attachment_file_name(&long).unwrap();
    assert!(name.chars().count() <= 150);
    assert!(name.ends_with(".pdf"));
}

#[test]
fn save_writes_inside_the_attachments_folder() {
    let app = mock_app();
    let bytes: &[u8] = b"%PDF-1.4\x00\xff binary";
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);

    let saved = save_attachment_file_blocking(
        app.handle().clone(),
        "../outside/report.pdf".to_string(),
        encoded,
    )
    .unwrap();

    let saved = PathBuf::from(saved);
    let attachments = get_jan_data_folder_path(app.handle().clone()).join(ATTACHMENTS_DIR);
    let rel = saved.strip_prefix(&attachments).unwrap_or_else(|_| {
        panic!("{saved:?} is outside {attachments:?}");
    });
    // <random id>/report.pdf, nothing deeper and no traversal components.
    assert_eq!(rel.components().count(), 2);
    assert_eq!(saved.file_name().unwrap(), "report.pdf");
    assert_eq!(fs::read(&saved).unwrap(), bytes);
    let _ = fs::remove_dir_all(saved.parent().unwrap());
}

#[test]
fn the_same_bytes_are_stored_once_and_different_bytes_apart() {
    let app = mock_app();
    let encode = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
    let tag = uuid::Uuid::new_v4().to_string();
    let a = save_attachment_file_blocking(app.handle().clone(), "a.txt".into(), encode(tag.as_bytes())).unwrap();
    let b = save_attachment_file_blocking(app.handle().clone(), "a.txt".into(), encode(tag.as_bytes())).unwrap();
    assert_eq!(a, b, "re-dropping the same file reuses the saved copy");
    let c = save_attachment_file_blocking(app.handle().clone(), "a.txt".into(), encode(b"other")).unwrap();
    assert_ne!(a, c);
    for p in [a, c] {
        let _ = fs::remove_dir_all(PathBuf::from(p).parent().unwrap());
    }
}

#[test]
fn a_raw_ten_megabyte_file_round_trips_and_leaves_no_part_file() {
    let dir = tempfile::tempdir().unwrap();
    let bytes: Vec<u8> = (0..10 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
    let saved = super::commands::store_attachment(dir.path(), "big.bin", &bytes, Some("thread-1")).unwrap();
    let saved = PathBuf::from(saved);
    assert_eq!(fs::read(&saved).unwrap(), bytes);
    assert!(saved.starts_with(dir.path().join("thread-1")));
    let names: Vec<String> = fs::read_dir(saved.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec!["big.bin".to_string()]);
}

#[test]
fn a_crashed_part_file_is_never_the_saved_attachment() {
    let dir = tempfile::tempdir().unwrap();
    let first = PathBuf::from(super::commands::store_attachment(dir.path(), "a.txt", b"hello", None).unwrap());
    // A truncated leftover from a crash, and the real file removed: the next
    // save writes a whole copy instead of trusting the leftover.
    let folder = first.parent().unwrap().to_path_buf();
    fs::write(folder.join("a.txt.deadbeef.part"), b"he").unwrap();
    fs::remove_file(&first).unwrap();
    let again = PathBuf::from(super::commands::store_attachment(dir.path(), "a.txt", b"hello", None).unwrap());
    assert_eq!(again, first);
    assert_eq!(fs::read(&again).unwrap(), b"hello");
}

#[test]
fn save_rejects_data_that_is_not_base64() {
    let app = mock_app();
    let result = save_attachment_file_blocking(
        app.handle().clone(),
        "report.pdf".to_string(),
        "not base64!".to_string(),
    );
    assert!(result.is_err());
}

#[test]
fn save_attachment_file_uses_thread_folder() {
    let app = mock_app();
    let encoded = base64::engine::general_purpose::STANDARD.encode(b"x");
    let saved = save_attachment_in(
        app.handle().clone(),
        "a.txt".into(),
        encoded,
        Some("thread-abc".into()),
    )
    .unwrap();
    let saved = PathBuf::from(saved);
    let attachments = get_jan_data_folder_path(app.handle().clone()).join(ATTACHMENTS_DIR);
    let rel = saved.strip_prefix(&attachments).unwrap();
    // <thread id>/<random id>/a.txt
    assert_eq!(rel.components().count(), 3);
    assert_eq!(rel.components().next().unwrap().as_os_str(), "thread-abc");
    let _ = fs::remove_dir_all(attachments.join("thread-abc"));
}

#[test]
fn save_rejects_a_traversal_thread_id() {
    let app = mock_app();
    let encoded = base64::engine::general_purpose::STANDARD.encode(b"x");
    for bad in ["..", "a/b", "a\\b", ""] {
        let r = save_attachment_in(app.handle().clone(), "a.txt".into(), encoded.clone(), Some(bad.into()));
        assert!(r.is_err(), "{bad:?}");
    }
}

#[test]
fn save_rejects_an_oversized_payload_without_decoding_it() {
    let app = mock_app();
    let huge = "A".repeat(MAX_ATTACHMENT_BYTES / 3 * 4 + 16);
    let err = save_attachment_file_blocking(app.handle().clone(), "big.bin".to_string(), huge).unwrap_err();
    assert!(err.contains("too large"), "{err}");
}
