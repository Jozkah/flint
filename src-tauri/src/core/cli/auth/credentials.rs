//! Versioned credential records persisted through the shared secret store
//! (`provider_secrets`: OS keyring first, encrypted permission-restricted file
//! fallback). A credential is the only thing that knows a key or token; the
//! provider catalog and provider configuration never do.

use serde::{Deserialize, Serialize};

use crate::core::server::provider_secrets;

/// Credential record format version; bump on any breaking shape change.
const CREDENTIAL_VERSION: u32 = 1;

/// What a provider account is authenticated with. Stored only as a versioned
/// record under `auth:<provider>`; never in config, logs, or transcripts.
///
/// `OAuthToken` is legacy: the Codex and Claude account sign-ins that wrote it
/// were removed. The variant stays so an old record still loads (and can be
/// reported and signed out) instead of failing to parse; nothing reads its
/// token and nothing writes a new one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum Credential {
    ApiKey(String),
    OAuthToken(OAuthToken),
}

impl Credential {
    /// The API key, when this credential is a plain key.
    pub fn as_api_key(&self) -> Option<&str> {
        match self {
            Credential::ApiKey(key) => Some(key.as_str()),
            Credential::OAuthToken(_) => None,
        }
    }

}

/// An OAuth access token plus the fields needed to refresh it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OAuthToken {
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Unix seconds at which the access token expires; `None` when unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    pub token_type: String,
    #[serde(default)]
    pub scopes: Vec<String>,
}

/// Read/write versioned credential records under `auth:<provider>` in the
/// shared secret store. Has no TUI or HTTP dependency, so any caller can use
/// it without pulling in presentation concerns.
pub struct CredentialStore;

impl CredentialStore {
    /// Replace the stored credential for `provider`. An empty record never
    /// exists: `store` with a value that serializes to nothing is rejected.
    pub fn store(provider: &str, credential: &Credential) -> Result<(), String> {
        if provider.is_empty() || provider.contains(':') || provider.chars().any(char::is_control) {
            return Err(format!("invalid provider id {provider:?}"));
        }
        if matches!(credential, Credential::ApiKey(key) if key.trim().is_empty()) {
            return Err("API key is empty".to_string());
        }
        let record = serde_json::json!({
            "version": CREDENTIAL_VERSION,
            "credential": credential,
        });
        let raw = record.to_string();
        provider_secrets::store_secret_record(&secret_key(provider), &raw)
    }

    /// The stored credential for `provider`, or `None`. A record with an
    /// unknown version or an unparsable body is treated as absent rather than
    /// surfaced, so a future format change degrades to "please sign in again".
    pub fn load(provider: &str) -> Result<Option<Credential>, String> {
        let Some(raw) = provider_secrets::load_secret_record(&secret_key(provider)) else {
            return Ok(None);
        };
        let parsed: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|e| format!("stored credential is unreadable: {e}"))?;
        if parsed.get("version").and_then(|v| v.as_u64()) != Some(CREDENTIAL_VERSION as u64) {
            return Ok(None);
        }
        let body = parsed
            .get("credential")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        serde_json::from_value(body)
            .map(Some)
            .map_err(|e| format!("stored credential is unreadable: {e}"))
    }

    /// Whether a credential is stored for `provider`, without reading it. Answers
    /// from the secret store's presence index, so it never touches the OS
    /// keyring (and never costs a keychain prompt).
    pub fn has(provider: &str) -> bool {
        provider_secrets::has_stored_key(&format!("auth:{}", secret_key(provider)))
    }

    /// Remove the stored credential for `provider`. Missing entries are not an
    /// error.
    pub fn delete(provider: &str) -> Result<(), String> {
        provider_secrets::delete_secret_record(&secret_key(provider))
    }

    /// The stored record for `provider` exactly as it is now, so a sign-in
    /// that overwrites it can put it back with [`CredentialStore::restore`]
    /// if a later step fails.
    pub fn snapshot(provider: &str) -> Option<String> {
        provider_secrets::load_secret_record(&secret_key(provider))
    }

    /// Put back what [`CredentialStore::snapshot`] returned: the previous
    /// record, or no record when there was none.
    pub fn restore(provider: &str, snapshot: Option<String>) -> Result<(), String> {
        match snapshot {
            Some(raw) => provider_secrets::store_secret_record(&secret_key(provider), &raw),
            None => Self::delete(provider),
        }
    }
}

/// Whether `provider` holds an account login left by the removed Codex/Claude
/// sign-in. It cannot authenticate anything; callers use this to say so and
/// point at an API key instead.
pub fn has_removed_account_login(provider: &str) -> bool {
    matches!(
        CredentialStore::load(provider),
        Ok(Some(Credential::OAuthToken(_)))
    )
}

/// Shown when a provider is selected while only a removed account login is stored.
pub const REMOVED_ACCOUNT_LOGIN_NOTICE: &str =
    "the account sign-in for this provider was removed; sign in with an API key instead (/login)";

fn secret_key(provider: &str) -> String {
    format!("auth:{provider}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::server::provider_secrets::TEST_ENV_LOCK;
    use crate::core::server::provider_secrets::TestEnvGuard;

    #[test]
    fn empty_keys_and_bad_provider_ids_are_refused_before_storing() {
        assert!(CredentialStore::store("openai", &Credential::ApiKey("  ".into())).is_err());
        assert!(CredentialStore::store("a:b", &Credential::ApiKey("k".into())).is_err());
        assert!(CredentialStore::store("", &Credential::ApiKey("k".into())).is_err());
    }

    struct TempSecrets {
        _guard: TestEnvGuard,
        prev_data_folder: Option<String>,
        _dir: tempfile::TempDir,
    }

    impl TempSecrets {
        fn new() -> Self {
            let guard = TEST_ENV_LOCK.lock();
            let dir = tempfile::tempdir().unwrap();
            let prev_data_folder = std::env::var("JAN_DATA_FOLDER").ok();
            std::env::set_var("JAN_DATA_FOLDER", dir.path());
            crate::core::server::provider_secrets::force_file_secrets();
            Self {
                _guard: guard,
                prev_data_folder,
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
        }
    }

    #[test]
    fn restore_puts_back_the_previous_credential_or_nothing() {
        let _tmp = TempSecrets::new();
        CredentialStore::store("openai", &Credential::ApiKey("old".into())).unwrap();
        let before = CredentialStore::snapshot("openai");
        CredentialStore::store("openai", &Credential::ApiKey("new".into())).unwrap();
        CredentialStore::restore("openai", before).unwrap();
        assert!(matches!(
            CredentialStore::load("openai").unwrap(),
            Some(Credential::ApiKey(key)) if key == "old"
        ));

        let none = CredentialStore::snapshot("deepseek");
        assert!(none.is_none());
        CredentialStore::store("deepseek", &Credential::ApiKey("new".into())).unwrap();
        CredentialStore::restore("deepseek", none).unwrap();
        assert!(CredentialStore::load("deepseek").unwrap().is_none());
    }

    fn oauth_credential() -> Credential {
        Credential::OAuthToken(OAuthToken {
            access_token: "access".into(),
            refresh_token: Some("refresh".into()),
            expires_at: Some(1_800_000_000),
            token_type: "Bearer".into(),
            scopes: vec!["model.read".into()],
        })
    }

    #[test]
    fn a_stored_account_login_still_loads_and_is_reported_as_removed() {
        let _tmp = TempSecrets::new();
        let credential = oauth_credential();
        CredentialStore::store("openai", &credential).unwrap();
        assert_eq!(CredentialStore::load("openai").unwrap(), Some(credential));
        assert!(has_removed_account_login("openai"));
        assert_eq!(
            CredentialStore::load("openai").unwrap().unwrap().as_api_key(),
            None,
            "the legacy token is never usable as a key"
        );

        CredentialStore::store("anthropic", &Credential::ApiKey("sk-ant".into())).unwrap();
        assert!(!has_removed_account_login("anthropic"));
        assert!(!has_removed_account_login("deepseek"));
    }

    #[test]
    fn a_pre_removal_oauth_record_on_disk_parses() {
        let _tmp = TempSecrets::new();
        // The exact shape the removed sign-in wrote.
        let raw = r#"{"version":1,"credential":{"kind":"o_auth_token","value":{"access_token":"a","refresh_token":"r","expires_at":1800000000,"token_type":"Bearer","scopes":["x"]}}}"#;
        provider_secrets::store_secret_record(&secret_key("anthropic"), raw).unwrap();
        assert!(has_removed_account_login("anthropic"));
    }

    #[test]
    fn credential_store_roundtrips_and_deletes_api_key() {
        let _tmp = TempSecrets::new();
        let credential = Credential::ApiKey("sk-live".into());
        CredentialStore::store("deepseek", &credential).unwrap();
        assert_eq!(CredentialStore::load("deepseek").unwrap(), Some(credential));

        CredentialStore::delete("deepseek").unwrap();
        assert_eq!(CredentialStore::load("deepseek").unwrap(), None);
        // Deleting one provider never touches another's record.
        assert_eq!(CredentialStore::load("openai").unwrap(), None);
    }

    #[test]
    fn load_missing_provider_is_none_and_delete_is_idempotent() {
        let _tmp = TempSecrets::new();
        assert_eq!(CredentialStore::load("anthropic").unwrap(), None);
        assert!(CredentialStore::delete("anthropic").is_ok());
    }

    #[test]
    fn provider_records_are_namespaced_away_from_key_chains() {
        let _tmp = TempSecrets::new();
        // A legacy provider key chain and a login credential share a provider
        // name but must not collide on storage.
        crate::core::server::provider_secrets::store_provider_keys(
            "openai",
            &["sk-legacy".to_string()],
        )
        .unwrap();
        let credential = Credential::ApiKey("sk-login".into());
        CredentialStore::store("openai", &credential).unwrap();
        assert_eq!(CredentialStore::load("openai").unwrap(), Some(credential));
        assert_eq!(
            crate::core::server::provider_secrets::load_provider_keys("openai"),
            vec!["sk-legacy".to_string()]
        );
    }
}
