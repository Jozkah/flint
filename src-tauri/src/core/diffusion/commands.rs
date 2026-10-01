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
