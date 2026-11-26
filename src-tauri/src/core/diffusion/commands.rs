//! The commands the app calls: install, load, generate, cancel, the gallery.

use super::args::Offload;
use super::catalog::{self, Backend, Kind, ModelDef};
use super::custom::{self, CustomModel, Family};
use super::engine;
use super::gallery::{self, GalleryItem};
use super::present::{self, Settled};
use super::runtime::{self, Generated, ImageParams, ResidentInfo, VideoParams};
use serde::Serialize;
use std::path::Path;
use tauri::{Emitter, Runtime};

/// Imported adapters live in Studio's own directory, separate from model weights.
#[tauri::command(async)]
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

#[tauri::command(async)]
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
    pub engine_builds: Vec<&'static str>,
    pub engine_tag: &'static str,
    pub engine_backend: Option<Backend>,
    pub models: Vec<ModelStatus>,
    pub resident: Option<ResidentInfo>,
    pub upscalers: Vec<super::upscale::UpscalerStatus>,
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
        engine_builds: catalog::available_backends().iter().map(|b| b.id()).collect(),
        engine_tag: catalog::ENGINE_TAG,
        engine_backend: engine::installed_backend(&app),
        models,
        resident: runtime::resident_info().await,
        upscalers: super::upscale::statuses(&app),
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

/// One file of a model that did not come down, for the Studio download card.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileFailure {
    pub index: usize,
    pub repo: String,
    pub filename: String,
    pub size: u64,
    /// Where the file is fetched from, so it can be downloaded by hand.
    pub url: String,
    /// Where Flint expects the finished file.
    pub path: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadFailed {
    model_id: String,
    files: Vec<FileFailure>,
}

/// The error text for a model with failed files: one line per file, naming it.
fn failure_summary(display_name: &str, total: usize, failures: &[FileFailure]) -> String {
    let lines = failures
        .iter()
        .map(|f| {
            format!(
                "file {} of {} ({} from {}): {}",
                f.index + 1,
                total,
                f.filename,
                f.repo,
                f.error
            )
        })
        .collect::<Vec<_>>()
        .join("
");
    format!("{display_name} could not be downloaded completely.
{lines}")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MovedAside {
    model_id: String,
    filename: String,
    from: String,
    to: String,
}

/// [`present::settle_existing`] off the async runtime, since hashing a
/// multi-GB file would otherwise hold a worker thread. Progress goes out as
/// the same event a download uses, under the file's own task id.
async fn settle_existing_blocking<R: Runtime>(
    app: &tauri::AppHandle<R>,
    model_id: &str,
    index: usize,
    path: &Path,
    file: &catalog::FileDef,
) -> Settled {
    let handle = app.clone();
    let task_id = format!("diffusion:{model_id}:{index}");
    let path = path.to_path_buf();
    let (size, sha256) = (file.size, file.sha256);
    let allow_move = !file.repo.starts_with(custom::LOCAL_REPO_PREFIX);
    let work = tauri::async_runtime::spawn_blocking(move || {
        let mut last = std::time::Instant::now();
        present::settle_existing(&path, size, sha256, allow_move, |done, total| {
            if done == total || last.elapsed() >= std::time::Duration::from_millis(250) {
                last = std::time::Instant::now();
                let _ = handle.emit(
                    "huggingface-download-progress",
                    crate::core::huggingface::HuggingFaceDownloadProgress {
                        task_id: task_id.clone(),
                        downloaded: done,
                        total: Some(total),
                        retry_in_ms: None,
                        attempt: None,
                        reason: None,
                    },
                );
            }
        })
    })
    .await;
    match work {
        Ok(Ok(settled)) => settled,
        Ok(Err(error)) => {
            log::warn!("could not check {}: {error}", file.filename);
            Settled::Missing
        }
        Err(error) => {
            log::warn!("checking {} failed: {error}", file.filename);
            Settled::Missing
        }
    }
}

/// Download every file of a model through the Hugging Face downloader (so it
/// resumes, retries and reports progress like any model). A file that fails
/// does not stop the others; the files that did not come down are named in the
/// error and in a `diffusion-download-failed` event, with the URL and
/// destination of each. Progress arrives as `huggingface-download-progress`
/// under the task ids `diffusion:<model>:<index>`.
#[tauri::command]
pub async fn diffusion_download_model<R: Runtime>(
    app: tauri::AppHandle<R>,
    model_id: String,
    token: Option<String>,
) -> Result<(), String> {
    if !engine::platform_supported() {
        return Err("Local image and video generation needs Windows x64 or Linux x64.".to_string());
    }
    let def = catalog::model(&model_id).ok_or_else(|| format!("Unknown model {model_id}."))?;
    let mut failures: Vec<FileFailure> = Vec::new();
    for (index, file) in def.files.iter().enumerate() {
        let path = runtime::model_file_path(&app, file);
        match settle_existing_blocking(&app, def.id, index, &path, file).await {
            Settled::Ready => continue,
            Settled::Missing => {}
            Settled::MovedAside(to) => {
                log::warn!("{} did not match the catalog; kept as {}", path.display(), to.display());
                let _ = app.emit(
                    "diffusion-file-moved-aside",
                    MovedAside {
                        model_id: def.id.to_string(),
                        filename: file.filename.to_string(),
                        from: path.display().to_string(),
                        to: to.display().to_string(),
                    },
                );
            }
        }
        let fail = |error: String| FileFailure {
            index,
            repo: file.repo.to_string(),
            filename: file.filename.to_string(),
            size: file.size,
            url: file.url().unwrap_or_default(),
            path: path.display().to_string(),
            error,
        };
        if file.repo.starts_with(custom::LOCAL_REPO_PREFIX) {
            failures.push(fail(format!(
                "it is not at {} any more. Put the file back, or remove the model and add it again.",
                path.display()
            )));
            continue;
        }
        let result = crate::core::huggingface::huggingface_download_model(
            app.clone(),
            format!("diffusion:{}:{index}", def.id),
            file.repo.to_string(),
            file.filename.to_string(),
            Some(file.size),
            Some(file.sha256.to_string()),
            token.clone(),
            file.revision().map(str::to_string),
            None,
        )
        .await;
        if let Err(error) = result {
            // A pause is the person's own choice, not a failure to report.
            if error == "Download paused" {
                return Err(error);
            }
            failures.push(fail(error));
        }
    }
    if failures.is_empty() {
        return Ok(());
    }
    let _ = app.emit(
        "diffusion-download-failed",
        DownloadFailed { model_id: def.id.to_string(), files: failures.clone() },
    );
    Err(failure_summary(def.display_name, def.files.len(), &failures))
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

/// Download an upscaler model (see `upscale.rs`).
#[tauri::command]
pub async fn diffusion_download_upscaler<R: Runtime>(
    app: tauri::AppHandle<R>,
    upscaler_id: String,
    token: Option<String>,
) -> Result<(), String> {
    super::upscale::download(&app, &upscaler_id, token).await
}

/// Make a gallery picture larger with an upscaler; the result is a new picture.
#[tauri::command]
pub async fn diffusion_upscale<R: Runtime>(
    app: tauri::AppHandle<R>,
    image_id: String,
    upscaler_id: String,
) -> Result<Generated, String> {
    super::upscale::upscale(&app, &image_id, &upscaler_id).await
}

#[tauri::command]
pub async fn diffusion_cancel<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    // An upscale runs apart from the engine's job queue.
    if super::upscale::cancel().await {
        return Ok(());
    }
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

/// Opens one gallery picture in the editor the person set up (G'MIC-Qt or any
/// other app). The file is looked up in the gallery by id, so the webview never
/// names a path to open; the program is validated and started without a shell
/// (see `external.rs`).
#[tauri::command(async)]
pub fn diffusion_open_external<R: Runtime>(
    app: tauri::AppHandle<R>,
    kind: Kind,
    id: String,
    program: String,
    args: Option<String>,
) -> Result<(), String> {
    let item = gallery::list(&app, kind)
        .into_iter()
        .find(|g| g.id == id)
        .ok_or("That picture is no longer in the gallery.")?;
    super::external::launch(&program, args.as_deref().unwrap_or(""), Path::new(&item.path))
}

/// What a saved copy may be: the media types the gallery holds.
const SAVE_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "webp", "mp4", "webm"];

/// Copies `source` to `dest` through a temporary file, so a failed copy never
/// leaves half a picture where the person chose to save.
fn copy_atomically(source: &Path, dest: &Path) -> Result<(), String> {
    let mut temp = dest.as_os_str().to_owned();
    temp.push(".tmp");
    let temp = std::path::PathBuf::from(temp);
    std::fs::copy(source, &temp).map_err(|e| format!("could not save the copy: {e}"))?;
    std::fs::rename(&temp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("could not save the copy: {e}")
    })
}

/// Saves a gallery picture or clip where the person chooses, through the
/// system save dialog. The webview names the gallery item, never a path, and
/// the destination comes from the dialog (an `<a download>` on a file URL
/// opens the web preview instead of saving, in the desktop app). `None` means
/// the person cancelled.
#[tauri::command]
pub async fn diffusion_save_copy<R: Runtime>(
    app: tauri::AppHandle<R>,
    kind: Kind,
    id: String,
    suggested_name: String,
) -> Result<Option<String>, String> {
    let item = gallery::list(&app, kind)
        .into_iter()
        .find(|g| g.id == id)
        .ok_or("That picture is no longer in the gallery.")?;
    let source = std::path::PathBuf::from(&item.path);
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| SAVE_EXTENSIONS.contains(&e.as_str()))
        .ok_or("That file is not a picture or video Flint can save.")?;
    let name = crate::core::filesystem::export_file::sanitize_file_name(&suggested_name, &ext);
    let Some(mut dest) = crate::core::filesystem::export_file::pick_path(&ext, &name).await else {
        return Ok(None);
    };
    if dest.extension().is_none() {
        dest.set_extension(&ext);
    }
    let target = dest.clone();
    tauri::async_runtime::spawn_blocking(move || copy_atomically(&source, &target))
        .await
        .map_err(|e| format!("could not save the copy: {e}"))??;
    Ok(Some(dest.to_string_lossy().to_string()))
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
            reference_ids: Vec::new(),
            frames: None,
            fps: None,
            created_at_ms,
            duration_ms: params.duration_ms,
            source_id: None,
            upscale: None,
            masked: false,
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
        return Err("Local image and video generation needs Windows x64 or Linux x64.".to_string());
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
        local_path: None,
        local_companions: Vec::new(),
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

/// Add a weights file that is already on this computer. It is used where it
/// is, not copied. `companions` are other files the person has (text encoders,
/// a VAE); those that match what the family needs are used in place too, and the
/// rest are downloaded as for any model, from the Studio model list.
// ipc-scope: dialog (a weights file the person picked; stat/read only, canonicalized, never written or copied)
#[tauri::command(async)]
pub fn diffusion_add_local_model<R: Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
    family: String,
    display_name: Option<String>,
    companions: Option<Vec<String>>,
) -> Result<ModelStatus, String> {
    if !engine::platform_supported() {
        return Err("Local image and video generation needs Windows x64 or Linux x64.".to_string());
    }
    let family_def = custom::family(&family).ok_or("That model family is not supported.")?;
    let candidates: Vec<(String, u64)> = companions
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| {
            let meta = std::fs::metadata(&p).ok().filter(|m| m.is_file())?;
            let shown = std::fs::canonicalize(&p).ok()?.to_string_lossy().trim_start_matches(r"\?\").to_string();
            Some((shown, meta.len()))
        })
        .collect();
    let local_companions = custom::match_companions(family_def, &candidates);
    let source = Path::new(&path);
    let meta = std::fs::metadata(source).map_err(|_| "That file could not be found.".to_string())?;
    if !meta.is_file() {
        return Err("Choose a weights file, not a folder.".to_string());
    }
    let source = std::fs::canonicalize(source).map_err(|e| format!("Could not read that path: {e}"))?;
    let filename = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("That file name is not usable.")?
        .to_string();
    if let Some(problem) = custom::weights_file_problem(&filename, meta.len()) {
        return Err(problem.to_string());
    }
    // Windows hands back a `\?\` verbatim prefix; keep the path a person would recognise.
    let shown = source.to_string_lossy().trim_start_matches(r"\?\").to_string();
    let id = custom::id_for("local", &shown);
    let name = display_name
        .map(|n| n.trim().chars().take(80).collect::<String>())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| filename.clone());
    let record = CustomModel {
        id: id.clone(),
        display_name: name,
        family,
        repo: format!("{}{id}", custom::LOCAL_REPO_PREFIX),
        filename,
        size: meta.len(),
        sha256: String::new(),
        license: "Local file".to_string(),
        local_path: Some(shown),
        local_companions,
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

#[cfg(test)]
mod tests {
    #[test]
    fn a_saved_copy_matches_the_original_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("a.png");
        let dst = dir.path().join("b.png");
        std::fs::write(&src, b"picture").unwrap();
        copy_atomically(&src, &dst).unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), b"picture");
        assert!(!dir.path().join("b.png.tmp").exists());
        assert!(copy_atomically(&dir.path().join("missing.png"), &dir.path().join("c.png")).is_err());
        assert!(!dir.path().join("c.png").exists() && !dir.path().join("c.png.tmp").exists());
    }

    use super::*;

    #[test]
    fn a_failed_download_names_each_file_that_did_not_come_down() {
        let failures = vec![
            FileFailure {
                index: 0,
                repo: "unsloth/Z-Image-Turbo-GGUF".into(),
                filename: "z-image-turbo-Q4_K_M.gguf".into(),
                size: 5,
                url: "https://huggingface.co/x".into(),
                path: "C:/m".into(),
                error: "Hugging Face answered 503".into(),
            },
            FileFailure {
                index: 2,
                repo: "unsloth/Qwen3-4B-Instruct-2507-GGUF".into(),
                filename: "q.gguf".into(),
                size: 5,
                url: String::new(),
                path: String::new(),
                error: "no space".into(),
            },
        ];
        let text = failure_summary("Z-Image Turbo", 3, &failures);
        assert!(text.starts_with("Z-Image Turbo could not be downloaded completely."));
        assert!(text.contains("file 1 of 3 (z-image-turbo-Q4_K_M.gguf from unsloth/Z-Image-Turbo-GGUF): Hugging Face answered 503"));
        assert!(text.contains("file 3 of 3 (q.gguf from unsloth/Qwen3-4B-Instruct-2507-GGUF): no space"));
    }
}
