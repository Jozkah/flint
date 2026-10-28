//! Desktop commands for the subscription providers: check a vendor CLI and hand
//! the UI what it needs to register the provider (the loopback URL, the
//! bridge's own key, the models). The vendor login is never read.

use serde::Serialize;

use super::backend::{find_binary, Backend};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    pub installed: bool,
    pub logged_in: bool,
    pub login_hint: &'static str,
    pub install_hint: &'static str,
    pub disclaimer: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeConnection {
    pub base_url: String,
    pub key: String,
    pub models: Vec<String>,
}

fn backend_of(provider: &str) -> Result<Backend, String> {
    Backend::from_id(provider).ok_or_else(|| format!("{provider} is not a subscription provider"))
}

pub(crate) fn login_hint(backend: Backend) -> &'static str {
    match backend {
        Backend::Claude => "Run `claude auth login` in a terminal.",
        Backend::Codex => "Run `codex login` in a terminal.",
        Backend::Gemini => "Run `gemini` once in a terminal and choose Login with Google.",
    }
}

pub(crate) fn install_hint(backend: Backend) -> &'static str {
    match backend {
        Backend::Claude => "npm install -g @anthropic-ai/claude-code",
        Backend::Codex => "npm install -g @openai/codex",
        Backend::Gemini => "npm install -g @google/gemini-cli",
    }
}

#[tauri::command]
pub async fn cli_bridge_status(provider: String) -> Result<BridgeStatus, String> {
    let backend = backend_of(&provider)?;
    let installed = find_binary(backend.binary()).is_some();
    Ok(BridgeStatus {
        installed,
        logged_in: installed && backend.logged_in().await,
        login_hint: login_hint(backend),
        install_hint: install_hint(backend),
        disclaimer: super::DISCLAIMER,
    })
}

/// Start the bridge and return what the provider entry needs. Fails with a
/// plain message when the CLI is missing or not signed in.
#[tauri::command]
pub async fn cli_bridge_connect(provider: String) -> Result<BridgeConnection, String> {
    let backend = backend_of(&provider)?;
    if find_binary(backend.binary()).is_none() {
        return Err(format!("{} is not installed. {}", backend.binary(), install_hint(backend)));
    }
    if !backend.logged_in().await {
        return Err(format!("{} is not signed in. {}", backend.binary(), login_hint(backend)));
    }
    super::ensure_started().await?;
    Ok(BridgeConnection {
        base_url: super::base_url(backend),
        key: super::token()?,
        models: backend.discover_models().await,
    })
}
