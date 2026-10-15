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
fn save_gives_each_file_its_own_folder() {
    let app = mock_app();
    let encoded = base64::engine::general_purpose::STANDARD.encode(b"x");
    let a = save_attachment_file_blocking(app.handle().clone(), "a.txt".into(), encoded.clone()).unwrap();
    let b = save_attachment_file_blocking(app.handle().clone(), "a.txt".into(), encoded).unwrap();
    assert_ne!(a, b);
    for p in [a, b] {
        let _ = fs::remove_dir_all(PathBuf::from(p).parent().unwrap());
    }
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
fn save_rejects_an_oversized_payload_without_decoding_it() {
    let app = mock_app();
    let huge = "A".repeat(MAX_ATTACHMENT_BYTES / 3 * 4 + 16);
    let err = save_attachment_file_blocking(app.handle().clone(), "big.bin".to_string(), huge).unwrap_err();
    assert!(err.contains("too large"), "{err}");
}
