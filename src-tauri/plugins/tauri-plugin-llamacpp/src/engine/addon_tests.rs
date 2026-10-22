use super::*;
use std::sync::atomic::AtomicBool;

const COMMIT: &str = "a5d22276be846d95958412e7042af20b0fc245f3";

fn signing_key(seed: u8) -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(&[seed; 32])
}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn pubkey_of(key: &ed25519_dalek::SigningKey) -> String {
    b64(key.verifying_key().as_bytes())
}

fn sign(key: &ed25519_dalek::SigningKey, bytes: &[u8]) -> String {
    use ed25519_dalek::Signer;
    b64(&key.sign(bytes).to_bytes())
}

fn expect(tag: Option<&'static str>) -> Expect<'static> {
    Expect { kind: "cuda13", platform: "win-x64", engine_commit: COMMIT, release_tag: tag }
}

fn manifest_for(files: &[(&str, &[u8])]) -> PackManifest {
    PackManifest {
        schema: 1,
        kind: "cuda13".into(),
        backend: "cuda".into(),
        release_tag: "v0.9.0".into(),
        platform: "win-x64".into(),
        engine_tag: "b11627".into(),
        engine_commit: COMMIT.into(),
        cuda_toolkit: Some("13.0".into()),
        min_driver: 580,
        min_compute: 75,
        files: files
            .iter()
            .map(|(n, b)| PackFile { name: n.to_string(), size: b.len() as u64, sha256: sha256_hex(b) })
            .collect(),
        archive: None,
    }
}

enum Entry<'a> {
    File(&'a str, &'a [u8]),
    Dir(&'a str),
    Symlink(&'a str, &'a str),
}

/// A pack zip: the signed manifest plus `entries`.
fn write_zip(path: &Path, manifest: &[u8], sig: &str, entries: &[Entry]) {
    let file = fs::File::create(path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file(MANIFEST_FILE, opts).unwrap();
    zip.write_all(manifest).unwrap();
    zip.start_file(SIGNATURE_FILE, opts).unwrap();
    zip.write_all(sig.as_bytes()).unwrap();
    for e in entries {
        match e {
            Entry::File(n, b) => {
                zip.start_file(*n, opts).unwrap();
                zip.write_all(b).unwrap();
            }
            Entry::Dir(n) => zip.add_directory(*n, opts).unwrap(),
            Entry::Symlink(n, t) => zip.add_symlink(*n, *t, opts).unwrap(),
        }
    }
    zip.finish().unwrap();
}

const DLL: &[u8] = b"pretend ggml-cuda module";
const RT: &[u8] = b"pretend cudart";

fn good_pack(dir: &Path, key: &ed25519_dalek::SigningKey) -> PathBuf {
    let m = manifest_for(&[("ggml-cuda.dll", DLL), ("cudart64_13.dll", RT)]);
    let bytes = serde_json::to_vec(&m).unwrap();
    let path = dir.join("pack.zip");
    write_zip(
        &path,
        &bytes,
        &sign(key, &bytes),
        &[Entry::File("ggml-cuda.dll", DLL), Entry::File("cudart64_13.dll", RT)],
    );
    path
}

// --- platform, tags, URLs ---------------------------------------------------

#[test]
fn platforms_with_a_pack() {
    assert_eq!(platform_for("windows", "x86_64"), Some("win-x64"));
    assert_eq!(platform_for("linux", "x86_64"), Some("linux-x64"));
    assert_eq!(platform_for("macos", "aarch64"), None);
    assert_eq!(platform_for("windows", "aarch64"), None);
    assert_eq!(platform_for("linux", "aarch64"), None);
}

#[test]
fn release_tags_are_validated() {
    for ok in ["v0.9.0", "nightly-20261017-12", "v1.0.0-beta.1"] {
        assert!(is_valid_tag(ok), "{ok}");
    }
    for bad in ["", "-v1", "../v1", "v1/../../x", "v1?x=1", "v 1", "v1#a", &"a".repeat(101)] {
        assert!(!is_valid_tag(bad), "{bad}");
    }
}

#[test]
fn the_asset_names_follow_the_release_tag() {
    assert_eq!(
        asset_stem("cuda13", "nightly-20261017-12", "linux-x64"),
        "flint-engine-cuda13-nightly-20261017-12-linux-x64"
    );
}

#[test]
fn the_base_url_is_this_repositorys_release() {
    if std::env::var_os("FLINT_ADDON_BASE_URL").is_some() {
        return;
    }
    assert_eq!(
        base_url("v0.9.0").unwrap(),
        "https://github.com/Jozkah/flint/releases/download/v0.9.0/"
    );
    assert!(matches!(base_url("../x"), Err(AddonError::BadUrl(_))));
}

#[test]
fn only_https_github_download_hosts_are_allowed() {
    for ok in [
        "https://github.com/Jozkah/flint/releases/download/v1/a.zip",
        "https://objects.githubusercontent.com/github-production-release-asset/1?x=y",
        "https://release-assets.githubusercontent.com/github-production-release-asset/1",
        "https://GITHUB.com:443/a",
    ] {
        assert!(url_allowed(ok, None), "{ok}");
    }
    for bad in [
        "http://github.com/a",
        "https://github.com.evil.example/a",
        "https://evil.example/github.com/a",
        "https://user@github.com/a",
        "https://github.com@evil.example/a",
        "ftp://github.com/a",
        "file:///C:/x.zip",
        "https://api.github.com/a",
        "github.com/a",
        "http://127.0.0.1:8000/a",
    ] {
        assert!(!url_allowed(bad, None), "{bad}");
    }
}

#[test]
fn a_debug_override_allows_only_its_own_origin() {
    let over = Some("http://127.0.0.1:8765");
    assert!(url_allowed("http://127.0.0.1:8765/pack.zip", over));
    assert!(!url_allowed("http://127.0.0.1:9999/pack.zip", over));
    assert!(!url_allowed("https://evil.example/pack.zip", over));
    assert!(url_allowed("https://github.com/x", over));
}

// --- eligibility ------------------------------------------------------------

#[test]
fn eligibility_table() {
    let base = HostFacts {
        platform: Some("win-x64"),
        nvidia_compute: vec![120],
        driver_branch: Some(617),
        bundled_cuda: false,
    };
    let cases: Vec<(&str, HostFacts, Eligibility)> = vec![
        ("RTX 5080, R617", base.clone(), Eligibility::Eligible),
        ("RTX 2060 (7.5), R580", HostFacts { nvidia_compute: vec![75], driver_branch: Some(580), ..base.clone() }, Eligibility::Eligible),
        ("driver R575", HostFacts { driver_branch: Some(575), ..base.clone() }, Eligibility::DriverTooOld),
        ("driver unknown", HostFacts { driver_branch: None, ..base.clone() }, Eligibility::DriverUnknown),
        ("GTX 1080 (6.1)", HostFacts { nvidia_compute: vec![61], ..base.clone() }, Eligibility::GpuTooOld),
        ("1080 + 4090", HostFacts { nvidia_compute: vec![61, 89], ..base.clone() }, Eligibility::Eligible),
        ("AMD / Intel / no GPU", HostFacts { nvidia_compute: vec![], ..base.clone() }, Eligibility::NoNvidia),
        ("macOS", HostFacts { platform: None, ..base.clone() }, Eligibility::UnsupportedPlatform),
        ("CUDA installer", HostFacts { bundled_cuda: true, ..base.clone() }, Eligibility::AlreadyBundled),
        ("old GPU on old driver", HostFacts { nvidia_compute: vec![52], driver_branch: Some(470), ..base.clone() }, Eligibility::GpuTooOld),
    ];
    for (name, facts, want) in cases {
        assert_eq!(eligibility(&facts, 580, 75), want, "{name}");
    }
}

#[test]
fn driver_and_compute_strings_parse() {
    assert_eq!(parse_driver_branch("617.12"), Some(617));
    assert_eq!(parse_driver_branch("580.95.05"), Some(580));
    assert_eq!(parse_driver_branch("garbage"), None);
    assert_eq!(parse_compute("12.0"), Some(120));
    assert_eq!(parse_compute("7.5"), Some(75));
    assert_eq!(parse_compute("8.9"), Some(89));
    assert_eq!(parse_compute("x"), None);
}

// --- manifest and signature -------------------------------------------------

#[test]
fn a_signed_matching_manifest_is_accepted() {
    let key = signing_key(1);
    let bytes = serde_json::to_vec(&manifest_for(&[("ggml-cuda.dll", DLL)])).unwrap();
    let m = verify_manifest(&bytes, &sign(&key, &bytes), Some(&pubkey_of(&key)), &expect(Some("v0.9.0"))).unwrap();
    assert_eq!(m.files.len(), 1);
}

#[test]
fn a_tampered_or_foreign_manifest_is_refused() {
    let key = signing_key(1);
    let bytes = serde_json::to_vec(&manifest_for(&[("ggml-cuda.dll", DLL)])).unwrap();
    let sig = sign(&key, &bytes);
    let mut tampered = bytes.clone();
    *tampered.last_mut().unwrap() = b' ';
    let pk = pubkey_of(&key);
    assert_eq!(verify_manifest(&tampered, &sig, Some(&pk), &expect(None)).unwrap_err(), AddonError::BadSignature);
    let other = pubkey_of(&signing_key(2));
    assert_eq!(verify_manifest(&bytes, &sig, Some(&other), &expect(None)).unwrap_err(), AddonError::BadSignature);
    assert_eq!(verify_manifest(&bytes, "not base64!", Some(&pk), &expect(None)).unwrap_err(), AddonError::BadSignature);
    assert_eq!(verify_manifest(&bytes, &sig, None, &expect(None)).unwrap_err(), AddonError::NoSigningKey);
}

#[test]
fn an_abi_platform_or_release_mismatch_is_refused() {
    let key = signing_key(1);
    let pk = pubkey_of(&key);
    let check = |m: PackManifest, exp: Expect| {
        let bytes = serde_json::to_vec(&m).unwrap();
        verify_manifest(&bytes, &sign(&key, &bytes), Some(&pk), &exp)
    };
    let mut other_engine = manifest_for(&[("ggml-cuda.dll", DLL)]);
    other_engine.engine_commit = "b29c606e28a01b1bc8c1351026a0fa6e616bf6c4".into();
    assert!(matches!(check(other_engine, expect(None)), Err(AddonError::Mismatch(_))));
    let mut linux = manifest_for(&[("ggml-cuda.dll", DLL)]);
    linux.platform = "linux-x64".into();
    assert!(matches!(check(linux, expect(None)), Err(AddonError::Mismatch(_))));
    let m = manifest_for(&[("ggml-cuda.dll", DLL)]);
    assert!(matches!(check(m.clone(), expect(Some("v0.9.1"))), Err(AddonError::Mismatch(_))));
    assert!(check(m, expect(None)).is_ok(), "a file install only pins the engine");
    let mut hip = manifest_for(&[("ggml-hip.dll", DLL)]);
    hip.kind = "hip6".into();
    assert!(matches!(check(hip, expect(None)), Err(AddonError::Mismatch(_))));
}

#[test]
fn unsafe_manifest_entries_are_refused() {
    let key = signing_key(1);
    let pk = pubkey_of(&key);
    for name in ["../evil.dll", "sub/x.dll", "C:\\x.dll", "/etc/passwd", ".hidden", "manifest.json", "a b.dll", ""] {
        let mut m = manifest_for(&[("ggml-cuda.dll", DLL)]);
        m.files[0].name = name.into();
        let bytes = serde_json::to_vec(&m).unwrap();
        let r = verify_manifest(&bytes, &sign(&key, &bytes), Some(&pk), &expect(None));
        assert!(matches!(r, Err(AddonError::BadManifest(_))), "{name:?}: {r:?}");
    }
    let mut dup = manifest_for(&[("a.dll", DLL), ("A.dll", DLL)]);
    dup.files[1].sha256 = dup.files[0].sha256.clone();
    let bytes = serde_json::to_vec(&dup).unwrap();
    assert!(matches!(verify_manifest(&bytes, &sign(&key, &bytes), Some(&pk), &expect(None)), Err(AddonError::BadManifest(_))));
    let mut huge = manifest_for(&[("a.dll", DLL)]);
    huge.files[0].size = 5 << 30;
    let bytes = serde_json::to_vec(&huge).unwrap();
    assert!(matches!(verify_manifest(&bytes, &sign(&key, &bytes), Some(&pk), &expect(None)), Err(AddonError::BadManifest(_))));
    let mut schema = manifest_for(&[("a.dll", DLL)]);
    schema.schema = 2;
    let bytes = serde_json::to_vec(&schema).unwrap();
    assert!(matches!(verify_manifest(&bytes, &sign(&key, &bytes), Some(&pk), &expect(None)), Err(AddonError::BadManifest(_))));
}

// --- extraction -------------------------------------------------------------

#[test]
fn a_good_pack_installs_atomically() {
    let tmp = tempfile::tempdir().unwrap();
    let key = signing_key(1);
    let pk = pubkey_of(&key);
    let zip = good_pack(tmp.path(), &key);
    let root = tmp.path().join("engine-addons");
    let (dir, m) = install_pack(&root, &zip, Some(&pk), &expect(None)).unwrap();
    assert_eq!(dir, root.join("cuda13-v0.9.0"));
    assert_eq!(fs::read(dir.join("ggml-cuda.dll")).unwrap(), DLL);
    assert_eq!(m.files.len(), 2);
    // Verifies from disk, signature included, and rehashes clean.
    let again = read_installed(&dir, Some(&pk), &expect(None)).unwrap();
    rehash(&dir, &again).unwrap();
    assert_eq!(active_addon(&root, Some(&pk), &expect(None)), Some(dir.clone()));
    // Nothing else left in the root.
    let names: Vec<_> = fs::read_dir(&root).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names.len(), 1, "{names:?}");
}

fn assert_refused_cleanly(entries: &[Entry], files: &[(&str, &[u8])], want: fn(&AddonError) -> bool) {
    let tmp = tempfile::tempdir().unwrap();
    let key = signing_key(1);
    let pk = pubkey_of(&key);
    let bytes = serde_json::to_vec(&manifest_for(files)).unwrap();
    let zip = tmp.path().join("bad.zip");
    write_zip(&zip, &bytes, &sign(&key, &bytes), entries);
    let root = tmp.path().join("root").join("engine-addons");
    let err = install_pack(&root, &zip, Some(&pk), &expect(None)).unwrap_err();
    assert!(want(&err), "{err:?}");
    let left: Vec<_> = fs::read_dir(&root).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert!(left.is_empty(), "staging left behind: {left:?}");
    assert!(!tmp.path().join("evil.dll").exists());
    assert!(!tmp.path().join("root").join("evil.dll").exists());
}

#[test]
fn zip_slip_entries_are_refused() {
    assert_refused_cleanly(
        &[Entry::File("ggml-cuda.dll", DLL), Entry::File("../evil.dll", DLL)],
        &[("ggml-cuda.dll", DLL)],
        |e| matches!(e, AddonError::UnsafeArchive(_)),
    );
    assert_refused_cleanly(
        &[Entry::File("../../evil.dll", DLL)],
        &[("ggml-cuda.dll", DLL)],
        |e| matches!(e, AddonError::UnsafeArchive(_)),
    );
}

#[test]
fn absolute_paths_and_directories_are_refused() {
    assert_refused_cleanly(
        &[Entry::File("/tmp/evil.dll", DLL)],
        &[("ggml-cuda.dll", DLL)],
        |e| matches!(e, AddonError::UnsafeArchive(_)),
    );
    assert_refused_cleanly(
        &[Entry::File("C:/evil.dll", DLL)],
        &[("ggml-cuda.dll", DLL)],
        |e| matches!(e, AddonError::UnsafeArchive(_)),
    );
    assert_refused_cleanly(
        &[Entry::Dir("sub"), Entry::File("ggml-cuda.dll", DLL)],
        &[("ggml-cuda.dll", DLL)],
        |e| matches!(e, AddonError::UnsafeArchive(_)),
    );
}

#[test]
fn symlinks_are_refused_even_under_a_listed_name() {
    assert_refused_cleanly(
        &[Entry::Symlink("ggml-cuda.dll", "C:/Windows/System32/kernel32.dll")],
        &[("ggml-cuda.dll", DLL)],
        |e| matches!(e, AddonError::UnsafeArchive(_)),
    );
}

#[test]
fn an_entry_larger_than_declared_is_refused() {
    let big = vec![0u8; 1 << 20];
    assert_refused_cleanly(
        &[Entry::File("ggml-cuda.dll", &big)],
        &[("ggml-cuda.dll", DLL)],
        |e| matches!(e, AddonError::UnsafeArchive(_)),
    );
}

#[test]
fn a_hash_mismatch_or_missing_file_is_refused() {
    let evil = b"pretend ggml-cuda modulX";
    assert_eq!(evil.len(), DLL.len());
    assert_refused_cleanly(
        &[Entry::File("ggml-cuda.dll", evil)],
        &[("ggml-cuda.dll", DLL)],
        |e| matches!(e, AddonError::Corrupt(_)),
    );
    assert_refused_cleanly(
        &[Entry::File("ggml-cuda.dll", DLL)],
        &[("ggml-cuda.dll", DLL), ("cudart64_13.dll", RT)],
        |e| matches!(e, AddonError::Corrupt(_)),
    );
}

#[test]
fn a_flipped_byte_inside_the_zip_is_corrupt_not_an_io_error() {
    let tmp = tempfile::tempdir().unwrap();
    let key = signing_key(1);
    let pk = pubkey_of(&key);
    let big: Vec<u8> = (0..300_000u32).map(|i| (i % 7) as u8).collect();
    let bytes = serde_json::to_vec(&manifest_for(&[("ggml-cuda.dll", &big)])).unwrap();
    let zip = tmp.path().join("p.zip");
    write_zip(&zip, &bytes, &sign(&key, &bytes), &[Entry::File("ggml-cuda.dll", &big)]);
    let mut raw = fs::read(&zip).unwrap();
    let at = raw.len() / 2;
    raw[at] ^= 0xff;
    fs::write(&zip, raw).unwrap();
    let err = install_pack(&tmp.path().join("root"), &zip, Some(&pk), &expect(None)).unwrap_err();
    assert!(matches!(err, AddonError::Corrupt(_)), "{err:?}");
}

#[test]
fn an_unsigned_or_unrelated_zip_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let pk = pubkey_of(&signing_key(1));
    let zip = good_pack(tmp.path(), &signing_key(9));
    let root = tmp.path().join("engine-addons");
    assert_eq!(install_pack(&root, &zip, Some(&pk), &expect(None)).unwrap_err(), AddonError::BadSignature);
    let junk = tmp.path().join("junk.zip");
    fs::write(&junk, b"not a zip").unwrap();
    assert!(matches!(install_pack(&root, &junk, Some(&pk), &expect(None)), Err(AddonError::UnsafeArchive(_))));
}

#[test]
fn a_failed_update_keeps_the_working_add_on() {
    let tmp = tempfile::tempdir().unwrap();
    let key = signing_key(1);
    let pk = pubkey_of(&key);
    let root = tmp.path().join("engine-addons");
    let (dir, _) = install_pack(&root, &good_pack(tmp.path(), &key), Some(&pk), &expect(None)).unwrap();
    let bytes = serde_json::to_vec(&manifest_for(&[("ggml-cuda.dll", DLL)])).unwrap();
    let bad = tmp.path().join("bad.zip");
    write_zip(&bad, &bytes, &sign(&key, &bytes), &[Entry::File("ggml-cuda.dll", b"short")]);
    assert!(install_pack(&root, &bad, Some(&pk), &expect(None)).is_err());
    assert_eq!(fs::read(dir.join("ggml-cuda.dll")).unwrap(), DLL);
    assert_eq!(active_addon(&root, Some(&pk), &expect(None)), Some(dir));
}

#[test]
fn a_new_release_replaces_the_old_one() {
    let tmp = tempfile::tempdir().unwrap();
    let key = signing_key(1);
    let pk = pubkey_of(&key);
    let root = tmp.path().join("engine-addons");
    let (old, _) = install_pack(&root, &good_pack(tmp.path(), &key), Some(&pk), &expect(None)).unwrap();
    let mut m = manifest_for(&[("ggml-cuda.dll", DLL)]);
    m.release_tag = "v0.9.1".into();
    let bytes = serde_json::to_vec(&m).unwrap();
    let zip = tmp.path().join("new.zip");
    write_zip(&zip, &bytes, &sign(&key, &bytes), &[Entry::File("ggml-cuda.dll", DLL)]);
    let (new, _) = install_pack(&root, &zip, Some(&pk), &expect(None)).unwrap();
    assert_eq!(new, root.join("cuda13-v0.9.1"));
    assert!(!old.exists());
    // Reinstalling the same release swaps it in place.
    let (again, _) = install_pack(&root, &zip, Some(&pk), &expect(None)).unwrap();
    assert_eq!(again, new);
    assert_eq!(list_dirs(&root, "cuda13"), vec![new]);
}

#[test]
fn a_damaged_install_is_skipped_so_the_engine_stays_on_vulkan() {
    let tmp = tempfile::tempdir().unwrap();
    let key = signing_key(1);
    let pk = pubkey_of(&key);
    let root = tmp.path().join("engine-addons");
    let (dir, m) = install_pack(&root, &good_pack(tmp.path(), &key), Some(&pk), &expect(None)).unwrap();
    fs::remove_file(dir.join("cudart64_13.dll")).unwrap();
    assert!(matches!(read_installed(&dir, Some(&pk), &expect(None)), Err(AddonError::Corrupt(_))));
    assert_eq!(active_addon(&root, Some(&pk), &expect(None)), None);
    // Same size, other bytes: only a rehash notices.
    fs::write(dir.join("cudart64_13.dll"), b"pretend cudarX").unwrap();
    assert!(read_installed(&dir, Some(&pk), &expect(None)).is_ok());
    assert!(matches!(rehash(&dir, &m), Err(AddonError::Corrupt(_))));
    // An install for another engine build is never loaded.
    let other = Expect { engine_commit: "0000000000000000000000000000000000000000", ..expect(None) };
    assert_eq!(active_addon(&root, Some(&pk), &other), None);
}

#[test]
fn leftovers_of_an_interrupted_install_are_swept() {
    let tmp = tempfile::tempdir().unwrap();
    fs::create_dir_all(tmp.path().join(".staging-1/x")).unwrap();
    fs::create_dir_all(tmp.path().join(".old-2")).unwrap();
    fs::create_dir_all(tmp.path().join("cuda13-v1")).unwrap();
    sweep_leftovers(tmp.path());
    assert!(!tmp.path().join(".staging-1").exists());
    assert!(!tmp.path().join(".old-2").exists());
    assert!(tmp.path().join("cuda13-v1").exists());
    remove_all(tmp.path(), "cuda13").unwrap();
    assert!(list_dirs(tmp.path(), "cuda13").is_empty());
}

#[test]
fn space_needed_counts_what_is_left_and_the_extracted_files() {
    assert_eq!(space_needed(100 << 20, 40 << 20, 200 << 20), (60 << 20) + (200 << 20) + (64 << 20));
    assert_eq!(space_needed(10, 20, 0), 64 << 20);
}

// --- download ---------------------------------------------------------------

/// A one-file HTTP server that honours `Range: bytes=N-`, and can cut the
/// first response short to simulate a dropped connection.
async fn serve(body: Vec<u8>, cut_first_at: Option<usize>) -> (String, tokio::task::JoinHandle<()>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        let mut first = true;
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { return };
            let mut buf = vec![0u8; 4096];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).to_lowercase();
            let start = req
                .lines()
                .find_map(|l| l.strip_prefix("range: bytes="))
                .and_then(|r| r.trim_end_matches('-').trim().trim_end_matches('-').parse::<usize>().ok())
                .unwrap_or(0);
            let slice = &body[start.min(body.len())..];
            let status = if start > 0 { "206 Partial Content" } else { "200 OK" };
            let head = format!(
                "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                slice.len()
            );
            let _ = sock.write_all(head.as_bytes()).await;
            let send = match (first, cut_first_at) {
                (true, Some(cut)) => &slice[..cut],
                _ => slice,
            };
            first = false;
            let _ = sock.write_all(send).await;
            let _ = sock.shutdown().await;
        }
    });
    (format!("http://{addr}"), handle)
}

#[tokio::test]
async fn an_interrupted_download_resumes_where_it_stopped() {
    let body: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    let (base, server) = serve(body.clone(), Some(70_000)).await;
    let tmp = tempfile::tempdir().unwrap();
    let part = tmp.path().join("p.part");
    let client = reqwest::Client::new();
    let cancel = AtomicBool::new(false);
    let url = format!("{base}/pack.zip");
    let first = download_resumable_to(&client, &url, Some(&base), &part, body.len() as u64, &cancel, &|_| {}).await;
    assert!(first.is_err(), "the first response was cut short");
    let have = fs::metadata(&part).unwrap().len();
    assert!(have > 0 && have < body.len() as u64, "{have}");
    download_resumable_to(&client, &url, Some(&base), &part, body.len() as u64, &cancel, &|_| {})
        .await
        .unwrap();
    assert_eq!(fs::read(&part).unwrap(), body);
    server.abort();
}

#[tokio::test]
async fn downloads_stop_on_cancel_and_refuse_other_hosts() {
    let body = vec![7u8; 4 << 20];
    let (base, server) = serve(body.clone(), None).await;
    let tmp = tempfile::tempdir().unwrap();
    let part = tmp.path().join("p.part");
    let client = reqwest::Client::new();
    let cancel = AtomicBool::new(true);
    let url = format!("{base}/pack.zip");
    let r = download_resumable_to(&client, &url, Some(&base), &part, body.len() as u64, &cancel, &|_| {}).await;
    assert_eq!(r.unwrap_err(), AddonError::Cancelled);
    let r = download_resumable_to(&client, &url, None, &part, body.len() as u64, &AtomicBool::new(false), &|_| {}).await;
    assert!(matches!(r, Err(AddonError::BadUrl(_))));
    // A body longer than the signed size is not kept.
    let r = download_resumable_to(&client, &url, Some(&base), &tmp.path().join("q"), 10, &AtomicBool::new(false), &|_| {}).await;
    assert!(matches!(r, Err(AddonError::Corrupt(_))));
    server.abort();
}
