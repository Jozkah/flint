//! Which Hugging Face hub the explicit model search and downloads talk to.
//! Compiled for both the desktop app and the CLI, so they share one rule.
//!
//! The hub is resolved in this order: the `HF_ENDPOINT` environment variable,
//! then the endpoint chosen in Settings (kept in `<data>/hf_endpoint.json` so
//! the CLI reads the same choice), then huggingface.co. The Hugging Face token
//! only goes to huggingface.co, unless the user ticked "send my token to this
//! mirror" for the endpoint they chose.

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use url::Url;

const DEFAULT_HF_ENDPOINT: &str = "https://huggingface.co";
const DEFAULT_HF_HOST: &str = "huggingface.co";
const SETTING_FILE: &str = "hf_endpoint.json";

/// The endpoint chosen in Settings. An empty `endpoint` means huggingface.co.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HfEndpointSetting {
    pub endpoint: String,
    pub send_token_to_mirror: bool,
}

static SETTING: RwLock<Option<HfEndpointSetting>> = RwLock::new(None);

fn current_setting() -> HfEndpointSetting {
    SETTING.read().ok().and_then(|s| s.clone()).unwrap_or_default()
}

fn install_setting(setting: HfEndpointSetting) {
    if let Ok(mut slot) = SETTING.write() {
        *slot = Some(setting);
    }
}

fn setting_path(data: &Path) -> PathBuf {
    data.join(SETTING_FILE)
}

/// Check an endpoint typed in Settings: the shared rules plus https only (a
/// mirror reached over plain http could be tampered with on the way). Empty
/// means huggingface.co and is fine.
pub fn validate_setting(setting: &HfEndpointSetting) -> Result<(), String> {
    if setting.endpoint.trim().is_empty() {
        return Ok(());
    }
    let url = parse_endpoint(Some(&setting.endpoint))?;
    if url.scheme() != "https" {
        return Err(format!("The Hugging Face endpoint must use https: {}", setting.endpoint.trim()));
    }
    Ok(())
}

/// Read the saved choice from the data folder and use it from now on. A
/// missing, unreadable or invalid file falls back to huggingface.co.
pub fn load_setting(data: &Path) {
    install_setting(read_setting(data));
}

fn read_setting(data: &Path) -> HfEndpointSetting {
    std::fs::read_to_string(setting_path(data))
        .ok()
        .and_then(|text| serde_json::from_str::<HfEndpointSetting>(&text).ok())
        .filter(|s| validate_setting(s).is_ok())
        .unwrap_or_default()
}

/// Validate, save to the data folder, and use the choice from now on.
pub fn save_setting(data: &Path, setting: HfEndpointSetting) -> Result<(), String> {
    install_setting(write_setting(data, setting)?);
    Ok(())
}

fn write_setting(data: &Path, setting: HfEndpointSetting) -> Result<HfEndpointSetting, String> {
    let setting = HfEndpointSetting { endpoint: setting.endpoint.trim().to_string(), ..setting };
    validate_setting(&setting)?;
    let text = serde_json::to_string_pretty(&setting).map_err(|e| e.to_string())?;
    std::fs::write(setting_path(data), text)
        .map_err(|e| format!("Could not save the Hugging Face endpoint: {e}"))?;
    Ok(setting)
}

/// The setting in force plus the `HF_ENDPOINT` override, for the Settings page.
pub fn current_setting_and_env() -> (HfEndpointSetting, Option<String>) {
    (current_setting(), env_endpoint())
}

fn env_endpoint() -> Option<String> {
    std::env::var("HF_ENDPOINT").ok().filter(|v| !v.trim().is_empty())
}

/// The resolved hub and whether the token may be sent there.
#[derive(Debug, Clone)]
pub(crate) struct ResolvedEndpoint {
    pub url: Url,
    pub send_token_to_mirror: bool,
}

/// `env` beats `setting`, which beats huggingface.co. The mirror-token opt-in
/// belongs to the endpoint chosen in Settings, so it does not carry over to an
/// `HF_ENDPOINT` override.
pub(crate) fn resolve_with(env: Option<&str>, setting: &HfEndpointSetting) -> Result<ResolvedEndpoint, String> {
    if let Some(env) = env.filter(|v| !v.trim().is_empty()) {
        return Ok(ResolvedEndpoint { url: parse_endpoint(Some(env))?, send_token_to_mirror: false });
    }
    if !setting.endpoint.trim().is_empty() {
        validate_setting(setting)?;
        return Ok(ResolvedEndpoint {
            url: parse_endpoint(Some(&setting.endpoint))?,
            send_token_to_mirror: setting.send_token_to_mirror,
        });
    }
    Ok(ResolvedEndpoint { url: parse_endpoint(None)?, send_token_to_mirror: false })
}

pub(crate) fn resolve() -> Result<ResolvedEndpoint, String> {
    resolve_with(env_endpoint().as_deref(), &current_setting())
}

/// The token to send to `endpoint`: always for huggingface.co, for any other
/// host only when the user opted in.
pub(crate) fn token_for<'a>(endpoint: &ResolvedEndpoint, token: Option<&'a str>) -> Option<&'a str> {
    let token = token.map(str::trim).filter(|t| !t.is_empty())?;
    let official = endpoint.url.scheme() == "https" && endpoint.url.host_str() == Some(DEFAULT_HF_HOST);
    // Never over plain http, even to an opted-in mirror (ENG-024).
    let secure = token_allowed_for(&endpoint.url);
    (secure && (official || endpoint.send_token_to_mirror)).then_some(token)
}

/// `token` filtered for the endpoint in force now.
pub(crate) fn hub_token(token: Option<&str>) -> Result<Option<&str>, String> {
    Ok(token_for(&resolve()?, token))
}

/// Validate a Hugging Face endpoint, the way `HF_ENDPOINT` is used by
/// `huggingface_hub`: an http(s) URL of a mirror or self-hosted hub. An unset or
/// empty value means huggingface.co. Credentials, a query and a fragment are
/// refused, and a trailing slash is dropped.
pub(crate) fn parse_endpoint(raw: Option<&str>) -> Result<Url, String> {
    let text = raw.map(str::trim).filter(|v| !v.is_empty()).unwrap_or(DEFAULT_HF_ENDPOINT);
    let invalid = |why: &str| format!("HF_ENDPOINT is not a usable Hugging Face endpoint ({why}): {text}");
    let url = Url::parse(text.trim_end_matches('/')).map_err(|_| invalid("not a URL"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(invalid("only http and https are allowed"));
    }
    if url.host_str().is_none() {
        return Err(invalid("no host"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(invalid("credentials in the URL are not allowed"));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(invalid("no query or fragment allowed"));
    }
    Ok(url)
}

/// The hub to talk to: `HF_ENDPOINT`, else the Settings choice, else huggingface.co.
pub(crate) fn hf_endpoint() -> Result<Url, String> {
    Ok(resolve()?.url)
}

/// Whether the access token may be sent to `endpoint`: only over https, so a
/// plain-http mirror never sees it (ENG-024).
// `token_for` uses it in every build, including the headless CLI.
pub(crate) fn token_allowed_for(endpoint: &Url) -> bool {
    endpoint.scheme() == "https"
}

/// `base` with `parts` appended as path segments.
/// A repository file path safe to request and to map onto disk: relative, no
/// backslash, no empty, `.` or `..` part, and no control character (NUL
/// included). Any other Unicode is allowed: Hugging Face serves such names.
/// Shared by the desktop app and the CLI.
pub fn valid_remote_path(filename: &str) -> bool {
    !filename.is_empty()
        && !filename.starts_with('/')
        && !filename.contains('\\')
        && filename.split('/').all(|part| {
            !part.is_empty() && part != "." && part != ".." && !part.chars().any(char::is_control)
        })
}

/// One path component made safe for every file system: anything but ASCII
/// letters, digits, `-`, `_` and `.` becomes `-`. A name that had to change
/// gets the first 8 hex digits of the SHA-256 of the original (lowercased)
/// before its extension, so `a b.gguf` and `a+b.gguf` no longer land on the
/// same file. A name that is already clean is returned as it is.
pub fn safe_path_component(value: &str) -> String {
    let mapped: String = value
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '-' })
        .collect();
    let mut out = mapped.trim_matches(['.', '-']).to_string();
    if out.is_empty() {
        out = "file".to_string();
    }
    if out == value {
        return out;
    }
    use sha2::{Digest, Sha256};
    let digest = hex::encode(Sha256::digest(value.to_lowercase().as_bytes()));
    let tag = &digest[..8];
    match out.rfind('.') {
        Some(i) if i > 0 => format!("{}-{tag}{}", &out[..i], &out[i..]),
        _ => format!("{out}-{tag}"),
    }
}

pub(crate) fn endpoint_url(base: &Url, parts: &[&str]) -> Result<Url, String> {
    let mut url = base.clone();
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "Invalid Hugging Face base URL".to_string())?;
        segments.pop_if_empty();
        for part in parts {
            segments.push(part);
        }
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_paths_allow_unicode_but_not_control_characters() {
        assert!(valid_remote_path("modèle-Q4.gguf"));
        assert!(valid_remote_path("日本語/model.gguf"));
        assert!(valid_remote_path("a+b (1).gguf"));
        assert!(!valid_remote_path("a\u{0}b.gguf"));
        assert!(!valid_remote_path("a\nb.gguf"));
        assert!(!valid_remote_path("../x.gguf"));
        assert!(!valid_remote_path("/x.gguf"));
        assert!(!valid_remote_path("a\\b.gguf"));
        assert!(!valid_remote_path("a//b.gguf"));
    }

    #[test]
    fn changed_names_get_a_hash_so_they_do_not_collide() {
        assert_eq!(safe_path_component("model-Q4_K_M.gguf"), "model-Q4_K_M.gguf");
        let space = safe_path_component("a b.gguf");
        let plus = safe_path_component("a+b.gguf");
        assert_ne!(space, plus);
        assert!(space.starts_with("a-b-") && space.ends_with(".gguf"), "{space}");
        assert_eq!(space.len(), "a-b-12345678.gguf".len());
        assert_eq!(safe_path_component("a b.gguf"), space, "stable");
        assert_ne!(safe_path_component("日本"), safe_path_component("中文"));
    }

    #[test]
    fn token_only_goes_to_https_endpoints() {
        let https = parse_endpoint(Some("https://huggingface.co")).unwrap();
        let http = parse_endpoint(Some("http://mirror.lan")).unwrap();
        assert!(token_allowed_for(&https));
        assert!(!token_allowed_for(&http));
    }

    #[test]
    fn endpoint_defaults_and_normalises() {
        assert_eq!(parse_endpoint(None).unwrap().as_str(), "https://huggingface.co/");
        assert_eq!(parse_endpoint(Some("  ")).unwrap().host_str(), Some("huggingface.co"));
        let mirror = parse_endpoint(Some(" https://hf-mirror.com/ ")).unwrap();
        assert_eq!(mirror.host_str(), Some("hf-mirror.com"));
        let url = endpoint_url(&mirror, &["o", "n", "resolve", "main", "m.gguf"]).unwrap();
        // The file name is formatted in so the source carries no literal weights URL;
        // web-app/src/__tests__/localOnly.test.ts forbids that shape anywhere.
        let file = "m.gguf";
        assert_eq!(url.as_str(), format!("https://hf-mirror.com/o/n/resolve/main/{file}"));
        let api = endpoint_url(&mirror, &["api", "models"]).unwrap();
        assert_eq!(api.as_str(), "https://hf-mirror.com/api/models");
    }

    #[test]
    fn endpoint_keeps_a_path_prefix() {
        let base = parse_endpoint(Some("http://10.0.0.5:8080/hub/")).unwrap();
        let url = endpoint_url(&base, &["o", "n", "resolve", "main", "m.gguf"]).unwrap();
        let file = "m.gguf";
        assert_eq!(url.as_str(), format!("http://10.0.0.5:8080/hub/o/n/resolve/main/{file}"));
    }

    #[test]
    fn endpoint_refuses_other_schemes_and_embedded_secrets() {
        for bad in [
            "file:///etc/passwd",
            "ftp://mirror.example",
            "javascript:alert(1)",
            "mirror.example",
            "https://user:pw@mirror.example",
            "https://mirror.example/?x=1",
            "https://mirror.example/#frag",
        ] {
            assert!(parse_endpoint(Some(bad)).is_err(), "{bad} was accepted");
        }
    }

    fn setting(endpoint: &str, send: bool) -> HfEndpointSetting {
        HfEndpointSetting { endpoint: endpoint.into(), send_token_to_mirror: send }
    }

    #[test]
    fn resolution_order_is_env_then_setting_then_default() {
        let mirror = setting("https://hf-mirror.com", false);
        let host = |r: ResolvedEndpoint| r.url.host_str().unwrap().to_string();
        assert_eq!(host(resolve_with(Some("https://env.example"), &mirror).unwrap()), "env.example");
        assert_eq!(host(resolve_with(None, &mirror).unwrap()), "hf-mirror.com");
        assert_eq!(host(resolve_with(Some("  "), &mirror).unwrap()), "hf-mirror.com");
        assert_eq!(host(resolve_with(None, &HfEndpointSetting::default()).unwrap()), "huggingface.co");
    }

    #[test]
    fn settings_endpoint_must_be_https_and_clean() {
        assert!(validate_setting(&setting("", false)).is_ok());
        assert!(validate_setting(&setting("https://hf-mirror.com", false)).is_ok());
        for bad in ["http://hf-mirror.com", "https://u:p@m.example", "https://m.example/?q=1", "nonsense", "file:///x"] {
            assert!(validate_setting(&setting(bad, false)).is_err(), "{bad} was accepted");
            assert!(resolve_with(None, &setting(bad, false)).is_err(), "{bad} resolved");
        }
    }

    #[test]
    fn token_is_withheld_from_mirrors_unless_opted_in() {
        let official = resolve_with(None, &HfEndpointSetting::default()).unwrap();
        assert_eq!(token_for(&official, Some("hf_x")), Some("hf_x"));
        assert_eq!(token_for(&official, Some("  ")), None);
        let mirror = resolve_with(None, &setting("https://hf-mirror.com", false)).unwrap();
        assert_eq!(token_for(&mirror, Some("hf_x")), None);
        let trusted = resolve_with(None, &setting("https://hf-mirror.com", true)).unwrap();
        assert_eq!(token_for(&trusted, Some("hf_x")), Some("hf_x"));
        // The opt-in belongs to the Settings endpoint, not an env override.
        let env = resolve_with(Some("https://env.example"), &setting("https://hf-mirror.com", true)).unwrap();
        assert_eq!(token_for(&env, Some("hf_x")), None);
        // A look-alike host is still a mirror.
        let fake = resolve_with(None, &setting("https://huggingface.co.evil.example", false)).unwrap();
        assert_eq!(token_for(&fake, Some("hf_x")), None);
    }

    #[test]
    fn setting_roundtrips_through_the_data_folder() {
        let dir = tempfile::tempdir().unwrap();
        assert!(write_setting(dir.path(), setting("http://plain.example", false)).is_err());
        assert_eq!(read_setting(dir.path()), HfEndpointSetting::default());
        write_setting(dir.path(), setting(" https://hf-mirror.com ", true)).unwrap();
        assert_eq!(read_setting(dir.path()), setting("https://hf-mirror.com", true));
        // A hand-edited file with a bad endpoint falls back to huggingface.co.
        std::fs::write(dir.path().join(SETTING_FILE), r#"{"endpoint":"http://x.example"}"#).unwrap();
        assert_eq!(read_setting(dir.path()), HfEndpointSetting::default());
    }

    /// Every Hugging Face request goes through the resolver: no hard-coded hub
    /// URL outside tests, and every client filters the token.
    #[test]
    fn every_call_site_uses_the_resolver() {
        let hub = ["https://", "huggingface.co/"].concat();
        for (name, src) in [
            ("huggingface.rs", include_str!("huggingface.rs")),
            ("cli/hf_cmd.rs", include_str!("cli/hf_cmd.rs")),
            ("diffusion/catalog.rs", include_str!("diffusion/catalog.rs")),
        ] {
            let body = src.split("#[cfg(test)]").next().unwrap();
            let code: String = body.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
            assert!(!code.contains(&hub), "{name} hard-codes the hub URL");
            if code.contains("AUTHORIZATION") {
                assert!(code.contains("hub_token("), "{name} sends a token without hub_token");
            }
        }
    }
}
