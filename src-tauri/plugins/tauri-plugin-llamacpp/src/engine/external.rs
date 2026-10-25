//! A user-supplied `llama-server` run in router mode in place of the bundled
//! worker.
//!
//! The bundled worker links llama.cpp at one pinned tag. Some quantizations and
//! features land in llama.cpp (or a fork) before that tag moves, so a user can
//! point Flint at their own `llama-server` build instead. The router speaks the
//! same `/models`, `/models/load`, `/models/unload` and `/models/sse` surface
//! the worker mirrors, so everything above the process boundary is unchanged.
//!
//! What the worker adds on top of the router does not exist here: live
//! `models_max` resizing (`/models/reload`), saved thread caches, and the
//! graceful stdin shutdown. The caller restarts instead of reloading.

use std::collections::HashSet;

/// Preset keys only the bundled worker understands. Upstream's preset parser
/// rejects keys it does not know, so these are dropped before the router reads
/// the file.
const WORKER_ONLY_KEYS: &[&str] = &[
    "lazy-mode",
    "kv-unified-per-slot",
    "n-cpu-ffn",
    "reasoning-preserve",
];

/// The preset rewritten for upstream `llama-server`, plus the model ids it
/// registers (every section except the `[*]` defaults).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompatPreset {
    pub text: String,
    pub models: Vec<String>,
}

/// Rewrites a worker preset so upstream `llama-server --models-preset` accepts
/// it: worker-only keys are dropped and `load-mode` is spelled as the
/// `mlock`/`no-mmap` pair it was derived from.
pub fn compat_preset(text: &str) -> CompatPreset {
    let drop: HashSet<&str> = WORKER_ONLY_KEYS.iter().copied().collect();
    let mut out = String::with_capacity(text.len());
    let mut models = Vec::new();

    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(section) = trimmed.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            let section = section.trim();
            if section != "*" && !section.is_empty() {
                models.push(section.to_string());
            }
            out.push_str(line);
            out.push('\n');
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            out.push_str(line);
            out.push('\n');
            continue;
        };
        if trimmed.starts_with(';') || trimmed.starts_with('#') {
            out.push_str(line);
            out.push('\n');
            continue;
        }
        let key = key.trim();
        if drop.contains(key) {
            continue;
        }
        if key == "load-mode" {
            let (mlock, no_mmap) = match value.trim() {
                "none" => (false, true),
                "mlock" => (true, true),
                "mmap+mlock" => (true, false),
                _ => (false, false),
            };
            if mlock {
                out.push_str("mlock = true\n");
            }
            if no_mmap {
                out.push_str("no-mmap = true\n");
            }
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }

    CompatPreset { text: out, models }
}

/// Router flags. The port and API key go through `LLAMA_ARG_PORT` and
/// `LLAMA_API_KEY` instead, so the key never shows in a process listing.
pub fn external_args(preset_path: &str, models_max: u32) -> Vec<String> {
    vec![
        "--models-preset".to_string(),
        preset_path.to_string(),
        "--models-max".to_string(),
        models_max.to_string(),
        "--host".to_string(),
        "127.0.0.1".to_string(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_worker_only_keys_and_lists_models() {
        let p = compat_preset(
            "[*]\nlazy-mode = on\nctx-size = 4096\n\n[qwen]\nmodel = /m/q.gguf\nkv-unified-per-slot = 8192\n[gemma]\nmodel = /m/g.gguf\n",
        );
        assert_eq!(p.models, vec!["qwen", "gemma"]);
        assert!(!p.text.contains("lazy-mode"));
        assert!(!p.text.contains("kv-unified-per-slot"));
        assert!(p.text.contains("ctx-size = 4096"));
        assert!(p.text.contains("model = /m/q.gguf"));
    }

    #[test]
    fn spells_load_mode_as_upstream_flags() {
        assert_eq!(compat_preset("load-mode = none\n").text, "no-mmap = true\n");
        assert_eq!(
            compat_preset("load-mode = mlock\n").text,
            "mlock = true\nno-mmap = true\n"
        );
        assert_eq!(compat_preset("load-mode = mmap+mlock\n").text, "mlock = true\n");
    }

    #[test]
    fn keeps_comments() {
        let p = compat_preset("; lazy-mode = on\n");
        assert_eq!(p.text, "; lazy-mode = on\n");
    }
}
