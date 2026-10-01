//! Phone uploads and the live-preview proxy's rules.

use std::time::{Duration, Instant};

use super::preview::*;
use super::uploads::*;

#[test]
fn names_are_cleaned() {
    assert_eq!(clean_name("../../etc/passwd"), "passwd");
    assert_eq!(clean_name("C:\\x\\a.txt"), "a.txt");
    assert_eq!(clean_name(".bashrc"), "bashrc");
    assert_eq!(clean_name("a<b>.png"), "ab.png");
    assert_eq!(clean_name(""), "upload");
}

#[test]
fn bytes_decide_the_type() {
    assert_eq!(decide_mime("image/png", "a.png", b"\x89PNG\r\n\x1a\n....").unwrap(), "image/png");
    assert_eq!(decide_mime("image/jpeg", "a.jpg", &[0xFF, 0xD8, 0xFF, 0xE0]).unwrap(), "image/jpeg");
    assert!(decide_mime("image/png", "a.png", b"hello world").is_err());
    assert!(decide_mime("image/png", "a.png", b"%PDF-1.7").is_err());
    assert_eq!(decide_mime("application/pdf", "a.pdf", b"%PDF-1.7").unwrap(), "application/pdf");
    assert!(decide_mime("application/octet-stream", "x.exe", b"MZ\x90\x00").is_err());
    assert!(decide_mime("text/plain", "a.txt", b"\x7fELF").is_err());
    assert!(decide_mime("application/zip", "a.zip", b"PK\x03\x04").is_err());
    assert!(decide_mime("", "a.docx", b"PK\x03\x04").is_ok());
    assert_eq!(decide_mime("", "notes.md", b"# hi").unwrap(), "text/plain");
    assert_eq!(decide_mime("text/markdown", "notes.md", "caf\u{e9}".as_bytes()).unwrap(), "text/markdown");
    assert!(decide_mime("", "blob.bin", &[0, 1, 2, 3, 0xFE]).is_err());
}

#[test]
fn uploads_are_sized_ordered_and_owned() {
    let dir = tempfile::tempdir().unwrap();
    let now = Instant::now();
    let mut b = UploadBook::default();
    assert_eq!(b.start(dir.path(), "d1", "a.png", 26 * 1024 * 1024, "image/png", 25, now), Err(UploadError::TooLarge(25)));
    assert_eq!(b.start(dir.path(), "d1", "a.png", 0, "image/png", 25, now), Err(UploadError::Empty));
    let u = b.start(dir.path(), "d1", "../a.png", 10, "image/png", 25, now).unwrap();
    assert!(u.path.starts_with(dir.path()));
    assert_eq!(u.name, "a.png");
    // Another device cannot touch it.
    assert_eq!(b.check_chunk("d2", &u.id, 0, 4), Err(UploadError::NotFound));
    assert_eq!(b.check_chunk("d1", &u.id, 4, 4), Err(UploadError::BadOffset(0)));
    assert_eq!(b.check_chunk("d1", &u.id, 0, 11), Err(UploadError::Overflow));
    b.check_chunk("d1", &u.id, 0, 6).unwrap();
    b.wrote(&u.id, 6, now);
    assert_eq!(b.finish("d1", &u.id, b"\x89PNG\r\n\x1a\n"), Err(UploadError::Incomplete));
    b.wrote(&u.id, 4, now);
    let info = b.finish("d1", &u.id, b"\x89PNG\r\n\x1a\n").unwrap();
    assert_eq!(info.mime, "image/png");
    assert_eq!(b.finished("d1", &[u.id.clone()]).len(), 1);
    assert!(b.finished("d2", &[u.id.clone()]).is_empty());
    // A refused file is forgotten.
    let bad = b.start(dir.path(), "d1", "x.png", 2, "image/png", 25, now).unwrap();
    b.wrote(&bad.id, 2, now);
    assert!(matches!(b.finish("d1", &bad.id, b"MZ"), Err(UploadError::Rejected(_))));
    assert!(b.get("d1", &bad.id).is_none());
}

#[test]
fn too_many_pending_uploads_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let now = Instant::now();
    let mut b = UploadBook::default();
    for _ in 0..MAX_PENDING_PER_DEVICE {
        b.start(dir.path(), "d", "a.txt", 1, "text/plain", 25, now).unwrap();
    }
    assert_eq!(b.start(dir.path(), "d", "a.txt", 1, "text/plain", 25, now), Err(UploadError::TooMany));
    assert!(b.start(dir.path(), "other", "a.txt", 1, "text/plain", 25, now).is_ok());
}

#[test]
fn preview_only_reaches_local_origins() {
    assert_eq!(local_origin("http://localhost:5173/app?x=1").as_deref(), Some("http://localhost:5173"));
    assert_eq!(local_origin("http://127.0.0.1:3000/").as_deref(), Some("http://127.0.0.1:3000"));
    assert!(local_origin("http://192.168.1.4:3000/").is_none());
    assert!(local_origin("https://example.com/").is_none());
    assert!(local_origin("file:///etc/passwd").is_none());
    let t = PreviewTarget::new("s1", "http://localhost:5173/app?x=1").unwrap();
    assert_eq!(t.start, "/app?x=1");
    assert_eq!(upstream_url("http://localhost:5173", "/src/main.tsx").as_deref(), Some("http://localhost:5173/src/main.tsx"));
    assert!(upstream_url("http://localhost:5173", "//evil.example/").is_none());
    assert!(upstream_url("http://localhost:5173", "@evil.example/").is_none());
    assert!(upstream_url("http://localhost:5173", "/\\evil.example").is_none());
}

#[test]
fn preview_paths_cookies_and_redirects() {
    assert_eq!(split_preview_path("/preview/abc_D-1/src/x.js"), Some(("abc_D-1", "/src/x.js".to_string())));
    assert_eq!(split_preview_path("/preview/abc"), Some(("abc", "/".to_string())));
    assert!(split_preview_path("/preview/a.b/x").is_none());
    assert_eq!(ticket_from_cookie("a=1; flint_pv=tk; b=2"), Some("tk"));
    assert_eq!(rewrite_location("http://localhost:5173", "http://localhost:5173/login", "tk").as_deref(), Some("/remote/v1/preview/tk/login"));
    assert!(rewrite_location("http://localhost:5173", "https://evil.example/", "tk").is_none());
}

#[test]
fn tickets_expire_and_go_with_the_device() {
    let now = Instant::now();
    let mut b = TicketBook::default();
    let t = b.issue("d1", "s1", now);
    assert_eq!(b.check(&t, now), Some(("d1".into(), "s1".into())));
    assert!(b.check(&t, now + TICKET_TTL + Duration::from_secs(1)).is_none());
    b.revoke_device("d1");
    assert!(b.check(&t, now).is_none());
}
