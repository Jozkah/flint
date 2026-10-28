//! Pure helpers that build the MLX server's key, argv and environment.
//! Kept free of platform gates so they are unit-testable on any host.

use rand::Rng;
use std::collections::HashMap;

/// Env var carrying the bearer key to the server.
pub const API_KEY_ENV: &str = "MLX_API_KEY";

/// 32 random bytes, hex encoded (64 chars). One per server launch.
pub fn generate_mlx_key() -> String {
    let bytes: [u8; 32] = rand::thread_rng().gen();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn allowed_env(name: &str) -> bool {
    let up = name.to_ascii_uppercase();
    if up == API_KEY_ENV || up == jan_utils::MLX_OWNER_ENV {
        return false;
    }
    up.starts_with("MLX_")
        || up.starts_with("HF_")
        || up == "TOKENIZERS_PARALLELISM"
        || up == "OMP_NUM_THREADS"
}

/// Keeps only allow-listed caller envs. Returns the kept map and the
/// rejected names (never values).
pub fn filter_envs(envs: HashMap<String, String>) -> (HashMap<String, String>, Vec<String>) {
    let mut kept = HashMap::new();
    let mut rejected = Vec::new();
    for (k, v) in envs {
        if allowed_env(&k) {
            kept.insert(k, v);
        } else {
            rejected.push(k);
        }
    }
    rejected.sort();
    (kept, rejected)
}

/// Builds argv and the final env map. The generated `key` always wins over
/// any caller-supplied `MLX_API_KEY`.
pub fn build_args_and_env(
    model_path: &str,
    model_id: &str,
    port: u16,
    ctx_size: i64,
    key: &str,
    envs: HashMap<String, String>,
) -> (Vec<String>, HashMap<String, String>, Vec<String>) {
    let mut args = vec![
        "--model".to_string(),
        model_path.to_string(),
        "--port".to_string(),
        port.to_string(),
        "--model-id".to_string(),
        model_id.to_string(),
    ];
    if ctx_size > 0 {
        args.push("--ctx-size".to_string());
        args.push(ctx_size.to_string());
    }
    let (mut env, rejected) = filter_envs(envs);
    env.insert(API_KEY_ENV.to_string(), key.to_string());
    (args, env, rejected)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }

    #[test]
    fn mlx_key_is_random_and_64_hex() {
        let (a, b) = (generate_mlx_key(), generate_mlx_key());
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn filter_envs_drops_loader_vars() {
        let (kept, rejected) = filter_envs(m(&[
            ("DYLD_INSERT_LIBRARIES", "x"),
            ("PYTHONPATH", "x"),
            ("PATH", "x"),
            ("LD_PRELOAD", "x"),
            ("HF_TOKEN", "t"),
            ("MLX_FOO", "1"),
            ("OMP_NUM_THREADS", "4"),
        ]));
        assert!(kept.contains_key("HF_TOKEN"));
        assert!(kept.contains_key("MLX_FOO"));
        assert!(kept.contains_key("OMP_NUM_THREADS"));
        assert_eq!(kept.len(), 3);
        assert_eq!(rejected.len(), 4);
        assert!(rejected.contains(&"DYLD_INSERT_LIBRARIES".to_string()));
    }

    #[test]
    fn filter_envs_ignores_caller_api_key() {
        let (kept, rejected) = filter_envs(m(&[
            ("MLX_API_KEY", "guessable"),
            (jan_utils::MLX_OWNER_ENV, "0"),
        ]));
        assert!(kept.is_empty());
        assert_eq!(rejected.len(), 2);
    }

    #[test]
    fn build_args_and_env_includes_generated_key() {
        let (args, env, _) = build_args_and_env(
            "/m",
            "id",
            8080,
            4096,
            "GENERATED",
            m(&[("MLX_API_KEY", "evil"), ("PATH", "x")]),
        );
        assert_eq!(env.get("MLX_API_KEY").unwrap(), "GENERATED");
        assert!(!env.contains_key("PATH"));
        assert!(args.contains(&"--ctx-size".to_string()));
        assert!(!args.iter().any(|a| a == "GENERATED"));
    }
}
