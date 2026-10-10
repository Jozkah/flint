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
    // Device names are not file names on Windows, with or without an extension.
    assert_eq!(clean_name("AUX"), "_AUX");
    assert_eq!(clean_name("lpt3.pdf"), "_lpt3.pdf");
    assert_eq!(clean_name("photo.jpg"), "photo.jpg");
    assert_eq!(clean_name("scan. "), "scan");
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
fn two_puts_at_the_same_offset_cannot_both_write() {
    let dir = tempfile::tempdir().unwrap();
    let now = Instant::now();
    let mut b = UploadBook::default();
    let u = b.start(dir.path(), "d1", "a.txt", 10, "text/plain", 25, now).unwrap();
    b.reserve_chunk("d1", &u.id, 0, 5).unwrap();
    assert_eq!(b.reserve_chunk("d1", &u.id, 0, 5), Err(UploadError::BadOffset(0)));
    // A failed write gives the claim back; a finished one moves the offset on.
    b.release_chunk(&u.id);
    b.reserve_chunk("d1", &u.id, 0, 5).unwrap();
    b.wrote(&u.id, 5, now);
    assert_eq!(b.reserve_chunk("d1", &u.id, 0, 5), Err(UploadError::BadOffset(5)));
    b.reserve_chunk("d1", &u.id, 5, 5).unwrap();
}

#[test]
fn expired_uploads_lose_their_folder_and_a_sweep_clears_orphans() {
    let dir = tempfile::tempdir().unwrap();
    let now = Instant::now();
    let mut b = UploadBook::default();
    let old = b.start(dir.path(), "d1", "a.txt", 3, "text/plain", 25, now).unwrap();
    std::fs::create_dir_all(old.path.parent().unwrap()).unwrap();
    std::fs::write(&old.path, b"abc").unwrap();
    // The next start, long after, prunes it and deletes the folder.
    let fresh = b.start(dir.path(), "d1", "b.txt", 3, "text/plain", 25, now + UPLOAD_TTL + Duration::from_secs(1)).unwrap();
    assert!(b.get("d1", &old.id).is_none());
    assert!(!old.path.parent().unwrap().exists());
    // A folder from a previous run, owned by no upload, is swept; a live one stays.
    let orphan = dir.path().join("deadbeef");
    std::fs::create_dir_all(&orphan).unwrap();
    std::fs::write(orphan.join("x.txt"), b"x").unwrap();
    std::fs::create_dir_all(fresh.path.parent().unwrap()).unwrap();
    b.sweep(dir.path());
    assert!(!orphan.exists());
    assert!(fresh.path.parent().unwrap().exists());
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

mod http {
    use std::sync::Arc;

    use super::super::auth::DeviceStore;
    use super::super::hub::*;

    struct NoWindow;
    impl Frontend for NoWindow {
        fn rpc(&self, _: &RpcRequestEvent) -> bool {
            false
        }
        fn pairing_request(&self, _: &PairingRequestEvent) {}
        fn devices_changed(&self) {}
    }

    #[tokio::test]
    async fn preview_needs_a_live_ticket_and_upload_needs_a_token() {
        let hub = Arc::new(RemoteHub::new(Default::default(), DeviceStore::in_memory(), Arc::new(NoWindow), None));
        let server = super::super::server::start(hub.clone(), "127.0.0.1:0".parse().unwrap(), None, Vec::new())
            .await
            .unwrap();
        let base = format!("http://127.0.0.1:{}", server.addr.port());
        let c = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
        // No ticket: nothing to proxy.
        let r = c.get(format!("{base}/remote/v1/preview/nope/")).send().await.unwrap();
        assert_eq!(r.status(), 404);
        // A sandboxed page's Origin: null is accepted only on preview paths.
        let r = c.post(format!("{base}/remote/v1/upload")).header("origin", "null").body("{}").send().await.unwrap();
        assert_eq!(r.status(), 403);
        let r = c.post(format!("{base}/remote/v1/upload")).body("{}").send().await.unwrap();
        assert_eq!(r.status(), 401);
        // An absolute path with a ticket in the Referer is sent under it.
        hub.set_preview(super::super::preview::PreviewTarget::new("s1", "http://127.0.0.1:9/"));
        let start = hub.start_pairing();
        let claim = hub.claim_pairing("127.0.0.1".parse().unwrap(), &start.code, "P").unwrap();
        let dev = hub.confirm_pairing(&claim.request_id, true).unwrap().unwrap();
        let (ticket, _) = hub.preview_ticket(&dev.id, "s1").unwrap();
        let r = c
            .get(format!("{base}/src/main.tsx?v=1"))
            .header("referer", format!("{base}/remote/v1/preview/{ticket}/"))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 307);
        assert_eq!(
            r.headers()["location"].to_str().unwrap(),
            format!("/remote/v1/preview/{ticket}/src/main.tsx?v=1")
        );
        assert!(r.headers()["content-security-policy"].to_str().unwrap().starts_with("sandbox"));
        // Nothing listens on :9, so the proxy says so rather than hanging.
        let r = c.get(format!("{base}/remote/v1/preview/{ticket}/")).header("origin", "null").send().await.unwrap();
        assert_eq!(r.status(), 502);
        hub.revoke(&dev.id);
        let r = c.get(format!("{base}/remote/v1/preview/{ticket}/")).send().await.unwrap();
        assert_eq!(r.status(), 404);
        server.stop();
    }
}
