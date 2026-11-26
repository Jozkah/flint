//! Making a gallery picture larger with an ESRGAN model.
//!
//! The engine's `sd-cli` has an upscale mode that needs no diffusion model:
//! `sd-cli -M upscale -i <picture> --upscale-model <model> -o <result>`. It runs
//! beside the resident `sd-server` (the upscaler is small), and the result is
//! kept in the gallery as a new picture that names its source.

use super::catalog::{FileDef, Kind, Role};
use super::engine;
use super::gallery;
use super::runtime::{model_file_path, Generated};
use serde::Serialize;
use std::path::Path;
use std::time::{Duration, Instant};
use tauri::{Emitter, Runtime};
use tokio::process::Command;

/// One upscaler Studio offers.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpscalerDef {
    pub id: &'static str,
    pub display_name: &'static str,
    /// How many times wider and taller the result is.
    pub scale: u32,
    pub license: &'static str,
    #[serde(skip)]
    pub file: FileDef,
}

pub const REAL_ESRGAN_X4PLUS: UpscalerDef = UpscalerDef {
    id: "realesrgan-x4plus",
    display_name: "Real-ESRGAN x4plus",
    scale: 4,
    license: "BSD-3-Clause",
    file: FileDef {
        role: Role::Upscaler,
        repo: "Comfy-Org/Real-ESRGAN",
        filename: "RealESRGAN_x4plus.safetensors",
        size: 66_857_836,
        sha256: "37f9a931c215f040aa6d50f711f2cb115f713c46df1d0d6469a8bd7bfe9a60bb",
    },
};

pub const UPSCALERS: &[UpscalerDef] = &[REAL_ESRGAN_X4PLUS];

pub fn upscaler(id: &str) -> Option<&'static UpscalerDef> {
    UPSCALERS.iter().find(|u| u.id == id)
}

/// The engine's command-line program, shipped in the same archive as the server.
pub const CLI_EXE: &str = if cfg!(windows) { "sd-cli.exe" } else { "sd-cli" };

/// Largest side a result may have. Four times a 2048 picture is 8192, which is
/// as far as the gallery and the viewer go comfortably.
const MAX_RESULT_SIDE: u32 = 8192;

/// How long one upscale may take before it is given up.
const UPSCALE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpscalerStatus {
    #[serde(flatten)]
    pub def: UpscalerDef,
    pub total_bytes: u64,
    pub installed: bool,
}

pub fn statuses<R: Runtime>(app: &tauri::AppHandle<R>) -> Vec<UpscalerStatus> {
    UPSCALERS
        .iter()
        .map(|def| UpscalerStatus {
            def: *def,
            total_bytes: def.file.size,
            installed: installed(app, def),
        })
        .collect()
}

fn installed<R: Runtime>(app: &tauri::AppHandle<R>, def: &UpscalerDef) -> bool {
    super::present::file_ready(&model_file_path(app, &def.file), def.file.size, def.file.sha256)
}

/// Download an upscaler through the Hugging Face downloader. Progress arrives
/// as `huggingface-download-progress` under the task id `diffusion:<id>:0`.
pub async fn download<R: Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
    token: Option<String>,
) -> Result<(), String> {
    let def = upscaler(id).ok_or_else(|| format!("Unknown upscaler {id}."))?;
    if installed(app, def) {
        return Ok(());
    }
    crate::core::huggingface::huggingface_download_model(
        app.clone(),
        format!("diffusion:{}:0", def.id),
        def.file.repo.to_string(),
        def.file.filename.to_string(),
        Some(def.file.size),
        Some(def.file.sha256.to_string()),
        token,
        def.file.revision().map(str::to_string),
        None,
    )
    .await
    .map(|_| ())
}

/// The picture is too large to make `scale` times larger, or `None` when it fits.
pub fn too_large(size: (u32, u32), scale: u32) -> Option<String> {
    let longest = size.0.max(size.1);
    (longest.saturating_mul(scale) > MAX_RESULT_SIDE).then(|| {
        format!(
            "This picture is {} x {}; made {scale} times larger it would pass {MAX_RESULT_SIDE} pixels. Upscale a picture of at most {} pixels on its longest side.",
            size.0,
            size.1,
            MAX_RESULT_SIDE / scale
        )
    })
}

/// The arguments `sd-cli` is started with.
pub fn cli_args(source: &Path, model: &Path, out: &Path) -> Vec<String> {
    vec![
        "-M".into(),
        "upscale".into(),
        "-i".into(),
        source.to_string_lossy().into_owned(),
        "--upscale-model".into(),
        model.to_string_lossy().into_owned(),
        "-o".into(),
        out.to_string_lossy().into_owned(),
    ]
}

static CANCEL: std::sync::OnceLock<tokio::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>> =
    std::sync::OnceLock::new();

fn cancel_slot() -> &'static tokio::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>> {
    CANCEL.get_or_init(|| tokio::sync::Mutex::new(None))
}

/// Stop the upscale in progress, if there is one. Returns whether one was stopped.
pub async fn cancel() -> bool {
    match cancel_slot().lock().await.take() {
        Some(stop) => stop.send(()).is_ok(),
        None => false,
    }
}

#[derive(Serialize, Clone)]
struct Progress<'a> {
    job_id: &'a str,
    phase: &'a str,
    fraction: f64,
}

/// Make gallery picture `image_id` larger with `upscaler_id` and keep the
/// result in the gallery as a new picture.
pub async fn upscale<R: Runtime>(
    app: &tauri::AppHandle<R>,
    image_id: &str,
    upscaler_id: &str,
) -> Result<Generated, String> {
    let def = upscaler(upscaler_id).ok_or_else(|| format!("Unknown upscaler {upscaler_id}."))?;
    if !installed(app, def) {
        return Err(format!("{} is not downloaded yet.", def.display_name));
    }
    let backend = engine::installed_backend(app).ok_or("The image engine is not installed yet.")?;
    let dir = engine::engine_dir(app, backend);
    let exe = dir.join(CLI_EXE);
    if !exe.is_file() {
        return Err("This image engine has no upscaler program. Install the engine again from Studio's settings.".to_string());
    }
    let item = gallery::list(app, Kind::Image)
        .into_iter()
        .find(|g| g.id == image_id)
        .ok_or("That picture is no longer in the gallery.")?;
    let source = std::path::PathBuf::from(&item.path);
    if let Some(problem) = std::fs::read(&source)
        .ok()
        .and_then(|bytes| super::args::png_dimensions(&bytes))
        .and_then(|size| too_large(size, def.scale))
    {
        return Err(problem);
    }

    let scratch = engine::diffusion_root(app).join("scratch");
    std::fs::create_dir_all(&scratch).map_err(|e| format!("Could not create the scratch folder: {e}"))?;
    let job_id = format!("upscale-{}", gallery::now_ms());
    let out = scratch.join(format!("{job_id}.png"));
    let model = model_file_path(app, &def.file);

    let mut command = Command::new(&exe);
    command
        .args(cli_args(&source, &model, &out))
        .current_dir(&dir)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    engine::configure_library_path(&mut command, &dir);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    jan_process::confine::die_with_parent(&mut command);

    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    *cancel_slot().lock().await = Some(stop_tx);
    let _ = app.emit("diffusion-progress", Progress { job_id: &job_id, phase: "upscaling", fraction: 0.1 });
    let started = Instant::now();
    let result = run(command, stop_rx).await;
    cancel_slot().lock().await.take();
    let output = match result {
        Ok(output) => output,
        Err(error) => {
            let _ = std::fs::remove_file(&out);
            return Err(error);
        }
    };
    let bytes = std::fs::read(&out);
    let _ = std::fs::remove_file(&out);
    let bytes = match bytes {
        Ok(bytes) if output.status.success() => bytes,
        _ => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let last = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
            return Err(if last.is_empty() {
                "The upscaler stopped without a result.".to_string()
            } else {
                format!("The upscaler stopped without a result: {last}")
            });
        }
    };
    let (width, height) = super::args::png_dimensions(&bytes).ok_or("The upscaler did not write a picture.")?;
    let _ = app.emit("diffusion-progress", Progress { job_id: &job_id, phase: "saving", fraction: 0.99 });

    let duration_ms = started.elapsed().as_millis() as u64;
    let recipe = gallery::Recipe {
        job_id: job_id.clone(),
        width,
        height,
        created_at_ms: gallery::now_ms(),
        duration_ms,
        source_id: Some(item.id.clone()),
        upscale: Some(def.scale),
        masked: false,
        ..item.recipe.clone()
    };
    let saved = gallery::save_image(app, &recipe, 0, &bytes)?;
    Ok(Generated {
        job_id,
        seed: recipe.seed,
        ids: vec![saved.id],
        paths: vec![saved.path.to_string_lossy().into_owned()],
        duration_ms,
    })
}

async fn run(
    mut command: Command,
    stop: tokio::sync::oneshot::Receiver<()>,
) -> Result<std::process::Output, String> {
    let child = command.spawn().map_err(|e| format!("Could not start the upscaler: {e}"))?;
    tokio::select! {
        output = tokio::time::timeout(UPSCALE_TIMEOUT, child.wait_with_output()) => match output {
            Ok(Ok(output)) => Ok(output),
            Ok(Err(e)) => Err(format!("The upscaler failed: {e}")),
            Err(_) => Err("The upscaler took too long and was stopped.".to_string()),
        },
        // Dropping the child future kills it (`kill_on_drop`).
        _ = stop => Err("Cancelled.".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_picture_that_would_grow_past_the_limit_is_refused() {
        assert!(too_large((1024, 1024), 4).is_none());
        assert!(too_large((2048, 1024), 4).is_none());
        let problem = too_large((2049, 512), 4).expect("too large");
        assert!(problem.contains("2048"), "{problem}");
    }

    #[test]
    fn the_cli_runs_in_upscale_mode_with_the_model_and_both_files() {
        let args = cli_args(Path::new("in.png"), Path::new("m.safetensors"), Path::new("out.png"));
        assert_eq!(
            args,
            vec!["-M", "upscale", "-i", "in.png", "--upscale-model", "m.safetensors", "-o", "out.png"]
        );
    }

    #[test]
    fn every_upscaler_is_pinned_and_found_by_id() {
        for def in UPSCALERS {
            assert_eq!(upscaler(def.id).map(|d| d.id), Some(def.id));
            assert_eq!(def.file.sha256.len(), 64);
            assert!(def.file.revision().is_some(), "{} is pinned", def.id);
            assert!(def.scale >= 2);
        }
        assert!(upscaler("nope").is_none());
    }
}
