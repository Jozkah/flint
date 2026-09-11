use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::core::state::{AppState, ProviderConfig};

/// Custom header for provider requests
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderCustomHeader {
    pub header: String,
    pub value: String,
    /// A credential: its value is redacted from every log line from here on.
    #[serde(default)]
    pub secret: bool,
}

/// Request to register/update a remote provider config
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterProviderRequest {
    pub provider: String,
    pub api_key: Option<String>,
    /// Additional keys (after `api_key`) when the upstream returns 401, 403, or 429.
    #[serde(default)]
    pub api_keys: Vec<String>,
    pub base_url: Option<String>,
    pub custom_headers: Vec<ProviderCustomHeader>,
    pub models: Vec<String>,
    /// Upstream wire API (`"openai"` default, or `"openai-responses"` /
    /// `"google"` / `"anthropic"` to engage a translating converter).
    #[serde(default)]
    pub api_type: Option<String>,
}

fn merge_register_api_keys(api_key: Option<String>, api_keys: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push_unique = |s: String| {
        let t = s.trim().to_string();
        if t.is_empty() {
            return;
        }
        if !out.iter().any(|x| x == &t) {
            out.push(t);
        }
    };
    if let Some(k) = api_key {
        push_unique(k);
    }
    for k in api_keys {
        push_unique(k);
    }
    out
}

/// Register a remote provider configuration
#[tauri::command]
pub async fn register_provider_config(
    state: State<'_, AppState>,
    request: RegisterProviderRequest,
) -> Result<(), String> {
    let key_chain = merge_register_api_keys(request.api_key.clone(), request.api_keys.clone());
    let api_key = key_chain.first().cloned();
    // Before anything can log them: an upstream error that echoes the request
    // back must not put a secret header's value in the log. janhq/jan#8208.
    for h in request.custom_headers.iter().filter(|h| h.secret) {
        crate::core::secret_values::register(&h.value);
    }

    let config = ProviderConfig {
        provider: request.provider.clone(),
        api_key,
        api_keys: key_chain,
        base_url: request.base_url,
        custom_headers: request
            .custom_headers
            .into_iter()
            .map(|h| crate::core::state::ProviderCustomHeader {
                header: h.header,
                value: h.value,
                secret: h.secret,
            })
            .collect(),
        models: request.models, // Models will be added when they are configured
        api_type: request.api_type,
    };

    // Persist the key chain to the OS keyring so it survives webview storage
    // clears and is readable by out-of-process consumers (jan CLI). Keyring
    // access is blocking, so run it off-thread and before taking the config
    // lock. Keyring failure (e.g. headless Linux without an unlocked Secret
    // Service) must not block registration; the in-memory config still works.
    let provider_name = request.provider.clone();
    let keys = config.api_keys.clone();
    if let Err(err) = tauri::async_runtime::spawn_blocking(move || {
        crate::core::server::provider_secrets::store_provider_keys(&provider_name, &keys)
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r)
    {
        log::warn!(
            "Failed to persist API keys to keyring for {}: {err}",
            request.provider
        );
    }

    let provider_configs = state.provider_configs.clone();
    let mut configs = provider_configs.lock().await;
    let provider_name = request.provider.clone();
    configs.insert(provider_name.clone(), config);
    log::debug!("Registered provider config: {provider_name}");
    Ok(())
}

/// Register values the user marked secret for exact-value redaction in every
/// log from now on. janhq/jan#8208.
///
/// Separate from `register_provider_config`, which only runs for a provider
/// with an API key: a provider needing none can still carry a secret custom
/// header, and its value must be redacted all the same. Values only, never
/// names or providers, and nothing is returned.
#[tauri::command]
pub fn register_secret_values(values: Vec<String>) {
    for value in &values {
        crate::core::secret_values::register(value);
    }
}

/// Replace the per-model sampling defaults the API server injects for MLX
/// requests. The frontend pushes the full map (model id → request-body object),
/// so this overwrites wholesale rather than merging.
#[tauri::command]
pub async fn set_model_param_defaults(
    state: State<'_, AppState>,
    defaults: std::collections::HashMap<String, serde_json::Value>,
) -> Result<(), String> {
    let mut guard = state.model_param_defaults.lock().await;
    *guard = defaults;
    Ok(())
}

/// Drop a provider's in-memory config, reporting whether it was present. Pure:
/// touches only the map, never the persisted keyring secret.
fn remove_provider_config(configs: &mut HashMap<String, ProviderConfig>, provider: &str) -> bool {
    configs.remove(provider).is_some()
}

/// Unregister a provider's in-memory config. This is called during routine
/// reconciliation (e.g. deactivating a provider at boot), so it MUST NOT touch
/// the persisted keyring secret — otherwise a provider whose in-memory key has
/// not been re-seeded yet would have its stored key destroyed. Deleting the
/// secret is an explicit user action; see `delete_provider_keys`.
#[tauri::command]
pub async fn unregister_provider_config(
    state: State<'_, AppState>,
    provider: String,
) -> Result<(), String> {
    let provider_configs = state.provider_configs.clone();
    let mut configs = provider_configs.lock().await;

    if remove_provider_config(&mut configs, &provider) {
        log::info!("Unregistered provider config: {provider}");
    }
    Ok(())
}

/// Permanently delete a provider's stored API key chain from the keyring (and
/// encrypted-file fallback). Explicit, user-initiated only — invoked when the
/// user removes a custom provider or clears its key, never during boot
/// reconciliation.
#[tauri::command]
pub async fn delete_provider_keys(provider: String) -> Result<(), String> {
    // Keyring/file access is blocking; keep it off the main (UI) thread.
    tauri::async_runtime::spawn_blocking(move || {
        crate::core::server::provider_secrets::delete_provider_keys(&provider)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read a provider's stored API key chain (keyring, then encrypted file
/// fallback). Used by the frontend to re-seed in-memory keys at boot, since
/// keys are no longer persisted to webview storage. Empty when none stored.
#[tauri::command]
pub async fn get_provider_keys(provider: String) -> Vec<String> {
    // Keyring/file access is blocking; keep it off the main (UI) thread.
    tauri::async_runtime::spawn_blocking(move || {
        crate::core::server::provider_secrets::load_provider_keys(&provider)
    })
    .await
    .unwrap_or_default()
}

/// Get provider configuration by name
#[tauri::command]
pub async fn get_provider_config(
    state: State<'_, AppState>,
    provider: String,
) -> Result<Option<ProviderConfig>, String> {
    let provider_configs = state.provider_configs.clone();
    let configs = provider_configs.lock().await;

    // Without its keys or secret header values: the webview never needs them
    // back, and this is how they would leak into it. janhq/jan#8208.
    Ok(configs.get(&provider).map(ProviderConfig::without_secrets))
}

/// List all registered provider configurations (without sensitive keys)
#[tauri::command]
pub async fn list_provider_configs(
    state: State<'_, AppState>,
) -> Result<Vec<ProviderConfig>, String> {
    let provider_configs = state.provider_configs.clone();
    let configs = provider_configs.lock().await;

    // The comment above promised this; the configs came back whole, keys and
    // all. janhq/jan#8208.
    Ok(configs.values().map(ProviderConfig::without_secrets).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(provider: &str, key: &str) -> ProviderConfig {
        ProviderConfig {
            provider: provider.to_string(),
            api_key: Some(key.to_string()),
            api_keys: vec![key.to_string()],
            base_url: None,
            custom_headers: vec![],
            models: vec![],
            api_type: None,
        }
    }

    #[test]
    fn merge_register_api_keys_dedupes_and_trims() {
        let out = merge_register_api_keys(
            Some(" sk-a ".to_string()),
            vec!["sk-a".to_string(), " ".to_string(), "sk-b".to_string()],
        );
        assert_eq!(out, vec!["sk-a".to_string(), "sk-b".to_string()]);
    }

    /// Unregister (boot reconciliation) must only drop the in-memory entry.
    /// Regression guard: the secret store is a separate concern and is never
    /// reached from this path, so a not-yet-reseeded provider keeps its key.
    #[test]
    fn remove_provider_config_is_in_memory_only() {
        let mut configs = HashMap::new();
        configs.insert("openai".to_string(), config("openai", "sk-live"));
        configs.insert("anthropic".to_string(), config("anthropic", "sk-ant"));

        assert!(remove_provider_config(&mut configs, "openai"));
        assert!(!configs.contains_key("openai"));
        // Unrelated provider untouched.
        assert!(configs.contains_key("anthropic"));
        // Removing a missing provider is a no-op reported as false.
        assert!(!remove_provider_config(&mut configs, "openai"));
    }

    /// janhq/jan#8208. What the config commands hand back to the webview: the
    /// keys and the secret header values are gone, everything else is there.
    #[test]
    fn a_config_leaves_the_backend_without_its_secrets() {
        let mut c = config("gateway", "sk-live-key");
        c.api_keys.push("sk-fallback-key".into());
        c.custom_headers = vec![
            crate::core::state::ProviderCustomHeader {
                header: "X-Tenant".into(),
                value: "acme".into(),
                secret: false,
            },
            crate::core::state::ProviderCustomHeader {
                header: "Ocp-Apim-Subscription-Key".into(),
                value: "header-secret-value".into(),
                secret: true,
            },
        ];
        let out = serde_json::to_string(&c.without_secrets()).unwrap();
        for secret in ["sk-live-key", "sk-fallback-key", "header-secret-value"] {
            assert!(!out.contains(secret), "{secret} left the backend: {out}");
        }
        assert!(out.contains("acme") && out.contains("Ocp-Apim-Subscription-Key"), "{out}");
        // The original still holds what requests are sent with.
        assert_eq!(c.custom_headers[1].value, "header-secret-value");
    }

    /// A header saved before `secret` existed still deserializes, as plain.
    #[test]
    fn a_header_without_the_secret_flag_is_plain() {
        let h: ProviderCustomHeader =
            serde_json::from_str(r#"{"header":"X-A","value":"b"}"#).unwrap();
        assert!(!h.secret);
    }
}
