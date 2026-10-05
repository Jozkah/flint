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
    catalog::available_backends().iter().copied()
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
    let dir = engine_dir(app, backend);
    let staging = diffusion_root(app).join("downloads");
    tokio::fs::create_dir_all(&staging).await.map_err(|e| e.to_string())?;
    // Start clean: a half-unpacked folder from an earlier try must not be mixed in.
    let _ = tokio::fs::remove_dir_all(&dir).await;
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
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

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
