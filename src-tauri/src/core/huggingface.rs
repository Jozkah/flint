use crate::core::app::commands::get_jan_data_folder_path;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{Emitter, Runtime};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use url::Url;

const HF_HOST: &str = "huggingface.co";
const MAX_SEARCH_RESULTS: &str = "30";

static ACTIVE_DOWNLOADS: OnceLock<Mutex<HashMap<String, CancellationToken>>> = OnceLock::new();

fn active_downloads() -> &'static Mutex<HashMap<String, CancellationToken>> {
    ACTIVE_DOWNLOADS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HuggingFaceModel {
    pub id: String,
    pub downloads: u64,
    pub likes: u64,
    pub gated: bool,
    pub tags: Vec<String>,
    pub pipeline_tag: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HuggingFaceFile {
    pub name: String,
    pub size: Option<u64>,
    pub sha256: Option<String>,
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
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    likes: u64,
    #[serde(default)]
    gated: serde_json::Value,
    #[serde(default)]
    tags: Vec<String>,
    pipeline_tag: Option<String>,
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

fn hf_client(token: Option<&str>) -> Result<reqwest::Client, String> {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::USER_AGENT,
        reqwest::header::HeaderValue::from_static("Flint/explicit-huggingface-download"),
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

fn valid_remote_filename(filename: &str) -> bool {
    !filename.is_empty()
        && filename.to_ascii_lowercase().ends_with(".gguf")
        && !filename.split('/').any(|part| part.is_empty() || part == "." || part == "..")
        && !filename.contains('\\')
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
    if trimmed.is_empty() { "model".to_string() } else { trimmed }
}

fn download_path<R: Runtime>(app: &tauri::AppHandle<R>, repo: &str, filename: &str) -> PathBuf {
    let basename = Path::new(filename)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("model.gguf");
    get_jan_data_folder_path(app.clone())
        .join("downloads")
        .join("huggingface")
        .join(safe_component(repo))
        .join(safe_component(basename))
}

fn model_file_url(repo: &str, filename: &str) -> Result<Url, String> {
    if !valid_repo_id(repo) {
        return Err("Invalid Hugging Face repository id".to_string());
    }
    if !valid_remote_filename(filename) {
        return Err("Only safe .gguf files can be downloaded".to_string());
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
        format!("Hugging Face returned {status}: {}", detail.chars().take(300).collect::<String>())
    }
}

#[tauri::command]
pub async fn huggingface_search_models(
    query: String,
    token: Option<String>,
) -> Result<Vec<HuggingFaceModel>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let mut url = api_url(&["api", "models"])?;
    url.query_pairs_mut()
        .append_pair("search", query)
        .append_pair("filter", "gguf")
        .append_pair("sort", "downloads")
        .append_pair("direction", "-1")
        .append_pair("limit", MAX_SEARCH_RESULTS);
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
            downloads: model.downloads,
            likes: model.likes,
            gated: gated(&model.gated),
            tags: model.tags,
            pipeline_tag: model.pipeline_tag,
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
        .filter(|file| valid_remote_filename(&file.rfilename))
        .map(|file| HuggingFaceFile {
            name: file.rfilename,
            size: file.lfs.as_ref().and_then(|lfs| lfs.size).or(file.size),
            sha256: file.lfs.and_then(|lfs| lfs.sha256),
        })
        .collect();
    files.sort_by(|a, b| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()));
    Ok(files)
}

#[tauri::command]
pub async fn huggingface_cancel_download(task_id: String) -> Result<(), String> {
    let downloads = active_downloads().lock().await;
    let Some(token) = downloads.get(&task_id) else {
        return Err("No active Hugging Face download with that id".to_string());
    };
    token.cancel();
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
    let url = model_file_url(&repo, &filename)?;
    let final_path = download_path(&app, &repo, &filename);
    let part_path = final_path.with_extension("gguf.part");
    if let Some(parent) = final_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Could not create model download folder: {e}"))?;
    }

    let cancel = CancellationToken::new();
    {
        let mut downloads = active_downloads().lock().await;
        if let Some(previous) = downloads.insert(task_id.clone(), cancel.clone()) {
            previous.cancel();
        }
    }

    let result = async {
        let client = hf_client(token.as_deref())?;
        let existing = tokio::fs::metadata(&part_path)
            .await
            .map(|meta| meta.len())
            .unwrap_or(0);
        let mut request = client.get(url.clone());
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
            if cancel.is_cancelled() {
                return Err("Download cancelled".to_string());
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
        output.flush().await.map_err(|e| format!("Could not flush model download: {e}"))?;

        if let Some(size) = expected_size {
            let actual = tokio::fs::metadata(&part_path)
                .await
                .map_err(|e| format!("Could not verify model size: {e}"))?
                .len();
            if actual != size {
                return Err(format!("Downloaded model size mismatch: expected {size} bytes, got {actual}"));
            }
        }
        if let Some(expected) = expected_sha256
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let actual = jan_utils::crypto::compute_file_sha256_with_cancellation(&part_path, &cancel)
                .await
                .map_err(|e| format!("Could not verify model SHA-256: {e}"))?;
            if !actual.eq_ignore_ascii_case(expected) {
                return Err("Downloaded model failed SHA-256 verification".to_string());
            }
        }
        if cancel.is_cancelled() {
            return Err("Download cancelled".to_string());
        }
        tokio::fs::rename(&part_path, &final_path)
            .await
            .map_err(|e| format!("Could not finalize model download: {e}"))?;
        Ok(final_path.to_string_lossy().into_owned())
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
        assert!(!valid_repo_id("Qwen3-GGUF"));
        assert!(!valid_repo_id("a/b/c"));
        assert!(!valid_repo_id("../b"));
    }

    #[test]
    fn model_files_must_be_safe_gguf_paths() {
        assert!(valid_remote_filename("Q4_K_M/model.gguf"));
        assert!(!valid_remote_filename("../model.gguf"));
        assert!(!valid_remote_filename("model.safetensors"));
        assert!(!valid_remote_filename("dir\\model.gguf"));
    }

    #[test]
    fn model_url_never_leaves_hugging_face() {
        let url = model_file_url("bartowski/Qwen3-GGUF", "Qwen3-Q4_K_M.gguf").unwrap();
        assert_eq!(url.host_str(), Some(HF_HOST));
        assert!(url.path().contains("/resolve/main/"));
    }
}
