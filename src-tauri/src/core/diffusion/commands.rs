//! The commands the app calls: install, load, generate, cancel, the gallery.

use super::args::Offload;
use super::catalog::{self, Backend, Kind, ModelDef};
use super::custom::{self, CustomModel, Family};
use super::engine;
use super::gallery::{self, GalleryItem};
use super::runtime::{self, Generated, ImageParams, ResidentInfo, VideoParams};
use serde::Serialize;
use std::path::Path;
use tauri::Runtime;

/// Imported adapters live in Studio's own directory, separate from model weights.
#[tauri::command]
pub fn diffusion_list_loras<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Vec<String>, String> {
    let dir = engine::diffusion_root(&app).join("loras");
    if !dir.exists() { return Ok(Vec::new()); }
    let mut names = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| format!("Could not read LoRA adapters: {e}"))? {
        let entry = entry.map_err(|e| format!("Could not read LoRA adapters: {e}"))?;
        let path = entry.path();
        if path.is_file() && path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("safetensors")) {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    names.sort_by_key(|name| name.to_ascii_lowercase());
    Ok(names)
}

#[tauri::command]
pub fn diffusion_import_lora<R: Runtime>(app: tauri::AppHandle<R>, path: String) -> Result<String, String> {
    let source = Path::new(&path);
    if !source.is_file() || !source.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("safetensors")) {
        return Err("Choose a .safetensors LoRA file.".to_string());
    }
    let name = source.file_name().and_then(|n| n.to_str()).ok_or("LoRA file name is invalid.")?.to_string();
    let dir = engine::diffusion_root(&app).join("loras");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create LoRA folder: {e}"))?;
    let target = dir.join(&name);
    let mut input = std::fs::File::open(source).map_err(|e| format!("Could not open LoRA: {e}"))?;
    let mut output = std::fs::OpenOptions::new().write(true).create_new(true).open(&target)
        .map_err(|e| format!("Could not import LoRA (file may already exist): {e}"))?;
    if let Err(error) = std::io::copy(&mut input, &mut output) {
        drop(output);
        let _ = std::fs::remove_file(&target);
        return Err(format!("Could not copy LoRA: {error}"));
    }
    Ok(name)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    #[serde(flatten)]
    pub def: ModelDef,
    pub installed: bool,
    pub total_bytes: u64,
    /// Added from Discover, so it can be removed.
    pub custom: bool,
    /// The family a custom model belongs to.
    pub family: Option<&'static str>,
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
    let models = catalog::all_models()
        .into_iter()
        .map(|def| ModelStatus {
            def: *def,
            installed: runtime::model_installed(&app, def),
            total_bytes: def.total_bytes(),
            custom: custom::is_custom(def.id),
            family: custom::family_of(def.id),
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
    if !engine::platform_supported() {
        return Err("Local image and video generation is available on Windows only for now.".to_string());
    }
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
    // With the archive on (the default) a result moves to the archive and can
    // be restored; permanent deletion is done from the Archive page.
    let data = crate::core::app::commands::get_jan_data_folder_path(app.clone());
    if crate::core::archive::store::read_settings(&data).enabled {
        return gallery::archive(&app, kind, &id);
    }
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
/// Base64 is a third longer than what it encodes; longer than this is refused before it is decoded.
const MAX_EXTERNAL_IMAGE_TEXT: usize = MAX_EXTERNAL_IMAGE_BYTES / 3 * 4 + 8;
const MAX_EXTERNAL_PROMPT_CHARS: usize = 20_000;
const MAX_EXTERNAL_NAME_CHARS: usize = 200;
static EXTERNAL_JOBS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[tauri::command]
pub async fn diffusion_save_external_images<R: Runtime>(
    app: tauri::AppHandle<R>,
    params: ExternalImages,
) -> Result<Generated, String> {
    use base64::Engine as _;
    if params.images.is_empty() || params.images.len() > MAX_EXTERNAL_IMAGES {
        return Err(format!("Expected between 1 and {MAX_EXTERNAL_IMAGES} pictures."));
    }
    if params.prompt.chars().count() > MAX_EXTERNAL_PROMPT_CHARS
        || params.negative_prompt.chars().count() > MAX_EXTERNAL_PROMPT_CHARS
        || params.model_id.chars().count() > MAX_EXTERNAL_NAME_CHARS
        || params.model_name.chars().count() > MAX_EXTERNAL_NAME_CHARS
        || !(1..=65_535).contains(&params.width)
        || !(1..=65_535).contains(&params.height)
    {
        return Err("That request is outside what Studio keeps.".to_string());
    }
    if params.images.iter().any(|text| text.len() > MAX_EXTERNAL_IMAGE_TEXT) {
        return Err("The provider's picture is too large to keep.".to_string());
    }
    let created_at_ms = gallery::now_ms();
    let counter = EXTERNAL_JOBS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let job_id = format!("cloud_{created_at_ms}_{counter}");
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
            lora: Vec::new(),
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

/// The families a model from Discover can belong to, with what each also downloads.
#[tauri::command]
pub fn diffusion_families() -> Vec<FamilyInfo> {
    custom::FAMILIES
        .iter()
        .map(|f| FamilyInfo { family: *f, companion_bytes: f.companion_bytes() })
        .collect()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FamilyInfo {
    #[serde(flatten)]
    pub family: Family,
    pub companion_bytes: u64,
}

/// The family a repo and file most likely belong to, for the picker's default.
#[tauri::command]
pub fn diffusion_guess_family(repo: String, filename: String) -> Option<&'static str> {
    custom::guess_family(&repo, &filename)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddCustomModel {
    pub repo: String,
    pub filename: String,
    pub family: String,
    pub display_name: Option<String>,
    pub license: Option<String>,
    pub token: Option<String>,
}

/// Add a diffusion model from Hugging Face to Studio. The file is looked up on
/// Hugging Face for its size and checksum, so what gets downloaded later is
/// verified against what the repository publishes; nothing is downloaded here.
#[tauri::command]
pub async fn diffusion_add_custom_model<R: Runtime>(
    app: tauri::AppHandle<R>,
    params: AddCustomModel,
) -> Result<ModelStatus, String> {
    if !engine::platform_supported() {
        return Err("Local image and video generation is available on Windows only for now.".to_string());
    }
    let AddCustomModel { repo, filename, family, display_name, license, token } = params;
    custom::family(&family).ok_or("That model family is not supported.")?;
    let files = crate::core::huggingface::huggingface_model_files(repo.clone(), token).await?;
    let file = files
        .into_iter()
        .find(|f| f.name == filename)
        .ok_or("That file is not in the repository.")?;
    let size = file.size.unwrap_or(0);
    if let Some(problem) = custom::weights_file_problem(&filename, size) {
        return Err(problem.to_string());
    }
    let sha256 = file
        .sha256
        .map(|s| s.to_ascii_lowercase())
        .filter(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or("Hugging Face does not publish a checksum for that file, so it cannot be verified.")?;
    let name = display_name
        .map(|n| n.trim().chars().take(80).collect::<String>())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| filename.rsplit('/').next().unwrap_or(&filename).to_string());
    let license = license
        .map(|l| l.trim().chars().take(40).collect::<String>())
        .filter(|l| !l.is_empty())
        .unwrap_or_else(|| "See the model page".to_string());
    let record = CustomModel {
        id: custom::id_for(&repo, &filename),
        display_name: name,
        family,
        repo,
        filename,
        size,
        sha256,
        license,
    };
    let def = custom::add(&app, record)?;
    Ok(ModelStatus {
        def: *def,
        installed: runtime::model_installed(&app, def),
        total_bytes: def.total_bytes(),
        custom: true,
        family: custom::family_of(def.id),
    })
}

/// Forget a model added from Discover. Its downloaded files stay on disk.
#[tauri::command]
pub async fn diffusion_remove_custom_model<R: Runtime>(
    app: tauri::AppHandle<R>,
    model_id: String,
) -> Result<(), String> {
    if let Some(resident) = runtime::resident_info().await {
        if resident.model_id == model_id {
            if resident.busy {
                return Err("That model is making a picture right now. Remove it when it is done.".to_string());
            }
            runtime::unload(&app).await;
        }
    }
    custom::remove(&app, &model_id)
}
