//! Which caller-supplied environment variables reach a worker process.
//!
//! The frontend forwards the user's free-form "llama.cpp env" setting. Letting
//! it set loader or search-path variables (`LD_PRELOAD`, `PATH`,
//! `FLINT_ENGINE_ADDON_DIR`, ...) would let any page script that can call the
//! start command run code inside the worker, so only an allow-list passes.

use std::collections::HashMap;

/// Names that are never accepted even when a prefix rule would match.
const DENIED: &[&str] = &[
    "GGML_BACKEND_PATH",
    "LLAMA_ARG_PORT",
    "LLAMA_ARG_HOST",
    "LLAMA_API_KEY",
    "LLAMA_ARG_API_KEY",
    "VK_ICD_FILENAMES",
    "VK_DRIVER_FILES",
    "VK_LAYER_PATH",
    "VK_ADD_LAYER_PATH",
    "VK_IMPLICIT_LAYER_PATH",
];

const EXACT: &[&str] = &[
    "CUDA_VISIBLE_DEVICES",
    "HIP_VISIBLE_DEVICES",
    "ROCR_VISIBLE_DEVICES",
    "HSA_OVERRIDE_GFX_VERSION",
    "OMP_NUM_THREADS",
];

const PREFIXES: &[&str] = &["GGML_", "LLAMA_", "GPU_", "VK_"];

fn allowed(name: &str) -> bool {
    // Windows environment names are case-insensitive.
    let upper = name.to_ascii_uppercase();
    if upper == super::addon::WORKER_ADDON_ENV || DENIED.contains(&upper.as_str()) {
        return false;
    }
    EXACT.contains(&upper.as_str()) || PREFIXES.iter().any(|p| upper.starts_with(p))
}

/// Keeps only allow-listed variables. Rejected names are logged, never values.
pub fn sanitize_envs(envs: HashMap<String, String>) -> HashMap<String, String> {
    let mut kept = HashMap::new();
    let mut rejected: Vec<String> = Vec::new();
    for (k, v) in envs {
        if allowed(&k) {
            kept.insert(k, v);
        } else {
            rejected.push(k);
        }
    }
    if !rejected.is_empty() {
        rejected.sort();
        log::warn!("ignored engine environment variables: {}", rejected.join(", "));
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn sanitize_envs_drops_loader_and_addon_vars() {
        let out = sanitize_envs(m(&[
            ("LD_PRELOAD", "/x.so"),
            ("DYLD_INSERT_LIBRARIES", "/x"),
            ("Path", "C:\\evil"),
            ("FLINT_ENGINE_ADDON_DIR", "/evil"),
            ("flint_engine_addon_dir", "/evil"),
            ("GGML_BACKEND_PATH", "/evil"),
            ("LLAMA_ARG_PORT", "1"),
            ("VK_ICD_FILENAMES", "/evil"),
        ]));
        assert!(out.is_empty(), "{out:?}");
    }

    #[test]
    fn sanitize_envs_keeps_cuda_visible_devices() {
        let out = sanitize_envs(m(&[
            ("CUDA_VISIBLE_DEVICES", "0,1"),
            ("GGML_CUDA_ENABLE_UNIFIED_MEMORY", "1"),
            ("LLAMA_ARG_TIMEOUT", "600"),
            ("HSA_OVERRIDE_GFX_VERSION", "10.3.0"),
        ]));
        assert_eq!(out.len(), 4);
    }
}
