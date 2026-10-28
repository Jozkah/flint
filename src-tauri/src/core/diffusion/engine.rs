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
    let response = client
        .get(catalog::engine_url(asset))
        .send()
        .await
        .map_err(|e| format!("Could not download the image engine: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "The image engine download answered {}.",
            response.status()
        ));
    }
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("Could not create the download file: {e}"))?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = tokio::time::timeout(std::time::Duration::from_secs(60), stream.next())
        .await
        .map_err(|_| "The image engine download stalled.".to_string())?
    {
        let chunk = chunk.map_err(|e| format!("The image engine download was interrupted: {e}"))?;
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Could not write the image engine: {e}"))?;
        downloaded += chunk.len() as u64;
        emit(app, "download", downloaded, asset.size);
    }
    file.flush().await.map_err(|e| e.to_string())?;
    if downloaded != asset.size {
        return Err(format!(
            "The image engine download is {downloaded} bytes, expected {}.",
            asset.size
        ));
    }
    let actual = format!("{:x}", hasher.finalize());
    if !actual.eq_ignore_ascii_case(asset.sha256) {
        return Err("The image engine download failed its checksum.".to_string());
    }
    Ok(())
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
    let result = async {
        for asset in &assets {
            let zip_path = staging.join(asset.name);
            download_asset(app, asset, &zip_path).await?;
            emit(app, "unpack", 0, 0);
            let (archive, target) = (zip_path.clone(), dir.clone());
            tokio::task::spawn_blocking(move || unzip(&archive, &target))
                .await
                .map_err(|e| format!("Unpacking stopped: {e}"))??;
            let _ = tokio::fs::remove_file(&zip_path).await;
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
    Ok(final_dir)
}

/// Only one install runs at a time.
static INSTALL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The sibling folder an install is built in before it replaces `dir`.
fn staging_path(dir: &Path) -> PathBuf {
    let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    dir.with_file_name(format!("{name}.staging-{}", std::process::id()))
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
                .start_file(*name, zip::write::FileOptions::default())
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
