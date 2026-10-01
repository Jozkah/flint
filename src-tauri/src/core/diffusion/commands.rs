//! The commands the app calls: install, load, generate, cancel, the gallery.

use super::args::Offload;
use super::catalog::{self, Backend, Kind, ModelDef};
use super::engine;
use super::gallery::{self, GalleryItem};
use super::runtime::{self, Generated, ImageParams, ResidentInfo, VideoParams};
use serde::Serialize;
use tauri::Runtime;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    #[serde(flatten)]
    pub def: ModelDef,
    pub installed: bool,
    pub total_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub supported: bool,
    pub engine_tag: &'static str,
    pub engine_backend: Option<Backend>,
    pub models: Vec<ModelStatus>,
    pub resident: Option<ResidentInfo>,
}

#[tauri::command]
pub async fn diffusion_status<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Status, String> {
    let models = catalog::MODELS
        .iter()
        .map(|def| ModelStatus {
            def: *def,
            installed: runtime::model_installed(&app, def),
            total_bytes: def.total_bytes(),
        })
        .collect();
    Ok(Status {
        supported: engine::platform_supported(),
        engine_tag: catalog::ENGINE_TAG,
        engine_backend: engine::installed_backend(&app),
        models,
        resident: runtime::resident_info().await,
    })
}

/// Download and install the engine. `backend` is `win-vulkan-x64`,
/// `win-cuda12-x64` or `win-cpu-x64`.
#[tauri::command]
pub async fn diffusion_install_engine<R: Runtime>(
    app: tauri::AppHandle<R>,
    backend: String,
) -> Result<(), String> {
    let backend = Backend::from_id(&backend).ok_or_else(|| format!("Unknown engine build {backend}."))?;
    engine::install(&app, backend).await.map(|_| ())
}

/// Download every file of a model, one after another, through the Hugging Face
/// downloader (so it resumes, retries and reports progress like any model).
/// Progress arrives as `huggingface-download-progress` under the task ids
/// `diffusion:<model>:<index>`.
#[tauri::command]
pub async fn diffusion_download_model<R: Runtime>(
    app: tauri::AppHandle<R>,
    model_id: String,
    token: Option<String>,
) -> Result<(), String> {
    let def = catalog::model(&model_id).ok_or_else(|| format!("Unknown model {model_id}."))?;
    for (index, file) in def.files.iter().enumerate() {
        if std::fs::metadata(runtime::model_file_path(&app, file))
            .map(|m| m.len() == file.size)
            .unwrap_or(false)
        {
            continue;
        }
        crate::core::huggingface::huggingface_download_model(
            app.clone(),
            format!("diffusion:{}:{index}", def.id),
            file.repo.to_string(),
            file.filename.to_string(),
            Some(file.size),
            Some(file.sha256.to_string()),
            token.clone(),
        )
        .await?;
    }
    Ok(())
}

fn offload_from(text: Option<&str>) -> Offload {
    match text {
        Some("group") => Offload::Group,
        Some("model") => Offload::Model,
        _ => Offload::None,
    }
}

#[tauri::command]
pub async fn diffusion_load<R: Runtime>(
    app: tauri::AppHandle<R>,
    model_id: String,
    offload: Option<String>,
) -> Result<ResidentInfo, String> {
    runtime::load(&app, &model_id, offload_from(offload.as_deref())).await
}

#[tauri::command]
pub async fn diffusion_unload<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    runtime::unload(&app).await;
    Ok(())
}

#[tauri::command]
pub async fn diffusion_generate_image<R: Runtime>(
    app: tauri::AppHandle<R>,
    params: ImageParams,
) -> Result<Generated, String> {
    runtime::generate_image(&app, params).await
}

#[tauri::command]
pub async fn diffusion_generate_video<R: Runtime>(
    app: tauri::AppHandle<R>,
    params: VideoParams,
) -> Result<Generated, String> {
    runtime::generate_video(&app, params).await
}

#[tauri::command]
pub async fn diffusion_cancel<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    runtime::cancel(&app).await
}

#[tauri::command]
pub async fn diffusion_gallery<R: Runtime>(
    app: tauri::AppHandle<R>,
    kind: Kind,
) -> Result<Vec<GalleryItem>, String> {
    tauri::async_runtime::spawn_blocking(move || gallery::list(&app, kind))
        .await
        .map_err(|e| format!("Could not read the gallery: {e}"))
}

#[tauri::command]
pub async fn diffusion_delete<R: Runtime>(
    app: tauri::AppHandle<R>,
    kind: Kind,
    id: String,
) -> Result<(), String> {
    gallery::delete(&app, kind, &id)
}

#[tauri::command]
pub async fn diffusion_media<R: Runtime>(
    app: tauri::AppHandle<R>,
    kind: Kind,
    id: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || gallery::media_data_url(&app, kind, &id))
        .await
        .map_err(|e| format!("Could not read the item: {e}"))?
}

/// Pictures a hosted provider returned, to keep in the gallery beside local ones.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalImages {
    pub prompt: String,
    #[serde(default)]
    pub negative_prompt: String,
    pub width: u32,
    pub height: u32,
    /// `provider/model`, so the gallery shows where it came from.
    pub model_id: String,
    pub model_name: String,
    pub duration_ms: u64,
    /// Base64 of each picture's bytes.
    pub images: Vec<String>,
}

/// Most pictures one request keeps, and the largest each may be once decoded.
const MAX_EXTERNAL_IMAGES: usize = 10;
const MAX_EXTERNAL_IMAGE_BYTES: usize = 40 * 1024 * 1024;

#[tauri::command]
pub async fn diffusion_save_external_images<R: Runtime>(
    app: tauri::AppHandle<R>,
    params: ExternalImages,
) -> Result<Generated, String> {
    use base64::Engine as _;
    if params.images.is_empty() || params.images.len() > MAX_EXTERNAL_IMAGES {
        return Err(format!("Expected between 1 and {MAX_EXTERNAL_IMAGES} pictures."));
    }
    let created_at_ms = gallery::now_ms();
    let job_id = format!("cloud_{created_at_ms}");
    let mut ids = Vec::new();
    let mut paths = Vec::new();
    for (index, encoded) in params.images.iter().enumerate() {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .map_err(|_| "The provider's picture was not readable.".to_string())?;
        if bytes.len() > MAX_EXTERNAL_IMAGE_BYTES {
            return Err("The provider's picture is too large to keep.".to_string());
        }
        let recipe = gallery::Recipe {
            job_id: job_id.clone(),
            kind: Kind::Image,
            prompt: params.prompt.clone(),
            negative_prompt: params.negative_prompt.clone(),
            width: params.width,
            height: params.height,
            steps: 0,
            seed: 0,
            batch_seed: 0,
            model_id: params.model_id.clone(),
            model_name: params.model_name.clone(),
            frames: None,
            fps: None,
            created_at_ms,
            duration_ms: params.duration_ms,
        };
        let saved = gallery::save_external_image(&app, &recipe, index as u32, &bytes)?;
        ids.push(saved.id);
        paths.push(saved.path.to_string_lossy().into_owned());
    }
    Ok(Generated { job_id, seed: 0, ids, paths, duration_ms: params.duration_ms })
}
