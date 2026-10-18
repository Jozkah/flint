//! Finds GGUF models other apps already keep on this machine, so a user does
//! not have to re-download a model they have. Read-only: it lists files and
//! never modifies, moves or reads anything but the first four bytes.
//!
//! Sources: LM Studio, the Hugging Face cache, llama.cpp's own cache, GPT4All
//! and Ollama. Each store's folder honours the variable that app documents for
//! moving it (`HF_HUB_CACHE`, `HF_HOME`, `LLAMA_CACHE`, `OLLAMA_MODELS`).

use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

/// Stops a pathological tree (a home folder symlinked to a drive) from
/// producing an unbounded list or an unbounded walk.
const MAX_RESULTS: usize = 500;
const MAX_ENTRIES_PER_ROOT: usize = 20_000;
/// Anything smaller is a test fixture or a stub, not a model.
const MIN_MODEL_BYTES: u64 = 1_000_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ScannedModel {
    /// Absolute path to the GGUF file.
    pub path: String,
    /// What the owning app calls it, e.g. `qwen3:8b` or `bartowski/Qwen3-8B-GGUF`.
    pub name: String,
    /// The app whose store it was found in.
    pub source: String,
    pub size_bytes: u64,
}

/// Inputs the scan depends on, so tests can point it at a temp directory.
pub struct ScanEnv {
    pub home: Option<PathBuf>,
    pub local_app_data: Option<PathBuf>,
    pub hf_hub_cache: Option<PathBuf>,
    pub hf_home: Option<PathBuf>,
    pub llama_cache: Option<PathBuf>,
    pub ollama_models: Option<PathBuf>,
    /// Folders the user added by hand; each is scanned for GGUF files, and as
    /// an Ollama store when it holds `manifests/` and `blobs/`.
    pub extra_folders: Vec<PathBuf>,
}

impl ScanEnv {
    pub fn from_process() -> Self {
        let var = |name: &str| {
            std::env::var_os(name)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        };
        Self {
            home: dirs::home_dir(),
            local_app_data: var("LOCALAPPDATA"),
            hf_hub_cache: var("HF_HUB_CACHE"),
            hf_home: var("HF_HOME"),
            llama_cache: var("LLAMA_CACHE"),
            ollama_models: var("OLLAMA_MODELS"),
            extra_folders: Vec::new(),
        }
    }
}

fn is_gguf(path: &Path) -> bool {
    let mut magic = [0u8; 4];
    fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut magic))
        .is_ok()
        && &magic == b"GGUF"
}

/// Skip multimodal projectors (they are not models) and every shard but the
/// first of a split model, which is the file llama.cpp loads.
fn is_loadable_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if !lower.ends_with(".gguf") || lower.contains("mmproj") {
        return false;
    }
    // The last "-of-": a model name may contain one too.
    if let Some(of) = lower.rfind("-of-") {
        // "...-00002-of-00005.gguf": only shard 1 is loadable.
        let before = &lower[..of];
        if let Some(dash) = before.rfind('-') {
            let index = &before[dash + 1..];
            if !index.is_empty()
                && index.chars().all(|c| c.is_ascii_digit())
                && index.trim_start_matches('0') != "1"
            {
                return false;
            }
        }
    }
    true
}

/// Walk `root` up to `depth` levels, calling `visit` for each regular file
/// (following file symlinks, never directory symlinks, so a cycle cannot loop).
fn walk(root: &Path, depth: usize, budget: &mut usize, visit: &mut dyn FnMut(&Path)) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if *budget == 0 {
            return;
        }
        *budget -= 1;
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            if depth > 0 {
                walk(&path, depth - 1, budget, visit);
            }
        } else if file_type.is_file() || (file_type.is_symlink() && path.is_file()) {
            visit(&path);
        }
    }
}

fn push(
    out: &mut Vec<ScannedModel>,
    seen: &mut HashSet<PathBuf>,
    path: &Path,
    name: String,
    source: &str,
) {
    if out.len() >= MAX_RESULTS {
        return;
    }
    let Ok(meta) = fs::metadata(path) else { return };
    if meta.len() < MIN_MODEL_BYTES || !is_gguf(path) {
        return;
    }
    // The same blob is reachable from several paths (HF snapshots symlink into
    // blobs); count it once, by where it really lives.
    let real = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if !seen.insert(real) {
        return;
    }
    out.push(ScannedModel {
        path: path.to_string_lossy().into_owned(),
        name,
        source: source.to_string(),
        size_bytes: meta.len(),
    });
}

fn scan_folder_of_ggufs(
    out: &mut Vec<ScannedModel>,
    seen: &mut HashSet<PathBuf>,
    root: &Path,
    depth: usize,
    source: &str,
    name_from: impl Fn(&Path, &Path) -> String,
) {
    let mut budget = MAX_ENTRIES_PER_ROOT;
    let mut found: Vec<PathBuf> = Vec::new();
    walk(root, depth, &mut budget, &mut |path| {
        if path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(is_loadable_name)
        {
            found.push(path.to_path_buf());
        }
    });
    found.sort();
    for path in found {
        let name = name_from(root, &path);
        push(out, seen, &path, name, source);
    }
}

fn file_stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string()
}

/// `models--org--name/snapshots/<rev>/file.gguf` -> `org/name`.
fn hf_cache_name(root: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(root).unwrap_or(path);
    let repo = rel
        .components()
        .next()
        .and_then(|c| c.as_os_str().to_str())
        .and_then(|c| c.strip_prefix("models--"))
        .map(|c| c.replacen("--", "/", 1));
    match repo {
        Some(repo) => format!("{repo} / {}", file_stem(path)),
        None => file_stem(path),
    }
}

/// `publisher/repo/file.gguf` -> `publisher/repo / file`.
fn lmstudio_name(root: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(root).unwrap_or(path);
    let parent = rel
        .parent()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    if parent.is_empty() {
        file_stem(path)
    } else {
        format!("{parent} / {}", file_stem(path))
    }
}

/// Ollama keeps weights as extensionless blobs named by digest; the manifest
/// for `library/qwen3/8b` names the layer that is the model.
fn scan_ollama(out: &mut Vec<ScannedModel>, seen: &mut HashSet<PathBuf>, root: &Path) {
    let manifests = root.join("manifests");
    let blobs = root.join("blobs");
    let mut budget = MAX_ENTRIES_PER_ROOT;
    let mut files: Vec<PathBuf> = Vec::new();
    walk(&manifests, 6, &mut budget, &mut |p| files.push(p.to_path_buf()));
    files.sort();
    for manifest in files {
        let Ok(text) = fs::read_to_string(&manifest) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let digest = json
            .get("layers")
            .and_then(|l| l.as_array())
            .and_then(|layers| {
                layers.iter().find(|layer| {
                    layer.get("mediaType").and_then(|m| m.as_str())
                        == Some("application/vnd.ollama.image.model")
                })
            })
            .and_then(|layer| layer.get("digest"))
            .and_then(|d| d.as_str());
        let Some(blob_name) = digest.and_then(blob_file_name) else { continue };
        let blob = blobs.join(blob_name);
        let rel = manifest.strip_prefix(&manifests).unwrap_or(&manifest);
        let parts: Vec<String> = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        // registry/namespace/model/tag
        let name = match parts.as_slice() {
            [_, ns, model, tag] if ns == "library" => format!("{model}:{tag}"),
            [_, ns, model, tag] => format!("{ns}/{model}:{tag}"),
            _ => parts.join("/"),
        };
        push(out, seen, &blob, name, "Ollama");
    }
}

/// The blob file for a manifest digest: "sha256:<64 hex>" on the wire,
/// "sha256-<64 hex>" on disk. Anything else (a path, a separator) is refused
/// so a manifest cannot point outside the blobs folder.
fn blob_file_name(digest: &str) -> Option<String> {
    let hex = digest.strip_prefix("sha256:")?;
    (hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
        .then(|| format!("sha256-{hex}"))
}

pub fn scan(env: &ScanEnv) -> Vec<ScannedModel> {
    let mut out: Vec<ScannedModel> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();

    if let Some(home) = &env.home {
        for dir in [".lmstudio/models", ".cache/lm-studio/models"] {
            scan_folder_of_ggufs(
                &mut out,
                &mut seen,
                &home.join(dir),
                3,
                "LM Studio",
                lmstudio_name,
            );
        }
    }

    let hf_hub = env
        .hf_hub_cache
        .clone()
        .or_else(|| env.hf_home.as_ref().map(|h| h.join("hub")))
        .or_else(|| env.home.as_ref().map(|h| h.join(".cache/huggingface/hub")));
    if let Some(hub) = hf_hub {
        scan_folder_of_ggufs(
            &mut out,
            &mut seen,
            &hub,
            5,
            "Hugging Face cache",
            hf_cache_name,
        );
    }

    let llama_cache = env.llama_cache.clone().or_else(|| {
        if cfg!(target_os = "windows") {
            env.local_app_data.as_ref().map(|d| d.join("llama.cpp"))
        } else if cfg!(target_os = "macos") {
            env.home.as_ref().map(|h| h.join("Library/Caches/llama.cpp"))
        } else {
            env.home.as_ref().map(|h| h.join(".cache/llama.cpp"))
        }
    });
    if let Some(dir) = llama_cache {
        scan_folder_of_ggufs(&mut out, &mut seen, &dir, 1, "llama.cpp cache", |_, p| {
            file_stem(p)
        });
    }

    let gpt4all = if cfg!(target_os = "windows") {
        env.local_app_data
            .as_ref()
            .map(|d| d.join("nomic.ai/GPT4All"))
    } else if cfg!(target_os = "macos") {
        env.home
            .as_ref()
            .map(|h| h.join("Library/Application Support/nomic.ai/GPT4All"))
    } else {
        env.home
            .as_ref()
            .map(|h| h.join(".local/share/nomic.ai/GPT4All"))
    };
    if let Some(dir) = gpt4all {
        scan_folder_of_ggufs(&mut out, &mut seen, &dir, 1, "GPT4All", |_, p| file_stem(p));
    }

    let ollama = env
        .ollama_models
        .clone()
        .or_else(|| env.home.as_ref().map(|h| h.join(".ollama/models")));
    if let Some(dir) = ollama {
        scan_ollama(&mut out, &mut seen, &dir);
    }

    for dir in &env.extra_folders {
        if dir.join("manifests").is_dir() && dir.join("blobs").is_dir() {
            scan_ollama(&mut out, &mut seen, dir);
        }
        scan_folder_of_ggufs(&mut out, &mut seen, dir, 4, "Custom folder", lmstudio_name);
    }

    out
}

/// Models other apps already keep on this machine. Runs on a blocking thread:
/// it walks directories.
#[tauri::command]
pub async fn scan_local_models(
    extra_folders: Option<Vec<String>>,
) -> Result<Vec<ScannedModel>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut env = ScanEnv::from_process();
        env.extra_folders = extra_folders
            .unwrap_or_default()
            .into_iter()
            .filter(|f| !f.trim().is_empty())
            .map(PathBuf::from)
            .collect();
        scan(&env)
    })
        .await
        .map_err(|e| format!("Model scan failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_ollama_digest_must_be_a_plain_sha256() {
        let hex = "a".repeat(64);
        assert_eq!(blob_file_name(&format!("sha256:{hex}")), Some(format!("sha256-{hex}")));
        assert_eq!(blob_file_name("sha256:../../x"), None);
        assert_eq!(blob_file_name("/etc/passwd"), None);
        assert_eq!(blob_file_name(r"C:\x"), None);
        assert_eq!(blob_file_name(&format!("sha256:{}", "A".repeat(64))), None);
        assert_eq!(blob_file_name(&format!("sha256:{}/", "a".repeat(63))), None);
    }

    #[test]
    fn a_model_name_containing_of_is_judged_by_its_shard_suffix() {
        assert!(!is_loadable_name("foo-of-bar-00002-of-00003.gguf"));
        assert!(is_loadable_name("foo-of-bar-00001-of-00003.gguf"));
        assert!(is_loadable_name("foo-of-bar.gguf"));
    }

    fn gguf(path: &Path, len: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut bytes = b"GGUF".to_vec();
        bytes.resize(len, 0);
        fs::write(path, bytes).unwrap();
    }

    fn env(home: &Path) -> ScanEnv {
        ScanEnv {
            home: Some(home.to_path_buf()),
            local_app_data: Some(home.join("AppData/Local")),
            hf_hub_cache: None,
            hf_home: None,
            llama_cache: None,
            ollama_models: None,
            extra_folders: Vec::new(),
        }
    }

    #[test]
    fn finds_lm_studio_models_and_skips_projectors_and_later_shards() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(".lmstudio/models/acme/qwen-GGUF");
        gguf(&root.join("qwen-8b-q4.gguf"), 2_000_000);
        gguf(&root.join("mmproj-qwen.gguf"), 2_000_000);
        gguf(&root.join("big-00001-of-00002.gguf"), 2_000_000);
        gguf(&root.join("big-00002-of-00002.gguf"), 2_000_000);
        let found = scan(&env(dir.path()));
        let names: Vec<_> = found.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["acme/qwen-GGUF / big-00001-of-00002", "acme/qwen-GGUF / qwen-8b-q4"]
        );
        assert!(found.iter().all(|m| m.source == "LM Studio"));
    }

    #[test]
    fn ignores_files_that_are_not_gguf_or_too_small() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(".lmstudio/models/a/b");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("fake.gguf"), vec![0u8; 2_000_000]).unwrap();
        gguf(&root.join("tiny.gguf"), 100);
        assert!(scan(&env(dir.path())).is_empty());
    }

    #[test]
    fn names_hugging_face_cache_models_by_repo() {
        let dir = tempfile::tempdir().unwrap();
        let snap = dir
            .path()
            .join(".cache/huggingface/hub/models--bartowski--Qwen3-8B-GGUF/snapshots/abc");
        gguf(&snap.join("Qwen3-8B-Q4_K_M.gguf"), 2_000_000);
        let found = scan(&env(dir.path()));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "bartowski/Qwen3-8B-GGUF / Qwen3-8B-Q4_K_M");
        assert_eq!(found[0].source, "Hugging Face cache");
    }

    #[test]
    fn honours_the_hub_cache_override() {
        let dir = tempfile::tempdir().unwrap();
        let custom = dir.path().join("elsewhere");
        gguf(&custom.join("models--o--m/snapshots/r/m.gguf"), 2_000_000);
        let mut e = env(dir.path());
        e.hf_hub_cache = Some(custom);
        assert_eq!(scan(&e).len(), 1);
    }

    #[test]
    fn resolves_an_ollama_manifest_to_its_blob() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(".ollama/models");
        let blob = root.join("blobs/sha256-deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
        gguf(&blob, 2_000_000);
        let manifest = root.join("manifests/registry.ollama.ai/library/qwen3/8b");
        fs::create_dir_all(manifest.parent().unwrap()).unwrap();
        fs::write(
            &manifest,
            r#"{"layers":[
                {"mediaType":"application/vnd.ollama.image.template","digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
                {"mediaType":"application/vnd.ollama.image.model","digest":"sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"}
            ]}"#,
        )
        .unwrap();
        let found = scan(&env(dir.path()));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "qwen3:8b");
        assert_eq!(found[0].source, "Ollama");
        assert!(found[0].path.ends_with("sha256-deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"));
    }

    #[test]
    fn lists_a_blob_reachable_from_two_stores_once() {
        let dir = tempfile::tempdir().unwrap();
        let blob = dir.path().join(".ollama/models/blobs/sha256-abababababababababababababababababababababababababababababababab");
        gguf(&blob, 2_000_000);
        let manifests = dir.path().join(".ollama/models/manifests/r/library/m");
        fs::create_dir_all(&manifests).unwrap();
        for tag in ["a", "b"] {
            fs::write(
                manifests.join(tag),
                r#"{"layers":[{"mediaType":"application/vnd.ollama.image.model","digest":"sha256:abababababababababababababababababababababababababababababababab"}]}"#,
            )
            .unwrap();
        }
        assert_eq!(scan(&env(dir.path())).len(), 1);
    }

    #[test]
    fn scans_a_user_added_folder_of_ggufs() {
        let dir = tempfile::tempdir().unwrap();
        let extra = dir.path().join("D-drive-models");
        gguf(&extra.join("org/repo/m-q4.gguf"), 2_000_000);
        gguf(&extra.join("mmproj-x.gguf"), 2_000_000);
        let mut e = env(dir.path());
        e.extra_folders = vec![extra.clone(), dir.path().join("does-not-exist")];
        let found = scan(&e);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].source, "Custom folder");
        assert_eq!(found[0].name, "org/repo / m-q4");
        // The path handed to the loader is absolute and readable.
        assert!(Path::new(&found[0].path).is_absolute());
        assert!(fs::File::open(&found[0].path).is_ok());
    }

    #[test]
    fn a_user_added_folder_can_be_an_ollama_store() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("moved-ollama");
        gguf(&root.join("blobs/sha256-cafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafe"), 2_000_000);
        let manifest = root.join("manifests/registry.ollama.ai/library/llama3/latest");
        fs::create_dir_all(manifest.parent().unwrap()).unwrap();
        fs::write(
            &manifest,
            r#"{"layers":[{"mediaType":"application/vnd.ollama.image.model","digest":"sha256:cafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafe"}]}"#,
        )
        .unwrap();
        let mut e = env(dir.path());
        e.extra_folders = vec![root];
        let found = scan(&e);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "llama3:latest");
        assert_eq!(found[0].source, "Ollama");
    }

    #[test]
    fn a_missing_store_is_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(scan(&env(dir.path())).is_empty());
    }

    #[test]
    fn shard_rule_keeps_only_the_first_part() {
        assert!(is_loadable_name("m-00001-of-00003.gguf"));
        assert!(!is_loadable_name("m-00002-of-00003.gguf"));
        assert!(is_loadable_name("model.gguf"));
        assert!(!is_loadable_name("model.bin"));
        assert!(!is_loadable_name("mmproj-F16.gguf"));
    }
}
