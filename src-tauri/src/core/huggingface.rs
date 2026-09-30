use crate::core::app::commands::get_jan_data_folder_path;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::{Emitter, Runtime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;
use url::Url;

const HF_HOST: &str = "huggingface.co";
const MAX_SEARCH_RESULTS: &str = "50";
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

fn hf_client(token: Option<&str>) -> Result<reqwest::Client, String> {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::USER_AGENT,
        reqwest::header::HeaderValue::from_static("Flint/explicit-huggingface"),
    );
    if let Some(token) = token.map(str::trim).filter(|token| !token.is_empty()) {
        let value = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| "Invalid Hugging Face token".to_string())?;
        headers.insert(reqwest::header::AUTHORIZATION, value);
    }
    reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .map_err(|e| format!("Could not create Hugging Face client: {e}"))
}

fn api_url(path: &[&str]) -> Result<Url, String> {
    let mut url = Url::parse("https://huggingface.co").map_err(|e| e.to_string())?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "Invalid Hugging Face base URL".to_string())?;
        for part in path {
            segments.push(part);
        }
    }
    Ok(url)
}

fn valid_repo_id(repo: &str) -> bool {
    let mut parts = repo.split('/');
    let Some(owner) = parts.next() else { return false };
    let Some(name) = parts.next() else { return false };
    parts.next().is_none()
        && !owner.is_empty()
        && !name.is_empty()
        && [owner, name].iter().all(|part| {
            part.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        })
}

fn valid_remote_path(filename: &str) -> bool {
    !filename.is_empty()
        && !filename.starts_with('/')
        && !filename.contains('\\')
        && filename.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && part
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ' ' | '+' | '(' | ')'))
        })
}

fn gated(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Bool(v) => *v,
        serde_json::Value::String(v) => !v.is_empty() && v != "false",
        _ => false,
    }
}

fn safe_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
            out.push(c);
        } else {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches(['.', '-']).to_string();
    if trimmed.is_empty() {
        "file".to_string()
    } else {
        trimmed
    }
}

fn relative_download_path(repo: &str, filename: &str) -> PathBuf {
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
    get_jan_data_folder_path(app.clone()).join(relative_download_path(repo, filename))
}

fn remote_file_url(repo: &str, filename: &str) -> Result<Url, String> {
    if !valid_repo_id(repo) {
        return Err("Invalid Hugging Face repository id".to_string());
    }
    if !valid_remote_path(filename) {
        return Err("Invalid Hugging Face file path".to_string());
    }
    let mut url = Url::parse("https://huggingface.co").map_err(|e| e.to_string())?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "Invalid Hugging Face base URL".to_string())?;
        for part in repo.split('/') {
            segments.push(part);
        }
        segments.push("resolve");
        segments.push("main");
        for part in filename.split('/') {
            segments.push(part);
        }
    }
    if url.host_str() != Some(HF_HOST) {
        return Err("Refusing a non-Hugging Face download URL".to_string());
    }
    Ok(url)
}

async fn response_error(response: reqwest::Response) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
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
) -> Result<Vec<HuggingFaceModel>, String> {
    let query = query.trim();
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
            _ => {
                pairs.append_pair("filter", "gguf");
            }
        }
        pairs
            .append_pair("sort", "downloads")
            .append_pair("direction", "-1")
            .append_pair("full", "true")
            .append_pair("limit", MAX_SEARCH_RESULTS);
    }
    let response = hf_client(token.as_deref())?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Hugging Face search failed: {e}"))?;
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
        .send()
        .await
        .map_err(|e| format!("Could not load Hugging Face model files: {e}"))?;
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
    files.sort_by(|a, b| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()));
    Ok(files)
}

#[tauri::command]
pub async fn huggingface_readme(repo: String, token: Option<String>) -> Result<String, String> {
    let url = remote_file_url(&repo, "README.md")?;
    let response = hf_client(token.as_deref())?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Could not load Hugging Face README: {e}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(String::new());
    }
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    if response.content_length().unwrap_or(0) > MAX_README_BYTES {
        return Err("Hugging Face README is too large to display".to_string());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Could not read Hugging Face README: {e}"))?;
    if bytes.len() as u64 > MAX_README_BYTES {
        return Err("Hugging Face README is too large to display".to_string());
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| "Hugging Face README is not UTF-8".to_string())
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
    let url = remote_file_url(&repo, &filename)?;
    let mut response = hf_client(token.as_deref())?
        .get(url)
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

#[tauri::command]
pub async fn huggingface_download_model<R: Runtime>(
    app: tauri::AppHandle<R>,
    task_id: String,
    repo: String,
    filename: String,
    expected_size: Option<u64>,
    expected_sha256: Option<String>,
    token: Option<String>,
) -> Result<String, String> {
    if task_id.trim().is_empty() {
        return Err("Missing download id".to_string());
    }
    let url = remote_file_url(&repo, &filename)?;
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

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut downloads = active_downloads().lock().await;
        if let Some(previous) = downloads.insert(task_id.clone(), cancel.clone()) {
            previous.store(true, Ordering::Relaxed);
        }
    }

    let result = async {
        let existing = tokio::fs::metadata(&part_path)
            .await
            .map(|meta| meta.len())
            .unwrap_or(0);

        if expected_size != Some(existing) || existing == 0 {
            let client = hf_client(token.as_deref())?;
            let mut request = client.get(url);
            if existing > 0 {
                request = request.header(reqwest::header::RANGE, format!("bytes={existing}-"));
            }
            let response = request
                .send()
                .await
                .map_err(|e| format!("Hugging Face download failed: {e}"))?;
            if !response.status().is_success() {
                return Err(response_error(response).await);
            }

            let resumed = existing > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
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
                .open(&part_path)
                .await
                .map_err(|e| format!("Could not open model download file: {e}"))?;
            let mut downloaded = start;
            let mut stream = response.bytes_stream();

            while let Some(chunk) = stream.next().await {
                if cancel.load(Ordering::Relaxed) {
                    return Err("Download paused".to_string());
                }
                let chunk = chunk.map_err(|e| format!("Hugging Face download interrupted: {e}"))?;
                output
                    .write_all(&chunk)
                    .await
                    .map_err(|e| format!("Could not write model download: {e}"))?;
                downloaded = downloaded.saturating_add(chunk.len() as u64);
                let _ = app.emit(
                    "huggingface-download-progress",
                    HuggingFaceDownloadProgress {
                        task_id: task_id.clone(),
                        downloaded,
                        total,
                    },
                );
            }
            output
                .flush()
                .await
                .map_err(|e| format!("Could not flush model download: {e}"))?;
        }

        if let Some(size) = expected_size {
            let actual = tokio::fs::metadata(&part_path)
                .await
                .map_err(|e| format!("Could not verify model size: {e}"))?
                .len();
            if actual != size {
                return Err(format!(
                    "Downloaded file size mismatch: expected {size} bytes, got {actual}"
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
                return Err("Downloaded file failed SHA-256 verification".to_string());
            }
        }
        if cancel.load(Ordering::Relaxed) {
            return Err("Download paused".to_string());
        }
        finalize_verified_download(&part_path, &final_path).await?;
        Ok(relative_download_path(&repo, &filename)
            .to_string_lossy()
            .replace('\\', "/"))
    }
    .await;

    active_downloads().lock().await.remove(&task_id);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_ids_are_strictly_owner_and_name() {
        assert!(valid_repo_id("bartowski/Qwen3-GGUF"));
        assert!(!valid_repo_id("bartowski/Qwen3-GGUF/extra"));
        assert!(!valid_repo_id("../Qwen"));
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
        let url = remote_file_url("bartowski/Qwen3-GGUF", "sub/model.gguf").unwrap();
        assert_eq!(url.host_str(), Some(HF_HOST));
        assert!(url.path().contains("/resolve/main/sub/model.gguf"));
    }

    #[test]
    fn download_path_keeps_repo_and_subdirectories_distinct() {
        let rel = relative_download_path("owner/repo", "tokenizer/files.json");
        assert_eq!(
            rel.to_string_lossy().replace('\\', "/"),
            "downloads/huggingface/owner/repo/tokenizer/files.json"
        );
    }
}
