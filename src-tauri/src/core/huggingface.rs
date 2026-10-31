use crate::core::app::commands::get_jan_data_folder_path;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::{Emitter, Runtime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;
use url::Url;

use crate::core::hf_endpoint::{endpoint_url, hf_endpoint};
/// Results per search when the caller names no limit, and the most it may ask
/// for (the Hub refuses larger pages).
const DEFAULT_SEARCH_RESULTS: u32 = 50;
const MAX_SEARCH_RESULTS: u32 = 1000;
const MAX_README_BYTES: u64 = 512 * 1024;
/// How much of a GGUF file's start is read to learn its architecture. The
/// key/value header sits at the front; a megabyte covers it for every model
/// this needed to handle, and it is a single ranged request.
const GGUF_HEADER_BYTES: usize = 1024 * 1024;

type CancelFlag = Arc<AtomicBool>;

static ACTIVE_DOWNLOADS: OnceLock<Mutex<HashMap<String, CancelFlag>>> = OnceLock::new();

fn active_downloads() -> &'static Mutex<HashMap<String, CancelFlag>> {
    ACTIVE_DOWNLOADS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Cap on model download throughput in bytes per second; 0 is unlimited. Shared
/// by every Hugging Face download (chat models, Studio models, the HTTP route).
static DOWNLOAD_LIMIT_BPS: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
pub fn set_download_speed_limit(bytes_per_sec: u64) {
    DOWNLOAD_LIMIT_BPS.store(bytes_per_sec, Ordering::Relaxed);
}

/// The Hugging Face endpoint chosen in Settings, and the `HF_ENDPOINT`
/// override when one is set (it wins over the setting).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HfEndpointState {
    endpoint: String,
    send_token_to_mirror: bool,
    env_override: Option<String>,
}

#[tauri::command]
pub fn get_hf_endpoint_setting() -> HfEndpointState {
    let (setting, env_override) = crate::core::hf_endpoint::current_setting_and_env();
    HfEndpointState { endpoint: setting.endpoint, send_token_to_mirror: setting.send_token_to_mirror, env_override }
}

#[tauri::command]
pub fn set_hf_endpoint_setting<R: Runtime>(
    app: tauri::AppHandle<R>,
    endpoint: String,
    send_token_to_mirror: bool,
) -> Result<(), String> {
    let data = crate::core::app::commands::get_jan_data_folder_path(app);
    crate::core::hf_endpoint::save_setting(
        &data,
        crate::core::hf_endpoint::HfEndpointSetting { endpoint, send_token_to_mirror },
    )
}

/// How long to wait so `bytes` received over `elapsed` stay within `limit`
/// bytes per second. Zero when unlimited or already behind the pace.
fn throttle_delay(bytes: u64, elapsed: std::time::Duration, limit: u64) -> std::time::Duration {
    if limit == 0 {
        return std::time::Duration::ZERO;
    }
    std::time::Duration::from_secs_f64(bytes as f64 / limit as f64).saturating_sub(elapsed)
}

/// One writer per partial file, process-wide.
///
/// Pausing only asks a download to stop; the command returns, and a resume can
/// start, before the old stream has noticed. Two of them then have the same
/// `.part` open, and the late one's truncating open wipes what the new one is
/// appending: a file of the right size whose hash fails after hours. Task ids
/// cannot see this (two tasks can share a file); paths can.
static PART_WRITERS: OnceLock<std::sync::Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();

/// Wait until nothing else is writing `path`, then hold it until the guard
/// drops. Gives up when the download is cancelled while waiting.
async fn lock_part_for_writing(
    path: &std::path::Path,
    cancel: &AtomicBool,
) -> Result<tokio::sync::OwnedMutexGuard<()>, String> {
    let lock = {
        let mut writers = PART_WRITERS
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // Entries nobody holds or waits on, so the map does not keep one per
        // file ever downloaded.
        writers.retain(|_, lock| Arc::strong_count(lock) > 1);
        writers.entry(path.to_path_buf()).or_default().clone()
    };
    tokio::select! {
        biased;
        guard = lock.lock_owned() => Ok(guard),
        _ = cancelled(cancel) => Err("Download paused".to_string()),
    }
}

/// Resolves once `cancel` is set. Raced against network waits so a pause takes
/// effect on a stalled connection instead of at the next chunk.
async fn cancelled(cancel: &AtomicBool) {
    while !cancel.load(Ordering::Relaxed) {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HuggingFaceFile {
    pub name: String,
    pub size: Option<u64>,
    pub sha256: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HuggingFaceModel {
    pub id: String,
    pub author: Option<String>,
    pub sha: Option<String>,
    pub downloads: u64,
    pub likes: u64,
    pub gated: bool,
    pub private: bool,
    pub disabled: bool,
    pub tags: Vec<String>,
    pub pipeline_tag: Option<String>,
    pub library_name: Option<String>,
    pub created_at: Option<String>,
    pub last_modified: Option<String>,
    pub card_data: Option<serde_json::Value>,
    pub files: Vec<HuggingFaceFile>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HuggingFaceDownloadProgress {
    pub task_id: String,
    pub downloaded: u64,
    pub total: Option<u64>,
    /// Set while the download waits to retry: how long until the next attempt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_in_ms: Option<u64>,
    /// The failed attempt count behind `retry_in_ms`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct SearchModel {
    id: String,
    author: Option<String>,
    sha: Option<String>,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    likes: u64,
    #[serde(default)]
    gated: serde_json::Value,
    #[serde(default, rename = "private")]
    is_private: bool,
    #[serde(default)]
    disabled: bool,
    #[serde(default)]
    tags: Vec<String>,
    pipeline_tag: Option<String>,
    library_name: Option<String>,
    #[serde(rename = "createdAt")]
    created_at: Option<String>,
    #[serde(rename = "lastModified")]
    last_modified: Option<String>,
    #[serde(rename = "cardData")]
    card_data: Option<serde_json::Value>,
    #[serde(default)]
    siblings: Vec<RepoSibling>,
}

#[derive(Debug, Deserialize)]
struct RepoInfo {
    #[serde(default)]
    siblings: Vec<RepoSibling>,
}

#[derive(Debug, Deserialize)]
struct RepoSibling {
    rfilename: String,
    size: Option<u64>,
    lfs: Option<LfsInfo>,
}

#[derive(Debug, Deserialize)]
struct LfsInfo {
    sha256: Option<String>,
    size: Option<u64>,
}

fn sibling_file(file: RepoSibling) -> HuggingFaceFile {
    HuggingFaceFile {
        name: file.rfilename,
        size: file.lfs.as_ref().and_then(|lfs| lfs.size).or(file.size),
        sha256: file.lfs.and_then(|lfs| lfs.sha256),
    }
}

/// Whole-request cap for the small metadata calls (search, file list, README,
/// GGUF header). The multi-GB downloads use their own stall-based handling and
/// must never get a total timeout.
const HF_API_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

fn api_error(prefix: &str, e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "Hugging Face did not answer in time".to_string()
    } else {
        format!("{prefix}: {e}")
    }
}

fn hf_client(token: Option<&str>) -> Result<reqwest::Client, String> {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::USER_AGENT,
        reqwest::header::HeaderValue::from_static("Flint/explicit-huggingface"),
    );
    // Token only over https, and to a mirror only when the user opted in.
    if let Some(token) = crate::core::hf_endpoint::hub_token(token)? {
        let value = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| "Invalid Hugging Face token".to_string())?;
        headers.insert(reqwest::header::AUTHORIZATION, value);
    }
    // The Settings HTTPS proxy and CA bundle apply to Hugging Face traffic.
    crate::core::net::tls::apply12(
        reqwest::Client::builder()
            .default_headers(headers)
            .connect_timeout(std::time::Duration::from_secs(15)),
    )
    .build()
        .map_err(|e| format!("Could not create Hugging Face client: {e}"))
}

fn api_url(path: &[&str]) -> Result<Url, String> {
    endpoint_url(&hf_endpoint()?, path)
}

pub(crate) fn valid_repo_id(repo: &str) -> bool {
    let mut parts = repo.split('/');
    let Some(owner) = parts.next() else { return false };
    let Some(name) = parts.next() else { return false };
    parts.next().is_none()
        && !owner.is_empty()
        && !name.is_empty()
        && [owner, name].iter().all(|part| {
            // ".." and "." pass the character check but climb out of the model folder.
            *part != ".."
                && *part != "."
                && part
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        })
}

pub(crate) use crate::core::hf_endpoint::valid_remote_path;

fn gated(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Bool(v) => *v,
        serde_json::Value::String(v) => !v.is_empty() && v != "false",
        _ => false,
    }
}

use crate::core::hf_endpoint::safe_path_component as safe_component;

pub(crate) fn relative_download_path(repo: &str, filename: &str) -> PathBuf {
    let mut path = PathBuf::from("downloads").join("huggingface");
    for part in repo.split('/') {
        path.push(safe_component(part));
    }
    for part in filename.split('/') {
        path.push(safe_component(part));
    }
    path
}

fn download_path<R: Runtime>(app: &tauri::AppHandle<R>, repo: &str, filename: &str) -> PathBuf {
    long_path_safe(get_jan_data_folder_path(app.clone()).join(relative_download_path(repo, filename)))
}

fn remote_file_url(repo: &str, filename: &str, revision: Option<&str>) -> Result<Url, String> {
    remote_file_url_on(&hf_endpoint()?, repo, filename, revision)
}

/// A branch name or commit sha usable as one URL segment. Empty or absent
/// means the default branch.
fn clean_revision(revision: Option<&str>) -> Result<&str, String> {
    match revision.map(str::trim).filter(|value| !value.is_empty()) {
        None => Ok("main"),
        Some(value)
            if value.len() <= 64
                && !value.starts_with('.')
                && value
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) =>
        {
            Ok(value)
        }
        Some(_) => Err("Invalid Hugging Face revision".to_string()),
    }
}

fn remote_file_url_on(
    base: &Url,
    repo: &str,
    filename: &str,
    revision: Option<&str>,
) -> Result<Url, String> {
    if !valid_repo_id(repo) {
        return Err("Invalid Hugging Face repository id".to_string());
    }
    if !valid_remote_path(filename) {
        return Err("Invalid Hugging Face file path".to_string());
    }
    let mut parts: Vec<&str> = repo.split('/').collect();
    parts.push("resolve");
    parts.push(clean_revision(revision)?);
    parts.extend(filename.split('/'));
    let url = endpoint_url(base, &parts)?;
    if url.host_str() != base.host_str() || url.scheme() != base.scheme() {
        return Err("Refusing a download URL outside the Hugging Face endpoint".to_string());
    }
    Ok(url)
}

/// Error pages are only quoted briefly; never buffer more than this.
const MAX_ERROR_BODY_BYTES: u64 = 4 * 1024;

/// Reads a body in chunks, stopping with `None` once it passes `cap` bytes, so a
/// response without a `content-length` cannot be buffered whole.
async fn read_capped(mut response: reqwest::Response, cap: u64) -> Result<Option<Vec<u8>>, reqwest::Error> {
    let mut out = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if out.len() as u64 + chunk.len() as u64 > cap {
            return Ok(None);
        }
        out.extend_from_slice(&chunk);
    }
    Ok(Some(out))
}

async fn response_error(response: reqwest::Response) -> String {
    let status = response.status();
    let body = match read_capped(response, MAX_ERROR_BODY_BYTES).await {
        Ok(Some(bytes)) => String::from_utf8_lossy(&bytes).into_owned(),
        _ => String::new(),
    };
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return "Hugging Face denied access. If the model is gated or private, accept its license on Hugging Face and add a token in Flint Settings.".to_string();
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return "Hugging Face rate-limited this request. Try again later or configure a Hugging Face token.".to_string();
    }
    let detail = body.trim();
    if detail.is_empty() {
        format!("Hugging Face returned {status}")
    } else {
        format!(
            "Hugging Face returned {status}: {}",
            detail.chars().take(300).collect::<String>()
        )
    }
}

async fn sha256_file(path: &PathBuf, cancel: &AtomicBool) -> Result<String, String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("Could not open downloaded file for verification: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("Download paused".to_string());
        }
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Could not read downloaded file for verification: {e}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// The sidecar that remembers which version of the file a `.part` came from.
fn part_meta_path(part_path: &std::path::Path) -> PathBuf {
    let mut name = part_path.as_os_str().to_owned();
    name.push(".meta");
    PathBuf::from(name)
}

/// A strong validator for the file in a response. Hugging Face sends the
/// content hash as `ETag` (or `X-Linked-ETag` on the redirect); a weak tag
/// cannot be used with `If-Range`.
fn etag_of(headers: &reqwest::header::HeaderMap) -> Option<String> {
    ["etag", "x-linked-etag"]
        .into_iter()
        .filter_map(|name| headers.get(name))
        .filter_map(|value| value.to_str().ok())
        .map(str::trim)
        .find(|value| !value.is_empty() && !value.starts_with("W/"))
        .map(str::to_string)
}

async fn read_part_etag(part_path: &std::path::Path) -> Option<String> {
    let text = tokio::fs::read_to_string(part_meta_path(part_path)).await.ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

async fn write_part_etag(part_path: &std::path::Path, etag: &str) {
    let _ = tokio::fs::write(part_meta_path(part_path), etag).await;
}

/// Removes a partial download and its sidecar.
async fn discard_part(part_path: &std::path::Path) {
    let _ = tokio::fs::remove_file(part_path).await;
    let _ = tokio::fs::remove_file(part_meta_path(part_path)).await;
}

async fn finalize_verified_download(part_path: &PathBuf, final_path: &PathBuf) -> Result<(), String> {
    if tokio::fs::metadata(final_path).await.is_err() {
        return tokio::fs::rename(part_path, final_path)
            .await
            .map_err(|e| format!("Could not finalize download: {e}"));
    }

    let file_name = final_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("model");
    let backup_path = final_path.with_file_name(format!("{file_name}.previous"));
    let _ = tokio::fs::remove_file(&backup_path).await;
    tokio::fs::rename(final_path, &backup_path)
        .await
        .map_err(|e| format!("Could not stage existing model for replacement: {e}"))?;

    match tokio::fs::rename(part_path, final_path).await {
        Ok(()) => {
            let _ = tokio::fs::remove_file(&backup_path).await;
            Ok(())
        }
        Err(error) => {
            let restore = tokio::fs::rename(&backup_path, final_path).await;
            match restore {
                Ok(()) => Err(format!("Could not finalize download: {error}")),
                Err(restore_error) => Err(format!(
                    "Could not finalize download ({error}) and could not restore the previous file ({restore_error}); the previous file remains at {}",
                    backup_path.display()
                )),
            }
        }
    }
}

#[tauri::command]
pub async fn huggingface_search_models(
    query: String,
    format: Option<String>,
    token: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<HuggingFaceModel>, String> {
    let query = query.trim();
    let limit = limit
        .unwrap_or(DEFAULT_SEARCH_RESULTS)
        .clamp(1, MAX_SEARCH_RESULTS)
        .to_string();
    let mut url = api_url(&["api", "models"])?;
    {
        let mut pairs = url.query_pairs_mut();
        if !query.is_empty() {
            pairs.append_pair("search", query);
        }
        match format.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
            Some("mlx") => {
                pairs.append_pair("filter", "mlx");
            }
            Some("all") => {}
            // Pictures and video: GGUF repositories tagged for the task, which
            // Studio can run, not every diffusers checkpoint.
            Some("image") => {
                pairs.append_pair("filter", "gguf");
                pairs.append_pair("pipeline_tag", "text-to-image");
            }
            Some("video") => {
                pairs.append_pair("filter", "gguf");
                pairs.append_pair("pipeline_tag", "text-to-video");
            }
            _ => {
                pairs.append_pair("filter", "gguf");
            }
        }
        pairs
            .append_pair("sort", "downloads")
            .append_pair("direction", "-1")
            .append_pair("full", "true")
            .append_pair("limit", &limit);
    }
    let response = hf_client(token.as_deref())?
        .get(url)
        .timeout(HF_API_TIMEOUT)
        .send()
        .await
        .map_err(|e| api_error("Hugging Face search failed", &e))?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    let models = response
        .json::<Vec<SearchModel>>()
        .await
        .map_err(|e| format!("Could not read Hugging Face search results: {e}"))?;
    Ok(models
        .into_iter()
        .map(|model| HuggingFaceModel {
            id: model.id,
            author: model.author,
            sha: model.sha,
            downloads: model.downloads,
            likes: model.likes,
            gated: gated(&model.gated),
            private: model.is_private,
            disabled: model.disabled,
            tags: model.tags,
            pipeline_tag: model.pipeline_tag,
            library_name: model.library_name,
            created_at: model.created_at,
            last_modified: model.last_modified,
            card_data: model.card_data,
            files: model
                .siblings
                .into_iter()
                .filter(|file| valid_remote_path(&file.rfilename))
                .map(sibling_file)
                .collect(),
        })
        .collect())
}

#[tauri::command]
pub async fn huggingface_model_files(
    repo: String,
    token: Option<String>,
) -> Result<Vec<HuggingFaceFile>, String> {
    if !valid_repo_id(&repo) {
        return Err("Invalid Hugging Face repository id".to_string());
    }
    let mut parts = vec!["api", "models"];
    parts.extend(repo.split('/'));
    let mut url = api_url(&parts)?;
    url.query_pairs_mut().append_pair("blobs", "true");
    let response = hf_client(token.as_deref())?
        .get(url)
        .timeout(HF_API_TIMEOUT)
        .send()
        .await
        .map_err(|e| api_error("Could not load Hugging Face model files", &e))?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    let info = response
        .json::<RepoInfo>()
        .await
        .map_err(|e| format!("Could not read Hugging Face model metadata: {e}"))?;
    let mut files: Vec<HuggingFaceFile> = info
        .siblings
        .into_iter()
        .filter(|file| valid_remote_path(&file.rfilename))
        .map(sibling_file)
        .collect();
    files.sort_by_key(|a| a.name.to_ascii_lowercase());
    Ok(files)
}

#[tauri::command]
pub async fn huggingface_readme(repo: String, token: Option<String>) -> Result<String, String> {
    let url = remote_file_url(&repo, "README.md", None)?;
    let response = hf_client(token.as_deref())?
        .get(url)
        .timeout(HF_API_TIMEOUT)
        .send()
        .await
        .map_err(|e| api_error("Could not load Hugging Face README", &e))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(String::new());
    }
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    if response.content_length().unwrap_or(0) > MAX_README_BYTES {
        return Err("Hugging Face README is too large to display".to_string());
    }
    let bytes = read_capped(response, MAX_README_BYTES)
        .await
        .map_err(|e| format!("Could not read Hugging Face README: {e}"))?
        .ok_or_else(|| "Hugging Face README is too large to display".to_string())?;
    String::from_utf8(bytes).map_err(|_| "Hugging Face README is not UTF-8".to_string())
}

/// The first `GGUF_HEADER_BYTES` of a `.gguf` file, base64-encoded, so the UI
/// can size a model's context memory exactly without downloading the weights.
/// Read-only, ranged, and only ever aimed at Hugging Face's own file URL.
#[tauri::command]
pub async fn huggingface_gguf_header(
    repo: String,
    filename: String,
    token: Option<String>,
) -> Result<String, String> {
    if !filename.to_ascii_lowercase().ends_with(".gguf") {
        return Err("Only GGUF files have a readable header".to_string());
    }
    let url = remote_file_url(&repo, &filename, None)?;
    let mut response = hf_client(token.as_deref())?
        .get(url)
        .timeout(HF_API_TIMEOUT)
        .header(
            reqwest::header::RANGE,
            format!("bytes=0-{}", GGUF_HEADER_BYTES - 1),
        )
        .send()
        .await
        .map_err(|e| format!("Could not read the model header: {e}"))?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    // A server that ignores Range answers 200 with the whole file: read only
    // what is needed and drop the rest of the connection.
    let mut header: Vec<u8> = Vec::with_capacity(GGUF_HEADER_BYTES);
    while header.len() < GGUF_HEADER_BYTES {
        match response
            .chunk()
            .await
            .map_err(|e| format!("Could not read the model header: {e}"))?
        {
            Some(chunk) => {
                let room = GGUF_HEADER_BYTES - header.len();
                header.extend_from_slice(&chunk[..chunk.len().min(room)]);
            }
            None => break,
        }
    }
    use base64::Engine as _;
    Ok(base64::engine::general_purpose::STANDARD.encode(&header))
}

#[tauri::command]
pub async fn huggingface_cancel_download(task_id: String) -> Result<(), String> {
    let downloads = active_downloads().lock().await;
    let Some(cancel) = downloads.get(&task_id) else {
        return Err("No active Hugging Face download with that id".to_string());
    };
    cancel.store(true, Ordering::Relaxed);
    Ok(())
}

/// A connection that sends nothing for this long is treated as dropped and
/// retried, instead of leaving a multi-gigabyte download hanging on bad wifi.
const STALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
/// Consecutive failed attempts retried on the quick backoff. After these the
/// download keeps trying at a steady pace until it recovers or is paused.
const QUICK_RETRIES: u32 = 5;
/// The wait between retries once the quick ones are used up.
const STEADY_RETRY: std::time::Duration = std::time::Duration::from_secs(64);
/// The longest `Retry-After` a server can make a download wait.
const MAX_RETRY_AFTER: std::time::Duration = std::time::Duration::from_secs(600);

/// The wait before retry number `failures` (1-based): 1, 2, 4, 8, 16, then 32 s.
fn retry_backoff(failures: u32) -> std::time::Duration {
    std::time::Duration::from_secs(1u64 << failures.saturating_sub(1).min(5))
}

/// The wait before retry number `failures`: the quick backoff, then a steady
/// 64 s. A server's `Retry-After` is honoured when it asks for longer.
fn retry_delay(failures: u32, retry_after: Option<std::time::Duration>) -> std::time::Duration {
    let base = if failures <= QUICK_RETRIES {
        retry_backoff(failures)
    } else {
        STEADY_RETRY
    };
    match retry_after {
        Some(wait) => base.max(wait.min(MAX_RETRY_AFTER)),
        None => base,
    }
}

/// Whether an HTTP status is worth retrying: server errors, rate limiting and
/// request timeouts. Every other refusal fails the download at once.
fn status_is_transient(status: reqwest::StatusCode) -> bool {
    status.is_server_error()
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status == reqwest::StatusCode::REQUEST_TIMEOUT
}

/// A `Retry-After` header given in seconds. The HTTP-date form is ignored and
/// the normal backoff applies.
fn retry_after_of(headers: &reqwest::header::HeaderMap) -> Option<std::time::Duration> {
    let value = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    value.trim().parse::<u64>().ok().map(std::time::Duration::from_secs)
}

/// Whether a connection failure is a certificate or TLS trust problem. Those
/// do not fix themselves (a proxy or clock is wrong), so retrying only hides
/// the cause.
fn transport_error_is_fatal(chain: &str) -> bool {
    let lower = chain.to_ascii_lowercase();
    [
        "certificate",
        "unknownissuer",
        "unknown issuer",
        "self signed",
        "self-signed",
        "invalid peer",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

/// One pass of the retry loop, as the loop sees it.
enum Step {
    Done,
    Paused,
    Retry {
        made_progress: bool,
        reason: String,
        retry_after: Option<std::time::Duration>,
    },
}

/// Run `attempt` until it finishes, retrying transient failures without a cap:
/// the quick backoff first, then every 64 s. Bytes received reset the backoff.
/// A pause or cancel ends the wait at once. `on_wait` hears each wait before
/// it starts; `sleep` is the wait itself (swapped out by tests).
async fn retry_until_done<A, AF, S, SF, W>(
    cancel: &AtomicBool,
    mut attempt: A,
    sleep: S,
    mut on_wait: W,
) -> Result<(), String>
where
    A: FnMut() -> AF,
    AF: std::future::Future<Output = Result<Step, String>>,
    S: Fn(std::time::Duration) -> SF,
    SF: std::future::Future<Output = ()>,
    W: FnMut(u32, std::time::Duration, &str),
{
    let mut failures: u32 = 0;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("Download paused".to_string());
        }
        match attempt().await? {
            Step::Done => return Ok(()),
            Step::Paused => return Err("Download paused".to_string()),
            Step::Retry {
                made_progress,
                reason,
                retry_after,
            } => {
                if made_progress {
                    failures = 0;
                }
                failures = failures.saturating_add(1);
                let wait = retry_delay(failures, retry_after);
                on_wait(failures, wait, &reason);
                tokio::select! {
                    biased;
                    _ = cancelled(cancel) => return Err("Download paused".to_string()),
                    _ = sleep(wait) => {}
                }
            }
        }
    }
}

/// What a raw OS error code means for a download, when it is one worth naming.
fn os_error_hint(code: i32) -> Option<&'static str> {
    #[cfg(windows)]
    {
        match code {
            112 => Some("there is not enough free space on the disk"),
            32 | 33 => Some("another program (often antivirus) has the file open"),
            5 => Some("access to the folder was denied"),
            3 | 206 => Some("the file path is too long for Windows; choose a data folder with a shorter path"),
            _ => None,
        }
    }
    #[cfg(not(windows))]
    {
        match code {
            28 | 122 => Some("there is not enough free space on the disk"),
            13 | 1 => Some("access to the folder was denied"),
            36 => Some("the file name is too long"),
            _ => None,
        }
    }
}

/// An error with its whole `source()` chain. reqwest's `Display` stops at
/// "error sending request for url (...)"; the part that says why (DNS, refused,
/// TLS, timeout) is only in the sources.
fn error_chain(e: &(dyn std::error::Error + 'static)) -> String {
    let mut out = e.to_string();
    let mut source = e.source();
    while let Some(cause) = source {
        let text = cause.to_string();
        if !out.ends_with(&text) {
            out.push_str(": ");
            out.push_str(&text);
        }
        source = cause.source();
    }
    out
}

/// A download file error that says what went wrong, not only the OS text.
fn io_failure(action: &str, err: &std::io::Error) -> String {
    match err.raw_os_error().and_then(os_error_hint) {
        Some(hint) => format!("{action}: {hint}. ({err})"),
        None => format!("{action}: {err}"),
    }
}

/// Windows refuses to create a path of 260 characters or more unless it is in
/// the extended form; a deep Hugging Face file name under a long data folder
/// can reach it, and the failure otherwise shows up late as a bare OS error.
#[cfg(windows)]
fn path_too_long(path: &std::path::Path) -> bool {
    let text = path.to_string_lossy();
    !text.starts_with(r"\\?\") && text.chars().count() >= 259
}

/// The `\\?\` form of an absolute Windows path (drive or UNC), which lifts the
/// 260 character limit. `None` for a path that cannot be extended (relative).
#[cfg_attr(not(windows), allow(dead_code))]
fn extended_windows_path(text: &str) -> Option<String> {
    if text.starts_with("\\\\?\\") {
        return Some(text.to_string());
    }
    let text = text.replace('/', "\\");
    if let Some(unc) = text.strip_prefix("\\\\") {
        return Some(format!("\\\\?\\UNC\\{unc}"));
    }
    let bytes = text.as_bytes();
    if bytes.len() > 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\' {
        return Some(format!("\\\\?\\{text}"));
    }
    None
}

/// `path` as is, or in extended form when it would exceed MAX_PATH on Windows.
fn long_path_safe(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    if path_too_long(&path) {
        if let Some(extended) = extended_windows_path(&path.to_string_lossy()) {
            return PathBuf::from(extended);
        }
    }
    path
}

/// Whether `path` is a regular file of exactly `size` bytes whose SHA-256
/// equals `sha256` when one is given.
async fn existing_file_matches(path: &PathBuf, size: u64, sha256: Option<&str>) -> bool {
    let Ok(meta) = tokio::fs::metadata(path).await else {
        return false;
    };
    if !meta.is_file() || meta.len() != size {
        return false;
    }
    match sha256.map(str::trim).filter(|value| !value.is_empty()) {
        None => true,
        Some(expected) => {
            let never = AtomicBool::new(false);
            sha256_file(path, &never)
                .await
                .map(|actual| actual.eq_ignore_ascii_case(expected))
                .unwrap_or(false)
        }
    }
}

/// Headroom kept free beyond the download itself, so the disk is not driven to
/// zero (the OS and the model's own `.part` rename need a little room).
const DISK_MARGIN_BYTES: u64 = 64 * 1024 * 1024;

fn gib(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / 1_073_741_824.0)
}

/// Whether a download of `total` bytes, of which `already` are on disk as a
/// partial file, fits in `free` bytes. An unknown total passes: there is
/// nothing to compare against, and a write error is still named if the disk
/// fills.
fn disk_preflight(total: Option<u64>, already: u64, free: u64) -> Result<(), String> {
    let Some(total) = total.filter(|total| *total > 0) else {
        return Ok(());
    };
    let needed = total.saturating_sub(already).saturating_add(DISK_MARGIN_BYTES);
    if free >= needed {
        return Ok(());
    }
    Err(format!(
        "Not enough free disk space for this download: it needs about {} more, but only {} is free on the drive holding the model folder. Free up space or choose another data folder in Settings.",
        gib(needed),
        gib(free)
    ))
}

fn normalize_for_mount_match(path: &std::path::Path) -> PathBuf {
    let text = path.to_string_lossy();
    let text = text.strip_prefix("\\\\?\\").unwrap_or(&text);
    #[cfg(windows)]
    let text = text.to_lowercase();
    PathBuf::from(text.to_string())
}

/// Free bytes of the disk that holds `path`: the mount with the longest prefix
/// of it. `None` when no mount matches, so the caller skips the check.
fn free_space_on(path: &std::path::Path, mounts: &[(PathBuf, u64)]) -> Option<u64> {
    let target = normalize_for_mount_match(path);
    mounts
        .iter()
        .filter(|(mount, _)| target.starts_with(normalize_for_mount_match(mount)))
        .max_by_key(|(mount, _)| normalize_for_mount_match(mount).components().count())
        .map(|(_, free)| *free)
}

// `sysinfo` is not linked on phones, which skip the free-space check.
#[cfg(any(target_os = "android", target_os = "ios"))]
fn free_space_for_path(_path: &std::path::Path) -> Option<u64> {
    None
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn free_space_for_path(path: &std::path::Path) -> Option<u64> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let mounts: Vec<(PathBuf, u64)> = disks
        .list()
        .iter()
        .map(|disk| (disk.mount_point().to_path_buf(), disk.available_space()))
        .collect();
    free_space_on(path, &mounts)
}

/// How long the free-space query may take before the check is skipped.
const FREE_SPACE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

enum Attempt {
    Finished,
    Paused,
    /// The connection failed or went quiet. `made_progress` says whether any
    /// bytes arrived before it did, which resets the count of failures.
    Retry {
        made_progress: bool,
        reason: String,
        retry_after: Option<std::time::Duration>,
    },
}

/// One request for the rest of the file, appended to the `.part` file. Network
/// trouble, 5xx, 408 and 429 come back as `Retry`; any other refusal, a
/// certificate problem or a disk error is fatal.
#[allow(clippy::too_many_arguments)]
async fn download_attempt<R: Runtime>(
    app: &tauri::AppHandle<R>,
    client: &reqwest::Client,
    url: &Url,
    task_id: &str,
    part_path: &std::path::Path,
    expected_size: Option<u64>,
    cancel: &AtomicBool,
) -> Result<Attempt, String> {
    let existing = tokio::fs::metadata(part_path)
        .await
        .map(|meta| meta.len())
        .unwrap_or(0);
    let mut request = client.get(url.clone());
    if existing > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={existing}-"));
        // Resume only if the file is still the one the partial came from. If it
        // changed, the server answers 200 with the whole new file and the
        // partial is rewritten instead of being glued onto different bytes.
        if let Some(etag) = read_part_etag(part_path).await {
            request = request.header(reqwest::header::IF_RANGE, etag);
        }
    }
    let response = tokio::select! {
        sent = tokio::time::timeout(STALL_TIMEOUT, request.send()) => match sent {
            Ok(Ok(response)) => response,
            Ok(Err(e)) => {
                let chain = error_chain(&e);
                if transport_error_is_fatal(&chain) {
                    return Err(format!("Hugging Face download failed: {chain}"));
                }
                return Ok(Attempt::Retry {
                    made_progress: false,
                    reason: format!("Hugging Face download failed: {chain}"),
                    retry_after: None,
                })
            }
            // A filtered connection or a server that never sends headers.
            Err(_) => {
                return Ok(Attempt::Retry {
                    made_progress: false,
                    reason: format!(
                        "No response from Hugging Face for {} seconds",
                        STALL_TIMEOUT.as_secs()
                    ),
                    retry_after: None,
                })
            }
        },
        _ = cancelled(cancel) => return Ok(Attempt::Paused),
    };
    let status = response.status();
    if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE && existing > 0 {
        // The partial file is not a prefix the server recognises; start over.
        let _ = tokio::fs::remove_file(part_path).await;
        return Ok(Attempt::Retry {
            made_progress: false,
            reason: "The partial download no longer matched the server".to_string(),
            retry_after: None,
        });
    }
    if status_is_transient(status) {
        return Ok(Attempt::Retry {
            made_progress: false,
            reason: format!("Hugging Face answered {status}"),
            retry_after: retry_after_of(response.headers()),
        });
    }
    if !status.is_success() {
        return Err(response_error(response).await);
    }

    if let Some(etag) = etag_of(response.headers()) {
        write_part_etag(part_path, &etag).await;
    }
    let resumed = existing > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT;
    let start = if resumed { existing } else { 0 };
    let total = response
        .content_length()
        .map(|remaining| start.saturating_add(remaining))
        .or(expected_size);
    let mut output = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resumed)
        .truncate(!resumed)
        .open(part_path)
        .await
        .map_err(|e| io_failure("Could not open the model download file", &e))?;
    let mut downloaded = start;
    let mut stream = response.bytes_stream();
    let attempt_started = std::time::Instant::now();
    let mut progress = ProgressThrottle::new();
    let emit_progress = |downloaded: u64| {
        let _ = app.emit(
            "huggingface-download-progress",
            HuggingFaceDownloadProgress {
                task_id: task_id.to_string(),
                downloaded,
                total,
                retry_in_ms: None,
                attempt: None,
            },
        );
    };

    loop {
        let next = tokio::select! {
            next = tokio::time::timeout(STALL_TIMEOUT, stream.next()) => Some(next),
            _ = cancelled(cancel) => None,
        };
        if cancel.load(Ordering::Relaxed) {
            // Keep what was written so a resume continues from it.
            let _ = output.flush().await;
            return Ok(Attempt::Paused);
        }
        let item = match next {
            Some(Ok(item)) => item,
            Some(Err(_)) => {
                let _ = output.flush().await;
                return Ok(Attempt::Retry {
                    made_progress: downloaded > start,
                    reason: format!(
                        "No data from Hugging Face for {} seconds",
                        STALL_TIMEOUT.as_secs()
                    ),
                    retry_after: None,
                });
            }
            None => return Ok(Attempt::Paused),
        };
        let Some(chunk) = item else { break };
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(e) => {
                let _ = output.flush().await;
                return Ok(Attempt::Retry {
                    made_progress: downloaded > start,
                    reason: format!("Hugging Face download interrupted: {}", error_chain(&e)),
                    retry_after: None,
                });
            }
        };
        output
            .write_all(&chunk)
            .await
            .map_err(|e| io_failure("Could not write the model download", &e))?;
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        let wait = throttle_delay(
            downloaded - start,
            attempt_started.elapsed(),
            DOWNLOAD_LIMIT_BPS.load(Ordering::Relaxed),
        );
        if !wait.is_zero() {
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = cancelled(cancel) => {}
            }
        }
        if progress.should_emit(std::time::Instant::now(), downloaded, total) {
            emit_progress(downloaded);
        }
    }
    output
        .flush()
        .await
        .map_err(|e| io_failure("Could not finish writing the model download", &e))?;
    // The last chunks may have been throttled away; the UI must end on the
    // true byte count.
    emit_progress(downloaded);
    Ok(Attempt::Finished)
}

/// Limits how often a download reports progress. A fast link delivers
/// thousands of chunks a second; each event crosses the IPC bridge and
/// re-renders the downloads list.
pub(crate) struct ProgressThrottle {
    last: Option<std::time::Instant>,
}

impl ProgressThrottle {
    const MIN_INTERVAL: std::time::Duration = std::time::Duration::from_millis(150);

    pub(crate) fn new() -> Self {
        Self { last: None }
    }

    /// Whether to emit now: the first chunk, the one that completes the file,
    /// and otherwise at most once per interval.
    pub(crate) fn should_emit(
        &mut self,
        now: std::time::Instant,
        downloaded: u64,
        total: Option<u64>,
    ) -> bool {
        let due = match self.last {
            None => true,
            Some(last) => now.saturating_duration_since(last) >= Self::MIN_INTERVAL || total == Some(downloaded),
        };
        if due {
            self.last = Some(now);
        }
        due
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn huggingface_download_model<R: Runtime>(
    app: tauri::AppHandle<R>,
    task_id: String,
    repo: String,
    filename: String,
    expected_size: Option<u64>,
    expected_sha256: Option<String>,
    token: Option<String>,
    revision: Option<String>,
    bundle_remaining: Option<u64>,
) -> Result<String, String> {
    if task_id.trim().is_empty() {
        return Err("Missing download id".to_string());
    }
    let url = remote_file_url(&repo, &filename, revision.as_deref())?;
    let final_path = download_path(&app, &repo, &filename);
    let mut part_name = final_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download")
        .to_string();
    part_name.push_str(".part");
    let part_path = final_path.with_file_name(part_name);
    if let Some(parent) = final_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Could not create model download folder: {e}"))?;
    }

    // A complete copy from an earlier install: reuse it instead of fetching
    // tens of gigabytes again. Size must match, and the hash too when given.
    if let Some(size) = expected_size {
        if existing_file_matches(&final_path, size, expected_sha256.as_deref()).await {
            return Ok(relative_download_path(&repo, &filename)
                .to_string_lossy()
                .replace('\\', "/"));
        }
    }

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut downloads = active_downloads().lock().await;
        if let Some(previous) = downloads.insert(task_id.clone(), cancel.clone()) {
            previous.store(true, Ordering::Relaxed);
        }
    }

    let result = async {
        // Before the partial's size is read: a predecessor still winding down
        // would change it under us.
        let _writer = lock_part_for_writing(&part_path, &cancel).await?;
        #[cfg(windows)]
        if path_too_long(&part_path) {
            return Err(format!(
                "The download path is too long for Windows: {}. Choose a data folder with a shorter path.",
                part_path.display()
            ));
        }
        let already = tokio::fs::metadata(&part_path)
            .await
            .map(|meta| meta.len())
            .unwrap_or(0);
        // On the blocking pool with a bound: the disk list can hang on a dead
        // network mount, and this runs before every file of a download.
        let probe_path = part_path.clone();
        if let Some(free) = jan_utils::system::run_bounded(FREE_SPACE_TIMEOUT, move || {
            free_space_for_path(&probe_path)
        })
        .await
        .flatten()
        {
            // The whole rest of the bundle must fit, not only this file: its
            // files download one after another and each would otherwise see
            // the same free space.
            let total = match (bundle_remaining, expected_size) {
                (Some(rest), Some(size)) => Some(rest.max(size)),
                (_, size) => size,
            };
            disk_preflight(total, already, free)?;
        }
        let client = hf_client(token.as_deref())?;
        let attempt = || async {
            let existing = tokio::fs::metadata(&part_path)
                .await
                .map(|meta| meta.len())
                .unwrap_or(0);
            if existing > 0 && expected_size == Some(existing) {
                return Ok(Step::Done);
            }
            Ok(
                match download_attempt(
                    &app,
                    &client,
                    &url,
                    &task_id,
                    &part_path,
                    expected_size,
                    &cancel,
                )
                .await?
                {
                    Attempt::Paused => Step::Paused,
                    Attempt::Retry {
                        made_progress,
                        reason,
                        retry_after,
                    } => Step::Retry {
                        made_progress,
                        reason,
                        retry_after,
                    },
                    // The server may end the stream cleanly but short of the
                    // size it listed: the connection was cut, so go on.
                    Attempt::Finished => {
                        let now = tokio::fs::metadata(&part_path)
                            .await
                            .map(|meta| meta.len())
                            .unwrap_or(0);
                        if expected_size.is_none_or(|size| now >= size) {
                            Step::Done
                        } else {
                            Step::Retry {
                                made_progress: now > existing,
                                reason: format!(
                                    "The connection closed after {now} of {} bytes",
                                    expected_size.unwrap_or(0)
                                ),
                                retry_after: None,
                            }
                        }
                    }
                },
            )
        };
        retry_until_done(&cancel, attempt, tokio::time::sleep, |failures, wait, reason| {
            log::warn!(
                "Hugging Face download of {repo}/{filename} will retry in {}s (attempt {failures}): {reason}",
                wait.as_secs()
            );
            // Tell the row it is waiting, so it can count down instead of
            // looking stuck.
            let downloaded = std::fs::metadata(&part_path)
                .map(|meta| meta.len())
                .unwrap_or(0);
            let _ = app.emit(
                "huggingface-download-progress",
                HuggingFaceDownloadProgress {
                    task_id: task_id.clone(),
                    downloaded,
                    total: expected_size,
                    retry_in_ms: Some(wait.as_millis() as u64),
                    attempt: Some(failures),
                },
            );
        })
        .await?;

        if let Some(size) = expected_size {
            let actual = tokio::fs::metadata(&part_path)
                .await
                .map_err(|e| format!("Could not verify model size: {e}"))?
                .len();
            if actual != size {
                // A part that is the wrong size will be the wrong size again on
                // resume; keeping it would loop the user on the same error.
                discard_part(&part_path).await;
                return Err(format!(
                    "Downloaded file size mismatch: expected {size} bytes, got {actual}. The partial download was discarded; start it again."
                ));
            }
        }
        if let Some(expected) = expected_sha256
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let actual = sha256_file(&part_path, &cancel).await?;
            if !actual.eq_ignore_ascii_case(expected) {
                discard_part(&part_path).await;
                return Err(
                    "Downloaded file failed SHA-256 verification. The partial download was discarded; start it again."
                        .to_string(),
                );
            }
        }
        if cancel.load(Ordering::Relaxed) {
            return Err("Download paused".to_string());
        }
        finalize_verified_download(&part_path, &final_path).await?;
        let _ = tokio::fs::remove_file(part_meta_path(&part_path)).await;
        Ok(relative_download_path(&repo, &filename)
            .to_string_lossy()
            .replace('\\', "/"))
    }
    .await;

    // A newer invocation for the same task id replaces our flag; only remove
    // the entry if it is still ours, or the newer download loses its cancel
    // handle and can no longer be paused.
    {
        let mut downloads = active_downloads().lock().await;
        if downloads
            .get(&task_id)
            .is_some_and(|current| Arc::ptr_eq(current, &cancel))
        {
            downloads.remove(&task_id);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct Layered(&'static str, Option<Box<dyn std::error::Error + 'static>>);

    impl std::fmt::Display for Layered {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.0)
        }
    }

    impl std::error::Error for Layered {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            self.1.as_deref()
        }
    }

    #[test]
    fn error_chain_keeps_the_cause_display_drops() {
        let io = std::io::Error::other("connection refused (os error 10061)");
        let connect = Layered("tcp connect error", Some(Box::new(io)));
        let outer = Layered("error sending request for url (https://huggingface.co/x)", Some(Box::new(connect)));
        assert_eq!(
            error_chain(&outer),
            "error sending request for url (https://huggingface.co/x): tcp connect error: connection refused (os error 10061)"
        );
    }

    #[test]
    fn throttle_waits_only_when_ahead_of_the_limit() {
        use std::time::Duration;
        // 1 MB received in 0.25 s at a 1 MB/s cap: wait the other 0.75 s.
        assert_eq!(
            throttle_delay(1_000_000, Duration::from_millis(250), 1_000_000),
            Duration::from_millis(750)
        );
        assert_eq!(throttle_delay(1_000_000, Duration::from_secs(2), 1_000_000), Duration::ZERO);
        assert_eq!(throttle_delay(1_000_000, Duration::ZERO, 0), Duration::ZERO);
    }

    #[test]
    fn retry_delay_goes_steady_after_the_quick_attempts() {
        let secs: Vec<u64> = (1..=8).map(|n| retry_delay(n, None).as_secs()).collect();
        assert_eq!(secs, vec![1, 2, 4, 8, 16, 64, 64, 64]);
        let ra = Some(std::time::Duration::from_secs(120));
        assert_eq!(retry_delay(1, ra).as_secs(), 120, "Retry-After is honoured");
        let huge = Some(std::time::Duration::from_secs(86_400));
        assert_eq!(retry_delay(1, huge), MAX_RETRY_AFTER, "Retry-After is capped");
        let short = Some(std::time::Duration::from_secs(1));
        assert_eq!(retry_delay(7, short).as_secs(), 64, "never shorter than the backoff");
    }

    #[test]
    fn transient_and_fatal_statuses_are_told_apart() {
        use reqwest::StatusCode as S;
        for status in [S::INTERNAL_SERVER_ERROR, S::BAD_GATEWAY, S::SERVICE_UNAVAILABLE, S::GATEWAY_TIMEOUT, S::TOO_MANY_REQUESTS, S::REQUEST_TIMEOUT] {
            assert!(status_is_transient(status), "{status} should retry");
        }
        for status in [S::BAD_REQUEST, S::UNAUTHORIZED, S::FORBIDDEN, S::NOT_FOUND, S::GONE] {
            assert!(!status_is_transient(status), "{status} should fail at once");
        }
    }

    #[test]
    fn retry_after_reads_seconds_only() {
        let mut headers = reqwest::header::HeaderMap::new();
        assert_eq!(retry_after_of(&headers), None);
        headers.insert(reqwest::header::RETRY_AFTER, "30".parse().unwrap());
        assert_eq!(retry_after_of(&headers), Some(std::time::Duration::from_secs(30)));
        headers.insert(reqwest::header::RETRY_AFTER, "Wed, 21 Oct 2015 07:28:00 GMT".parse().unwrap());
        assert_eq!(retry_after_of(&headers), None);
    }

    #[test]
    fn certificate_failures_are_fatal_and_network_ones_are_not() {
        assert!(transport_error_is_fatal("error sending request: invalid peer certificate: UnknownIssuer"));
        assert!(transport_error_is_fatal("self-signed certificate in certificate chain"));
        assert!(!transport_error_is_fatal("error sending request: connection reset by peer"));
        assert!(!transport_error_is_fatal("dns error: no such host is known"));
        assert!(!transport_error_is_fatal("operation timed out"));
    }

    fn transient() -> Result<Step, String> {
        Ok(Step::Retry {
            made_progress: false,
            reason: "Hugging Face answered 503".to_string(),
            retry_after: None,
        })
    }

    #[tokio::test]
    async fn retry_loop_keeps_going_past_the_quick_attempts() {
        let cancel = AtomicBool::new(false);
        let calls = std::cell::Cell::new(0u32);
        let mut waits = Vec::new();
        let result = retry_until_done(
            &cancel,
            || {
                calls.set(calls.get() + 1);
                let n = calls.get();
                async move { if n > 12 { Ok(Step::Done) } else { transient() } }
            },
            |_| async {},
            |failures, wait, _| waits.push((failures, wait.as_secs())),
        )
        .await;
        assert_eq!(result, Ok(()));
        assert_eq!(calls.get(), 13);
        assert_eq!(waits.len(), 12);
        assert_eq!(waits[5], (6, 64));
        assert_eq!(waits[11], (12, 64));
    }

    #[tokio::test]
    async fn retry_loop_progress_resets_the_backoff() {
        let cancel = AtomicBool::new(false);
        let calls = std::cell::Cell::new(0u32);
        let mut waits = Vec::new();
        let _ = retry_until_done(
            &cancel,
            || {
                calls.set(calls.get() + 1);
                let n = calls.get();
                async move {
                    match n {
                        8 => Ok(Step::Retry { made_progress: true, reason: String::new(), retry_after: None }),
                        9 => Ok(Step::Done),
                        _ => transient(),
                    }
                }
            },
            |_| async {},
            |_, wait, _| waits.push(wait.as_secs()),
        )
        .await;
        assert_eq!(waits, vec![1, 2, 4, 8, 16, 64, 64, 1]);
    }

    #[tokio::test]
    async fn retry_loop_stops_on_pause_during_the_wait() {
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let calls = std::cell::Cell::new(0u32);
        let flag = cancel.clone();
        let result = retry_until_done(
            &cancel,
            || {
                calls.set(calls.get() + 1);
                async { transient() }
            },
            // Quick waits pass at once; a steady 64 s wait never ends on its
            // own, so only the pause can end it.
            |wait| {
                let steady = wait == STEADY_RETRY;
                async move {
                    if steady {
                        std::future::pending::<()>().await
                    }
                }
            },
            |failures, _, _| {
                if failures == 6 {
                    let flag = flag.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(300));
                        flag.store(true, Ordering::Relaxed);
                    });
                }
            },
        )
        .await;
        assert_eq!(result, Err("Download paused".to_string()));
        // Past the five quick waits, the pause lands during the first 64 s one.
        assert_eq!(calls.get(), 6);
    }

    #[tokio::test]
    async fn retry_loop_fails_at_once_on_a_fatal_error() {
        let cancel = AtomicBool::new(false);
        let calls = std::cell::Cell::new(0u32);
        let result = retry_until_done(
            &cancel,
            || {
                calls.set(calls.get() + 1);
                async { Err::<Step, _>("Hugging Face answered 404".to_string()) }
            },
            |_| async {},
            |_, _, _| {},
        )
        .await;
        assert!(result.is_err());
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn retry_waits_double_up_to_thirty_two_seconds() {
        let secs: Vec<u64> = (1..=8).map(|n| retry_backoff(n).as_secs()).collect();
        assert_eq!(secs, vec![1, 2, 4, 8, 16, 32, 32, 32]);
    }

    #[test]
    fn a_full_disk_error_is_named() {
        #[cfg(windows)]
        let err = std::io::Error::from_raw_os_error(112);
        #[cfg(not(windows))]
        let err = std::io::Error::from_raw_os_error(28);
        let msg = io_failure("Could not write the model download", &err);
        assert!(msg.contains("not enough free space"), "{msg}");
    }

    #[test]
    fn an_unrecognised_error_keeps_only_the_os_text() {
        let err = std::io::Error::other("odd failure");
        assert_eq!(
            io_failure("Could not open", &err),
            "Could not open: odd failure"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_path_of_260_characters_is_too_long_unless_extended() {
        let long = std::path::PathBuf::from(format!("C:\\{}", "a".repeat(270)));
        assert!(path_too_long(&long));
        let extended = std::path::PathBuf::from(format!("\\\\?\\C:\\{}", "a".repeat(270)));
        assert!(!path_too_long(&extended));
        assert!(!path_too_long(std::path::Path::new("C:\\short\\file.gguf")));
    }

    #[test]
    fn repo_ids_are_strictly_owner_and_name() {
        assert!(valid_repo_id("bartowski/Qwen3-GGUF"));
        assert!(!valid_repo_id("bartowski/Qwen3-GGUF/extra"));
        assert!(!valid_repo_id("../Qwen"));
    }

    #[test]
    fn preflight_passes_when_the_download_fits() {
        let gb = 1u64 << 30;
        assert!(disk_preflight(Some(4 * gb), 0, 10 * gb).is_ok());
        // A partial file already on disk is not needed again.
        assert!(disk_preflight(Some(4 * gb), 3 * gb, 2 * gb).is_ok());
        // An unknown size cannot be checked.
        assert!(disk_preflight(None, 0, 0).is_ok());
        assert!(disk_preflight(Some(0), 0, 0).is_ok());
    }

    #[test]
    fn preflight_fails_early_with_an_actionable_message() {
        let gb = 1u64 << 30;
        let err = disk_preflight(Some(8 * gb), 0, 2 * gb).unwrap_err();
        assert!(err.contains("Not enough free disk space"), "{err}");
        assert!(err.contains("8.1 GB") && err.contains("2.0 GB"), "{err}");
        assert!(err.contains("data folder"), "{err}");
        // The margin counts: exactly the file size free is not enough.
        assert!(disk_preflight(Some(gb), 0, gb).is_err());
        assert!(disk_preflight(Some(gb), 0, gb + DISK_MARGIN_BYTES).is_ok());
    }

    #[test]
    fn etag_is_taken_from_etag_then_linked_etag_and_never_weak() {
        use reqwest::header::{HeaderMap, HeaderValue};
        let mut h = HeaderMap::new();
        h.insert("etag", HeaderValue::from_static("W/\"abc\""));
        h.insert("x-linked-etag", HeaderValue::from_static("\"def\""));
        assert_eq!(etag_of(&h).as_deref(), Some("\"def\""), "a weak etag is skipped");
        h.insert("etag", HeaderValue::from_static("\"strong\""));
        assert_eq!(etag_of(&h).as_deref(), Some("\"strong\""));
        assert_eq!(etag_of(&HeaderMap::new()), None);
    }

    #[tokio::test]
    async fn etag_sidecar_roundtrips_and_discard_removes_both_files() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("m.gguf.part");
        tokio::fs::write(&part, b"bytes").await.unwrap();
        assert_eq!(read_part_etag(&part).await, None, "no sidecar means no If-Range");
        write_part_etag(&part, "\"abc\"").await;
        assert_eq!(read_part_etag(&part).await.as_deref(), Some("\"abc\""));
        discard_part(&part).await;
        assert!(!part.exists() && !part_meta_path(&part).exists());
    }

    #[test]
    fn progress_throttle_emits_first_final_and_one_per_interval() {
        use std::time::Instant;
        let t0 = Instant::now();
        let mut p = ProgressThrottle::new();
        assert!(p.should_emit(t0, 10, Some(1000)), "the first chunk reports");
        assert!(!p.should_emit(t0 + std::time::Duration::from_millis(50), 20, Some(1000)));
        assert!(!p.should_emit(t0 + std::time::Duration::from_millis(149), 30, Some(1000)));
        assert!(p.should_emit(t0 + std::time::Duration::from_millis(150), 40, Some(1000)));
        assert!(!p.should_emit(t0 + std::time::Duration::from_millis(160), 50, Some(1000)));
        assert!(p.should_emit(t0 + std::time::Duration::from_millis(165), 1000, Some(1000)), "the completing chunk always reports");
        assert!(!p.should_emit(t0 + std::time::Duration::from_millis(170), 1001, None), "unknown total is throttled too");
    }

    #[test]
    fn free_space_uses_the_most_specific_mount() {
        let (root, data, inside, outside) = if cfg!(windows) {
            ("C:\\", "C:\\Data", "C:\\Data\\models\\a.part", "C:\\Users\\a.part")
        } else {
            ("/", "/data", "/data/models/a.part", "/home/a.part")
        };
        let mounts = vec![(PathBuf::from(root), 100), (PathBuf::from(data), 7)];
        assert_eq!(free_space_on(std::path::Path::new(inside), &mounts), Some(7));
        assert_eq!(free_space_on(std::path::Path::new(outside), &mounts), Some(100));
        assert_eq!(free_space_on(std::path::Path::new("relative/a.part"), &mounts), None);
    }

    #[test]
    fn remote_paths_allow_model_assets_but_not_traversal() {
        assert!(valid_remote_path("model-q4_k_m.gguf"));
        assert!(valid_remote_path("tokenizer/tokenizer.json"));
        assert!(valid_remote_path("model-00001-of-00002.safetensors"));
        assert!(!valid_remote_path("../secret"));
        assert!(!valid_remote_path("folder/../secret"));
        assert!(!valid_remote_path("folder\\secret"));
    }

    #[test]
    fn resolve_url_stays_on_hugging_face() {
        let base = crate::core::hf_endpoint::parse_endpoint(None).unwrap();
        let url = remote_file_url_on(&base, "bartowski/Qwen3-GGUF", "sub/model.gguf", None).unwrap();
        assert_eq!(url.host_str(), Some("huggingface.co"));
        assert!(url.path().contains("/resolve/main/sub/model.gguf"));
    }

    #[test]
    fn revision_is_used_and_validated() {
        let base = crate::core::hf_endpoint::parse_endpoint(None).unwrap();
        let sha = "0123456789abcdef0123456789abcdef01234567";
        let url = remote_file_url_on(&base, "o/n", "m.gguf", Some(sha)).unwrap();
        assert!(url.path().contains(&format!("/resolve/{sha}/m.gguf")));
        let blank = remote_file_url_on(&base, "o/n", "m.gguf", Some("  ")).unwrap();
        assert!(blank.path().contains("/resolve/main/"));
        assert!(remote_file_url_on(&base, "o/n", "m.gguf", Some("../x")).is_err());
        assert!(remote_file_url_on(&base, "o/n", "m.gguf", Some("a/b")).is_err());
    }

    #[test]
    fn long_windows_paths_get_the_extended_prefix() {
        assert_eq!(
            extended_windows_path("C:/data/a.gguf").as_deref(),
            Some("\\\\?\\C:\\data\\a.gguf")
        );
        assert_eq!(
            extended_windows_path("\\\\srv\\share\\a").as_deref(),
            Some("\\\\?\\UNC\\srv\\share\\a")
        );
        assert_eq!(
            extended_windows_path("\\\\?\\C:\\a").as_deref(),
            Some("\\\\?\\C:\\a")
        );
        assert_eq!(extended_windows_path("relative\\a"), None);
    }

    #[test]
    fn bundle_preflight_counts_the_remaining_files() {
        let gb = 1_073_741_824u64;
        assert!(disk_preflight(Some(10 * gb), 0, 11 * gb).is_ok());
        assert!(disk_preflight(Some(20 * gb), 0, 11 * gb).is_err());
    }

    #[tokio::test]
    async fn a_complete_existing_file_is_reused_only_when_it_matches() {
        let dir = std::env::temp_dir().join(format!("flint-hf-reuse-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("m.gguf");
        std::fs::write(&file, b"hello").unwrap();
        let hello = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        assert!(existing_file_matches(&file, 5, None).await);
        assert!(existing_file_matches(&file, 5, Some(hello)).await);
        assert!(!existing_file_matches(&file, 6, None).await);
        assert!(!existing_file_matches(&file, 5, Some("00")).await);
        assert!(!existing_file_matches(&dir.join("none"), 5, None).await);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn download_path_keeps_repo_and_subdirectories_distinct() {
        let rel = relative_download_path("owner/repo", "tokenizer/files.json");
        assert_eq!(
            rel.to_string_lossy().replace('\\', "/"),
            "downloads/huggingface/owner/repo/tokenizer/files.json"
        );
    }

    #[tokio::test]
    async fn a_second_writer_waits_for_the_first_and_gives_up_when_cancelled() {
        let path = std::path::Path::new("lock-test/model.gguf.part");
        let first_cancel = AtomicBool::new(false);
        let first = lock_part_for_writing(path, &first_cancel).await.unwrap();

        // Cancelled while waiting: gives up instead of hanging.
        let cancelled_task = AtomicBool::new(true);
        assert!(lock_part_for_writing(path, &cancelled_task).await.is_err());

        // Not cancelled: only proceeds once the first lets go.
        let waiting = tokio::spawn(async move {
            let cancel = AtomicBool::new(false);
            lock_part_for_writing(std::path::Path::new("lock-test/model.gguf.part"), &cancel)
                .await
                .map(|_| ())
        });
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(!waiting.is_finished());
        drop(first);
        assert!(waiting.await.unwrap().is_ok());

        // Another file is never held up.
        let other = std::path::Path::new("lock-test/other.gguf.part");
        assert!(lock_part_for_writing(other, &AtomicBool::new(false)).await.is_ok());
    }
}
