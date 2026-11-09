//! Installing the image engine.
//!
//! `sd-server` is not part of the installer: the Vulkan build alone is 30 MB and
//! the CUDA build with its runtime close to 900 MB. It is downloaded once from
//! the pinned release, checked against the checksum the release publishes,
//! unpacked, and started once to see that it runs, before it is trusted.

use super::catalog::{self, Backend, EngineAsset};
use super::installation::unzip;
pub use super::installation::configure_library_path;
use crate::core::app::commands::get_jan_data_folder_path;
use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::{Emitter, Runtime};
use tokio::io::AsyncWriteExt;

pub const SERVER_EXE: &str = if cfg!(windows) { "sd-server.exe" } else { "sd-server" };

/// Native engine availability is determined by the pinned platform catalog.
pub fn platform_supported() -> bool {
    !catalog::available_backends().is_empty()
}

pub fn diffusion_root<R: Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    get_jan_data_folder_path(app.clone()).join("diffusion")
}

pub fn engine_dir<R: Runtime>(app: &tauri::AppHandle<R>, backend: Backend) -> PathBuf {
    diffusion_root(app)
        .join("backends")
        .join(catalog::ENGINE_TAG)
        .join(backend.id())
}

/// Where the engine runs, if one is installed: the first backend that has it.
pub fn installed_backend<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<Backend> {
    [Backend::Cuda12, Backend::Vulkan, Backend::Cpu].into_iter()
        .filter(|b| catalog::available_backends().contains(b))
        .find(|b| engine_dir(app, *b).join(SERVER_EXE).is_file() && engine_dir(app, *b).join("install.json").is_file())
}

#[derive(Debug, Clone, Serialize)]
pub struct InstallProgress {
    pub stage: &'static str,
    pub downloaded: u64,
    pub total: u64,
}

fn emit<R: Runtime>(app: &tauri::AppHandle<R>, stage: &'static str, downloaded: u64, total: u64) {
    let _ = app.emit(
        "diffusion-install-progress",
        InstallProgress { stage, downloaded, total },
    );
}

/// Where a download is kept until it is whole and checked: beside `dest`, with
/// `.part` added. A failed attempt leaves it so the next one resumes from it.
fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".part");
    dest.with_file_name(name)
}

/// SHA-256 of the first `len` bytes already in `path`, read from disk so what
/// is hashed is exactly what is kept.
async fn hash_prefix(path: &Path, len: u64) -> std::io::Result<Sha256> {
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    let mut left = len;
    while left > 0 {
        let want = buf.len().min(left as usize);
        let n = file.read(&mut buf[..want]).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        left -= n as u64;
    }
    Ok(hasher)
}

/// Download `asset` to `dest`, checking size and SHA-256 as it arrives.
async fn download_asset<R: Runtime>(
    app: &tauri::AppHandle<R>,
    asset: &EngineAsset,
    dest: &Path,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .user_agent("Flint/diffusion-engine")
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Could not create the download client: {e}"))?;
    let mut throttle = crate::core::huggingface::ProgressThrottle::new();
    fetch_verified(
        &client,
        &catalog::engine_url(asset),
        asset.size,
        asset.sha256,
        dest,
        |downloaded| {
            if throttle.should_emit(std::time::Instant::now(), downloaded, Some(asset.size)) {
                emit(app, "download", downloaded, asset.size);
            }
        },
    )
    .await?;
    // The last chunks may have been throttled away; end on the true count.
    emit(app, "download", asset.size, asset.size);
    Ok(())
}

/// Fetch `url` into `dest` and check it is `size` bytes with SHA-256 `sha256`.
///
/// The bytes go to `dest.part`. When an attempt is cut short (a stall, a
/// dropped connection) the partial file stays and the next call asks the server
/// for the rest with a `Range` header, so a ~900 MB engine is not fetched again
/// from zero. A server that ignores the range sends the whole body, and the
/// download starts over. A finished file that fails its checks is deleted, since
/// resuming from it could only reproduce the same bytes.
async fn fetch_verified(
    client: &reqwest::Client,
    url: &str,
    size: u64,
    sha256: &str,
    dest: &Path,
    mut progress: impl FnMut(u64),
) -> Result<(), String> {
    let part = part_path(dest);
    let mut have = match tokio::fs::metadata(&part).await {
        Ok(m) if m.len() <= size => m.len(),
        Ok(_) => {
            // Longer than the whole file: not a prefix of it.
            let _ = tokio::fs::remove_file(&part).await;
            0
        }
        Err(_) => 0,
    };
    let mut hasher = Sha256::new();
    if have > 0 {
        hasher = hash_prefix(&part, have)
            .await
            .map_err(|e| format!("Could not read the earlier part of the download: {e}"))?;
    }

    if have < size {
        let mut request = client.get(url);
        if have > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={have}-"));
        }
        let response = request
            .send()
            .await
            .map_err(|e| format!("Could not download the image engine: {e}"))?;
        let status = response.status();
        if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
            let _ = tokio::fs::remove_file(&part).await;
            return Err("The earlier part of the download no longer fits; it was discarded, so try again.".to_string());
        }
        if !status.is_success() {
            return Err(format!("The image engine download answered {status}."));
        }
        let resumed = have > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT;
        let mut file = if resumed {
            tokio::fs::OpenOptions::new().append(true).open(&part).await
        } else {
            // A full body: whatever was kept is replaced.
            have = 0;
            hasher = Sha256::new();
            tokio::fs::File::create(&part).await
        }
        .map_err(|e| format!("Could not create the download file: {e}"))?;

        let mut downloaded = have;
        let mut stream = response.bytes_stream();
        let received: Result<(), String> = async {
            while let Some(chunk) =
                tokio::time::timeout(std::time::Duration::from_secs(60), stream.next())
                    .await
                    .map_err(|_| "The image engine download stalled.".to_string())?
            {
                let chunk =
                    chunk.map_err(|e| format!("The image engine download was interrupted: {e}"))?;
                hasher.update(&chunk);
                file.write_all(&chunk)
                    .await
                    .map_err(|e| format!("Could not write the image engine: {e}"))?;
                downloaded += chunk.len() as u64;
                progress(downloaded);
            }
            Ok(())
        }
        .await;
        // Flushed either way: what reached the disk is what a resume builds on.
        let flushed = file.flush().await.map_err(|e| e.to_string());
        received?;
        flushed?;
        have = downloaded;
    }

    if have != size {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(format!(
            "The image engine download is {have} bytes, expected {size}."
        ));
    }
    let actual = format!("{:x}", hasher.finalize());
    if !actual.eq_ignore_ascii_case(sha256) {
        let _ = tokio::fs::remove_file(&part).await;
        return Err("The image engine download failed its checksum.".to_string());
    }
    tokio::fs::rename(&part, dest)
        .await
        .map_err(|e| format!("Could not finish the download file: {e}"))
}

/// Whether the engine's `--help` output says it is the engine.
pub fn looks_like_engine(help: &str) -> bool {
    let lower = help.to_ascii_lowercase();
    lower.contains("stable-diffusion.cpp") || lower.contains("--cfg-scale")
}

/// Start the engine once and read its help. Antivirus often holds a freshly
/// unpacked program for a few seconds, so a failed start is retried.
async fn probe(dir: &Path) -> Result<(), String> {
    let exe = dir.join(SERVER_EXE);
    if !exe.is_file() {
        return Err(format!("The archive did not contain {SERVER_EXE}."));
    }
    let mut last = String::new();
    for attempt in 0..3 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        let mut command = tokio::process::Command::new(&exe);
        command.arg("--help").current_dir(dir).kill_on_drop(true);
        configure_library_path(&mut command, dir);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        match tokio::time::timeout(std::time::Duration::from_secs(120), command.output()).await {
            Ok(Ok(output)) => {
                let text = format!(
                    "{}{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
                if looks_like_engine(&text) {
                    return Ok(());
                }
                last = "It started but did not look like the image engine.".to_string();
            }
            Ok(Err(e)) => last = format!("It would not start: {e}"),
            Err(_) => last = "It did not answer within two minutes.".to_string(),
        }
    }
    Err(format!("The image engine did not pass its start-up check. {last}"))
}

/// Download, check, unpack and test the engine for `backend`.
pub async fn install<R: Runtime>(app: &tauri::AppHandle<R>, backend: Backend) -> Result<PathBuf, String> {
    if !platform_supported() {
        return Err("Local image generation needs Windows x64 or Linux x64.".to_string());
    }
    if !catalog::available_backends().contains(&backend) { return Err("This engine backend is not available on this platform.".into()); }
    // One install at a time: two would unpack into, and delete, the same folders.
    let _installing = INSTALL_LOCK
        .try_lock()
        .map_err(|_| "An engine install is already running.".to_string())?;
    // A running engine holds its folder open (Windows cannot replace it), and
    // the new one is about to take its place.
    super::runtime::unload(app).await;
    let final_dir = engine_dir(app, backend);
    let staging = diffusion_root(app).join("downloads");
    tokio::fs::create_dir_all(&staging).await.map_err(|e| e.to_string())?;
    // The new engine is built next to the installed one and swapped in only
    // once it has passed its start-up check, so a failed install leaves the
    // working engine alone.
    clean_stale_staging(&final_dir);
    let dir = staging_path(&final_dir);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;

    let mut assets = vec![catalog::engine_asset(backend)];
    if cfg!(windows) && backend == Backend::Cuda12 {
        assets.push(catalog::cuda_runtime_asset());
    }
    let resumable: Vec<PathBuf> = assets.iter().map(|a| part_path(&staging.join(a.name))).collect();
    let dropped = clean_stale_parts(&staging, &resumable, PART_MAX_AGE);
    if dropped > 0 {
        log::info!("diffusion: deleted {dropped} partial engine download(s) no install will resume");
    }
    let result = async {
        for asset in &assets {
            let zip_path = staging.join(asset.name);
            // The archive is up to ~900 MB; it goes whether or not the
            // download, checksum or unpack succeeded.
            let step = async {
                download_asset(app, asset, &zip_path).await?;
                emit(app, "unpack", 0, 0);
                let (archive, target) = (zip_path.clone(), dir.clone());
                tokio::task::spawn_blocking(move || unzip(&archive, &target))
                    .await
                    .map_err(|e| format!("Unpacking stopped: {e}"))?
            }
            .await;
            let _ = tokio::fs::remove_file(&zip_path).await;
            step?;
        }
        emit(app, "check", 0, 0);
        probe(&dir).await?;
        let info = serde_json::json!({
            "tag": catalog::ENGINE_TAG,
            "backend": backend.id(),
            "installedAtMs": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        });
        tokio::fs::write(dir.join("install.json"), info.to_string())
            .await
            .map_err(|e| e.to_string())?;
        Ok::<_, String>(())
    }
    .await;
    if let Err(e) = result {
        let _ = tokio::fs::remove_dir_all(&dir).await;
        return Err(e);
    }
    let (new, old) = (dir.clone(), final_dir.clone());
    let swapped = tokio::task::spawn_blocking(move || swap_in(&old, &new))
        .await
        .map_err(|e| format!("Installing stopped: {e}"))?;
    if let Err(e) = swapped {
        let _ = tokio::fs::remove_dir_all(&dir).await;
        return Err(e);
    }
    // Installed: a partial download of another backend has nothing left to
    // finish for.
    clean_stale_parts(&staging, &[], std::time::Duration::ZERO);
    Ok(final_dir)
}

/// Only one install runs at a time.
static INSTALL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The sibling folder an install is built in before it replaces `dir`.
fn staging_path(dir: &Path) -> PathBuf {
    let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    dir.with_file_name(format!("{name}.staging-{}", std::process::id()))
}

/// How long a partial engine download is kept for a later attempt to resume.
const PART_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 3600);

/// Deletes partial downloads (`*.part`) in `downloads` that no attempt will
/// resume: any not named in `keep`, and any last written more than `max_age`
/// ago. A cancelled attempt at one backend followed by an install of another,
/// or an attempt nobody retried, otherwise left up to ~900 MB behind for good.
/// Returns how many were deleted.
fn clean_stale_parts(downloads: &Path, keep: &[PathBuf], max_age: std::time::Duration) -> usize {
    let Ok(entries) = std::fs::read_dir(downloads) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|x| x != "part") {
            continue;
        }
        let fresh = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age < max_age);
        if keep.contains(&path) && fresh {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Removes staging folders an interrupted install left beside `dir`.
fn clean_stale_staging(dir: &Path) {
    let (Some(parent), Some(name)) = (dir.parent(), dir.file_name()) else {
        return;
    };
    let prefix = format!("{}.staging-", name.to_string_lossy());
    if let Ok(entries) = std::fs::read_dir(parent) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(&prefix) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
}

/// Puts the finished `staging` folder in place of `dir`. Windows cannot rename
/// over an existing folder, so the old one is moved aside first and put back if
/// the second rename fails.
fn swap_in(dir: &Path, staging: &Path) -> Result<(), String> {
    let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let old = dir.with_file_name(format!("{name}.old"));
    let _ = std::fs::remove_dir_all(&old);
    let had_old = dir.exists();
    if had_old {
        std::fs::rename(dir, &old).map_err(|e| format!("Could not move the old engine aside: {e}"))?;
    }
    if let Err(e) = std::fs::rename(staging, dir) {
        if had_old {
            let _ = std::fs::rename(&old, dir);
        }
        return Err(format!("Could not put the new engine in place: {e}"));
    }
    let _ = std::fs::remove_dir_all(&old);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn engine_folder(root: &Path, file: &str, text: &str) -> PathBuf {
        let dir = root.join("engine");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(file), text).unwrap();
        dir
    }

    #[test]
    fn swap_replaces_the_old_engine() {
        let root = tempfile::tempdir().unwrap();
        let dir = engine_folder(root.path(), "sd-server", "old");
        let staging = staging_path(&dir);
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("sd-server"), "new").unwrap();
        swap_in(&dir, &staging).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("sd-server")).unwrap(), "new");
        assert!(!staging.exists() && !root.path().join("engine.old").exists());
    }

    #[test]
    fn swap_restores_old_on_rename_failure() {
        let root = tempfile::tempdir().unwrap();
        let dir = engine_folder(root.path(), "sd-server", "old");
        // The staging folder is missing, so the second rename fails.
        let missing = root.path().join("engine.staging-none");
        assert!(swap_in(&dir, &missing).is_err());
        assert_eq!(std::fs::read_to_string(dir.join("sd-server")).unwrap(), "old");
        assert!(!root.path().join("engine.old").exists());
    }

    #[test]
    fn stale_staging_cleaned() {
        let root = tempfile::tempdir().unwrap();
        let dir = engine_folder(root.path(), "sd-server", "old");
        let stale = root.path().join("engine.staging-99999");
        std::fs::create_dir_all(stale.join("x")).unwrap();
        let other = root.path().join("engines-else");
        std::fs::create_dir_all(&other).unwrap();
        clean_stale_staging(&dir);
        assert!(!stale.exists());
        assert!(other.exists() && dir.exists());
    }

    #[test]
    fn concurrent_install_second_rejected() {
        let first = INSTALL_LOCK.try_lock().expect("free to start");
        assert!(INSTALL_LOCK.try_lock().is_err(), "a second install must be refused");
        drop(first);
        assert!(INSTALL_LOCK.try_lock().is_ok());
    }

    /// A one-shot HTTP server for `body`. The first request is cut short after
    /// `cut_first_at` bytes when set; `honour_range` decides whether a `Range`
    /// request is answered with the rest or with the whole body. Returns the
    /// url and the `Range` header of every request seen.
    async fn serve(
        body: Vec<u8>,
        cut_first_at: Option<usize>,
        honour_range: bool,
        requests: usize,
    ) -> (String, std::sync::Arc<std::sync::Mutex<Vec<Option<String>>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/engine.zip", listener.local_addr().unwrap());
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            for n in 0..requests {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buf = vec![0u8; 8192];
                let read = socket.read(&mut buf).await.unwrap();
                let head = String::from_utf8_lossy(&buf[..read]).to_string();
                let range = head
                    .lines()
                    .find_map(|l| l.to_ascii_lowercase().strip_prefix("range: bytes=").map(str::to_string))
                    .map(|r| r.trim_end_matches('-').to_string());
                log.lock().unwrap().push(range.clone());
                let (status, extra, start) = match (&range, honour_range) {
                    (Some(from), true) => {
                        let from: usize = from.parse().unwrap();
                        (
                            "206 Partial Content",
                            format!("Content-Range: bytes {from}-{}/{}\r\n", body.len() - 1, body.len()),
                            from,
                        )
                    }
                    _ => ("200 OK", String::new(), 0),
                };
                let payload = &body[start..];
                let head = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n",
                    payload.len()
                );
                socket.write_all(head.as_bytes()).await.unwrap();
                let send = match (n, cut_first_at) {
                    (0, Some(cut)) => &payload[..cut],
                    _ => payload,
                };
                socket.write_all(send).await.unwrap();
                socket.flush().await.unwrap();
                // Dropping the socket short of Content-Length is the cut.
            }
        });
        (url, seen)
    }

    fn sample(len: usize) -> (Vec<u8>, String) {
        let data: Vec<u8> = (0..len).map(|i| (i * 31 % 251) as u8).collect();
        let sum = format!("{:x}", Sha256::digest(&data));
        (data, sum)
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    #[tokio::test]
    async fn an_interrupted_download_resumes_from_the_part_file() {
        let (data, sum) = sample(300_000);
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("engine.zip");
        let (url, seen) = serve(data.clone(), Some(120_000), true, 2).await;

        let first = fetch_verified(&client(), &url, data.len() as u64, &sum, &dest, |_| {}).await;
        assert!(first.is_err(), "the first attempt was cut short");
        assert!(!dest.exists());
        let kept = std::fs::metadata(part_path(&dest)).unwrap().len();
        assert!(kept > 0 && kept < data.len() as u64, "partial bytes are kept: {kept}");

        fetch_verified(&client(), &url, data.len() as u64, &sum, &dest, |_| {})
            .await
            .expect("the second attempt finishes it");
        assert_eq!(std::fs::read(&dest).unwrap(), data);
        assert!(!part_path(&dest).exists(), "the part file is renamed into place");
        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen[0], None);
        assert_eq!(seen[1].as_deref(), Some(kept.to_string().as_str()), "asked only for the rest");
    }

    #[tokio::test]
    async fn a_server_that_ignores_the_range_restarts_the_download() {
        let (data, sum) = sample(200_000);
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("engine.zip");
        std::fs::write(part_path(&dest), &data[..50_000]).unwrap();
        let (url, _) = serve(data.clone(), None, false, 1).await;

        fetch_verified(&client(), &url, data.len() as u64, &sum, &dest, |_| {})
            .await
            .expect("a full body replaces the part");
        assert_eq!(std::fs::read(&dest).unwrap(), data);
    }

    #[tokio::test]
    async fn a_download_that_fails_its_checksum_leaves_nothing_to_resume() {
        let (data, _) = sample(100_000);
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("engine.zip");
        let (url, _) = serve(data.clone(), None, true, 1).await;

        let wrong = "0".repeat(64);
        let err = fetch_verified(&client(), &url, data.len() as u64, &wrong, &dest, |_| {})
            .await
            .unwrap_err();
        assert!(err.contains("checksum"), "{err}");
        assert!(!dest.exists() && !part_path(&dest).exists());
    }

    #[test]
    fn the_part_file_sits_beside_the_archive() {
        assert_eq!(
            part_path(Path::new("downloads/sd.zip")),
            PathBuf::from("downloads/sd.zip.part")
        );
    }

    /// Only a recent partial download of an archive this install fetches is
    /// kept to resume; other backends' parts, old parts and nothing else go.
    #[test]
    fn stale_partial_downloads_are_deleted_and_resumable_ones_kept() {
        let dir = tempfile::tempdir().unwrap();
        let mine = part_path(&dir.path().join("cuda.zip"));
        let other = part_path(&dir.path().join("vulkan.zip"));
        let old = part_path(&dir.path().join("cudart.zip"));
        let unrelated = dir.path().join("notes.txt");
        for p in [&mine, &other, &old, &unrelated] {
            std::fs::write(p, b"partial").unwrap();
        }
        let long_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(8 * 24 * 3600);
        std::fs::File::options().write(true).open(&old).unwrap().set_modified(long_ago).unwrap();

        let keep = [mine.clone(), old.clone()];
        assert_eq!(clean_stale_parts(dir.path(), &keep, PART_MAX_AGE), 2);
        assert!(mine.exists());
        assert!(!other.exists() && !old.exists());
        assert!(unrelated.exists());

        // After an install nothing is left to resume.
        assert_eq!(clean_stale_parts(dir.path(), &[], std::time::Duration::ZERO), 1);
        assert!(!mine.exists() && unrelated.exists());
        assert_eq!(clean_stale_parts(&dir.path().join("missing"), &[], PART_MAX_AGE), 0);
    }

    #[test]
    fn the_engine_is_recognised_by_its_help_text() {
        assert!(looks_like_engine("stable-diffusion.cpp version master-883"));
        assert!(looks_like_engine("  --cfg-scale <float>"));
        assert!(!looks_like_engine("usage: some other tool"));
    }

    fn zip_with(entries: &[(&str, &[u8])]) -> tempfile::NamedTempFile {
        let file = tempfile::NamedTempFile::new().unwrap();
        let mut writer = zip::ZipWriter::new(file.reopen().unwrap());
        for (name, data) in entries {
            writer
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(data).unwrap();
        }
        writer.finish().unwrap();
        file
    }

    #[test]
    fn a_zip_is_unpacked_with_its_folders() {
        let zip = zip_with(&[("sd-server.exe", b"exe"), ("lib/ggml.dll", b"dll")]);
        let dir = tempfile::tempdir().unwrap();
        unzip(zip.path(), dir.path()).unwrap();
        assert_eq!(std::fs::read(dir.path().join("sd-server.exe")).unwrap(), b"exe");
        assert_eq!(std::fs::read(dir.path().join("lib").join("ggml.dll")).unwrap(), b"dll");
    }

    #[test]
    fn an_entry_that_climbs_out_of_the_folder_is_refused() {
        let zip = zip_with(&[("../evil.txt", b"x")]);
        let dir = tempfile::tempdir().unwrap();
        let err = unzip(zip.path(), dir.path()).unwrap_err();
        assert!(err.contains("outside"), "{err}");
        assert!(!dir.path().parent().unwrap().join("evil.txt").exists());
    }
}
