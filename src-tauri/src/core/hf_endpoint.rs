//! Which Hugging Face hub the explicit model search and downloads talk to.
//! Compiled for both the desktop app and the CLI, so they share one rule.

use url::Url;

const DEFAULT_HF_ENDPOINT: &str = "https://huggingface.co";

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

/// The hub to talk to: `HF_ENDPOINT` when set, huggingface.co otherwise.
pub(crate) fn hf_endpoint() -> Result<Url, String> {
    parse_endpoint(std::env::var("HF_ENDPOINT").ok().as_deref())
}

/// `base` with `parts` appended as path segments.
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
    fn endpoint_defaults_and_normalises() {
        assert_eq!(parse_endpoint(None).unwrap().as_str(), "https://huggingface.co/");
        assert_eq!(parse_endpoint(Some("  ")).unwrap().host_str(), Some("huggingface.co"));
        let mirror = parse_endpoint(Some(" https://hf-mirror.com/ ")).unwrap();
        assert_eq!(mirror.host_str(), Some("hf-mirror.com"));
        let url = endpoint_url(&mirror, &["o", "n", "resolve", "main", "m.gguf"]).unwrap();
        assert_eq!(url.as_str(), "https://hf-mirror.com/o/n/resolve/main/m.gguf");
        let api = endpoint_url(&mirror, &["api", "models"]).unwrap();
        assert_eq!(api.as_str(), "https://hf-mirror.com/api/models");
    }

    #[test]
    fn endpoint_keeps_a_path_prefix() {
        let base = parse_endpoint(Some("http://10.0.0.5:8080/hub/")).unwrap();
        let url = endpoint_url(&base, &["o", "n", "resolve", "main", "m.gguf"]).unwrap();
        assert_eq!(url.as_str(), "http://10.0.0.5:8080/hub/o/n/resolve/main/m.gguf");
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
}
