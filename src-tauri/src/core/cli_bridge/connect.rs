//! Connecting and disconnecting a subscription provider (`flint login`, `/login`).
//!
//! Connecting stores only the bridge's own loopback key and a provider entry
//! that points at the bridge. The vendor login stays inside the vendor's CLI.

use crate::core::agent::global_config::{
    remove_provider, set_default_model_if_unset, set_provider, ProviderUpdate,
};
use crate::core::cli::auth::{Credential, CredentialStore};

use super::backend::{find_binary, Backend};

#[derive(Debug, Clone, PartialEq)]
pub struct Connected {
    pub provider: &'static str,
    pub models: Vec<String>,
    pub default_model: Option<String>,
}

fn login_hint(backend: Backend) -> &'static str {
    match backend {
        Backend::Claude => "run `claude auth login`",
        Backend::Codex => "run `codex login`",
        Backend::Gemini => "run `gemini` once and choose Login with Google",
    }
}

fn install_hint(backend: Backend) -> &'static str {
    match backend {
        Backend::Claude => "npm install -g @anthropic-ai/claude-code",
        Backend::Codex => "npm install -g @openai/codex",
        Backend::Gemini => "npm install -g @google/gemini-cli",
    }
}

/// Check the vendor CLI is installed and signed in, start the bridge, and write
/// the provider entry. Nothing is written when a check fails.
pub async fn connect(backend: Backend) -> Result<Connected, String> {
    if find_binary(backend.binary()).is_none() {
        return Err(format!(
            "{} is not installed. Install it with `{}`, then sign in.",
            backend.binary(),
            install_hint(backend)
        ));
    }
    if !backend.logged_in().await {
        return Err(format!(
            "{} is not signed in: {}, then connect again.",
            backend.binary(),
            login_hint(backend)
        ));
    }
    super::ensure_started().await?;
    let token = super::token()?;
    let id = backend.id();
    let models = backend.discover_models().await;

    let previous = CredentialStore::snapshot(id);
    CredentialStore::store(id, &Credential::ApiKey(token))
        .map_err(|error| format!("could not save the bridge key: {error}"))?;
    if let Err(error) = set_provider(
        id,
        ProviderUpdate {
            api_key: None,
            clear_api_key: true,
            base_url: Some(super::base_url(backend)),
            models: Some(models.clone()),
            ..Default::default()
        },
    ) {
        let _ = CredentialStore::restore(id, previous);
        return Err(format!("could not save the provider configuration: {error}"));
    }
    let default_model = models
        .first()
        .and_then(|first| matches!(set_default_model_if_unset(first), Ok(true)).then(|| first.clone()));
    Ok(Connected { provider: id, models, default_model })
}

/// Remove the provider entry and its bridge key. The vendor CLI's own login is
/// left alone: sign out of it with the vendor's command.
pub fn disconnect(backend: Backend) -> Result<(), String> {
    CredentialStore::delete(backend.id())
        .map_err(|error| format!("could not clear the bridge key: {error}"))?;
    remove_provider(backend.id())
        .map_err(|error| format!("could not clear the provider configuration: {error}"))?;
    Ok(())
}
