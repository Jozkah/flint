//! API-key validation and the login/logout transaction.
//!
//! Ordering is the security contract: sanitize, then validate over HTTP,
//! then persist the secret, then write only non-secret provider
//! configuration. A failure at any point leaves nothing behind - a rejected
//! key never creates a credential record or a config entry, and a failed
//! write rolls back the secret it already stored.

use std::time::Duration;

use crate::core::agent::global_config::{
    remove_provider, set_default_model_if_unset, set_provider, ProviderUpdate,
};

use super::{Credential, CredentialStore, LoginError, LoginResult, ProviderDefinition, Transport};

const VERIFY_TIMEOUT: Duration = Duration::from_secs(20);

/// Trim and reject a key before any I/O. A key with interior whitespace is
/// a mis-paste (partial selection, wrapped line) that would otherwise fail
/// as a confusing 401.
pub fn sanitize_key(raw: &str) -> Result<String, String> {
    let key = raw.trim();
    if key.is_empty() {
        return Err("no API key entered".to_string());
    }
    if key.chars().any(char::is_whitespace) {
        return Err("that key contains spaces or line breaks - copy it again".to_string());
    }
    Ok(key.to_string())
}

/// Validate `raw_key` against the provider's model endpoint, then persist
/// the credential (secret store) and non-secret provider configuration.
/// Nothing is written when validation fails.
pub async fn login_with_api_key(
    definition: &ProviderDefinition,
    raw_key: &str,
) -> Result<LoginResult, LoginError> {
    let key = sanitize_key(raw_key).map_err(LoginError::InvalidKey)?;
    let models = discover_models(definition, &key).await?;
    persist(definition, &key, &models)
}

/// Remove the stored credential and the provider's non-secret
/// configuration entry. Missing entries are not an error.
pub fn logout(provider: &str) -> Result<(), LoginError> {
    CredentialStore::delete(provider)
        .map_err(|e| LoginError::Persist(format!("could not clear the stored credential: {e}")))?;
    remove_provider(provider).map_err(|e| {
        LoginError::Persist(format!("could not clear the provider configuration: {e}"))
    })?;
    Ok(())
}

pub(crate) async fn discover_models(
    definition: &ProviderDefinition,
    credential: &str,
) -> Result<Vec<String>, LoginError> {
    let client = crate::core::net::tls::apply12(reqwest::Client::builder().timeout(VERIFY_TIMEOUT))
        .build()
        .map_err(|e| LoginError::Unavailable(format!("could not build an HTTP client: {e}")))?;
    let url = format!(
        "{}/models",
        definition.default_base_url.trim_end_matches('/')
    );
    let mut request = client.get(&url);
    request = match definition.transport {
        // An API-key credential identifies itself with `x-api-key`.
        Transport::Anthropic => request
            .header("x-api-key", credential)
            .header("anthropic-version", "2023-06-01")
            .header("Accept", "application/json"),
        Transport::OpenAi => request.header("Authorization", format!("Bearer {credential}")),
    };
    let response = request.send().await.map_err(|e| {
        LoginError::Unavailable(format!(
            "could not reach {}: {e}",
            definition.default_base_url
        ))
    })?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(failure_for(definition, status.as_u16(), &body));
    }
    let parsed: serde_json::Value = serde_json::from_str(&body).map_err(|e| {
        LoginError::Unavailable(format!(
            "{} returned a response we could not read: {e}",
            definition.name
        ))
    })?;
    Ok(parse_models(&parsed))
}

/// Human-readable reason a verification request was rejected. Never includes
/// the key.
fn failure_for(definition: &ProviderDefinition, status: u16, _body: &str) -> LoginError {
    match status {
        401 | 403 => LoginError::Unauthorized,
        429 => LoginError::RateLimited,
        500..=599 => LoginError::Unavailable(format!(
            "{} is unavailable right now (HTTP {status}).",
            definition.name
        )),
        _ => LoginError::Unavailable(format!("{} returned HTTP {status}.", definition.name)),
    }
}

/// Model ids from a `/models` payload, sorted and deduped so a config write
/// and the "N models" report are stable across calls. Accepts the OpenAI shape
/// (`{"data":[{"id":...}]}`) plus the bare-array and array-of-strings variants
/// smaller gateways serve. Anthropic's `/models` uses the same `data` shape.
pub(crate) fn parse_models(value: &serde_json::Value) -> Vec<String> {
    let entries = value
        .get("data")
        .and_then(|d| d.as_array())
        .or_else(|| value.as_array());
    let Some(entries) = entries else {
        return Vec::new();
    };
    let mut ids: Vec<String> = entries
        .iter()
        .filter_map(|entry| {
            entry
                .as_str()
                .or_else(|| entry.get("id").and_then(|id| id.as_str()))
        })
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(String::from)
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

/// The first listed model that can hold a chat: embedding, speech, image,
/// moderation and legacy completion models are skipped. `None` leaves the
/// default unset, so the user picks one with `/model` rather than inheriting a
/// model that cannot answer.
fn pick_default_model(ids: &[String]) -> Option<String> {
    const NOT_CHAT: [&str; 11] = [
        "embed", "whisper", "tts", "dall-e", "moderation", "babbage", "davinci", "-instruct", "image", "audio",
        "rerank",
    ];
    ids.iter()
        .find(|id| {
            let lower = id.to_ascii_lowercase();
            !NOT_CHAT.iter().any(|marker| lower.contains(marker))
        })
        .cloned()
}

/// Write the verified key + model list. Secret first, then non-secret
/// configuration; a failed config write rolls back the secret.
fn persist(
    definition: &ProviderDefinition,
    key: &str,
    models: &[String],
) -> Result<LoginResult, LoginError> {
    // What was stored before, so a failed config write puts it back instead
    // of signing the user out of a provider they were already signed in to.
    let previous = CredentialStore::snapshot(definition.id);
    CredentialStore::store(definition.id, &Credential::ApiKey(key.to_string()))
        .map_err(|e| LoginError::Persist(format!("could not save the credential securely: {e}")))?;

    let config_path = match set_provider(
        definition.id,
        ProviderUpdate {
            // Keys never enter provider configuration; the credential store is
            // the only home for secrets.
            api_key: None,
            // Migrate away any legacy plaintext key the entry still holds.
            clear_api_key: true,
            base_url: Some(definition.default_base_url.clone()),
            models: Some(models.to_vec()),
            api_type: match definition.transport {
                Transport::Anthropic => Some("anthropic".to_string()),
                Transport::OpenAi => None,
            },
            ..Default::default()
        },
    ) {
        Ok(path) => path,
        Err(e) => {
            let _ = CredentialStore::restore(definition.id, previous);
            return Err(LoginError::Persist(format!(
                "could not save the provider configuration: {e}"
            )));
        }
    };

    // Adopt the first discovered model as the default only when the user has
    // none; an explicit choice is never overwritten. A failure here is not
    // fatal: the sign-in itself is complete and the config is valid.
    let default_model = match pick_default_model(models) {
        Some(first) => match set_default_model_if_unset(&first) {
            Ok(true) => Some(first),
            _ => None,
        },
        None => None,
    };

    Ok(LoginResult {
        provider: definition.id.to_string(),
        models: models.to_vec(),
        config_path,
        default_model,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_default_skips_embeddings() {
        let ids = ["text-embedding-3-small", "whisper-1", "gpt-4o", "gpt-4o-mini"].map(String::from);
        assert_eq!(pick_default_model(&ids).as_deref(), Some("gpt-4o"));
    }

    #[test]
    fn pick_default_none_leaves_unset() {
        let ids = ["text-embedding-3-small", "tts-1"].map(String::from);
        assert_eq!(pick_default_model(&ids), None);
        assert_eq!(pick_default_model(&[]), None);
    }

    use crate::core::agent::global_config::{load_global_config, with_temp_home};
    use crate::core::cli::auth::provider_by_id;
    use crate::core::server::provider_secrets::TEST_ENV_LOCK;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use crate::core::server::provider_secrets::TestEnvGuard;

    struct TempSecrets {
        _guard: TestEnvGuard,
        prev_data_folder: Option<String>,
        prev_home: Option<std::ffi::OsString>,
        _dir: tempfile::TempDir,
    }

    impl TempSecrets {
        fn new() -> Self {
            let guard = TEST_ENV_LOCK.lock();
            let dir = tempfile::tempdir().unwrap();
            let prev_data_folder = std::env::var("JAN_DATA_FOLDER").ok();
            std::env::set_var("JAN_DATA_FOLDER", dir.path());
            // These tests persist a secret *and* non-secret config, and the
            // non-secret half lands in `~/.jan`. Pin that to the same scratch
            // tree, or the test reads back whatever home another test happened
            // to leave configured.
            let prev_home = std::env::var_os(crate::core::app::commands::JAN_HOME_ENV);
            std::env::set_var(crate::core::app::commands::JAN_HOME_ENV, dir.path());
            crate::core::server::provider_secrets::force_file_secrets();
            Self {
                _guard: guard,
                prev_data_folder,
                prev_home,
                _dir: dir,
            }
        }
    }

    impl Drop for TempSecrets {
        fn drop(&mut self) {
            match &self.prev_data_folder {
                Some(v) => std::env::set_var("JAN_DATA_FOLDER", v),
                None => std::env::remove_var("JAN_DATA_FOLDER"),
            }
            match &self.prev_home {
                Some(v) => std::env::set_var(crate::core::app::commands::JAN_HOME_ENV, v),
                None => std::env::remove_var(crate::core::app::commands::JAN_HOME_ENV),
            }
        }
    }

    /// A one-shot HTTP server answering with `status` and `body`, returning its
    /// base URL. The thread detaches; it serves exactly one request.
    fn mock_server(status_line: &'static str, body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(1) {
                let Ok(mut stream) = stream else { continue };
                let _ = Read::read(&mut stream, &mut [0u8; 4096]);
                let response = format!(
                    "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = Write::write_all(&mut stream, response.as_bytes());
            }
        });
        format!("http://{addr}/v1")
    }

    fn deepseek_at(endpoint: String) -> ProviderDefinition {
        let mut def = provider_by_id("deepseek").unwrap();
        def.default_base_url = endpoint;
        def
    }

    fn login_for_test(
        definition: &ProviderDefinition,
        key: &str,
    ) -> Result<LoginResult, LoginError> {
        let definition = definition.clone();
        let key = key.to_string();
        std::thread::spawn(move || {
            tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(login_with_api_key(&definition, &key))
        })
        .join()
        .expect("verification thread must not panic")
    }

    #[test]
    fn sanitize_trims_and_rejects_unusable_input() {
        assert_eq!(sanitize_key("  sk-abc\n").unwrap(), "sk-abc");
        assert!(sanitize_key("   ").is_err());
        assert!(sanitize_key("").is_err());
        assert!(sanitize_key("sk-abc def").is_err());
        assert!(sanitize_key("sk-abc\ndef").is_err());
    }

    #[test]
    fn parses_openai_and_bare_model_lists_sorted_and_deduped() {
        let body = json!({"data": [{"id": "deepseek-chat"}, {"id": "b"}, {"id": "b"}]});
        assert_eq!(
            parse_models(&body),
            vec!["b".to_string(), "deepseek-chat".to_string()]
        );
        assert_eq!(
            parse_models(&json!(["x", {"id": "y"}])),
            vec!["x".to_string(), "y".to_string()]
        );
        assert!(parse_models(&json!({"data": []})).is_empty());
        assert!(parse_models(&json!({"unexpected": 1})).is_empty());
    }

    #[test]
    fn provider_error_never_echoes_the_submitted_key() {
        let definition = provider_by_id("deepseek").unwrap();
        let error = failure_for(
            &definition,
            400,
            r#"{"error":{"message":"invalid key sk-secret"}}"#,
        );
        let LoginError::Unavailable(message) = error else {
            panic!("HTTP 400 must be an unavailable error");
        };
        assert!(!message.contains("sk-secret"), "{message}");
    }

    #[test]
    fn rejected_key_never_writes_a_secret_or_provider_config() {
        let _tmp = TempSecrets::new();
        with_temp_home(|_| {
            let endpoint = mock_server("401 Unauthorized", "{}");
            let result = login_for_test(&deepseek_at(endpoint), "bad");
            assert!(matches!(result, Err(LoginError::Unauthorized)));
            assert!(CredentialStore::load("deepseek").unwrap().is_none());
            assert!(!load_global_config().unwrap().contains_key("deepseek"));
        });
    }

    #[tokio::test]
    async fn rate_limited_key_maps_to_rate_limited_error() {
        let _tmp = TempSecrets::new();
        let endpoint = mock_server("429 Too Many Requests", "{}");
        let result = login_with_api_key(&deepseek_at(endpoint), "sk-busy").await;
        assert!(matches!(result, Err(LoginError::RateLimited)));
    }

    #[tokio::test]
    async fn unreachable_provider_maps_to_unavailable() {
        let _tmp = TempSecrets::new();
        // Nothing listens on this port: connection refused.
        let def = deepseek_at("http://127.0.0.1:9/v1".to_string());
        let result = login_with_api_key(&def, "sk-x").await;
        assert!(matches!(result, Err(LoginError::Unavailable(_))));
    }

    #[tokio::test]
    async fn valid_key_persists_secret_and_non_secret_config() {
        let _tmp = TempSecrets::new();
        with_temp_home(|_| {
            let body = r#"{"data":[{"id":"deepseek-chat"},{"id":"deepseek-reasoner"}]}"#;
            let endpoint = mock_server("200 OK", body);
            let result = login_for_test(&deepseek_at(endpoint.clone()), "sk-ok").unwrap();
            assert_eq!(result.provider, "deepseek");
            assert_eq!(
                result.models,
                vec!["deepseek-chat".to_string(), "deepseek-reasoner".to_string()]
            );
            assert_eq!(result.default_model.as_deref(), Some("deepseek-chat"));

            // The credential lives only in the secret store.
            assert_eq!(
                CredentialStore::load("deepseek").unwrap(),
                Some(Credential::ApiKey("sk-ok".into()))
            );
            // The config entry carries no secret, only id/endpoint/models.
            let cfg = load_global_config()
                .unwrap()
                .get("deepseek")
                .unwrap()
                .clone();
            assert!(cfg.api_key.is_none());
            assert!(cfg.api_keys.is_empty());
            assert_eq!(cfg.base_url.as_deref(), Some(endpoint.as_str()));
            assert_eq!(
                cfg.models,
                vec!["deepseek-chat".to_string(), "deepseek-reasoner".to_string()]
            );
        });
    }

    /// Makes the next `set_provider` fail: config.toml exists but is not TOML.
    fn break_global_config() {
        let path = crate::core::agent::global_config::global_config_path().unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "this is [not toml").unwrap();
    }

    /// #201: a failed config write puts the previous credential back, so a
    /// re-login that fails half-way does not sign the user out.
    #[test]
    fn a_failed_config_write_restores_the_previous_credential() {
        let _tmp = TempSecrets::new();
        with_temp_home(|_| {
            CredentialStore::store("deepseek", &Credential::ApiKey("sk-old".into())).unwrap();
            break_global_config();
            let def = deepseek_at("http://127.0.0.1:9/v1".to_string());
            let result = persist(&def, "sk-new", &["deepseek-chat".to_string()]);
            assert!(matches!(result, Err(LoginError::Persist(_))));
            assert_eq!(
                CredentialStore::load("deepseek").unwrap(),
                Some(Credential::ApiKey("sk-old".into()))
            );
        });
    }

    /// #201: with no previous credential, a failed config write leaves none.
    #[test]
    fn a_failed_config_write_without_a_previous_credential_leaves_none() {
        let _tmp = TempSecrets::new();
        with_temp_home(|_| {
            break_global_config();
            let def = deepseek_at("http://127.0.0.1:9/v1".to_string());
            let result = persist(&def, "sk-new", &["deepseek-chat".to_string()]);
            assert!(matches!(result, Err(LoginError::Persist(_))));
            assert!(CredentialStore::load("deepseek").unwrap().is_none());
        });
    }

    #[tokio::test]
    async fn logout_removes_credential_and_config() {
        let _tmp = TempSecrets::new();
        with_temp_home(|_| {
            let body = r#"{"data":[{"id":"deepseek-chat"}]}"#;
            let endpoint = mock_server("200 OK", body);
            login_for_test(&deepseek_at(endpoint), "sk-ok").unwrap();
            assert!(CredentialStore::load("deepseek").unwrap().is_some());
            assert!(load_global_config().unwrap().contains_key("deepseek"));

            logout("deepseek").unwrap();
            assert!(CredentialStore::load("deepseek").unwrap().is_none());
            assert!(!load_global_config().unwrap().contains_key("deepseek"));
            // Logging out again is a no-op, not an error.
            logout("deepseek").unwrap();
        });
    }

    #[tokio::test]
    async fn legacy_plaintext_key_is_cleared_by_login() {
        let _tmp = TempSecrets::new();
        with_temp_home(|_| {
            // Simulate a pre-existing legacy entry with a plaintext key.
            set_provider(
                "deepseek",
                ProviderUpdate {
                    api_key: Some("sk-legacy".into()),
                    clear_api_key: false,
                    base_url: Some("https://api.deepseek.com/v1".into()),
                    models: Some(vec!["deepseek-chat".into()]),
                    api_type: None,
                    ..Default::default()
                },
            )
            .unwrap();

            let body = r#"{"data":[{"id":"deepseek-chat"}]}"#;
            let endpoint = mock_server("200 OK", body);
            login_for_test(&deepseek_at(endpoint), "sk-new").unwrap();

            let cfg = load_global_config()
                .unwrap()
                .get("deepseek")
                .unwrap()
                .clone();
            assert!(
                cfg.api_key.is_none(),
                "legacy plaintext key must be migrated away"
            );
            assert_eq!(
                CredentialStore::load("deepseek").unwrap(),
                Some(Credential::ApiKey("sk-new".into()))
            );
        });
    }
}
