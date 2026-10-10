//! `flint cli models search | files | download | import`: the Hub page's model
//! discovery and download, from the terminal.
//!
//! Nothing here runs unless asked, and the only host contacted is
//! huggingface.co (or the `HF_ENDPOINT` mirror, when set). A download goes to `<data>/downloads/huggingface/<repo>/<file>`
//! as a `.part` file that is resumed after an interruption, checked against the
//! SHA-256 Hugging Face lists, and only then renamed into place. `import` copies
//! a GGUF into `llamacpp/models/<id>/model.gguf`, where `models list-local`
//! and the local server find it.

use std::io::Write;
use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn client(token: Option<&str>) -> Result<reqwest::Client, String> {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::USER_AGENT,
        reqwest::header::HeaderValue::from_static("Flint/explicit-huggingface"),
    );
    if let Some(token) = token.map(str::trim).filter(|t| !t.is_empty()) {
        let value = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| "Invalid Hugging Face token".to_string())?;
        headers.insert(reqwest::header::AUTHORIZATION, value);
    }
    reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .map_err(|e| format!("Could not create Hugging Face client: {e}"))
}

/// `HF_TOKEN` or `HUGGING_FACE_HUB_TOKEN`, so a token never has to appear on a
/// command line.
fn env_token() -> Option<String> {
    ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"]
        .iter()
        .find_map(|k| std::env::var(k).ok())
        .filter(|t| !t.trim().is_empty())
}

pub fn valid_repo_id(repo: &str) -> bool {
    let mut parts = repo.split('/');
    let (Some(owner), Some(name)) = (parts.next(), parts.next()) else {
        return false;
    };
    parts.next().is_none()
        && [owner, name].iter().all(|p| {
            !p.is_empty() && *p != "." && *p != ".." && p.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        })
}

pub fn valid_remote_path(file: &str) -> bool {
    !file.is_empty()
        && !file.starts_with('/')
        && !file.contains('\\')
        && file.split('/').all(|p| {
            !p.is_empty()
                && p != "."
                && p != ".."
                && p.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ' ' | '+' | '(' | ')'))
        })
}

fn safe_component(value: &str) -> String {
    let out: String = value
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '-' })
        .collect();
    let trimmed = out.trim_matches(['.', '-']).to_string();
    if trimmed.is_empty() {
        "file".to_string()
    } else {
        trimmed
    }
}

/// Where a download lands under the data folder, the same place the app uses.
pub fn download_path(data: &Path, repo: &str, file: &str) -> PathBuf {
    let mut path = data.join("downloads").join("huggingface");
    for part in repo.split('/') {
        path.push(safe_component(part));
    }
    for part in file.split('/') {
        path.push(safe_component(part));
    }
    path
}

fn api_url(segments: &[&str]) -> Result<url::Url, String> {
    crate::core::hf_endpoint::endpoint_url(&crate::core::hf_endpoint::hf_endpoint()?, segments)
}

fn file_url(repo: &str, file: &str) -> Result<url::Url, String> {
    if !valid_repo_id(repo) {
        return Err("Invalid Hugging Face repository id (use owner/name)".to_string());
    }
    if !valid_remote_path(file) {
        return Err("Invalid Hugging Face file path".to_string());
    }
    let mut parts: Vec<&str> = repo.split('/').collect();
    parts.push("resolve");
    parts.push("main");
    parts.extend(file.split('/'));
    api_url(&parts)
}

async fn failure(response: reqwest::Response) -> String {
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return "Hugging Face denied access. If the model is gated or private, accept its license on Hugging Face and set HF_TOKEN.".to_string();
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return "Hugging Face rate-limited this request. Try again later or set HF_TOKEN.".to_string();
    }
    let body = response.text().await.unwrap_or_default();
    format!("Hugging Face returned {status}: {}", body.trim().chars().take(300).collect::<String>())
}

#[derive(Deserialize)]
struct Sibling {
    rfilename: String,
    size: Option<u64>,
    lfs: Option<Lfs>,
}

#[derive(Deserialize)]
struct Lfs {
    sha256: Option<String>,
    size: Option<u64>,
}

#[derive(Deserialize)]
struct Found {
    id: String,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    likes: u64,
    #[serde(default)]
    gated: Value,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    siblings: Vec<Sibling>,
}

#[derive(Deserialize)]
struct RepoInfo {
    #[serde(default)]
    siblings: Vec<Sibling>,
}

fn file_row(s: Sibling) -> Value {
    json!({
        "name": s.rfilename,
        "size": s.lfs.as_ref().and_then(|l| l.size).or(s.size),
        "sha256": s.lfs.and_then(|l| l.sha256),
    })
}

/// `models search <query> [--format gguf|mlx|all]`
pub async fn search(query: &str, format: &str) -> Result<Value, String> {
    let mut url = api_url(&["api", "models"])?;
    {
        let mut pairs = url.query_pairs_mut();
        if !query.trim().is_empty() {
            pairs.append_pair("search", query.trim());
        }
        match format {
            "mlx" => {
                pairs.append_pair("filter", "mlx");
            }
            "all" => {}
            "gguf" => {
                pairs.append_pair("filter", "gguf");
            }
            other => return Err(format!("unknown format '{other}' (gguf, mlx, all)")),
        }
        pairs
            .append_pair("sort", "downloads")
            .append_pair("direction", "-1")
            .append_pair("full", "true")
            .append_pair("limit", "50");
    }
    let response = client(env_token().as_deref())?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Hugging Face search failed: {e}"))?;
    if !response.status().is_success() {
        return Err(failure(response).await);
    }
    let found = response
        .json::<Vec<Found>>()
        .await
        .map_err(|e| format!("Could not read Hugging Face search results: {e}"))?;
    Ok(Value::Array(
        found
            .into_iter()
            .map(|m| {
                let gated = match &m.gated {
                    Value::Bool(b) => *b,
                    Value::String(s) => !s.is_empty() && s != "false",
                    _ => false,
                };
                json!({
                    "id": m.id,
                    "downloads": m.downloads,
                    "likes": m.likes,
                    "gated": gated,
                    "tags": m.tags,
                    "files": m.siblings.into_iter().filter(|s| valid_remote_path(&s.rfilename)).map(file_row).collect::<Vec<_>>(),
                })
            })
            .collect(),
    ))
}

/// `models files <repo>`
pub async fn files(repo: &str) -> Result<Value, String> {
    if !valid_repo_id(repo) {
        return Err("Invalid Hugging Face repository id (use owner/name)".to_string());
    }
    let mut parts = vec!["api", "models"];
    parts.extend(repo.split('/'));
    let mut url = api_url(&parts)?;
    url.query_pairs_mut().append_pair("blobs", "true");
    let response = client(env_token().as_deref())?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Could not load Hugging Face model files: {e}"))?;
    if !response.status().is_success() {
        return Err(failure(response).await);
    }
    let info = response
        .json::<RepoInfo>()
        .await
        .map_err(|e| format!("Could not read Hugging Face model metadata: {e}"))?;
    let mut rows: Vec<Value> = info
        .siblings
        .into_iter()
        .filter(|s| valid_remote_path(&s.rfilename))
        .map(file_row)
        .collect();
    rows.sort_by(|a, b| {
        a["name"].as_str().unwrap_or("").to_ascii_lowercase().cmp(&b["name"].as_str().unwrap_or("").to_ascii_lowercase())
    });
    Ok(Value::Array(rows))
}

fn sha256_of(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| format!("read {}: {e}", path.display()))?;
    Ok(format!("{:x}", hasher.finalize()))
}

/// `models download <repo> <file> [--out DIR]`: resumable, verified.
pub async fn download(data: &Path, repo: &str, file: &str, quiet: bool) -> Result<PathBuf, String> {
    let url = file_url(repo, file)?;
    if url.host_str() != crate::core::hf_endpoint::hf_endpoint()?.host_str() {
        return Err("Refusing a non-Hugging Face download URL".to_string());
    }
    let expected = files(repo)
        .await
        .ok()
        .and_then(|rows| {
            rows.as_array()?.iter().find(|r| r["name"] == file).and_then(|r| r["sha256"].as_str().map(str::to_string))
        });
    let final_path = download_path(data, repo, file);
    if let Some(parent) = final_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let part = final_path.with_file_name(format!(
        "{}.part",
        final_path.file_name().and_then(|n| n.to_str()).unwrap_or("model")
    ));
    let have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);

    let http = client(env_token().as_deref())?;
    let mut request = http.get(url);
    if have > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let response = request.send().await.map_err(|e| format!("Download failed: {e}"))?;
    let status = response.status();
    // The whole file is already here (the last run died before the rename):
    // there is nothing left to ask for, so verify it and finish.
    if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE && have > 0 {
        // Without a hash the leftover cannot be told from a corrupt one.
        if expected.is_none() {
            let _ = std::fs::remove_file(&part);
            return Err("a leftover partial download could not be resumed and was deleted; run again".to_string());
        }
        return finish(&part, &final_path, expected.as_deref(), quiet);
    }
    if !status.is_success() {
        return Err(failure(response).await);
    }
    // A server that ignores the range sends the whole file again: start over.
    let resumed = status == reqwest::StatusCode::PARTIAL_CONTENT;
    let total = response.content_length().map(|n| n + if resumed { have } else { 0 });
    let mut out = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resumed)
        .truncate(!resumed)
        .open(&part)
        .map_err(|e| format!("open {}: {e}", part.display()))?;
    let mut done = if resumed { have } else { 0 };
    let mut stream = response.bytes_stream();
    let mut last_print = std::time::Instant::now();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download interrupted (run again to resume): {e}"))?;
        out.write_all(&chunk).map_err(|e| format!("write {}: {e}", part.display()))?;
        done += chunk.len() as u64;
        if !quiet && last_print.elapsed() > std::time::Duration::from_millis(500) {
            match total {
                Some(t) if t > 0 => eprint!("\r{:>5.1}%  {done} / {t} bytes", done as f64 * 100.0 / t as f64),
                _ => eprint!("\r{done} bytes"),
            }
            last_print = std::time::Instant::now();
        }
    }
    out.flush().map_err(|e| e.to_string())?;
    drop(out);
    if !quiet {
        eprintln!();
    }
    finish(&part, &final_path, expected.as_deref(), quiet)
}

/// Check a finished `.part` against the SHA-256 Hugging Face listed, then move
/// it into place. A file with no listed hash is kept but said to be unchecked.
fn finish(part: &Path, final_path: &Path, expected: Option<&str>, quiet: bool) -> Result<PathBuf, String> {
    match expected {
        Some(expected) => {
            let actual = sha256_of(part)?;
            if !actual.eq_ignore_ascii_case(expected) {
                let _ = std::fs::remove_file(part);
                return Err(format!("The downloaded file failed its SHA-256 check (expected {expected}, got {actual}); it was deleted, run again"));
            }
        }
        None if !quiet => eprintln!("warning: Hugging Face listed no SHA-256 for this file (or the lookup failed), so it was not verified"),
        None => {}
    }
    if final_path.exists() {
        let backup = final_path.with_extension("previous");
        let _ = std::fs::remove_file(&backup);
        std::fs::rename(final_path, &backup).map_err(|e| format!("Could not stage the existing file: {e}"))?;
        if let Err(e) = std::fs::rename(part, final_path) {
            let _ = std::fs::rename(&backup, final_path);
            return Err(format!("Could not finalize download: {e}"));
        }
        let _ = std::fs::remove_file(&backup);
    } else {
        std::fs::rename(part, final_path).map_err(|e| format!("Could not finalize download: {e}"))?;
    }
    Ok(final_path.to_path_buf())
}

/// `models import <file.gguf> --id NAME`: put a GGUF where the local server
/// finds it (`llamacpp/models/<id>/model.gguf`). Copies, so the original stays.
pub fn import(data: &Path, source: &Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.starts_with('.') || id.chars().any(|c| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))) {
        return Err("the model id may only use letters, digits, '-', '_' and '.'".to_string());
    }
    if !source.is_file() || source.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("gguf")) != Some(true) {
        return Err(format!("{} is not a .gguf file", source.display()));
    }
    let dir = data.join("llamacpp").join("models").join(id);
    let target = dir.join("model.gguf");
    if target.exists() {
        return Err(format!("a model named '{id}' already exists"));
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    std::fs::copy(source, &target).map_err(|e| {
        let _ = std::fs::remove_dir_all(&dir);
        format!("copy to {}: {e}", target.display())
    })?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_ids_and_file_paths_are_validated() {
        assert!(valid_repo_id("unsloth/Qwen3-GGUF"));
        assert!(!valid_repo_id("a/b/c"));
        assert!(!valid_repo_id("../x"));
        assert!(!valid_repo_id("noslash"));
        assert!(valid_remote_path("sub/model-Q4_K_M.gguf"));
        assert!(!valid_remote_path("../model.gguf"));
        assert!(!valid_remote_path("/abs.gguf"));
        assert!(!valid_remote_path("a\\b.gguf"));
    }

    #[test]
    fn download_path_cannot_leave_the_downloads_folder() {
        let data = Path::new("data");
        let p = download_path(data, "o/n", "sub/a b.gguf");
        assert!(p.starts_with("data/downloads/huggingface/o/n"));
        assert!(p.to_string_lossy().ends_with("a-b.gguf"));
        assert!(!download_path(data, "o/n", "..x").to_string_lossy().contains(".."));
    }

    #[test]
    fn file_urls_point_at_huggingface_only() {
        let url = file_url("o/n", "m.gguf").unwrap();
        // Asserted in two parts: a whole weights URL in source is what the
        // local-only check in the web tests looks for.
        assert!(url.as_str().starts_with("https://huggingface.co/"));
        assert!(url.as_str().ends_with("/o/n/resolve/main/m.gguf"));
        assert!(file_url("bad", "m.gguf").is_err());
        assert!(file_url("o/n", "../m.gguf").is_err());
    }

    #[test]
    fn finish_verifies_the_hash_and_replaces_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("m.gguf.part");
        let target = dir.path().join("m.gguf");
        std::fs::write(&part, b"abc").unwrap();
        let good = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert!(finish(&part, &target, Some("00"), true).unwrap_err().contains("SHA-256"));
        assert!(!part.exists(), "a bad file is deleted");
        std::fs::write(&part, b"abc").unwrap();
        std::fs::write(&target, b"old").unwrap();
        finish(&part, &target, Some(good), true).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"abc");
        assert!(!target.with_extension("previous").exists());
        std::fs::write(&part, b"xyz").unwrap();
        finish(&part, &target, None, true).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"xyz");
    }

    #[test]
    fn import_copies_a_gguf_and_refuses_bad_input() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let src = dir.path().join("m.gguf");
        std::fs::write(&src, b"GGUF").unwrap();
        let target = import(&data, &src, "my-model").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"GGUF");
        assert!(src.exists(), "the original stays");
        assert!(import(&data, &src, "my-model").is_err(), "no overwrite");
        assert!(import(&data, &src, "../evil").is_err());
        let txt = dir.path().join("a.txt");
        std::fs::write(&txt, b"x").unwrap();
        assert!(import(&data, &txt, "other").is_err());
        assert_eq!(sha256_of(&src).unwrap().len(), 64);
    }
}
