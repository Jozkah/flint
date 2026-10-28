//! Cloud provider credential loader for the CLI.
//!
//! Flint Agent runs standalone, without Flint Desktop, so provider config is
//! resolved from two `.jan` scopes rather than desktop's `settings.json`:
//!
//! 1. Global `~/.jan/config.toml` (user-wide, [`crate::core::agent::global_config`]) - the base.
//! 2. Desktop `settings.json`, if present, is layered in as an **inherit-only**
//!    additive source (never overwrites a Global entry, never written back to).
//! 3. Project-local `agent.toml` `[provider]` override
//!    ([`crate::core::agent::project::ProviderSection`]) - highest of the
//!    three, since it's an explicit per-project choice.
//! 4. `--provider`/`--api-key` CLI flags (+ `JAN_API_KEY`/`{PROVIDER}_API_KEY`
//!    env fallback via [`ProviderOverrides::with_env`]) win over all of the
//!    above - the most explicit, most ephemeral signal.
//!
//! Under `flint serve`, the providers its browser client added (kept in the
//! server's `web-server/settings.json`, keys in the server's keyring) are
//! layered between 2 and 3: they replace a Global/Desktop entry of the same
//! name and are themselves replaced by a project's `agent.toml` under the same
//! endpoint-trust rule as any other user-written provider.

use std::{collections::HashMap, path::Path, time::Duration};

use crate::core::agent::global_config::load_global_config;
use crate::core::agent::project::ProviderSection;
use crate::core::app::commands::resolve_jan_data_folder;
use crate::core::state::{same_endpoint, ProviderConfig, StoredCredentials};

const MODEL_PROVIDER_KEY: &str = "model-provider";
const API_KEY_SETTING_KEYS: [&str; 2] = ["api-key", "api_key"];

/// CLI/env overrides applied after loading the persisted store.
#[derive(Debug, Default, Clone)]
pub struct ProviderOverrides {
    /// Restrict/target a single provider (e.g. `anthropic`).
    pub provider: Option<String>,
    /// API key to inject for `provider` (or all providers when `provider` is None).
    pub api_key: Option<String>,
    /// Whether the user named `provider` explicitly (`--provider`), so a run
    /// must go to it. A provider defaulted from the desktop selection only
    /// steers the env-key fallback and never pins the run.
    pub pin: bool,
}

impl ProviderOverrides {
    /// Fold in environment fallbacks for the API key when not set explicitly.
    /// `JAN_API_KEY` wins, then a provider-specific var (`ANTHROPIC_API_KEY`,
    /// `OPENAI_API_KEY`, ...) when a provider is targeted.
    pub fn with_env(mut self) -> Self {
        if self.api_key.is_none() {
            if let Ok(k) = crate::core::compat_env::var("API_KEY") {
                if !k.is_empty() {
                    self.api_key = Some(k);
                }
            }
        }
        if self.api_key.is_none() {
            if let Some(provider) = &self.provider {
                // A display name such as `Qwen 3.8 (8080)` is not a valid
                // variable name: anything but letters and digits becomes `_`,
                // and runs collapse.
                let mut name = String::new();
                for c in provider.chars() {
                    let c = if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' };
                    if c != '_' || !name.ends_with('_') {
                        name.push(c);
                    }
                }
                let var = format!("{}_API_KEY", name.trim_matches('_'));
                if let Ok(k) = std::env::var(&var) {
                    if !k.is_empty() {
                        self.api_key = Some(k);
                    }
                }
            }
        }
        self
    }
}

/// The desktop app's current selection (`state.selectedProvider` /
/// `state.selectedModel.id` in the `model-provider` store), used to default the
/// CLI `--provider`/`--model` when the user gives none.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct DesktopSelection {
    pub provider: Option<String>,
    pub model: Option<String>,
}

/// Read the desktop's selected provider + model from `settings.json`. Missing or
/// malformed data yields an empty selection (no defaults applied).
pub fn desktop_selection() -> DesktopSelection {
    let path = resolve_jan_data_folder().join("settings.json");
    match std::fs::read_to_string(&path) {
        Ok(raw) => parse_selection(&raw),
        Err(_) => DesktopSelection::default(),
    }
}

/// The model the `flint serve` browser last selected, when this process is a
/// server and that model's provider is one the browser added. `None` otherwise.
pub fn server_selected_model() -> Option<String> {
    let raw = server_settings_raw()?;
    let selection = parse_selection(&raw);
    let model = selection.model?;
    let provider = selection.provider?;
    server_provider_entries(&raw)
        .iter()
        .any(|p| p.get("provider").and_then(|v| v.as_str()) == Some(provider.as_str()))
        .then_some(model)
}

/// Extract the selection from a `settings.json` body. Tolerant of shape drift.
fn parse_selection(raw: &str) -> DesktopSelection {
    let root: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return DesktopSelection::default(),
    };
    let blob = match root.get(MODEL_PROVIDER_KEY).and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return DesktopSelection::default(),
    };
    let parsed: serde_json::Value = match serde_json::from_str(blob) {
        Ok(v) => v,
        Err(_) => return DesktopSelection::default(),
    };
    let state = parsed.get("state");
    let non_empty = |v: Option<&serde_json::Value>| {
        v.and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
    };
    DesktopSelection {
        provider: non_empty(state.and_then(|s| s.get("selectedProvider"))),
        model: non_empty(state.and_then(|s| s.get("selectedModel").and_then(|m| m.get("id")))),
    }
}

/// Whether the CLI can actually reach this provider. A populated `base_url` is
/// an HTTP upstream; an empty one means a local engine (llamacpp, llamacpp-rs,
/// mlx) whose endpoint only exists after the desktop app spawns it. The CLI is
/// remote-only, so those entries are dead options and must not be offered.
/// Mirrors the resolution rule in `agent::upstream::resolve_upstream_for_model`,
/// whose local-engine branches are compiled out of this build.
pub fn is_cli_reachable(config: &ProviderConfig) -> bool {
    config.base_url.as_deref().is_some_and(|u| !u.is_empty())
}

/// Log a provider-config load failure at most once per process. Startup probes
/// this in two independent places (the headless sign-in guard and the model
/// fallback), and a malformed `~/.jan/config.toml` fails both, so without this
/// the same multi-line TOML error is printed twice before the fatal error
/// prints it a third time.
fn warn_load_failure_once(context: &str, err: &str) {
    static LOGGED: std::sync::Once = std::sync::Once::new();
    LOGGED.call_once(|| log::warn!("could not load provider configs{context}: {err}"));
}

/// Whether this install can run a turn at all: some provider is reachable and
/// either credentialed or local (a self-hosted endpoint - typically the desktop
/// app's API server - needs no key). `false` is the fresh-install state that
/// triggers the sign-in flow. A remote entry with no key does not count: the
/// request would only fail later with a 401.
pub fn has_usable_provider(project_root: Option<&std::path::Path>) -> bool {
    let overrides = ProviderOverrides::default().with_env();
    match load_provider_configs(project_root, &overrides) {
        Ok(configs) => configs.values().any(is_usable),
        Err(e) => {
            warn_load_failure_once("", &e);
            false
        }
    }
}

/// Whether `provider` has a stored credential or resolves to a usable config.
pub fn provider_is_signed_in(project_root: Option<&Path>, provider: &str) -> bool {
    // Only an API key counts: a stored account login from a removed sign-in
    // cannot authenticate anything.
    if matches!(
        crate::core::cli::auth::CredentialStore::load(provider),
        Ok(Some(credential)) if credential.as_api_key().is_some()
    ) {
        return true;
    }

    let overrides = ProviderOverrides {
        provider: Some(provider.to_string()),
        api_key: None,
        pin: false,
    }
    .with_env();

    load_provider_configs(project_root, &overrides)
        .ok()
        .and_then(|configs| configs.get(provider).map(is_usable))
        .unwrap_or(false)
}

fn is_usable(config: &ProviderConfig) -> bool {
    if !is_cli_reachable(config) {
        return false;
    }
    has_credential(config) || config.base_url.as_deref().is_some_and(is_loopback_url)
}

/// Whether a base URL points at this machine, where an API key is usually not
/// required. Host-only match (no DNS): anything else is treated as remote.
///
/// The host is the one a URL parser -- and so the HTTP client -- reads, so
/// user info cannot pass for it: `http://localhost:80@evil.example` is
/// `evil.example`. A bare `host:port` without a scheme is read as `http://`.
/// Anything that does not parse is remote.
pub(crate) fn is_loopback_url(url: &str) -> bool {
    let url = url.trim();
    let parsed = if url.contains("://") {
        url::Url::parse(url)
    } else {
        url::Url::parse(&format!("http://{url}"))
    };
    match parsed.ok().and_then(|u| u.host().map(|h| h.to_owned())) {
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        // `0.0.0.0` is not loopback, but a server bound to it is reached here
        // and it was always accepted.
        Some(url::Host::Ipv4(ip)) => ip.is_loopback() || ip.is_unspecified(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// `(provider, model_id)` pairs the CLI can actually run: Tokamak first, then
/// every other provider by name, models sorted within each.
///
/// Tokamak leads because it is the provider the product signs users in to; a
/// plain alphabetical sort buried it below whatever else happened to be
/// configured. Ordering only -- nothing is filtered by provider, so a user who
/// prefers another provider still sees it.
pub fn reachable_models(configs: &HashMap<String, ProviderConfig>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = configs
        .values()
        .filter(|c| is_cli_reachable(c))
        .flat_map(|c| c.models.iter().map(|m| (c.provider.clone(), m.clone())))
        .collect();
    // `false < true`, so the Tokamak rows sort ahead of everything else while
    // the rest stay alphabetical.
    out.sort_by(|a, b| {
        let key = |(provider, model): &(String, String)| {
            (
                provider != super::tokamak::PROVIDER,
                provider.clone(),
                model.clone(),
            )
        };
        key(a).cmp(&key(b))
    });
    out
}

/// Name of the local-engine provider serving `model_id` when **no** reachable
/// provider offers it, so the caller can reject the run up front instead of
/// failing at upstream resolution. Lookup mirrors
/// `agent::upstream::resolve_upstream_for_model`: an exact hit in a provider's
/// `models` list, or a `<provider>/<model>` prefix.
///
/// `None` for a model nobody claims: provider `models` lists are routinely
/// incomplete (custom deployments, freshly released ids), so an unknown id must
/// still fall through to normal resolution rather than be rejected here.
pub fn unreachable_local_provider(
    configs: &HashMap<String, ProviderConfig>,
    model_id: &str,
) -> Option<String> {
    let offering = |c: &&ProviderConfig| c.models.iter().any(|m| m == model_id);
    if configs.values().filter(offering).any(is_cli_reachable) {
        return None;
    }
    if let Some(local) = configs.values().find(|c| offering(c)) {
        return Some(local.provider.clone());
    }

    let prefix = model_id.split_once('/')?.0;
    configs
        .get(prefix)
        .filter(|c| !is_cli_reachable(c))
        .map(|c| c.provider.clone())
}

/// Runnable `(provider, model_id)` pairs for the TUI `/model` selector, taken
/// from the same layered resolution the agent uses -- so the picker offers
/// exactly what a run can reach, including `~/.jan/config.toml` providers the
/// desktop store knows nothing about.
pub fn list_provider_models(project_root: Option<&std::path::Path>) -> Vec<(String, String)> {
    match load_provider_configs(project_root, &ProviderOverrides::default().with_env()) {
        Ok(configs) => reachable_models(&configs),
        Err(e) => {
            warn_load_failure_once(" for the model picker", &e);
            Vec::new()
        }
    }
}

/// Populate model lists for providers that have none configured
/// (e.g. a provider just added via the `/settings` wizard with the models field
/// left blank). For each reachable provider with an empty `models` list, query
/// its OpenAI-compatible `GET {base_url}/models` endpoint and persist the
/// discovered ids back to `~/.jan/config.toml`, mirroring how `/login` records
/// Tokamak's model list. Returns `true` if at least one provider was populated.
/// An unreachable endpoint is not fatal: it yields a warning and is skipped, so
/// a dead credential never blocks the picker. The configured list is preserved
/// when a provider already names models (the user's explicit choice wins), and
/// only providers present in the global store are touched -- writing a
/// models-only entry for a Desktop-inherited provider would shadow it.
/// `already_probed` records which `(provider, base_url)` pairs were queried,
/// so each is touched at most once per session: a dead upstream is not
/// re-contacted on every picker open.
pub async fn fetch_missing_models(
    project_root: Option<&std::path::Path>,
    already_probed: &mut std::collections::HashSet<String>,
) -> Result<bool, String> {
    let global = load_global_config()?;
    let configs = load_provider_configs(project_root, &ProviderOverrides::default().with_env())?;
    let to_fetch: Vec<(String, String, Vec<String>)> = configs
        .values()
        .filter(|c| global.contains_key(&c.provider) && is_cli_reachable(c) && c.models.is_empty())
        // Probe each provider at most once per session. A provider that still
        // has an empty list after a probe was unreachable or offered nothing;
        // re-probing it on every bare `/model` would freeze the render loop
        // for the full request timeout each time. Filtered before the key is
        // fetched so a re-open cannot re-prompt for a provider already probed.
        .filter(|c| {
            let tag = format!("{}|{}", c.provider, c.base_url.clone().unwrap_or_default());
            if already_probed.contains(&tag) {
                return false;
            }
            already_probed.insert(tag);
            true
        })
        .cloned()
        .map(|mut c| {
            hydrate_provider_keys(&mut c);
            (
                c.provider.clone(),
                c.base_url.clone().unwrap_or_default(),
                c.bearer_key_chain(),
            )
        })
        .collect();
    if to_fetch.is_empty() {
        return Ok(false);
    }

    let client = crate::core::net::tls::apply12(reqwest::Client::builder().timeout(Duration::from_secs(15)))
        .build()
        .map_err(|e| e.to_string())?;
    // Probe providers concurrently so a batch of dead upstreams cannot stall
    // the `/model` picker for the sum of their timeouts; the slowest provider
    // bounds the wait.
    let results = futures::future::join_all(to_fetch.into_iter().map(|(name, base_url, keys)| {
        let client = &client;
        async move {
            let models = fetch_models(client, &base_url, &keys).await;
            (name, base_url, models)
        }
    }))
    .await;
    let mut populated = false;
    for (name, _, result) in results {
        let models = match result {
            Ok(m) => m,
            Err(e) => {
                log::warn!("could not list models for provider '{name}': {e}");
                continue;
            }
        };
        if models.is_empty() {
            continue;
        }
        crate::core::agent::global_config::set_provider(
            &name,
            crate::core::agent::global_config::ProviderUpdate {
                api_key: None,
                base_url: None,
                clear_api_key: false,
                models: Some(models),
                api_type: None,
                ..Default::default()
            },
        )?;
        populated = true;
    }
    Ok(populated)
}

/// `url` with any `user:password@` removed, for messages. Unparseable text is
/// returned as is.
fn without_userinfo(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(mut parsed) if !parsed.username().is_empty() || parsed.password().is_some() => {
            let _ = parsed.set_username("");
            let _ = parsed.set_password(None);
            parsed.to_string()
        }
        _ => url.to_string(),
    }
}

/// Query an OpenAI-compatible `GET {base_url}/models` with Bearer auth (trying
/// each key in the chain on 401/403, matching upstream resolution) and return
/// the parsed, sorted, deduped ids from the response body. A provider with no
/// key (a keyless local endpoint) is queried unauthenticated. A remote
/// plaintext-`http` base URL is rejected up front so a bearer key is never
/// sent over a cleartext connection (loopback `http` is allowed).
async fn fetch_models(
    client: &reqwest::Client,
    base_url: &str,
    keys: &[String],
) -> Result<Vec<String>, String> {
    if !(base_url.starts_with("https://")
        || (base_url.starts_with("http://") && is_loopback_url(base_url)))
    {
        return Err(format!(
            "base URL must be https:// (or http:// for localhost): {}",
            without_userinfo(base_url)
        ));
    }
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    // Only this form reaches an error or a log: a `user:pass@` in the base URL
    // must not.
    let shown = without_userinfo(&url);
    let mut last_err = format!("GET {shown} failed");
    let attempts: Vec<Option<&String>> = if keys.is_empty() {
        vec![None]
    } else {
        keys.iter().map(Some).collect()
    };
    for key in attempts {
        let mut request = client.get(&url);
        if let Some(key) = key {
            request = request.header("Authorization", format!("Bearer {key}"));
        }
        let response = request
            .send()
            .await
            .map_err(|e| format!("could not reach {shown}: {}", e.without_url()))?;
        let status = response.status();
        if status.is_success() {
            let body = response.text().await.unwrap_or_default();
            let parsed: serde_json::Value = serde_json::from_str(&body)
                .map_err(|e| format!("{shown} returned a response we could not read: {e}"))?;
            return Ok(super::tokamak::parse_models(&parsed));
        }
        if status != reqwest::StatusCode::UNAUTHORIZED && status != reqwest::StatusCode::FORBIDDEN {
            // A non-auth error (rate limit, upstream down) won't be fixed by
            // trying another key, so report it and stop.
            return Err(format!("GET {shown} returned {status}"));
        }
        last_err = format!("{shown} rejected the key ({status})");
    }
    Err(last_err)
}

/// Load provider configs by layering the four `.jan`-based scopes (see module
/// docs for the priority order): Global `~/.jan/config.toml` -> Desktop
/// `settings.json` (inherit-only, additive) -> `flint serve` browser providers
/// (when this process is a server) -> project `agent.toml`
/// `[provider]` override -> `--provider`/`--api-key` CLI/env overrides.
///
/// `project_root` is `None` when no project context is available (e.g.
/// `flint cli agent status` without `--project`); the local override is then
/// skipped. A missing/malformed Desktop store is not fatal: it's simply not
/// layered in, since Global config alone is a valid standalone setup.
pub fn load_provider_configs(
    project_root: Option<&std::path::Path>,
    overrides: &ProviderOverrides,
) -> Result<HashMap<String, ProviderConfig>, String> {
    let mut configs = load_global_config()?;

    inherit_desktop_providers(&mut configs);
    if let Some(raw) = server_settings_raw() {
        layer_server_providers(&mut configs, &raw, load_header_secrets);
    }
    // Everything so far is configuration the user wrote themselves, so the
    // credentials they stored for these providers may go to these endpoints.
    for cfg in configs.values_mut() {
        cfg.stored_credentials = StoredCredentials::Allowed;
    }

    if let Some(root) = project_root {
        apply_local_override(&mut configs, root)?;
    }

    apply_overrides(&mut configs, overrides)?;
    // Keys held in the secret store are NOT read here. Loading the config runs
    // on startup, on every `/model` open and on every status call; reading each
    // provider's item would cost one macOS keychain prompt per provider for
    // providers the run never selects. `hydrate_provider_keys` reads the one
    // provider that is actually used, and `has_credential` answers "is there
    // one" from the presence index without reading anything.
    Ok(configs)
}

/// Layer in providers from Desktop's `settings.json` that Global doesn't
/// already define. Read-only inherit: never overwrites a Global entry, never
/// writes back to `settings.json`.
///
/// Their secrets live in the OS keyring (#8388) and are deliberately *not*
/// read here: this runs on startup, on every `/model` open and on every status
/// call, and reading N keychain items costs N macOS authorization prompts for
/// providers a run will never select. Keys are fetched by
/// [`hydrate_provider_keys`] for the one provider that is actually used;
/// [`has_stored_key`] answers presence without touching the secret.
fn inherit_desktop_providers(configs: &mut HashMap<String, ProviderConfig>) {
    let path = resolve_jan_data_folder().join("settings.json");
    let desktop_configs = match std::fs::read_to_string(&path) {
        Ok(raw) => parse_provider_store(&raw),
        Err(_) => return,
    };
    for (name, cfg) in desktop_configs {
        configs.entry(name).or_insert(cfg);
    }
}

/// The `flint serve` settings store (`<data>/web-server/settings.json`), where
/// the browser client keeps its providers. Set once when a server starts; a
/// plain CLI run never sets it and never reads that file.
static SERVER_SETTINGS_FILE: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// Make the providers a `flint serve` browser added available to every run in
/// this process. Called by the server at startup.
pub fn use_server_settings(file: std::path::PathBuf) {
    let _ = SERVER_SETTINGS_FILE.set(file);
}

#[cfg(test)]
thread_local! {
    /// A test's server settings file; the process-wide one is set only once.
    static TEST_SERVER_SETTINGS: std::cell::RefCell<Option<std::path::PathBuf>> =
        const { std::cell::RefCell::new(None) };
}

fn server_settings_raw() -> Option<String> {
    #[cfg(test)]
    if let Some(file) = TEST_SERVER_SETTINGS.with(|f| f.borrow().clone()) {
        return std::fs::read_to_string(file).ok();
    }
    std::fs::read_to_string(SERVER_SETTINGS_FILE.get()?).ok()
}

/// Where the browser keeps a provider's secret custom-header values: the same
/// secret store as its keys, under a key of its own (`providerHeaderSecrets.ts`).
fn header_secrets_key(provider: &str) -> String {
    format!("provider-headers:{provider}")
}

/// A provider's secret header values by lower-case header name, from the
/// server's secret store. Empty when none or unreadable.
fn load_header_secrets(provider: &str) -> HashMap<String, String> {
    crate::core::server::provider_secrets::load_provider_keys(&header_secrets_key(provider))
        .into_iter()
        .next()
        .and_then(|raw| serde_json::from_str::<HashMap<String, String>>(&raw).ok())
        .unwrap_or_default()
}

/// Why a provider the browser added cannot serve agent runs, if it cannot.
/// Bedrock signs requests with AWS credentials, and a deployments-style Azure
/// endpoint needs an `api-version` query and an `api-key` header; the agent's
/// OpenAI-style transport does neither, so both are refused up front rather
/// than sent and failed with a bare 401/404.
fn server_provider_unsupported(p: &serde_json::Value) -> Option<String> {
    let name = p.get("provider").and_then(|v| v.as_str()).unwrap_or_default();
    if name == "bedrock" || p.get("api_type").and_then(|v| v.as_str()) == Some("bedrock") {
        return Some(format!(
            "provider `{name}` (Amazon Bedrock) cannot run agent sessions on `flint serve`; pick a model from another provider"
        ));
    }
    let base_url = p.get("base_url").and_then(|v| v.as_str()).unwrap_or_default();
    let azure = name == "azure"
        || url::Url::parse(base_url).ok().and_then(|u| u.host_str().map(str::to_owned)).is_some_and(|h| {
            h.ends_with(".openai.azure.com") || h.ends_with(".services.ai.azure.com")
        });
    let legacy = url::Url::parse(base_url).is_ok_and(|u| {
        u.query().is_some() || u.path().to_ascii_lowercase().contains("/deployments")
    });
    if azure && legacy {
        return Some(format!(
            "provider `{name}` uses a deployments-style Azure endpoint (api-version), which agent sessions on `flint serve` do not support; set its base URL to the `/openai/v1` endpoint in the browser's provider settings"
        ));
    }
    None
}

/// The provider entries in the server settings blob, as raw JSON.
fn server_provider_entries(raw: &str) -> Vec<serde_json::Value> {
    let root: serde_json::Value = serde_json::from_str(raw).unwrap_or_default();
    root.get(MODEL_PROVIDER_KEY)
        .and_then(|v| v.as_str())
        .and_then(|blob| serde_json::from_str::<serde_json::Value>(blob).ok())
        .and_then(|v| v.pointer("/state/providers").and_then(|p| p.as_array()).cloned())
        .unwrap_or_default()
}

/// Layer the providers the `flint serve` browser added over `~/.jan/config.toml`
/// and the desktop inherit: the server's own settings are the more specific
/// choice on that server. Keys are never in the blob (the browser strips them
/// and keeps them in this server's keyring); they are read on demand by
/// [`hydrate_provider_keys`] like the desktop's. Secret custom-header values
/// come from the same store; `header_secrets` is injected for tests.
fn layer_server_providers(
    configs: &mut HashMap<String, ProviderConfig>,
    raw: &str,
    mut header_secrets: impl FnMut(&str) -> HashMap<String, String>,
) {
    for p in server_provider_entries(raw) {
        if server_provider_unsupported(&p).is_some() {
            continue;
        }
        let Some(mut cfg) = provider_from_json(&p) else {
            continue;
        };
        // An endpoint the browser left blank is not one to send anything to.
        if cfg.base_url.is_none() {
            continue;
        }
        let rows = p.get("custom_header").and_then(|h| h.as_array()).cloned().unwrap_or_default();
        let mut secrets: Option<HashMap<String, String>> = None;
        for row in rows {
            let header = row.get("header").and_then(|v| v.as_str()).unwrap_or_default().trim();
            if header.is_empty() {
                continue;
            }
            let secret = row.get("secret").and_then(|v| v.as_bool()).unwrap_or(false);
            let value = if secret {
                let map = secrets.get_or_insert_with(|| header_secrets(&cfg.provider));
                match map.get(&header.to_ascii_lowercase()) {
                    Some(v) => {
                        crate::core::secret_values::register(v);
                        v.clone()
                    }
                    None => continue,
                }
            } else {
                row.get("value").and_then(|v| v.as_str()).unwrap_or_default().to_owned()
            };
            cfg.custom_headers.push(crate::core::state::ProviderCustomHeader {
                header: header.to_owned(),
                value,
                secret,
            });
        }
        configs.insert(cfg.provider.clone(), cfg);
    }
}

/// Whether `base_url` names this machine or a private network, where a server
/// without a key is normal (llama.cpp, vLLM, Ollama on the LAN).
fn is_private_endpoint(base_url: &str) -> bool {
    let Some(host) = url::Url::parse(base_url).ok().and_then(|u| u.host().map(|h| h.to_owned())) else {
        return false;
    };
    match host {
        url::Host::Ipv4(ip) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        url::Host::Ipv6(ip) => match ip.to_ipv4_mapped() {
            // `::ffff:192.168.1.5` is the IPv4 address, whatever the notation.
            Some(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
            None => {
                ip.is_loopback()
                    || (ip.segments()[0] & 0xfe00) == 0xfc00 // unique local
                    || (ip.segments()[0] & 0xffc0) == 0xfe80 // link local
            }
        },
        url::Host::Domain(name) => {
            let name = name.to_ascii_lowercase();
            !name.contains('.')
                || [".local", ".lan", ".internal", ".home.arpa", ".localhost"]
                    .iter()
                    .any(|suffix| name.ends_with(suffix))
        }
    }
}

/// Refuse a run whose model belongs to a provider the `flint serve` browser
/// added but that cannot serve it: an unsupported kind (Bedrock, legacy
/// Azure), or a public endpoint with no key stored on this server. The error
/// names the provider and where to fix it, and never carries a key.
pub fn check_server_provider(model: &str) -> Result<(), String> {
    let Some(raw) = server_settings_raw() else {
        return Ok(());
    };
    let configs = load_provider_configs(None, &ProviderOverrides::default()).unwrap_or_default();
    check_server_provider_in(&raw, &configs, model, has_credential)
}

fn check_server_provider_in(
    raw: &str,
    configs: &HashMap<String, ProviderConfig>,
    model: &str,
    has_key: impl Fn(&ProviderConfig) -> bool,
) -> Result<(), String> {
    let (prefix, bare) = match model.split_once('/') {
        Some((p, rest)) => (Some(p), rest),
        None => (None, model),
    };
    for p in server_provider_entries(raw) {
        let name = p.get("provider").and_then(|v| v.as_str()).unwrap_or_default();
        let offers = p
            .get("models")
            .and_then(|m| m.as_array())
            .is_some_and(|ms| ms.iter().any(|m| {
                let id = m.get("id").and_then(|v| v.as_str()).unwrap_or_default();
                id == model || (prefix == Some(name) && id == bare)
            }));
        if !offers || p.get("active").and_then(|v| v.as_bool()) == Some(false) {
            continue;
        }
        if let Some(reason) = server_provider_unsupported(&p) {
            return Err(reason);
        }
        // Only the entry the run will actually use: a project may have replaced it.
        let Some(cfg) = configs.get(name) else { continue };
        let server_url = p.get("base_url").and_then(|v| v.as_str()).unwrap_or_default();
        let ours = cfg.base_url.as_deref().is_some_and(|u| same_endpoint(u, server_url));
        if ours && !has_key(cfg) && !is_private_endpoint(server_url) {
            return Err(format!(
                "provider `{name}` has no API key stored on this Flint server; add it in the browser under Settings > Model Providers > {name}, then start the session again"
            ));
        }
    }
    Ok(())
}

/// Apply the project's `agent.toml` `[provider]` section, if present. Highest
/// priority of the three `.jan`-based sources: always wins over Global and the
/// Desktop inherit for the named provider.
fn apply_local_override(
    configs: &mut HashMap<String, ProviderConfig>,
    project_root: &std::path::Path,
) -> Result<(), String> {
    let cfg = match crate::core::agent::project::load_agent_config(project_root) {
        Ok(cfg) => cfg,
        Err(_) => return Ok(()),
    };
    if let Some(section) = cfg.provider {
        let mut project = provider_config_from_section(section);
        // The project may keep the endpoint the user trusts for this name --
        // then what the user stored for it may still be used -- or name any
        // other one, which gets only the key the project itself wrote.
        let trusted = configs.get(&project.provider).is_some_and(|user| {
            user.may_use_stored_credentials()
                && matches!(
                    (user.base_url.as_deref(), project.base_url.as_deref()),
                    (Some(a), Some(b)) if same_endpoint(a, b)
                )
        });
        project.stored_credentials = if trusted {
            StoredCredentials::Allowed
        } else {
            StoredCredentials::Withheld
        };
        configs.insert(project.provider.clone(), project);
    }
    Ok(())
}

fn provider_config_from_section(section: ProviderSection) -> ProviderConfig {
    ProviderConfig {
        provider: section.name,
        api_keys: section.api_key.iter().cloned().collect(),
        api_key: section.api_key,
        base_url: section.base_url,
        custom_headers: Vec::new(),
        models: section.models,
        api_type: section.api_type,
        stored_credentials: StoredCredentials::Withheld,
    }
}

/// Seed each config's key chain from the secret store when the settings blob
/// carried no key. `load` is injected for testability. Explicit `--api-key`/env
/// overrides run afterward and still win.
/// Fill in a provider's key chain from the OS secret store, on demand.
///
/// No-op when the config already carries one: `~/.jan/config.toml` providers
/// (Tokamak included) hold their key inline, as do `--api-key`/env overrides,
/// so the prioritized path never reaches the keyring at all. Call this only for
/// a provider that is about to be used -- each call can cost a macOS keychain
/// prompt.
pub fn hydrate_provider_keys(config: &mut ProviderConfig) {
    hydrate_with(config, |p| {
        let keys = crate::core::server::provider_secrets::load_provider_keys(p);
        if !keys.is_empty() {
            return keys;
        }
        // A `/login`-created provider keeps its key as a credential record
        // rather than in config. Only a plain API key counts: a removed account
        // login cannot authenticate anything.
        match crate::core::cli::auth::CredentialStore::load(p) {
            Ok(Some(credential)) => credential.as_api_key().map(|k| vec![k.to_string()]).unwrap_or_default(),
            _ => Vec::new(),
        }
    })
}

fn hydrate_with(config: &mut ProviderConfig, mut load: impl FnMut(&str) -> Vec<String>) {
    if !config.bearer_key_chain().is_empty() || !config.may_use_stored_credentials() {
        return;
    }
    let keys = load(&config.provider);
    if !keys.is_empty() {
        config.api_key = keys.first().cloned();
        config.api_keys = keys;
    }
}

/// Whether `config` can present a key, without reading one. Inline keys answer
/// themselves; anything else defers to the secret store's presence index.
pub fn has_credential(config: &ProviderConfig) -> bool {
    !config.bearer_key_chain().is_empty()
        || (config.may_use_stored_credentials()
            && (crate::core::server::provider_secrets::has_stored_key(&config.provider)
                || crate::core::cli::auth::CredentialStore::has(&config.provider)))
}

/// Whether a credential is stored under `provider`'s name anywhere a request
/// could have taken it from. Presence only: no secret is read. A stored
/// account login left by the removed Codex/Claude sign-in is not a credential
/// anything can send, so it does not count.
pub(crate) fn has_stored_credential(provider: &str, _base_url: &str) -> bool {
    matches!(
        crate::core::cli::auth::CredentialStore::load(provider),
        Ok(Some(credential)) if credential.as_api_key().is_some()
    ) || crate::core::server::provider_secrets::has_stored_key(provider)
}

/// The error for a provider whose endpoint does not match the one its stored
/// credentials belong to: better refused than sent without the credential the
/// user expects it to carry.
pub(crate) fn withheld_credential_error(provider: &str, base_url: &str) -> String {
    format!(
        "provider `{provider}` points at base_url `{base_url}`, which is not the endpoint its stored credentials were saved for, so they were not sent. Set `api_key` next to that base_url in the project's agent.toml, or remove the project's `base_url` override."
    )
}

/// Parse the `settings.json` body into provider configs. Tolerant of shape
/// drift: anything it cannot read is skipped rather than erroring. Providers
/// Desktop has marked inactive are skipped too (see `provider_from_json`).
fn parse_provider_store(raw: &str) -> HashMap<String, ProviderConfig> {
    let root: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return HashMap::new(),
    };

    // The store value is itself a JSON string ("{\"state\":{...}}").
    let blob = match root.get(MODEL_PROVIDER_KEY).and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return HashMap::new(),
    };
    let parsed: serde_json::Value = match serde_json::from_str(blob) {
        Ok(v) => v,
        Err(_) => return HashMap::new(),
    };
    let providers = parsed
        .get("state")
        .and_then(|s| s.get("providers"))
        .and_then(|p| p.as_array());
    let providers = match providers {
        Some(p) => p,
        None => return HashMap::new(),
    };

    let mut out = HashMap::new();
    for p in providers {
        if let Some(cfg) = provider_from_json(p) {
            out.insert(cfg.provider.clone(), cfg);
        }
    }
    out
}

fn provider_from_json(p: &serde_json::Value) -> Option<ProviderConfig> {
    let provider = p.get("provider").and_then(|v| v.as_str())?.to_string();

    // A provider the user switched off in Desktop is not an option here either.
    // Desktop stops registering an inactive provider (`syncRemoteProviders`
    // gates on `active`), so inheriting one meant offering an entry whose key
    // Desktop no longer maintains. Absent field = inherit: `active` is written
    // for every provider Desktop creates, so only an explicit `false` is a
    // deliberate opt-out.
    if p.get("active").and_then(|v| v.as_bool()) == Some(false) {
        return None;
    }

    let base_url = p
        .get("base_url")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from);

    let api_key = p
        .get("settings")
        .and_then(|s| s.as_array())
        .and_then(|settings| {
            settings.iter().find_map(|s| {
                let key = s.get("key").and_then(|k| k.as_str())?;
                if !API_KEY_SETTING_KEYS.contains(&key) {
                    return None;
                }
                s.get("controller_props")
                    .and_then(|c| c.get("value"))
                    .and_then(|v| v.as_str())
                    .filter(|v| !v.is_empty())
                    .map(String::from)
            })
        });

    let models = p
        .get("models")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|id| id.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let api_type = p
        .get("api_type")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from);

    Some(ProviderConfig {
        provider,
        api_keys: api_key.iter().cloned().collect(),
        api_key,
        base_url,
        custom_headers: Vec::new(),
        models,
        api_type,
        stored_credentials: StoredCredentials::Allowed,
    })
}

/// Inject the override API key into the targeted provider(s). When a provider
/// is named but absent from the store, a minimal config is synthesized so the
/// CLI can reach it purely from flags/env.
fn apply_overrides(
    configs: &mut HashMap<String, ProviderConfig>,
    overrides: &ProviderOverrides,
) -> Result<(), String> {
    let Some(api_key) = &overrides.api_key else {
        return Ok(());
    };
    match &overrides.provider {
        Some(requested) => {
            let provider = &find_provider(configs, requested)
                .map(str::to_string)
                .unwrap_or_else(|| requested.clone());
            let cfg = configs
                .entry(provider.clone())
                .or_insert_with(|| ProviderConfig {
                    provider: provider.clone(),
                    api_key: None,
                    api_keys: Vec::new(),
                    base_url: None,
                    custom_headers: Vec::new(),
                    models: Vec::new(),
                    api_type: None,
                    stored_credentials: StoredCredentials::Allowed,
                });
            // The override key is the user's own, set outside the project, so
            // it is held to the same rule as a key they stored.
            if !cfg.may_use_stored_credentials() {
                return Err(withheld_credential_error(
                    provider,
                    cfg.base_url.as_deref().unwrap_or_default(),
                ));
            }
            set_key(cfg, api_key);
        }
        None => {
            // No provider was named, so this key is a guess about where it goes.
            // It fills providers that have no credential of their own and never
            // replaces one the user stored on purpose.
            let mut ignored = false;
            for cfg in configs.values_mut().filter(|c| c.may_use_stored_credentials()) {
                if has_credential(cfg) {
                    ignored = true;
                } else {
                    set_key(cfg, api_key);
                }
            }
            if ignored {
                warn_blanket_key_ignored();
            }
        }
    }
    Ok(())
}

/// Said once per process: configs load many times (status, `/model`, sign-in).
fn warn_blanket_key_ignored() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        eprintln!(
            "note: --api-key / JAN_API_KEY without --provider only fills providers that have no key of their own; \
             providers with a stored key keep it. Add --provider <name> to send it to one."
        );
    });
}

fn set_key(cfg: &mut ProviderConfig, api_key: &str) {
    cfg.api_key = Some(api_key.to_string());
    cfg.api_keys = vec![api_key.to_string()];
}

/// How long `flint cli models list` waits for a provider's server to accept a
/// connection before reporting it unreachable.
pub const REACHABILITY_TIMEOUT: Duration = Duration::from_secs(2);

/// Whether something accepts a TCP connection at `base_url`'s host and port
/// within `timeout`. A URL that does not parse, or names no host, is not
/// reachable.
pub async fn probe_base_url(base_url: &str, timeout: Duration) -> bool {
    let trimmed = base_url.trim();
    // The CLI bridge lives in this process: start it rather than report a
    // signed-in subscription provider as down.
    if crate::core::cli_bridge::is_bridge_url(trimmed)
        && crate::core::cli_bridge::ensure_started().await.is_err()
    {
        return false;
    }
    let parsed = if trimmed.contains("://") {
        url::Url::parse(trimmed)
    } else {
        url::Url::parse(&format!("http://{trimmed}"))
    };
    let Ok(url) = parsed else {
        return false;
    };
    let (Some(host), Some(port)) = (url.host_str(), url.port_or_known_default()) else {
        return false;
    };
    // IPv6 literals come back bracketed; the socket address wants them bare.
    let host = host.trim_start_matches('[').trim_end_matches(']').to_string();
    matches!(
        tokio::time::timeout(timeout, tokio::net::TcpStream::connect((host.as_str(), port))).await,
        Ok(Ok(_))
    )
}

/// Probe every provider with a `base_url` concurrently, keyed by provider
/// name. Local engines (no `base_url`) are left out: they are never reachable
/// from the CLI and need no probe.
pub async fn probe_providers(
    configs: &HashMap<String, ProviderConfig>,
    timeout: Duration,
) -> HashMap<String, bool> {
    let targets: Vec<(String, String)> = configs
        .values()
        .filter(|c| is_cli_reachable(c))
        .map(|c| (c.provider.clone(), c.base_url.clone().unwrap_or_default()))
        .collect();
    futures::future::join_all(targets.into_iter().map(|(name, url)| async move {
        let up = probe_base_url(&url, timeout).await;
        (name, up)
    }))
    .await
    .into_iter()
    .collect()
}

/// The config key of the provider `requested` names: its key or its
/// `provider` name exactly, else either one compared case-insensitively. A
/// Desktop provider's name is what the app shows (e.g. `Qwen 3.8 500k
/// (8080)`), so that is what a user types.
pub fn find_provider<'a>(
    configs: &'a HashMap<String, ProviderConfig>,
    requested: &str,
) -> Option<&'a str> {
    let requested = requested.trim();
    if let Some((key, _)) = configs.get_key_value(requested) {
        return Some(key.as_str());
    }
    if let Some((key, _)) = configs.iter().find(|(_, c)| c.provider == requested) {
        return Some(key.as_str());
    }
    let mut matches: Vec<&String> = configs
        .iter()
        .filter(|(key, c)| {
            key.eq_ignore_ascii_case(requested) || c.provider.eq_ignore_ascii_case(requested)
        })
        .map(|(key, _)| key)
        .collect();
    matches.sort();
    matches.first().map(|k| k.as_str())
}

/// Pin a run to the provider `--provider` named: resolve it by id or display
/// name, then make it the only provider offering `model`, so upstream
/// resolution cannot pick another provider serving the same model id. Errors
/// when no configured provider matches. Returns the provider's config key.
pub fn pin_provider(
    configs: &mut HashMap<String, ProviderConfig>,
    requested: &str,
    model: &str,
) -> Result<String, String> {
    let Some(key) = find_provider(configs, requested).map(str::to_string) else {
        let mut known: Vec<&str> = configs.values().map(|c| c.provider.as_str()).collect();
        known.sort_unstable();
        return Err(format!(
            "unknown provider '{requested}'. Configured providers: {}",
            if known.is_empty() {
                "(none)".to_string()
            } else {
                known.join(", ")
            }
        ));
    };
    if model.is_empty() {
        return Ok(key);
    }
    for (name, cfg) in configs.iter_mut() {
        if *name == key {
            // Model lists are routinely incomplete; naming the provider is an
            // explicit choice, so it serves the model whether listed or not.
            if !cfg.models.iter().any(|m| m == model) {
                cfg.models.push(model.to_string());
            }
        } else {
            cfg.models.retain(|m| m != model);
        }
    }
    Ok(key)
}

/// Every configured model, for `flint cli models list`.
///
/// Models the CLI cannot reach are listed too, marked `reachable: false`,
/// rather than dropped. A desktop user whose models all run on the local
/// llama.cpp engine has no `base_url` for them -- the engine runs inside the
/// app -- and filtering on reachability printed `[]` while the app showed a
/// full model list, with nothing to say why (janhq/jan#8412).
///
/// `reachable` is `false` for a local engine the CLI cannot start, and
/// otherwise whatever `probed` says about that provider's server: `true` only
/// when it answered, `false` when it did not, and `null` (unknown) when it was
/// not probed. A configured `base_url` alone never reads as reachable.
pub fn model_listing(
    configs: &HashMap<String, ProviderConfig>,
    provider: Option<&str>,
    probed: &HashMap<String, bool>,
) -> Vec<serde_json::Value> {
    let wanted = provider.map(|p| find_provider(configs, p).unwrap_or(p).to_string());
    let mut output: Vec<serde_json::Value> = configs
        .iter()
        .filter(|(key, _)| wanted.as_deref().is_none_or(|p| key.as_str() == p))
        .map(|(_, c)| c)
        .flat_map(|c| {
            let reachable = if is_cli_reachable(c) {
                probed
                    .get(&c.provider)
                    .map_or(serde_json::Value::Null, |&up| serde_json::Value::Bool(up))
            } else {
                serde_json::Value::Bool(false)
            };
            c.models.iter().map(move |m| {
                serde_json::json!({
                    "id": m,
                    "provider": c.provider,
                    "base_url": c.base_url,
                    "api_type": c.api_type,
                    "has_api_key": has_credential(c),
                    "reachable": reachable,
                })
            })
        })
        .collect();
    output.sort_by(|a, b| {
        (a["provider"].as_str(), a["id"].as_str()).cmp(&(b["provider"].as_str(), b["id"].as_str()))
    });
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    const STORE: &str = r#"{"setting-general":{"x":1},"model-provider":"{\"state\":{\"providers\":[{\"provider\":\"anthropic\",\"base_url\":\"https://api.anthropic.com/v1\",\"settings\":[{\"key\":\"api-key\",\"controller_props\":{\"value\":\"sk-ant-123\"}}],\"models\":[{\"id\":\"claude-sonnet-4-5\"},{\"id\":\"claude-opus-4\"}]},{\"provider\":\"openai\",\"base_url\":\"https://api.openai.com/v1\",\"settings\":[{\"key\":\"api-key\",\"controller_props\":{\"value\":\"\"}}],\"models\":[{\"id\":\"gpt-4o\"}]}]}}"}"#;

    #[test]
    fn parses_provider_with_key_base_url_and_models() {
        let configs = parse_provider_store(STORE);
        let anthropic = configs.get("anthropic").expect("anthropic present");
        assert_eq!(anthropic.api_key.as_deref(), Some("sk-ant-123"));
        assert_eq!(anthropic.api_keys, vec!["sk-ant-123".to_string()]);
        assert_eq!(
            anthropic.base_url.as_deref(),
            Some("https://api.anthropic.com/v1")
        );
        assert!(anthropic.models.iter().any(|m| m == "claude-sonnet-4-5"));
    }

    #[test]
    fn empty_api_key_becomes_none() {
        let configs = parse_provider_store(STORE);
        let openai = configs.get("openai").expect("openai present");
        assert_eq!(openai.api_key, None);
        assert!(openai.api_keys.is_empty());
    }

    /// Desktop stops maintaining an inactive provider's key, so inheriting one
    /// offers an entry that cannot run and reports as keyless.
    #[test]
    fn an_inactive_desktop_provider_is_not_inherited() {
        let store = STORE.replace(
            r#"{\"provider\":\"openai\""#,
            r#"{\"provider\":\"openai\",\"active\":false"#,
        );
        let configs = parse_provider_store(&store);
        assert!(!configs.contains_key("openai"), "inactive provider skipped");
        assert!(configs.contains_key("anthropic"), "active one still there");
    }

    #[test]
    fn an_active_desktop_provider_is_inherited() {
        let store = STORE.replace(
            r#"{\"provider\":\"openai\""#,
            r#"{\"provider\":\"openai\",\"active\":true"#,
        );
        assert!(parse_provider_store(&store).contains_key("openai"));
    }

    /// Stores predating the flag, and any shape drift, must keep working.
    #[test]
    fn a_provider_without_the_active_flag_is_inherited() {
        assert!(parse_provider_store(STORE).contains_key("openai"));
    }

    #[test]
    fn malformed_store_yields_empty_map() {
        assert!(parse_provider_store("not json").is_empty());
        assert!(parse_provider_store(r#"{"model-provider":"not json"}"#).is_empty());
        assert!(parse_provider_store(r#"{"other":1}"#).is_empty());
    }

    #[test]
    fn override_injects_key_into_named_provider() {
        let mut configs = parse_provider_store(STORE);
        let ov = ProviderOverrides {
            provider: Some("openai".to_string()),
            api_key: Some("sk-new".to_string()),
            pin: false,
        };
        apply_overrides(&mut configs, &ov).unwrap();
        let openai = configs.get("openai").unwrap();
        assert_eq!(openai.api_key.as_deref(), Some("sk-new"));
        assert_eq!(openai.api_keys, vec!["sk-new".to_string()]);
    }

    #[test]
    fn override_synthesizes_absent_provider() {
        let mut configs = HashMap::new();
        let ov = ProviderOverrides {
            provider: Some("anthropic".to_string()),
            api_key: Some("sk-ant".to_string()),
            pin: false,
        };
        apply_overrides(&mut configs, &ov).unwrap();
        assert_eq!(
            configs.get("anthropic").and_then(|c| c.api_key.as_deref()),
            Some("sk-ant")
        );
    }

    #[test]
    fn override_without_provider_fills_only_keyless_providers() {
        let mut configs = parse_provider_store(STORE);
        let keyed: Vec<String> = configs.iter().filter(|(_, c)| !c.bearer_key_chain().is_empty()).map(|(n, _)| n.clone()).collect();
        let before: HashMap<String, Vec<String>> = configs.iter().map(|(n, c)| (n.clone(), c.bearer_key_chain())).collect();
        let ov = ProviderOverrides {
            provider: None,
            api_key: Some("shared".to_string()),
            pin: false,
        };
        apply_overrides(&mut configs, &ov).unwrap();
        for (name, cfg) in &configs {
            if keyed.contains(name) {
                assert_eq!(cfg.bearer_key_chain(), before[name], "{name} lost its own key");
            } else if cfg.may_use_stored_credentials() {
                assert_eq!(cfg.api_key.as_deref(), Some("shared"), "{name} stayed keyless");
            }
        }
    }

    #[test]
    fn blanket_key_does_not_override_a_provider_key() {
        let mut configs = parse_provider_store(STORE);
        configs.get_mut("openai").unwrap().api_key = Some("sk-own".into());
        configs.get_mut("openai").unwrap().api_keys = vec!["sk-own".into()];
        let ov = ProviderOverrides { provider: None, api_key: Some("blanket".into()), pin: false };
        apply_overrides(&mut configs, &ov).unwrap();
        assert_eq!(configs["openai"].bearer_key_chain(), vec!["sk-own".to_string()]);
    }

    #[test]
    fn hydrate_fills_missing_key_from_store() {
        let mut configs = parse_provider_store(STORE);
        // openai has an empty key in the blob -> should be filled in.
        let openai = configs.get_mut("openai").unwrap();
        hydrate_with(openai, |p| match p {
            "openai" => vec!["sk-stored-1".to_string(), "sk-stored-2".to_string()],
            _ => Vec::new(),
        });
        assert_eq!(openai.api_key.as_deref(), Some("sk-stored-1"));
        assert_eq!(
            openai.api_keys,
            vec!["sk-stored-1".to_string(), "sk-stored-2".to_string()]
        );
    }

    #[test]
    fn hydrate_does_not_clobber_existing_key() {
        let mut configs = parse_provider_store(STORE);
        // anthropic already has sk-ant-123 from the blob -> store must not win.
        let anthropic = configs.get_mut("anthropic").unwrap();
        hydrate_with(anthropic, |_| vec!["sk-should-not-apply".to_string()]);
        assert_eq!(anthropic.api_key.as_deref(), Some("sk-ant-123"));
    }

    /// The whole point of deferring: a desktop-inherited provider is keyless
    /// as loaded, and reaches the secret store exactly once, only when it is
    /// the provider actually being used -- each read can cost a macOS keychain
    /// prompt.
    #[test]
    fn a_desktop_provider_stays_keyless_until_hydrated() {
        let mut configs = parse_provider_store(STORE);
        let openai = configs.get_mut("openai").unwrap();
        assert_eq!(openai.api_key, None, "keyless until hydrated");

        let mut reads = 0;
        hydrate_with(openai, |_| {
            reads += 1;
            Vec::new()
        });
        assert_eq!(reads, 1, "and exactly one read when it is");
        assert_eq!(openai.api_key, None);
    }

    #[test]
    fn hydrate_skips_the_store_when_a_key_is_already_present() {
        let mut configs = parse_provider_store(STORE);
        let anthropic = configs.get_mut("anthropic").unwrap();
        let mut reads = 0;
        hydrate_with(anthropic, |_| {
            reads += 1;
            Vec::new()
        });
        assert_eq!(reads, 0, "an inline key must not trigger a store read");
    }

    #[test]
    fn provider_models_from_store_are_flattened_and_sorted() {
        let mut pairs: Vec<(String, String)> = parse_provider_store(STORE)
            .values()
            .flat_map(|c| c.models.iter().map(|m| (c.provider.clone(), m.clone())))
            .collect();
        pairs.sort();
        assert_eq!(
            pairs,
            vec![
                ("anthropic".to_string(), "claude-opus-4".to_string()),
                ("anthropic".to_string(), "claude-sonnet-4-5".to_string()),
                ("openai".to_string(), "gpt-4o".to_string()),
            ]
        );
    }

    #[test]
    fn parses_desktop_selection() {
        let store = r#"{"model-provider":"{\"state\":{\"selectedProvider\":\"anthropic\",\"selectedModel\":{\"id\":\"claude-sonnet-4-5\",\"provider\":\"anthropic\"},\"providers\":[]}}"}"#;
        let sel = parse_selection(store);
        assert_eq!(sel.provider.as_deref(), Some("anthropic"));
        assert_eq!(sel.model.as_deref(), Some("claude-sonnet-4-5"));
    }

    #[test]
    fn selection_absent_or_empty_is_none() {
        assert_eq!(parse_selection("not json"), DesktopSelection::default());
        assert_eq!(
            parse_selection(r#"{"model-provider":"{\"state\":{\"providers\":[]}}"}"#),
            DesktopSelection::default()
        );
        // Empty strings / null model are treated as unset.
        let blank = r#"{"model-provider":"{\"state\":{\"selectedProvider\":\"\",\"selectedModel\":null}}"}"#;
        assert_eq!(parse_selection(blank), DesktopSelection::default());
    }

    #[test]
    fn only_providers_with_a_base_url_are_cli_reachable() {
        let remote = ProviderConfig {
            provider: "anthropic".into(),
            base_url: Some("https://api.anthropic.com/v1".into()),
            ..Default::default()
        };
        // Local engines (llamacpp, llamacpp-rs, mlx) are stored by the desktop
        // app without a base_url: their upstream only exists once the desktop
        // has spawned the engine, which the CLI never does.
        let local = ProviderConfig {
            provider: "llamacpp".into(),
            base_url: None,
            ..Default::default()
        };
        let blank = ProviderConfig {
            provider: "mlx".into(),
            base_url: Some(String::new()),
            ..Default::default()
        };
        assert!(is_cli_reachable(&remote));
        assert!(!is_cli_reachable(&local));
        assert!(!is_cli_reachable(&blank));
    }

    #[test]
    fn usable_requires_a_key_only_for_remote_upstreams() {
        let keyed_remote = ProviderConfig {
            provider: "tokamak".into(),
            base_url: Some("https://api.tokamak.sh/v1".into()),
            api_key: Some("tk".into()),
            ..Default::default()
        };
        let keyless_remote = ProviderConfig {
            provider: "openai".into(),
            base_url: Some("https://api.openai.com/v1".into()),
            ..Default::default()
        };
        let keyless_local = ProviderConfig {
            provider: "jan".into(),
            base_url: Some("http://localhost:1337/v1".into()),
            ..Default::default()
        };
        let engine = ProviderConfig {
            provider: "llamacpp".into(),
            base_url: None,
            api_key: Some("k".into()),
            ..Default::default()
        };
        assert!(is_usable(&keyed_remote));
        assert!(!is_usable(&keyless_remote));
        assert!(is_usable(&keyless_local));
        assert!(!is_usable(&engine));
    }

    #[test]
    fn loopback_detection_ignores_ports_paths_and_lookalike_hosts() {
        assert!(is_loopback_url("http://127.0.0.1:1337/v1"));
        assert!(is_loopback_url("http://localhost/v1"));
        assert!(is_loopback_url("http://[::1]:1337/v1"));
        assert!(is_loopback_url("localhost:1337"));
        assert!(!is_loopback_url("https://localhost.evil.com/v1"));
        assert!(!is_loopback_url("https://api.tokamak.sh/v1"));
        assert!(!is_loopback_url(""));
    }

    /// The host is the one the HTTP client would connect to, never a
    /// substring of the URL that merely looks like one.
    #[test]
    fn loopback_detection_reads_the_host_a_request_would_reach() {
        for remote in [
            "http://localhost:80@evil.example/v1",
            "http://localhost@evil.example/v1",
            "http://127.0.0.1:1337@evil.example/v1",
            "http://[::1]@evil.example/v1",
            "http://evil.example/localhost:1337",
            "http://evil.example#@localhost",
            "http://localhost.evil.example/v1",
            "http://127.0.0.1.nip.io/v1",
            "not a url",
            "http://",
            "://localhost",
        ] {
            assert!(!is_loopback_url(remote), "{remote} is not this machine");
        }
        for local in [
            "http://LOCALHOST:1337/v1",
            "HTTP://LocalHost/v1",
            "http://127.0.0.2:8080/v1",
            "http://127.255.255.254/v1",
            "http://[::1]/v1",
            "http://[0:0:0:0:0:0:0:1]:1337/v1",
            "http://0.0.0.0:1337/v1",
            " http://localhost/v1 ",
            "127.0.0.1:1337",
        ] {
            assert!(is_loopback_url(local), "{local} is this machine");
        }
    }

    // janhq/jan#8412: models on the desktop's local engine have no base_url,
    // and the listing used to drop them silently, printing `[]`.
    #[test]
    fn model_listing_keeps_local_engine_models_and_marks_them_unreachable() {
        let mut configs = HashMap::new();
        configs.insert(
            "llamacpp".to_string(),
            ProviderConfig {
                provider: "llamacpp".into(),
                base_url: None,
                models: vec!["qwen3-8b".into()],
                ..Default::default()
            },
        );
        configs.insert(
            "jan".to_string(),
            ProviderConfig {
                provider: "jan".into(),
                base_url: Some("http://localhost:1337/v1".into()),
                models: vec!["qwen3-8b".into()],
                ..Default::default()
            },
        );

        let probed = HashMap::from([("jan".to_string(), true)]);
        let all = model_listing(&configs, None, &probed);
        assert_eq!(all.len(), 2);
        let engine = all.iter().find(|m| m["provider"] == "llamacpp").unwrap();
        assert_eq!(engine["reachable"], false);
        let server = all.iter().find(|m| m["provider"] == "jan").unwrap();
        assert_eq!(server["reachable"], true);

        // Unprobed, a configured server is unknown -- never assumed up.
        let unprobed = model_listing(&configs, None, &HashMap::new());
        let server = unprobed.iter().find(|m| m["provider"] == "jan").unwrap();
        assert!(server["reachable"].is_null());
        let down = HashMap::from([("jan".to_string(), false)]);
        let listed = model_listing(&configs, None, &down);
        let server = listed.iter().find(|m| m["provider"] == "jan").unwrap();
        assert_eq!(server["reachable"], false);

        let only = model_listing(&configs, Some("jan"), &probed);
        assert_eq!(only.len(), 1);
        assert_eq!(only[0]["provider"], "jan");
    }

    /// Tokamak leads the `/model` picker; everything else keeps its alphabetical
    /// order behind it, and models stay sorted within each provider.
    #[test]
    fn reachable_models_lists_tokamak_first() {
        let mut configs = HashMap::new();
        configs.insert(
            "anthropic".to_string(),
            cfg(
                "anthropic",
                Some("https://api.anthropic.com/v1"),
                &["claude-sonnet-5"],
            ),
        );
        configs.insert(
            "tokamak".to_string(),
            cfg(
                "tokamak",
                Some("https://api.tokamak.sh/v1"),
                &["tokamak-1-preview"],
            ),
        );
        configs.insert(
            "openai".to_string(),
            cfg(
                "openai",
                Some("https://api.openai.com/v1"),
                &["gpt-5", "gpt-4o"],
            ),
        );

        assert_eq!(
            reachable_models(&configs),
            vec![
                ("tokamak".to_string(), "tokamak-1-preview".to_string()),
                ("anthropic".to_string(), "claude-sonnet-5".to_string()),
                ("openai".to_string(), "gpt-4o".to_string()),
                ("openai".to_string(), "gpt-5".to_string()),
            ]
        );
    }

    /// Ordering is the only change: with no Tokamak entry the list is exactly
    /// the alphabetical order it always was.
    #[test]
    fn without_tokamak_the_order_is_unchanged() {
        let mut configs = HashMap::new();
        configs.insert(
            "zeta".to_string(),
            cfg("zeta", Some("https://z.example/v1"), &["z1"]),
        );
        configs.insert(
            "alpha".to_string(),
            cfg("alpha", Some("https://a.example/v1"), &["a1"]),
        );
        assert_eq!(
            reachable_models(&configs),
            vec![
                ("alpha".to_string(), "a1".to_string()),
                ("zeta".to_string(), "z1".to_string()),
            ]
        );
    }

    #[test]
    fn reachable_models_skips_local_engine_providers() {
        let mut configs = HashMap::new();
        configs.insert(
            "llamacpp".to_string(),
            ProviderConfig {
                provider: "llamacpp".into(),
                base_url: None,
                models: vec!["gemma-4-E2B-it-IQ4_XS".into()],
                ..Default::default()
            },
        );
        configs.insert(
            "anthropic".to_string(),
            ProviderConfig {
                provider: "anthropic".into(),
                base_url: Some("https://api.anthropic.com/v1".into()),
                models: vec!["claude-sonnet-5".into(), "claude-opus-5".into()],
                ..Default::default()
            },
        );
        let pairs = reachable_models(&configs);
        assert_eq!(
            pairs,
            vec![
                ("anthropic".to_string(), "claude-opus-5".to_string()),
                ("anthropic".to_string(), "claude-sonnet-5".to_string()),
            ]
        );
    }

    fn cfg(provider: &str, base_url: Option<&str>, models: &[&str]) -> ProviderConfig {
        ProviderConfig {
            provider: provider.into(),
            base_url: base_url.map(String::from),
            models: models.iter().map(|m| m.to_string()).collect(),
            ..Default::default()
        }
    }

    fn two_provider_store() -> HashMap<String, ProviderConfig> {
        let mut c = HashMap::new();
        c.insert(
            "llamacpp".into(),
            cfg("llamacpp", None, &["gemma-4-E2B-it-IQ4_XS", "shared-id"]),
        );
        c.insert(
            "anthropic".into(),
            cfg(
                "anthropic",
                Some("https://api.anthropic.com/v1"),
                &["claude-sonnet-5", "shared-id"],
            ),
        );
        c
    }

    #[test]
    fn local_only_model_is_reported_with_its_provider() {
        assert_eq!(
            unreachable_local_provider(&two_provider_store(), "gemma-4-E2B-it-IQ4_XS"),
            Some("llamacpp".to_string())
        );
    }

    #[test]
    fn remote_model_is_not_flagged() {
        assert_eq!(
            unreachable_local_provider(&two_provider_store(), "claude-sonnet-5"),
            None
        );
    }

    #[test]
    fn model_offered_by_both_local_and_remote_is_not_flagged() {
        // A reachable provider also serves it, so the run can proceed.
        assert_eq!(
            unreachable_local_provider(&two_provider_store(), "shared-id"),
            None
        );
    }

    #[test]
    fn unknown_model_is_not_flagged() {
        // Provider `models` lists are often incomplete (custom deployments), so
        // an id nobody claims must fall through to normal upstream resolution
        // rather than being rejected here.
        assert_eq!(
            unreachable_local_provider(&two_provider_store(), "some-custom-model"),
            None
        );
    }

    #[test]
    fn provider_prefixed_local_model_is_flagged() {
        assert_eq!(
            unreachable_local_provider(&two_provider_store(), "llamacpp/whatever"),
            Some("llamacpp".to_string())
        );
    }

    #[test]
    fn no_override_is_noop() {
        let mut configs = parse_provider_store(STORE);
        apply_overrides(&mut configs, &ProviderOverrides::default()).unwrap();
        assert_eq!(
            configs.get("anthropic").and_then(|c| c.api_key.as_deref()),
            Some("sk-ant-123")
        );
    }

    /// One-shot `/models` stub on a random loopback port. Returns the bound
    /// address; each accepted connection gets `body` back as JSON.
    fn models_stub(body: String, connections: usize) -> std::net::SocketAddr {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(connections) {
                let Ok(mut stream) = stream else { continue };
                let mut buf = [0u8; 4096];
                let _ = std::io::Read::read(&mut stream, &mut buf);
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = std::io::Write::write_all(&mut stream, resp.as_bytes());
            }
        });
        addr
    }

    #[test]
    fn fetch_missing_models_populates_and_persists_empty_providers() {
        crate::core::agent::global_config::with_temp_home(|_| {
            let addr = models_stub(
                serde_json::json!({"data": [{"id": "m-b"}, {"id": "m-a"}]}).to_string(),
                1,
            );
            crate::core::agent::global_config::set_provider(
                "bare",
                crate::core::agent::global_config::ProviderUpdate {
                    api_key: Some("k".into()),
                    base_url: Some(format!("http://{addr}/v1")),
                    clear_api_key: false,
                    models: Some(vec![]),
                    api_type: None,
                    ..Default::default()
                },
            )
            .unwrap();

            let rt = tokio::runtime::Runtime::new().unwrap();
            let populated = rt
                .block_on(fetch_missing_models(
                    None,
                    &mut std::collections::HashSet::new(),
                ))
                .expect("fetch");
            assert!(populated);

            let configs = load_global_config().unwrap();
            assert_eq!(
                configs.get("bare").unwrap().models,
                vec!["m-a".to_string(), "m-b".to_string()],
                "discovered ids persist sorted"
            );
        });
    }

    #[test]
    fn fetch_missing_models_leaves_configured_lists_alone() {
        crate::core::agent::global_config::with_temp_home(|_| {
            crate::core::agent::global_config::set_provider(
                "chosen",
                crate::core::agent::global_config::ProviderUpdate {
                    api_key: Some("k".into()),
                    base_url: Some("http://127.0.0.1:9/v1".into()), // would refuse
                    clear_api_key: false,
                    models: Some(vec!["my-model".into()]),
                    api_type: None,
                    ..Default::default()
                },
            )
            .unwrap();

            let rt = tokio::runtime::Runtime::new().unwrap();
            // Nothing to fetch: the provider already names its models, so the
            // dead endpoint above must never be contacted.
            let populated = rt
                .block_on(fetch_missing_models(
                    None,
                    &mut std::collections::HashSet::new(),
                ))
                .expect("fetch");
            assert!(!populated);
            let configs = load_global_config().unwrap();
            assert_eq!(
                configs.get("chosen").unwrap().models,
                vec!["my-model".to_string()]
            );
        });
    }

    #[test]
    fn fetch_missing_models_queries_keyless_loopback_providers() {
        crate::core::agent::global_config::with_temp_home(|_| {
            let addr = models_stub(
                serde_json::json!({"data": [{"id": "local-model"}]}).to_string(),
                1,
            );
            crate::core::agent::global_config::set_provider(
                "local",
                crate::core::agent::global_config::ProviderUpdate {
                    api_key: None,
                    base_url: Some(format!("http://{addr}/v1")),
                    clear_api_key: false,
                    models: Some(vec![]),
                    api_type: None,
                    ..Default::default()
                },
            )
            .unwrap();

            let rt = tokio::runtime::Runtime::new().unwrap();
            let populated = rt
                .block_on(fetch_missing_models(
                    None,
                    &mut std::collections::HashSet::new(),
                ))
                .expect("fetch");
            assert!(populated, "a keyless endpoint is queried unauthenticated");
            let configs = load_global_config().unwrap();
            assert_eq!(
                configs.get("local").unwrap().models,
                vec!["local-model".to_string()]
            );
        });
    }

    /// Probes must run concurrently, not sequentially: each stub here only
    /// responds after BOTH providers have connected, so a sequential
    /// implementation (probe one to completion before starting the next)
    /// deadlocks into its 15s timeout and populates only one provider.
    #[test]
    fn fetch_missing_models_probes_concurrently() {
        crate::core::agent::global_config::with_temp_home(|_| {
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
            let stub = |models: &str| {
                let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
                let addr = listener.local_addr().unwrap();
                let body = serde_json::json!({"data": [{"id": models}]}).to_string();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let Ok((mut stream, _)) = listener.accept() else {
                        return;
                    };
                    let mut buf = [0u8; 4096];
                    let _ = std::io::Read::read(&mut stream, &mut buf);
                    barrier.wait();
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = std::io::Write::write_all(&mut stream, resp.as_bytes());
                });
                addr
            };
            let addr_a = stub("model-a");
            let addr_b = stub("model-b");
            for (name, addr) in [("prov-a", addr_a), ("prov-b", addr_b)] {
                crate::core::agent::global_config::set_provider(
                    name,
                    crate::core::agent::global_config::ProviderUpdate {
                        api_key: Some("k".into()),
                        base_url: Some(format!("http://{addr}/v1")),
                        clear_api_key: false,
                        models: Some(vec![]),
                        api_type: None,
                        ..Default::default()
                    },
                )
                .unwrap();
            }

            let rt = tokio::runtime::Runtime::new().unwrap();
            let populated = rt
                .block_on(fetch_missing_models(
                    None,
                    &mut std::collections::HashSet::new(),
                ))
                .expect("fetch");
            assert!(populated);
            let configs = load_global_config().unwrap();
            assert_eq!(
                configs.get("prov-a").unwrap().models,
                vec!["model-a".to_string()]
            );
            assert_eq!(
                configs.get("prov-b").unwrap().models,
                vec!["model-b".to_string()]
            );
        });
    }

    #[test]
    fn fetch_missing_models_short_circuits_already_probed() {
        crate::core::agent::global_config::with_temp_home(|_| {
            // A dead endpoint: if it were contacted, the 15s timeout would hang.
            crate::core::agent::global_config::set_provider(
                "dead",
                crate::core::agent::global_config::ProviderUpdate {
                    api_key: Some("k".into()),
                    base_url: Some("http://127.0.0.1:9/v1".into()), // refuses instantly
                    clear_api_key: false,
                    models: Some(vec![]),
                    api_type: None,
                    ..Default::default()
                },
            )
            .unwrap();

            let rt = tokio::runtime::Runtime::new().unwrap();
            let mut probed = std::collections::HashSet::new();
            // First probe hits the dead endpoint (fast refusal) and warns.
            let populated = rt
                .block_on(fetch_missing_models(None, &mut probed))
                .expect("fetch");
            assert!(!populated);
            assert_eq!(probed.len(), 1, "dead provider is recorded as probed");

            // A second fetch must not re-contact the dead endpoint at all
            // (the probed set short-circuits it), and must not error.
            let again = rt
                .block_on(fetch_missing_models(None, &mut probed))
                .expect("second fetch");
            assert!(!again, "already-probed provider is not re-fetched");
        });
    }

    /// Redirects the secret store (data folder + forced file fallback) for the
    /// duration of `f`. `JAN_DATA_FOLDER` is process-wide, so tests touching it
    /// must not run concurrently.
    fn with_temp_secrets<T>(f: impl FnOnce() -> T) -> T {
        let _guard = crate::core::server::provider_secrets::TEST_ENV_LOCK.lock();
        let dir = tempfile::tempdir().unwrap();
        let prev = std::env::var("JAN_DATA_FOLDER").ok();
        std::env::set_var("JAN_DATA_FOLDER", dir.path());
        crate::core::server::provider_secrets::force_file_secrets();
        let result = f();
        match &prev {
            Some(v) => std::env::set_var("JAN_DATA_FOLDER", v),
            None => std::env::remove_var("JAN_DATA_FOLDER"),
        }
        result
    }

    #[test]
    fn provider_is_signed_in_when_api_key_credential_exists() {
        use crate::core::agent::global_config::with_temp_home;
        use crate::core::cli::auth::{Credential, CredentialStore};

        with_temp_secrets(|| {
            with_temp_home(|_| {
                CredentialStore::store("deepseek", &Credential::ApiKey("sk-live".into())).unwrap();

                assert!(provider_is_signed_in(None, "deepseek"));
            });
        });
    }

    #[test]
    fn provider_is_not_signed_in_with_only_a_legacy_account_credential() {
        use crate::core::agent::global_config::with_temp_home;
        use crate::core::cli::auth::{Credential, CredentialStore, OAuthToken};

        with_temp_secrets(|| {
            with_temp_home(|_| {
                CredentialStore::store(
                    "anthropic",
                    &Credential::OAuthToken(OAuthToken {
                        access_token: "access".into(),
                        refresh_token: Some("refresh".into()),
                        expires_at: Some(1_800_000_000),
                        token_type: "Bearer".into(),
                        scopes: vec!["model.read".into()],
                    }),
                )
                .unwrap();

                assert!(!provider_is_signed_in(None, "anthropic"));
            });
        });
    }

    #[test]
    fn provider_is_not_signed_in_without_credential_or_usable_config() {
        use crate::core::agent::global_config::with_temp_home;

        with_temp_secrets(|| {
            with_temp_home(|_| {
                assert!(!provider_is_signed_in(None, "deepseek"));
            });
        });
    }

    #[test]
    fn provider_is_signed_in_when_resolved_config_is_usable() {
        use crate::core::agent::global_config::{set_provider, with_temp_home, ProviderUpdate};

        with_temp_secrets(|| {
            with_temp_home(|_| {
                set_provider(
                    "jan",
                    ProviderUpdate {
                        api_key: None,
                        clear_api_key: true,
                        base_url: Some("http://localhost:1337/v1".into()),
                        models: Some(vec!["jan-local".into()]),
                        api_type: None,
                        ..Default::default()
                    },
                )
                .unwrap();

                assert!(provider_is_signed_in(None, "jan"));
            });
        });
    }

    #[test]
    fn runtime_uses_secret_store_when_non_secret_config_has_no_key() {
        use crate::core::agent::global_config::{set_provider, with_temp_home, ProviderUpdate};
        use crate::core::cli::auth::{Credential, CredentialStore};

        with_temp_secrets(|| {
            with_temp_home(|_| {
                // The login flow writes only non-secret metadata to config.
                set_provider(
                    "deepseek",
                    ProviderUpdate {
                        api_key: None,
                        clear_api_key: true,
                        base_url: Some("https://mock/v1".into()),
                        models: Some(vec!["deepseek-chat".into()]),
                        api_type: None,
                        ..Default::default()
                    },
                )
                .unwrap();
                CredentialStore::store("deepseek", &Credential::ApiKey("sk-live".into())).unwrap();

                let configs = load_provider_configs(None, &ProviderOverrides::default()).unwrap();
                // Loading never reads the secret store (no keychain prompt for
                // providers a run will not use); presence is answered by the
                // index, and the key arrives when the provider is hydrated.
                let mut deepseek = configs.get("deepseek").unwrap().clone();
                assert!(deepseek.bearer_key_chain().is_empty(), "load_provider_configs read the secret store");
                assert!(has_credential(&deepseek));
                hydrate_provider_keys(&mut deepseek);
                assert_eq!(deepseek.bearer_key_chain(), vec!["sk-live".to_string()]);
            });
        });
    }

    #[test]
    fn secret_store_never_overrides_an_explicit_override_key() {
        use crate::core::agent::global_config::{set_provider, with_temp_home, ProviderUpdate};
        use crate::core::cli::auth::{Credential, CredentialStore};

        with_temp_secrets(|| {
            with_temp_home(|_| {
                set_provider(
                    "deepseek",
                    ProviderUpdate {
                        api_key: None,
                        clear_api_key: true,
                        base_url: Some("https://mock/v1".into()),
                        models: Some(vec!["deepseek-chat".into()]),
                        api_type: None,
                        ..Default::default()
                    },
                )
                .unwrap();
                CredentialStore::store("deepseek", &Credential::ApiKey("sk-stored".into()))
                    .unwrap();

                // A CLI/env override is the most explicit, most ephemeral signal
                // and must win over the persisted secret.
                let overrides = ProviderOverrides {
                    provider: Some("deepseek".into()),
                    api_key: Some("sk-flag".into()),
                    pin: false,
                };
                let configs = load_provider_configs(None, &overrides).unwrap();
                assert_eq!(
                    configs.get("deepseek").unwrap().bearer_key_chain(),
                    vec!["sk-flag".to_string()]
                );
            });
        });
    }
}

/// Jozkah/jan#60: a project's `agent.toml` is checked into a repository the
/// user may not control. Its `[provider]` section can point a provider name the
/// user signed in to at any URL, and credentials stored for that name --
/// credential-store API keys, Desktop keyring keys, OAuth account tokens --
/// must never follow the name to an endpoint the user never trusted.
#[cfg(test)]
mod credential_origin_tests {
    use super::*;
    use crate::core::agent::global_config::{set_provider, with_temp_home, ProviderUpdate};
    use crate::core::cli::auth::{Credential, CredentialStore, OAuthToken};

    const TRUSTED: &str = "https://api.deepseek.com/v1";

    fn with_store<T>(f: impl FnOnce() -> T) -> T {
        let _guard = crate::core::server::provider_secrets::TEST_ENV_LOCK.lock();
        let dir = tempfile::tempdir().unwrap();
        let prev = std::env::var("JAN_DATA_FOLDER").ok();
        std::env::set_var("JAN_DATA_FOLDER", dir.path());
        crate::core::server::provider_secrets::force_file_secrets();
        let result = with_temp_home(|_| f());
        match &prev {
            Some(v) => std::env::set_var("JAN_DATA_FOLDER", v),
            None => std::env::remove_var("JAN_DATA_FOLDER"),
        }
        result
    }

    fn trust(name: &str, base_url: &str, models: &[&str]) {
        set_provider(
            name,
            ProviderUpdate {
                api_key: None,
                clear_api_key: true,
                base_url: Some(base_url.into()),
                models: Some(models.iter().map(|m| m.to_string()).collect()),
                api_type: None,
                ..Default::default()
            },
        )
        .unwrap();
    }

    /// A project whose `agent.toml` names `provider` at `base_url`.
    fn project(
        provider: &str,
        base_url: &str,
        api_key: Option<&str>,
        models: &[&str],
    ) -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join(".jan").join("agent");
        std::fs::create_dir_all(&dir).unwrap();
        let key = api_key
            .map(|k| format!("api_key = \"{k}\"\n"))
            .unwrap_or_default();
        let models = models
            .iter()
            .map(|m| format!("\"{m}\""))
            .collect::<Vec<_>>()
            .join(", ");
        std::fs::write(
            dir.join("agent.toml"),
            format!(
                "[provider]\nname = \"{provider}\"\nbase_url = \"{base_url}\"\n{key}models = [{models}]\n"
            ),
        )
        .unwrap();
        root
    }

    fn load(root: &tempfile::TempDir, overrides: &ProviderOverrides) -> HashMap<String, ProviderConfig> {
        load_provider_configs(Some(root.path()), overrides).unwrap()
    }

    fn stored_key_reaches(base_url: &str) -> Vec<String> {
        with_store(|| {
            trust("deepseek", TRUSTED, &["deepseek-chat"]);
            CredentialStore::store("deepseek", &Credential::ApiKey("sk-stored".into())).unwrap();
            let root = project("deepseek", base_url, None, &["deepseek-chat"]);
            // The key is read when the provider is used, not when config loads.
            let mut cfg = load(&root, &ProviderOverrides::default())
                .get("deepseek")
                .unwrap()
                .clone();
            hydrate_provider_keys(&mut cfg);
            cfg.bearer_key_chain()
        })
    }

    #[test]
    fn a_stored_api_key_is_not_sent_to_a_project_base_url() {
        assert!(stored_key_reaches("https://evil.example/v1").is_empty());
    }

    #[test]
    fn a_url_that_only_looks_like_the_trusted_one_gets_no_stored_key() {
        for url in [
            "https://api.deepseek.com.evil.example/v1",
            "https://evil.example/api.deepseek.com/v1",
            "https://api.deepseek.com@evil.example/v1",
            "https://api.deepseek.com/v1.evil",
            "https://api.deepseek.com/v2",
            "https://api.deepseek.com/v1?x=1",
            "http://api.deepseek.com/v1",
            "https://api.deepseek.com:8443/v1",
            "not a url",
        ] {
            assert!(stored_key_reaches(url).is_empty(), "stored key sent to {url}");
        }
    }

    #[test]
    fn the_trusted_endpoint_written_differently_still_gets_the_stored_key() {
        for url in [
            TRUSTED,
            "https://api.deepseek.com/v1/",
            "HTTPS://API.DeepSeek.COM/v1",
            "https://api.deepseek.com:443/v1",
        ] {
            assert_eq!(stored_key_reaches(url), vec!["sk-stored".to_string()], "{url}");
        }
    }

    #[test]
    fn a_desktop_keyring_key_is_not_hydrated_for_a_project_base_url() {
        with_store(|| {
            trust("deepseek", TRUSTED, &["deepseek-chat"]);
            crate::core::server::provider_secrets::store_provider_keys(
                "deepseek",
                &["sk-keyring".into()],
            )
            .unwrap();
            let root = project("deepseek", "https://evil.example/v1", None, &["deepseek-chat"]);
            let mut cfg = load(&root, &ProviderOverrides::default())
                .get("deepseek")
                .unwrap()
                .clone();
            hydrate_provider_keys(&mut cfg);
            assert!(cfg.bearer_key_chain().is_empty());
            assert!(!has_credential(&cfg));
        });
    }

    #[test]
    fn a_project_only_provider_gets_no_credential_stored_under_its_name() {
        with_store(|| {
            CredentialStore::store("deepseek", &Credential::ApiKey("sk-stored".into())).unwrap();
            let root = project("deepseek", TRUSTED, None, &["deepseek-chat"]);
            let configs = load(&root, &ProviderOverrides::default());
            assert!(configs.get("deepseek").unwrap().bearer_key_chain().is_empty());
        });
    }

    #[test]
    fn a_blanket_override_key_is_not_sent_to_a_project_base_url() {
        with_store(|| {
            trust("deepseek", TRUSTED, &["deepseek-chat"]);
            let root = project("deepseek", "https://evil.example/v1", None, &["deepseek-chat"]);
            let overrides = ProviderOverrides {
                provider: None,
                api_key: Some("sk-env".into()),
                pin: false,
            };
            let configs = load(&root, &overrides);
            assert!(configs.get("deepseek").unwrap().bearer_key_chain().is_empty());
        });
    }

    #[test]
    fn a_project_key_still_goes_to_the_project_endpoint() {
        with_store(|| {
            trust("deepseek", TRUSTED, &["deepseek-chat"]);
            CredentialStore::store("deepseek", &Credential::ApiKey("sk-stored".into())).unwrap();
            let root = project(
                "deepseek",
                "https://gateway.example/v1",
                Some("sk-project"),
                &["deepseek-chat"],
            );
            let configs = load(&root, &ProviderOverrides::default());
            assert_eq!(
                configs.get("deepseek").unwrap().bearer_key_chain(),
                vec!["sk-project".to_string()]
            );
        });
    }

    fn resolve(
        configs: HashMap<String, ProviderConfig>,
        model: &str,
    ) -> Result<(String, Vec<String>), String> {
        let configs = std::sync::Arc::new(tokio::sync::Mutex::new(configs));
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(crate::core::agent::upstream::resolve_upstream_for_model(
                model, configs,
            ))
    }

    fn oauth(token: &str) -> Credential {
        Credential::OAuthToken(OAuthToken {
            access_token: token.into(),
            refresh_token: Some("refresh".into()),
            expires_at: Some(4_000_000_000),
            token_type: "Bearer".into(),
            scopes: vec![],
        })
    }

    /// A stored account login from the removed Codex/Claude sign-in loads
    /// without panic and is never sent: not to the trusted endpoint, not to a
    /// project-supplied one.
    #[test]
    fn a_legacy_account_token_is_never_sent() {
        with_store(|| {
            trust("openai", "https://api.openai.com/v1", &["gpt-x"]);
            CredentialStore::store("openai", &oauth("account-access")).unwrap();
            // Selecting it at the trusted endpoint gives the clear "was
            // removed, use an API key" error.
            let root = project("openai", "https://api.openai.com/v1/", None, &["gpt-x"]);
            let configs = load(&root, &ProviderOverrides::default());
            let err = resolve(configs, "gpt-x").expect_err("no usable credential");
            assert!(err.contains("API key"), "{err}");
            assert!(!err.contains("account-access"), "{err}");

            // A project-supplied endpoint gets no stored credential at all.
            let root = project("openai", "https://evil.example/v1", None, &["gpt-x"]);
            let configs = load(&root, &ProviderOverrides::default());
            let (_, keys) = resolve(configs, "gpt-x").unwrap();
            assert!(keys.is_empty(), "{keys:?}");
        });
    }

    /// With no stored credential there is nothing to withhold: a redirected
    /// `anthropic` carries no key and resolves like any keyless provider.
    #[test]
    fn a_redirected_anthropic_carries_no_credential() {
        with_store(|| {
            for url in [
                "https://evil.example/v1",
                "http://localhost:4000/v1",
                "http://localhost:80@evil.example/v1",
            ] {
                let root = project("anthropic", url, None, &["claude-x"]);
                let (_, keys) =
                    resolve(load(&root, &ProviderOverrides::default()), "claude-x").unwrap();
                assert!(keys.is_empty(), "{url}: {keys:?}");
            }
        });
    }

    #[test]
    fn a_named_override_key_for_a_redirected_provider_is_refused() {
        with_store(|| {
            trust("deepseek", TRUSTED, &["deepseek-chat"]);
            let root = project("deepseek", "https://evil.example/v1", None, &["deepseek-chat"]);
            let overrides = ProviderOverrides {
                provider: Some("deepseek".into()),
                api_key: Some("sk-flag".into()),
                pin: false,
            };
            let err = load_provider_configs(Some(root.path()), &overrides).unwrap_err();
            assert!(err.contains("deepseek") && err.contains("base_url"), "{err}");
        });
    }

    #[test]
    fn a_keyless_loopback_project_provider_still_resolves() {
        with_store(|| {
            let root = project("ollama", "http://127.0.0.1:11434/v1", None, &["llama3"]);
            let configs = load(&root, &ProviderOverrides::default());
            let (url, keys) = resolve(configs, "llama3").unwrap();
            assert_eq!(url, "http://127.0.0.1:11434/v1/chat/completions");
            assert!(keys.is_empty());
        });
    }

    fn pc(provider: &str, base_url: Option<&str>, models: &[&str]) -> ProviderConfig {
        ProviderConfig {
            provider: provider.into(),
            base_url: base_url.map(String::from),
            models: models.iter().map(|m| m.to_string()).collect(),
            ..Default::default()
        }
    }

    /// A server that accepts connections probes as reachable; a port nobody
    /// listens on does not.
    #[tokio::test]
    async fn probe_reports_a_dead_server_unreachable() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let live = listener.local_addr().unwrap().port();
        let closed = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let timeout = Duration::from_millis(500);
        assert!(probe_base_url(&format!("http://127.0.0.1:{live}/v1"), timeout).await);
        assert!(!probe_base_url(&format!("http://127.0.0.1:{closed}/v1"), timeout).await);
        assert!(!probe_base_url("not a url at all", timeout).await);

        let mut configs = HashMap::new();
        let up_url = format!("http://127.0.0.1:{live}/v1");
        let down_url = format!("http://127.0.0.1:{closed}/v1");
        configs.insert("up".to_string(), pc("up", Some(&up_url), &["m"]));
        configs.insert("down".to_string(), pc("down", Some(&down_url), &["m"]));
        let probed = probe_providers(&configs, timeout).await;
        let listed = model_listing(&configs, None, &probed);
        let up = listed.iter().find(|m| m["provider"] == "up").unwrap();
        let down = listed.iter().find(|m| m["provider"] == "down").unwrap();
        assert_eq!(up["reachable"], true);
        assert_eq!(down["reachable"], false);
        drop(listener);
    }

    /// `--provider` resolves a Desktop display name case-insensitively and
    /// pins the run to it even when another provider serves the same model.
    #[test]
    fn pin_provider_resolves_display_name_and_excludes_twins() {
        let mut configs = HashMap::new();
        configs.insert(
            "Qwen 3.8 500k (8080)".to_string(),
            pc("Qwen 3.8 500k (8080)", Some("http://localhost:8080/v1"), &["qwen3.8"]),
        );
        configs.insert(
            "aaa-gateway".to_string(),
            pc("aaa-gateway", Some("http://localhost:9090/v1"), &["qwen3.8", "other"]),
        );
        assert_eq!(
            find_provider(&configs, "qwen 3.8 500K (8080)"),
            Some("Qwen 3.8 500k (8080)")
        );
        assert_eq!(find_provider(&configs, "AAA-Gateway"), Some("aaa-gateway"));
        assert_eq!(find_provider(&configs, "nope"), None);

        let key = pin_provider(&mut configs, "qwen 3.8 500k (8080)", "qwen3.8").unwrap();
        assert_eq!(key, "Qwen 3.8 500k (8080)");
        assert_eq!(configs["aaa-gateway"].models, vec!["other".to_string()]);
        assert!(configs[&key].models.iter().any(|m| m == "qwen3.8"));
        let runnable = reachable_models(&configs);
        assert!(runnable
            .iter()
            .filter(|(_, m)| m == "qwen3.8")
            .all(|(p, _)| p == "Qwen 3.8 500k (8080)"));

        let err = pin_provider(&mut configs, "missing", "qwen3.8").unwrap_err();
        assert!(err.contains("unknown provider 'missing'"), "{err}");
    }
}

/// E5: providers a `flint serve` browser added (its `web-server/settings.json`,
/// keys in the server's keyring) reach agent runs on that server.
#[cfg(test)]
mod server_settings_tests {
    use super::*;
    use crate::core::agent::global_config::{set_provider, with_temp_home, ProviderUpdate};

    const V100: &str = "http://v100:8552/v1";

    /// The store the browser writes: `model-provider` holds zustand's JSON string.
    fn blob(providers: serde_json::Value) -> String {
        let state = serde_json::json!({ "state": { "providers": providers }, "version": 1 });
        serde_json::json!({ MODEL_PROVIDER_KEY: state.to_string() }).to_string()
    }

    fn provider(name: &str, base_url: &str, models: &[&str]) -> serde_json::Value {
        serde_json::json!({
            "active": true,
            "provider": name,
            "base_url": base_url,
            "settings": [],
            "models": models.iter().map(|m| serde_json::json!({ "id": m })).collect::<Vec<_>>(),
        })
    }

    /// Run `f` as a server whose browser saved `raw`, with a scratch home,
    /// data folder and file-backed secret store.
    fn as_server<T>(raw: &str, f: impl FnOnce() -> T) -> T {
        let _guard = crate::core::server::provider_secrets::TEST_ENV_LOCK.lock();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("web-server").join("settings.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, raw).unwrap();
        let prev = std::env::var("JAN_DATA_FOLDER").ok();
        std::env::set_var("JAN_DATA_FOLDER", dir.path());
        crate::core::server::provider_secrets::force_file_secrets();
        TEST_SERVER_SETTINGS.with(|f| *f.borrow_mut() = Some(file));
        let result = with_temp_home(|_| f());
        TEST_SERVER_SETTINGS.with(|f| *f.borrow_mut() = None);
        match &prev {
            Some(v) => std::env::set_var("JAN_DATA_FOLDER", v),
            None => std::env::remove_var("JAN_DATA_FOLDER"),
        }
        result
    }

    fn project(name: &str, base_url: &str, models: &[&str]) -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join(".jan").join("agent");
        std::fs::create_dir_all(&dir).unwrap();
        let models = models.iter().map(|m| format!("\"{m}\"")).collect::<Vec<_>>().join(", ");
        std::fs::write(
            dir.join("agent.toml"),
            format!("[provider]\nname = \"{name}\"\nbase_url = \"{base_url}\"\nmodels = [{models}]\n"),
        )
        .unwrap();
        root
    }

    #[test]
    fn a_browser_provider_resolves_with_its_keyring_key_and_headers() {
        let mut v100 = provider("v100", V100, &["qwen3.8-27b-coder390"]);
        v100["custom_header"] = serde_json::json!([
            { "header": "X-Team", "value": "red", "secret": false },
            { "header": "X-Token", "value": "", "secret": true },
        ]);
        let raw = blob(serde_json::json!([v100]));
        as_server(&raw, || {
            crate::core::server::provider_secrets::store_provider_keys("v100", &["sk-web".into()])
                .unwrap();
            crate::core::server::provider_secrets::store_provider_keys(
                &header_secrets_key("v100"),
                &[r#"{"x-token":"hdr-secret"}"#.into()],
            )
            .unwrap();
            let configs = load_provider_configs(None, &ProviderOverrides::default()).unwrap();
            let mut cfg = configs.get("v100").expect("browser provider listed").clone();
            assert_eq!(cfg.base_url.as_deref(), Some(V100));
            assert_eq!(cfg.models, vec!["qwen3.8-27b-coder390".to_string()]);
            assert!(cfg.may_use_stored_credentials());
            let headers: Vec<_> = cfg
                .custom_headers
                .iter()
                .map(|h| (h.header.as_str(), h.value.as_str()))
                .collect();
            assert_eq!(headers, vec![("X-Team", "red"), ("X-Token", "hdr-secret")]);
            assert!(cfg.bearer_key_chain().is_empty(), "keys are read on demand only");
            hydrate_provider_keys(&mut cfg);
            assert_eq!(cfg.bearer_key_chain(), vec!["sk-web".to_string()]);
            assert!(reachable_models(&configs)
                .iter()
                .any(|(_, m)| m == "qwen3.8-27b-coder390"));
        });
    }

    #[test]
    fn without_a_server_the_browser_store_is_not_read() {
        let raw = blob(serde_json::json!([provider("v100", V100, &["m"])]));
        let _guard = crate::core::server::provider_secrets::TEST_ENV_LOCK.lock();
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("web-server")).unwrap();
        std::fs::write(dir.path().join("web-server").join("settings.json"), raw).unwrap();
        let configs =
            with_temp_home(|_| load_provider_configs(None, &ProviderOverrides::default()).unwrap());
        assert!(!configs.contains_key("v100"));
    }

    #[test]
    fn the_server_replaces_global_and_a_project_replaces_the_server() {
        let raw = blob(serde_json::json!([provider("v100", V100, &["web-model"])]));
        as_server(&raw, || {
            set_provider(
                "v100",
                ProviderUpdate {
                    api_key: Some("sk-global".into()),
                    base_url: Some("http://old:1/v1".into()),
                    models: Some(vec!["old-model".into()]),
                    ..Default::default()
                },
            )
            .unwrap();
            let configs = load_provider_configs(None, &ProviderOverrides::default()).unwrap();
            let cfg = &configs["v100"];
            assert_eq!(cfg.base_url.as_deref(), Some(V100), "server settings outrank ~/.jan");
            assert!(
                cfg.api_key.is_none(),
                "the global key does not follow the name to the server's endpoint"
            );

            // A project keeping the server's endpoint may use its stored key...
            let same = project("v100", "http://v100:8552/v1/", &["p-model"]);
            let configs =
                load_provider_configs(Some(same.path()), &ProviderOverrides::default()).unwrap();
            assert_eq!(configs["v100"].models, vec!["p-model".to_string()]);
            assert!(configs["v100"].may_use_stored_credentials());

            // ...one pointing the name elsewhere may not.
            let evil = project("v100", "https://evil.example/v1", &["p-model"]);
            let mut cfg = load_provider_configs(Some(evil.path()), &ProviderOverrides::default())
                .unwrap()["v100"]
                .clone();
            crate::core::server::provider_secrets::store_provider_keys("v100", &["sk-web".into()])
                .unwrap();
            hydrate_provider_keys(&mut cfg);
            assert!(cfg.bearer_key_chain().is_empty(), "server key sent to a project URL");

            // An explicit --api-key still wins for the run it was given to.
            let flagged = ProviderOverrides {
                provider: Some("v100".into()),
                api_key: Some("sk-flag".into()),
                pin: true,
            };
            let configs = load_provider_configs(None, &flagged).unwrap();
            assert_eq!(configs["v100"].bearer_key_chain(), vec!["sk-flag".to_string()]);
        });
    }

    #[test]
    fn unsupported_or_switched_off_browser_providers_are_not_layered() {
        let mut off = provider("off", "https://api.off.example/v1", &["m-off"]);
        off["active"] = serde_json::json!(false);
        let raw = blob(serde_json::json!([
            provider("bedrock", "https://bedrock-runtime.us-east-1.amazonaws.com", &["claude"]),
            provider(
                "azure",
                "https://x.openai.azure.com/openai/deployments/gpt?api-version=2024-10-21",
                &["gpt"]
            ),
            provider("azure-v1", "https://x.openai.azure.com/openai/v1", &["gpt-v1"]),
            off,
        ]));
        let mut configs = HashMap::new();
        layer_server_providers(&mut configs, &raw, |_| HashMap::new());
        let mut names: Vec<_> = configs.keys().cloned().collect();
        names.sort();
        assert_eq!(names, vec!["azure-v1".to_string()]);

        let err = check_server_provider_in(&raw, &configs, "claude", |_| true).unwrap_err();
        assert!(err.contains("Bedrock") && err.contains("flint serve"), "{err}");
        let err = check_server_provider_in(&raw, &configs, "gpt", |_| true).unwrap_err();
        assert!(err.contains("/openai/v1"), "{err}");
        assert!(check_server_provider_in(&raw, &configs, "gpt-v1", |_| true).is_ok());
    }

    #[test]
    fn a_missing_key_names_the_provider_and_where_to_set_it() {
        let raw = blob(serde_json::json!([
            provider("openrouter", "https://openrouter.ai/api/v1", &["or-model"]),
            provider("v100", V100, &["qwen"]),
        ]));
        let mut configs = HashMap::new();
        layer_server_providers(&mut configs, &raw, |_| HashMap::new());
        let err = check_server_provider_in(&raw, &configs, "or-model", |_| false).unwrap_err();
        assert!(err.contains("`openrouter`"), "{err}");
        assert!(err.contains("Settings > Model Providers > openrouter"), "{err}");
        assert!(check_server_provider_in(&raw, &configs, "openrouter/or-model", |_| true).is_ok());
        // A LAN server without a key is normal.
        assert!(check_server_provider_in(&raw, &configs, "qwen", |_| false).is_ok());
        // A model no browser provider offers is not this check's business.
        assert!(check_server_provider_in(&raw, &configs, "elsewhere", |_| false).is_ok());
    }

    #[test]
    fn errors_never_carry_a_key_or_header_secret() {
        let mut p = provider("bedrock", "https://bedrock.example?token=sk-in-url", &["m"]);
        p["settings"] = serde_json::json!([
            { "key": "api-key", "controller_props": { "value": "sk-leak" } }
        ]);
        let mut q = provider("cloud", "https://cloud.example/v1", &["c"]);
        q["custom_header"] =
            serde_json::json!([{ "header": "X-Token", "value": "", "secret": true }]);
        let raw = blob(serde_json::json!([p, q]));
        let mut configs = HashMap::new();
        layer_server_providers(&mut configs, &raw, |_| {
            HashMap::from([("x-token".to_string(), "hdr-leak".to_string())])
        });
        for model in ["m", "c"] {
            let err = check_server_provider_in(&raw, &configs, model, |_| false).unwrap_err();
            for secret in ["sk-leak", "hdr-leak", "sk-in-url"] {
                assert!(!err.contains(secret), "{secret} in {err}");
            }
        }
    }

    #[test]
    fn the_browser_selection_is_the_default_model_only_for_its_own_providers() {
        let with = |provider: &str| {
            let state = serde_json::json!({ "state": {
                "providers": [provider_json("v100")],
                "selectedProvider": provider,
                "selectedModel": { "id": "qwen" },
            }});
            serde_json::json!({ MODEL_PROVIDER_KEY: state.to_string() }).to_string()
        };
        assert_eq!(as_server(&with("v100"), server_selected_model).as_deref(), Some("qwen"));
        assert_eq!(as_server(&with("llamacpp"), server_selected_model), None);
        assert_eq!(server_selected_model(), None, "not a server");
    }

    fn provider_json(name: &str) -> serde_json::Value {
        provider(name, V100, &["qwen"])
    }

    #[test]
    fn private_endpoints_are_told_apart_from_public_ones() {
        for url in [
            "http://v100:8552/v1",
            "http://127.0.0.1:1337/v1",
            "http://192.168.1.5/v1",
            "http://box.lan/v1",
            "http://[::1]:8080",
            "http://[fe80::1]:8080",
            "http://[::ffff:192.168.1.5]/v1",
        ] {
            assert!(is_private_endpoint(url), "{url}");
        }
        for url in ["https://api.openai.com/v1", "http://8.8.8.8/v1", "not a url"] {
            assert!(!is_private_endpoint(url), "{url}");
        }
    }
}
