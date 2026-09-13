//! Semantic code search (AH-071).
//!
//! Finds code by meaning rather than by spelling: the project's text files are
//! cut into overlapping line ranges, each range is turned into a vector by an
//! embedding model, and a query is answered with the ranges whose vectors are
//! closest to the query's. "try again later" finds a function called
//! `with_backoff` although the two share no word.
//!
//! ## Only with a real embedding model
//!
//! Semantic search needs an embedding model, and nothing here pretends
//! otherwise. The model is named by the user -- `embeddings_model =
//! "<provider>/<model>"` in `~/.jan/config.toml` (the provider's base URL and
//! key come from its entry there), or `JAN_EMBEDDINGS_MODEL`, with
//! `JAN_EMBEDDINGS_URL` and `JAN_EMBEDDINGS_KEY` for a provider that is not
//! configured. Without one, or when the provider does not serve embeddings (a
//! llama.cpp server started without `--embeddings` answers 501), the tool
//! fails with `tool_unavailable` and says so. It never falls back to a text
//! search and never calls a text search semantic: `grep` and `symbol_find` are
//! the text searches, and they are named as such.
//!
//! ## What is sent, and what is kept
//!
//! File ranges are sent to the embedding provider the user named, and nowhere
//! else. Anything that looks like a credential is scrubbed from a range before
//! it is sent, and files that exist to hold secrets (`.env*`, keys,
//! certificates) are never read. Vectors are kept under the data folder, keyed
//! by the project path and the model: a different model starts afresh, and a
//! file whose content hash is unchanged is not sent again.
//!
//! ## Cancellation
//!
//! Embedding happens in batches, and cancellation is checked before each one
//! and raced during it. The store is written once, atomically, after every
//! batch has been answered: an abandoned build leaves the previous store as it
//! was, with no partial file and no lock.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri_plugin_agent_tools::harness_error::{scrub, ErrorKind, HarnessError};

pub const STORE_VERSION: u32 = 1;
pub const CHUNK_LINES: usize = 40;
pub const CHUNK_OVERLAP: usize = 10;
pub const MAX_CHUNK_CHARS: usize = 4_000;
pub const MAX_CHUNKS: usize = 5_000;
pub const BATCH: usize = 32;
pub const DEFAULT_RESULTS: usize = 8;
pub const MAX_RESULTS: usize = 20;
pub const MODEL_ENV: &str = "JAN_EMBEDDINGS_MODEL";
pub const URL_ENV: &str = "JAN_EMBEDDINGS_URL";
pub const KEY_ENV: &str = "JAN_EMBEDDINGS_KEY";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
/// What is embedded first, before any project content: it learns whether the
/// provider serves embeddings, and at what length, from a text that is not the
/// user's.
pub const PROBE: &str = "jan semantic search probe";

fn refuse(kind: ErrorKind, message: impl Into<String>) -> HarnessError {
    HarnessError::new(kind, message.into())
}

// ---- which model -----------------------------------------------------------

/// Where embeddings come from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Embedder {
    /// `provider/model`, as named; also what the store is keyed by.
    pub id: String,
    pub model: String,
    /// The full embeddings endpoint.
    pub url: String,
    pub key: Option<String>,
}

pub const NOT_CONFIGURED: &str = "semantic search needs an embedding model, and none is configured: set embeddings_model = \"<provider>/<model>\" in ~/.jan/config.toml (or JAN_EMBEDDINGS_MODEL). Nothing was searched. grep and symbol_find search text, not meaning.";

/// Resolve the embedding model from what the user named. `provider` answers a
/// provider name with its base URL and key.
pub fn resolve(
    env: &dyn Fn(&str) -> Option<String>,
    setting: Option<String>,
    provider: &dyn Fn(&str) -> Option<(Option<String>, Option<String>)>,
) -> Result<Embedder, HarnessError> {
    let get = |name: &str| env(name).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let named = get(MODEL_ENV)
        .or_else(|| setting.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
        .ok_or_else(|| refuse(ErrorKind::ToolUnavailable, NOT_CONFIGURED))?;
    let (provider_name, model) = named
        .split_once('/')
        .filter(|(p, m)| !p.is_empty() && !m.is_empty())
        .ok_or_else(|| refuse(ErrorKind::InvalidInput, format!("the embedding model {named:?} must be written <provider>/<model>")))?;
    let (base, key) = match get(URL_ENV) {
        Some(url) => (Some(url), get(KEY_ENV)),
        None => provider(provider_name).ok_or_else(|| {
            refuse(ErrorKind::NotFound, format!("the embedding model names provider {provider_name:?}, which is not configured"))
        })?,
    };
    let base = base.ok_or_else(|| refuse(ErrorKind::InvalidInput, format!("provider {provider_name:?} has no base_url")))?;
    let parsed = reqwest::Url::parse(base.trim())
        .map_err(|e| refuse(ErrorKind::InvalidInput, format!("the embeddings URL {base:?} is not a URL: {e}")))?;
    if !matches!(parsed.scheme(), "http" | "https") || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(refuse(ErrorKind::InvalidInput, format!("the embeddings URL {base:?} must be a plain http(s) URL")));
    }
    let url = if base.trim_end_matches('/').ends_with("/embeddings") {
        base.trim_end_matches('/').to_string()
    } else {
        format!("{}/embeddings", base.trim_end_matches('/'))
    };
    Ok(Embedder { id: named.clone(), model: model.to_string(), url, key: key.filter(|k| !k.trim().is_empty()) })
}

/// The embedding model for this process, from the user's settings.
pub fn configured() -> Result<Embedder, HarnessError> {
    resolve(&|name| std::env::var(name).ok(), user_setting(), &user_provider)
}

#[cfg(feature = "cli")]
fn user_setting() -> Option<String> {
    crate::core::agent::global_config::embeddings_model().ok().flatten()
}

#[cfg(not(feature = "cli"))]
fn user_setting() -> Option<String> {
    None
}

#[cfg(feature = "cli")]
fn user_provider(name: &str) -> Option<(Option<String>, Option<String>)> {
    let providers = crate::core::agent::global_config::load_global_config().ok()?;
    let entry = providers.get(name)?;
    Some((entry.base_url.clone(), entry.api_keys.first().cloned().or_else(|| entry.api_key.clone())))
}

#[cfg(not(feature = "cli"))]
fn user_provider(_name: &str) -> Option<(Option<String>, Option<String>)> {
    None
}

// ---- asking the model ------------------------------------------------------

/// Something that turns texts into vectors, one per text, in order.
pub trait Embed {
    fn embed(&self, inputs: &[String]) -> impl std::future::Future<Output = Result<Vec<Vec<f32>>, HarnessError>> + Send;
}

pub struct HttpEmbedder {
    pub embedder: Embedder,
    pub cancel: Option<tauri_plugin_agent_tools::lifecycle::Token>,
}

async fn until_stopped(token: Option<tauri_plugin_agent_tools::lifecycle::Token>) {
    match token {
        Some(token) => {
            while !token.is_stopped() {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        None => std::future::pending::<()>().await,
    }
}

/// An error and every cause under it, so "error sending request" says why.
fn cause_chain(error: &dyn std::error::Error) -> String {
    let mut out = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        let text = cause.to_string();
        if !out.contains(&text) {
            out.push_str(": ");
            out.push_str(&text);
        }
        source = cause.source();
    }
    out
}

impl Embed for HttpEmbedder {
    fn embed(&self, inputs: &[String]) -> impl std::future::Future<Output = Result<Vec<Vec<f32>>, HarnessError>> + Send {
        let inputs = inputs.to_vec();
        let embedder = self.embedder.clone();
        let cancel = self.cancel.clone();
        async move {
            let client = crate::core::net::tls::apply12(reqwest::Client::builder())
                .timeout(REQUEST_TIMEOUT)
                .build()
                .map_err(|e| refuse(ErrorKind::Transport, format!("no HTTP client: {e}")))?;
            let mut request = client
                .post(&embedder.url)
                .json(&serde_json::json!({ "model": embedder.model, "input": inputs }));
            if let Some(key) = &embedder.key {
                request = request.bearer_auth(key);
            }
            let response = tokio::select! {
                response = request.send() => response,
                _ = until_stopped(cancel) => {
                    return Err(refuse(ErrorKind::Cancelled, "the run was cancelled while embeddings were being made; nothing was saved"));
                }
            };
            let response = response.map_err(|e| {
                refuse(ErrorKind::Transport, format!("the embedding provider could not be reached: {}", scrub(&cause_chain(&e))))
            })?;
            let status = response.status().as_u16();
            let text = response.text().await.unwrap_or_default();
            let message = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| {
                    v.pointer("/error/message")
                        .or_else(|| v.get("detail"))
                        .or_else(|| v.get("error"))
                        .and_then(|m| m.as_str().map(str::to_string))
                })
                .unwrap_or_default();
            let message = scrub(&message);
            match status {
                200..=299 => {}
                404 | 405 | 501 => {
                    return Err(refuse(
                        ErrorKind::ToolUnavailable,
                        format!(
                            "{} does not serve embeddings (HTTP {status}{}), so semantic search is unavailable with it. Nothing was searched; grep and symbol_find search text, not meaning.",
                            embedder.id,
                            if message.is_empty() { String::new() } else { format!(": {message}") }
                        ),
                    ))
                }
                401 | 403 => return Err(refuse(ErrorKind::Authentication, format!("the embedding provider refused the key (HTTP {status}): {message}"))),
                429 => return Err(refuse(ErrorKind::RateLimited, format!("the embedding provider is rate limiting: {message}"))),
                _ => return Err(refuse(ErrorKind::Upstream, format!("the embedding provider answered HTTP {status}: {message}"))),
            }
            let value: serde_json::Value = serde_json::from_str(&text)
                .map_err(|e| refuse(ErrorKind::InvalidResponse, format!("the embedding provider's answer is not JSON: {e}")))?;
            let mut items: Vec<(usize, Vec<f32>)> = value
                .get("data")
                .and_then(|d| d.as_array())
                .map(|items| {
                    items
                        .iter()
                        .enumerate()
                        .filter_map(|(i, item)| {
                            let index = item.get("index").and_then(|x| x.as_u64()).map(|x| x as usize).unwrap_or(i);
                            let vector = item.get("embedding")?.as_array()?.iter().map(|x| x.as_f64().map(|f| f as f32)).collect::<Option<Vec<f32>>>()?;
                            Some((index, vector))
                        })
                        .collect()
                })
                .unwrap_or_default();
            items.sort_by_key(|(i, _)| *i);
            Ok(items.into_iter().map(|(_, v)| v).collect())
        }
    }
}

// ---- the store -------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    pub path: String,
    /// 1-based, inclusive.
    pub start: usize,
    pub end: usize,
    /// The content hash of the file the range was cut from.
    pub file_hash: String,
    pub vector: Vec<f32>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    pub version: u32,
    pub project: String,
    /// The embedding model, `provider/model`.
    pub model: String,
    pub dim: usize,
    pub chunks: Vec<Chunk>,
    /// Set when a bound stopped the build: not every file is searchable.
    pub truncated: bool,
}

/// What a refresh did, so "incremental" is checkable.
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    pub embedded: usize,
    pub reused: usize,
    pub files: usize,
}

pub fn store_path(data_folder: &Path, project: &Path) -> PathBuf {
    let digest = hex::encode(Sha256::digest(project.to_string_lossy().as_bytes()));
    data_folder.join("semantic").join(format!("{}.json", &digest[..24]))
}

pub fn load(data_folder: &Path, project: &Path) -> Option<Store> {
    let raw = std::fs::read_to_string(store_path(data_folder, project)).ok()?;
    serde_json::from_str::<Store>(&raw).ok().filter(|s| s.version == STORE_VERSION)
}

fn save(data_folder: &Path, project: &Path, store: &Store) -> Result<(), HarnessError> {
    let path = store_path(data_folder, project);
    let io = |e: std::io::Error| refuse(ErrorKind::Io, format!("the semantic index could not be written: {e}"));
    std::fs::create_dir_all(path.parent().unwrap_or(Path::new("."))).map_err(io)?;
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_vec(store).map_err(|e| refuse(ErrorKind::Internal, e.to_string()))?;
    std::fs::write(&tmp, body).map_err(io)?;
    std::fs::rename(&tmp, &path).map_err(io)
}

/// Files that exist to hold secrets are never read, let alone sent.
pub fn holds_secrets(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    name.starts_with(".env")
        || name.starts_with("id_rsa")
        || name.starts_with("id_ed25519")
        || [".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"].iter().any(|ext| name.ends_with(ext))
        || name == ".netrc"
        || name == "credentials"
}

/// Overlapping line ranges of a text: `(start, end, text)`, 1-based inclusive.
pub fn chunks_of(text: &str) -> Vec<(usize, usize, String)> {
    let lines: Vec<&str> = text.lines().collect();
    let step = CHUNK_LINES - CHUNK_OVERLAP;
    let mut out = Vec::new();
    let mut start = 0;
    while start < lines.len() {
        let end = (start + CHUNK_LINES).min(lines.len());
        let body: String = lines[start..end].join("\n").chars().take(MAX_CHUNK_CHARS).collect();
        if !body.trim().is_empty() {
            out.push((start + 1, end, body));
        }
        if end == lines.len() {
            break;
        }
        start += step;
    }
    out
}

fn normalized(mut v: Vec<f32>) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        v.iter_mut().for_each(|x| *x /= norm);
    }
    v
}

/// Bring the store up to date with the project: embed what changed, reuse the
/// rest, and write it once everything is answered.
pub async fn refresh<E: Embed>(
    data_folder: &Path,
    project: &Path,
    embedder_id: &str,
    embedder: &E,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<(Store, Update), HarnessError> {
    let stop = AtomicBool::new(false);
    let (index, _) = crate::core::agent::index::refresh(data_folder, project, &stop).map_err(|e| HarnessError::from(&e))?;
    let previous = load(data_folder, project).filter(|s| s.model == embedder_id);
    let mut reusable: BTreeMap<(String, String), Vec<Chunk>> = BTreeMap::new();
    if let Some(previous) = &previous {
        for chunk in &previous.chunks {
            reusable.entry((chunk.path.clone(), chunk.file_hash.clone())).or_default().push(chunk.clone());
        }
    }
    let mut kept: Vec<Chunk> = Vec::new();
    let mut pending: Vec<(String, String, usize, usize, String)> = Vec::new();
    let mut update = Update::default();
    let mut truncated = index.truncated;
    for (path, entry) in &index.files {
        if holds_secrets(path) {
            continue;
        }
        update.files += 1;
        if let Some(chunks) = reusable.remove(&(path.clone(), entry.hash.clone())) {
            update.reused += chunks.len();
            kept.extend(chunks);
            continue;
        }
        let Ok(text) = std::fs::read_to_string(project.join(path)) else { continue };
        for (start, end, body) in chunks_of(&text) {
            pending.push((path.clone(), entry.hash.clone(), start, end, scrub(&body)));
        }
    }
    if kept.len() + pending.len() > MAX_CHUNKS {
        pending.truncate(MAX_CHUNKS.saturating_sub(kept.len()));
        truncated = true;
    }
    let mut dim = previous.as_ref().filter(|_| !kept.is_empty()).map(|s| s.dim).unwrap_or(0);
    if !pending.is_empty() {
        if cancelled() {
            return Err(refuse(ErrorKind::Cancelled, "semantic indexing was cancelled; the previous index was left as it was"));
        }
        let probe = embedder.embed(&[PROBE.to_string()]).await?;
        let length = probe.first().map(Vec::len).unwrap_or(0);
        if probe.len() != 1 || length == 0 {
            return Err(refuse(ErrorKind::InvalidResponse, "the embedding model did not return one vector for one text"));
        }
        if dim != 0 && dim != length {
            // The model behind the name changed length: nothing old is comparable.
            kept.clear();
            update.reused = 0;
            return Err(refuse(
                ErrorKind::InvalidResponse,
                format!("the embedding model now returns {length}-dimensional vectors and the index holds {dim}; it changed behind the same name, so nothing was saved"),
            ));
        }
        dim = length;
    }
    for batch in pending.chunks(BATCH) {
        if cancelled() {
            return Err(refuse(ErrorKind::Cancelled, "semantic indexing was cancelled; the previous index was left as it was"));
        }
        let texts: Vec<String> = batch.iter().map(|(path, _, _, _, body)| format!("{path}\n{body}")).collect();
        let vectors = embedder.embed(&texts).await?;
        if vectors.len() != batch.len() {
            return Err(refuse(
                ErrorKind::InvalidResponse,
                format!("the embedding model returned {} vectors for {} texts", vectors.len(), batch.len()),
            ));
        }
        for ((path, hash, start, end, _), vector) in batch.iter().zip(vectors) {
            if vector.is_empty() {
                return Err(refuse(ErrorKind::InvalidResponse, "the embedding model returned an empty vector"));
            }
            if dim == 0 {
                dim = vector.len();
            } else if vector.len() != dim {
                return Err(refuse(
                    ErrorKind::InvalidResponse,
                    format!("the embedding model returned vectors of {} and {} dimensions; they cannot be compared, so nothing was saved", dim, vector.len()),
                ));
            }
            kept.push(Chunk { path: path.clone(), start: *start, end: *end, file_hash: hash.clone(), vector: normalized(vector) });
            update.embedded += 1;
        }
    }
    if cancelled() {
        return Err(refuse(ErrorKind::Cancelled, "semantic indexing was cancelled; the previous index was left as it was"));
    }
    kept.sort_by(|a, b| (&a.path, a.start).cmp(&(&b.path, b.start)));
    let store = Store {
        version: STORE_VERSION,
        project: project.to_string_lossy().to_string(),
        model: embedder_id.to_string(),
        dim,
        chunks: kept,
        truncated,
    };
    save(data_folder, project, &store)?;
    Ok((store, update))
}

// ---- searching -------------------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub path: String,
    pub start: usize,
    pub end: usize,
    pub score: f32,
}

pub async fn search<E: Embed>(store: &Store, query: &str, limit: usize, embedder: &E) -> Result<Vec<Hit>, HarnessError> {
    let query = query.trim();
    if query.is_empty() {
        return Err(refuse(ErrorKind::InvalidInput, "a semantic search needs a query"));
    }
    if store.chunks.is_empty() {
        return Ok(Vec::new());
    }
    let mut vectors = embedder.embed(&[scrub(query)]).await?;
    let q = normalized(vectors.pop().unwrap_or_default());
    if q.len() != store.dim {
        return Err(refuse(
            ErrorKind::InvalidResponse,
            format!("the query's vector has {} dimensions and the index's have {}; the embedding model changed", q.len(), store.dim),
        ));
    }
    let mut hits: Vec<Hit> = store
        .chunks
        .iter()
        .map(|c| Hit { path: c.path.clone(), start: c.start, end: c.end, score: c.vector.iter().zip(&q).map(|(a, b)| a * b).sum() })
        .collect();
    hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    hits.truncate(limit.clamp(1, MAX_RESULTS));
    Ok(hits)
}

pub fn render(project: &Path, store: &Store, update: &Update, hits: &[Hit]) -> String {
    let mut out = format!(
        "Semantic matches by meaning (embedding model {}; {} ranges from {} files, {} embedded now, {} reused){}:\n",
        store.model,
        store.chunks.len(),
        update.files,
        update.embedded,
        update.reused,
        if store.truncated { "; the index is cut, so not every file was searched" } else { "" }
    );
    if hits.is_empty() {
        out.push_str("no ranges to search.");
        return out;
    }
    for hit in hits {
        let first = std::fs::read_to_string(project.join(&hit.path))
            .ok()
            .and_then(|text| text.lines().skip(hit.start - 1).find(|l| !l.trim().is_empty()).map(|l| scrub(l.trim())))
            .unwrap_or_default();
        let first: String = first.chars().take(160).collect();
        out.push_str(&format!("- {}:{}-{} (similarity {:.2})\n  {}\n", hit.path, hit.start, hit.end, hit.score, first));
    }
    out.trim_end().to_string()
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    const GROUPS: &[&[&str]] = &[
        &["retry", "retries", "backoff", "again", "attempt", "exponential", "later"],
        &["password", "credential", "login", "authenticate", "secret"],
        &["sort", "sorted", "order", "ranking"],
    ];

    /// Concept vectors, as the exercise's fixture builds them: words of one
    /// group share a dimension, so meaning matches without shared spelling.
    struct Fake {
        dim: usize,
        sent: Mutex<Vec<String>>,
        calls: AtomicUsize,
        wrong_dim_after: Option<usize>,
        refuse: bool,
    }

    impl Fake {
        fn new() -> Self {
            Fake { dim: 16, sent: Mutex::new(Vec::new()), calls: AtomicUsize::new(0), wrong_dim_after: None, refuse: false }
        }
        fn vector(&self, text: &str, dim: usize) -> Vec<f32> {
            let mut v = vec![0.0f32; dim];
            for word in text.to_lowercase().split(|c: char| !c.is_ascii_alphabetic()).filter(|w| !w.is_empty()) {
                match GROUPS.iter().position(|g| g.contains(&word)) {
                    Some(i) => v[i] += 1.0,
                    None => v[GROUPS.len() + (word.len() * 7 + word.as_bytes()[0] as usize) % (dim - GROUPS.len())] += 0.25,
                }
            }
            v
        }
    }

    impl Embed for Fake {
        fn embed(&self, inputs: &[String]) -> impl std::future::Future<Output = Result<Vec<Vec<f32>>, HarnessError>> + Send {
            let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
            self.sent.lock().unwrap().extend(inputs.iter().cloned());
            let dim = match self.wrong_dim_after {
                Some(n) if call > n => self.dim + 3,
                _ => self.dim,
            };
            let out: Result<Vec<Vec<f32>>, HarnessError> = if self.refuse {
                Err(refuse(ErrorKind::ToolUnavailable, "fake/model does not serve embeddings (HTTP 501)"))
            } else {
                Ok(inputs.iter().map(|t| self.vector(t, dim)).collect())
            };
            async move { out }
        }
    }

    fn project(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("jan-semantic-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("project");
        let data = base.join("data");
        std::fs::create_dir_all(root.join("net")).unwrap();
        std::fs::create_dir_all(root.join("auth")).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(root.join("net/client.py"), "def with_backoff(call):\n    # exponential backoff between attempts\n    return call()\n").unwrap();
        std::fs::write(root.join("auth/login.py"), "def check(user, password):\n    return authenticate(user, password)\n").unwrap();
        std::fs::write(root.join("rank.py"), "def top(items):\n    return sorted(items)\n").unwrap();
        std::fs::write(root.join(".env"), "API_TOKEN=sk-live-should-never-leave-this-machine\n").unwrap();
        (base, root, data)
    }

    #[test]
    fn only_a_model_the_user_named_is_used() {
        let none = |_: &str| None;
        let providers = |name: &str| match name {
            "emb" => Some((Some("http://127.0.0.1:9/v1".to_string()), Some("k".to_string()))),
            "nobase" => Some((None, None)),
            _ => None,
        };
        let unset = resolve(&none, None, &providers).unwrap_err();
        assert_eq!(unset.kind(), ErrorKind::ToolUnavailable);
        assert!(unset.message().contains("none is configured") && unset.message().contains("not meaning"), "{}", unset.message());
        let e = resolve(&none, Some("emb/e".into()), &providers).unwrap();
        assert_eq!((e.id.as_str(), e.model.as_str(), e.url.as_str(), e.key.as_deref()), ("emb/e", "e", "http://127.0.0.1:9/v1/embeddings", Some("k")));
        assert_eq!(resolve(&none, Some("no-slash".into()), &providers).unwrap_err().kind(), ErrorKind::InvalidInput);
        assert_eq!(resolve(&none, Some("ghost/e".into()), &providers).unwrap_err().kind(), ErrorKind::NotFound);
        assert_eq!(resolve(&none, Some("nobase/e".into()), &providers).unwrap_err().kind(), ErrorKind::InvalidInput);
        let env = |name: &str| match name {
            MODEL_ENV => Some("local/nomic".to_string()),
            URL_ENV => Some("http://127.0.0.1:7/v1/embeddings".to_string()),
            _ => None,
        };
        let e = resolve(&env, Some("emb/e".into()), &providers).unwrap();
        assert_eq!((e.id.as_str(), e.url.as_str(), e.key), ("local/nomic", "http://127.0.0.1:7/v1/embeddings", None));
        let bad = |name: &str| match name {
            MODEL_ENV => Some("x/y".to_string()),
            URL_ENV => Some("file:///etc/passwd".to_string()),
            _ => None,
        };
        assert_eq!(resolve(&bad, None, &providers).unwrap_err().kind(), ErrorKind::InvalidInput);
    }

    #[test]
    fn a_file_is_cut_into_overlapping_ranges_and_secret_files_are_never_read() {
        let text: String = (1..=100).map(|i| format!("line {i}\n")).collect();
        let ranges: Vec<(usize, usize)> = chunks_of(&text).iter().map(|(s, e, _)| (*s, *e)).collect();
        assert_eq!(ranges, vec![(1, 40), (31, 70), (61, 100)]);
        assert!(chunks_of("\n\n   \n").is_empty());
        assert_eq!(chunks_of("one line").len(), 1);
        for secret in [".env", "config/.env.local", "id_rsa", "certs/server.pem", "deploy.key", ".netrc"] {
            assert!(holds_secrets(secret), "{secret}");
        }
        assert!(!holds_secrets("src/environment.rs"));
    }

    #[tokio::test]
    async fn code_is_found_by_meaning_and_only_changed_files_are_embedded_again() {
        let (base, root, data) = project("meaning");
        let fake = Fake::new();
        let (store, update) = refresh(&data, &root, "emb/e", &fake, &|| false).await.unwrap();
        assert_eq!(update.embedded, 3, "{update:?}");
        let hits = search(&store, "try again later", 3, &fake).await.unwrap();
        assert_eq!(hits[0].path, "net/client.py", "{hits:?}");
        let text = std::fs::read_to_string(root.join("net/client.py")).unwrap();
        assert!(!["try", "later"].iter().any(|w| text.contains(w)), "the match must not be lexical");
        let hits = search(&store, "who may sign in with their credential", 1, &fake).await.unwrap();
        assert_eq!(hits[0].path, "auth/login.py");
        let rendered = render(&root, &store, &update, &hits);
        assert!(rendered.starts_with("Semantic matches by meaning (embedding model emb/e"), "{rendered}");

        let sent = fake.sent.lock().unwrap().join("\n");
        assert!(!sent.contains("sk-live-should-never-leave-this-machine"), "a secret file was sent");

        let (_, again) = refresh(&data, &root, "emb/e", &fake, &|| false).await.unwrap();
        assert_eq!((again.embedded, again.reused), (0, 3), "an unchanged project was embedded again");
        std::fs::write(root.join("rank.py"), "def top(items):\n    return sorted(items, reverse=True)\n").unwrap();
        let (_, changed) = refresh(&data, &root, "emb/e", &fake, &|| false).await.unwrap();
        assert_eq!((changed.embedded, changed.reused), (1, 2));
        let (_, other_model) = refresh(&data, &root, "emb/other", &fake, &|| false).await.unwrap();
        assert_eq!(other_model.embedded, 3, "another model's vectors were reused");
        assert!(search(&store, "  ", 3, &fake).await.unwrap_err().kind() == ErrorKind::InvalidInput);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn a_credential_inside_a_file_is_scrubbed_before_it_is_sent() {
        let (base, root, data) = project("scrub");
        std::fs::write(root.join("settings.py"), "OPENAI_KEY = \"sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD\"\n").unwrap();
        let fake = Fake::new();
        refresh(&data, &root, "emb/e", &fake, &|| false).await.unwrap();
        let sent = fake.sent.lock().unwrap().join("\n");
        assert!(sent.contains("settings.py") && !sent.contains("abcdefghijklmnopqrstuvwxyz0123456789ABCD"), "{sent}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn vectors_that_cannot_be_compared_or_a_cancelled_build_leave_the_index_as_it_was() {
        let (base, root, data) = project("refuse");
        for i in 0..40 {
            std::fs::write(root.join(format!("f{i}.py")), format!("def f{i}():\n    return {i}\n")).unwrap();
        }
        let fake = Fake::new();
        let (first, _) = refresh(&data, &root, "emb/e", &fake, &|| false).await.unwrap();
        let before = std::fs::read(store_path(&data, &root)).unwrap();

        let mut wrong = Fake::new();
        wrong.wrong_dim_after = Some(2);
        let refused = refresh(&data, &root, "emb/new", &wrong, &|| false).await.unwrap_err();
        assert_eq!(refused.kind(), ErrorKind::InvalidResponse, "{}", refused.message());
        assert_eq!(std::fs::read(store_path(&data, &root)).unwrap(), before, "a refused build changed the index");

        let slow = Fake::new();
        let calls = &slow.calls;
        // The probe is call 1 and the first batch call 2; cancel after that batch.
        let cancelled = || calls.load(Ordering::SeqCst) >= 2;
        let stopped = refresh(&data, &root, "emb/new", &slow, &cancelled).await.unwrap_err();
        assert_eq!(stopped.kind(), ErrorKind::Cancelled);
        assert_eq!(slow.calls.load(Ordering::SeqCst), 2, "it kept embedding after cancellation");
        assert_eq!(std::fs::read(store_path(&data, &root)).unwrap(), before, "a cancelled build changed the index");
        let leftovers: Vec<_> = std::fs::read_dir(data.join("semantic")).unwrap().filter_map(|e| e.ok()).filter(|e| e.path().extension().is_some_and(|x| x == "tmp")).collect();
        assert!(leftovers.is_empty(), "a temporary file was left");
        assert_eq!(first.chunks.len(), 43);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// R17: an unsupported provider is found out by the probe, before any of
    /// the project's content is sent to it.
    #[tokio::test]
    async fn an_unsupported_provider_receives_no_project_content() {
        let (base, root, data) = project("probe");
        let mut refusing = Fake::new();
        refusing.refuse = true;
        let err = refresh(&data, &root, "fake/model", &refusing, &|| false).await.unwrap_err();
        assert_eq!(err.kind(), ErrorKind::ToolUnavailable);
        assert_eq!(*refusing.sent.lock().unwrap(), vec![PROBE.to_string()], "project content reached a provider that does not embed");
        assert!(!store_path(&data, &root).exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A provider that does not serve embeddings is named as unavailable, not
    /// replaced with something else.
    #[tokio::test]
    async fn a_provider_without_embeddings_makes_the_search_unavailable() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0u8; 65536];
                let _ = stream.read(&mut buffer);
                let body = r#"{"error":{"code":501,"message":"This server does not support embeddings. Start it with `--embeddings`","type":"not_supported_error"}}"#;
                let _ = write!(stream, "HTTP/1.1 501 Not Implemented\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
            }
        });
        let http = HttpEmbedder {
            embedder: Embedder { id: "local/qwen".into(), model: "qwen".into(), url: format!("http://127.0.0.1:{port}/v1/embeddings"), key: None },
            cancel: None,
        };
        let err = http.embed(&["x".to_string()]).await.unwrap_err();
        assert_eq!(err.kind(), ErrorKind::ToolUnavailable);
        assert!(err.message().contains("does not serve embeddings") && err.message().contains("--embeddings"), "{}", err.message());
    }
}
