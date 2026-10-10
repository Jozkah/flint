//! The HTTPS proxy from Settings, applied to outbound clients.
//!
//! The settings page stores `proxyEnabled`, `proxyUrl`, `proxyUsername`,
//! `noProxy` (and, in the OS keyring, the password) under
//! [`DESKTOP_SETTINGS_KEY`]. Until this module nothing read them: only the CA
//! bundle path was honoured, so a typed proxy was silently ignored.
//!
//! * A client built through [`crate::core::net::tls::apply12`] / `apply13`
//!   gets the proxy added; callers that cache a client rebuild it when
//!   [`fingerprint`] changes.
//! * This machine is never proxied: `localhost`, `127.0.0.0/8` and `::1` go
//!   direct, so a local engine keeps working behind a corporate proxy.
//! * `noProxy` (comma separated, same wildcard rules as the rest of the app)
//!   and the `NO_PROXY` environment variable bypass the proxy.
//! * Clients that deliberately resolve names themselves to keep a public-only
//!   rule (the web-fetch client in the web search plugin) are not given the
//!   proxy: a proxy resolves the name on its side, which would bypass that
//!   rule.
//!
//! Desktop only: the CLI keeps reqwest's own `HTTPS_PROXY` / `NO_PROXY`
//! handling.

use std::hash::{Hash, Hasher};

use url::Url;

pub const DESKTOP_SETTINGS_KEY: &str = super::tls::DESKTOP_SETTINGS_KEY;
/// Keyring key the web app stores the proxy password under.
pub const PASSWORD_SECRET: &str = "proxy-password";

/// A proxy that is configured and usable.
#[derive(Clone, PartialEq, Eq)]
pub struct ProxySettings {
    /// The proxy's own URL, credentials in the userinfo.
    url: Url,
    no_proxy: Vec<String>,
}

impl std::fmt::Debug for ProxySettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print the credentials.
        f.debug_struct("ProxySettings")
            .field("host", &self.url.host_str())
            .field("port", &self.url.port_or_known_default())
            .field("no_proxy", &self.no_proxy)
            .finish()
    }
}

/// Whether `host` is this machine.
fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_matches(|c| c == '[' || c == ']');
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

impl ProxySettings {
    /// Read the stored settings blob (a Zustand `persist` object:
    /// `{"state": {...}, "version": 1}`). `password` is asked for only when a
    /// username is set. `None` when the proxy is off, empty or not a usable
    /// `http`/`https` URL.
    pub fn parse(stored: Option<&str>, password: impl FnOnce() -> Option<String>) -> Option<Self> {
        let value: serde_json::Value = serde_json::from_str(stored?).ok()?;
        let state = value.get("state")?;
        if state.get("proxyEnabled").and_then(|v| v.as_bool()) != Some(true) {
            return None;
        }
        let raw = state.get("proxyUrl")?.as_str()?.trim();
        if raw.is_empty() {
            return None;
        }
        // "proxy.corp:8080" is how people type it.
        let with_scheme = if raw.contains("://") { raw.to_string() } else { format!("http://{raw}") };
        let mut url = Url::parse(&with_scheme).ok()?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return None;
        }
        let user = state
            .get("proxyUsername")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|u| !u.is_empty());
        if let Some(user) = user {
            url.set_username(user).ok()?;
            if let Some(password) = password().filter(|p| !p.is_empty()) {
                url.set_password(Some(&password)).ok()?;
            }
        }
        let no_proxy = state
            .get("noProxy")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|e| !e.is_empty())
            .map(str::to_string)
            .collect();
        Some(Self { url, no_proxy })
    }

    /// The proxy to send a request for `target` through, or `None` to connect
    /// directly. `env_no_proxy` is the `NO_PROXY` list.
    pub fn proxy_for_with_env(&self, target: &Url, env_no_proxy: &[String]) -> Option<Url> {
        let host = target.host_str()?;
        if is_loopback_host(host) {
            return None;
        }
        if !matches!(target.scheme(), "http" | "https") {
            return None;
        }
        if jan_utils::network::should_bypass_proxy_with_env(target.as_str(), &self.no_proxy, env_no_proxy) {
            return None;
        }
        Some(self.url.clone())
    }

    pub fn proxy_for(&self, target: &Url) -> Option<Url> {
        let env = jan_utils::network::no_proxy_from(|n| std::env::var(n).ok());
        self.proxy_for_with_env(target, &env)
    }

    fn fingerprint(&self) -> u64 {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        self.url.as_str().hash(&mut h);
        self.no_proxy.hash(&mut h);
        h.finish() | 1
    }
}

/// The configured proxy, `None` when off or unusable. Reads the settings
/// store (in memory) and, only when a username is set, the keyring.
pub fn configured() -> Option<ProxySettings> {
    #[cfg(not(feature = "cli"))]
    {
        let stored = crate::core::app::settings_store::settings_get(DESKTOP_SETTINGS_KEY.to_string());
        ProxySettings::parse(stored.as_deref(), || {
            crate::core::server::provider_secrets::load_provider_keys(PASSWORD_SECRET)
                .into_iter()
                .next()
        })
    }
    #[cfg(feature = "cli")]
    {
        None
    }
}

/// A cheap key for "which proxy is in force", `0` for none.
pub fn fingerprint() -> u64 {
    configured().map_or(0, |p| p.fingerprint())
}

/// Add the configured proxy to a reqwest 0.12 client.
pub fn apply12(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    match configured() {
        Some(settings) => builder.proxy(reqwest::Proxy::custom(move |url| settings.proxy_for(url))),
        None => builder,
    }
}

/// Add the configured proxy to a reqwest 0.13 client.
pub fn apply13(builder: reqwest13::ClientBuilder) -> reqwest13::ClientBuilder {
    match configured() {
        Some(settings) => builder.proxy(reqwest13::Proxy::custom(move |url| settings.proxy_for(url))),
        None => builder,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(blob: &str, password: Option<&str>) -> Option<ProxySettings> {
        ProxySettings::parse(Some(blob), || password.map(str::to_string))
    }

    const ON: &str = r#"{"state":{"proxyEnabled":true,"proxyUrl":"http://proxy.corp:3128","noProxy":"intranet.corp, *.internal"},"version":1}"#;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn proxy_is_applied_to_a_public_url() {
        let p = settings(ON, None).unwrap();
        let via = p.proxy_for_with_env(&u("https://huggingface.co/resolve-check"), &[]).unwrap();
        assert_eq!(via.host_str(), Some("proxy.corp"));
        assert_eq!(via.port(), Some(3128));
    }

    #[test]
    fn loopback_is_never_proxied() {
        let p = settings(ON, None).unwrap();
        for url in [
            "http://127.0.0.1:8080/models",
            "http://localhost:8080/",
            "http://LOCALHOST/",
            "http://[::1]:9/",
            "http://127.9.9.9/",
        ] {
            assert_eq!(p.proxy_for_with_env(&u(url), &[]), None, "{url}");
        }
    }

    #[test]
    fn no_proxy_setting_and_env_bypass_the_proxy() {
        let p = settings(ON, None).unwrap();
        assert_eq!(p.proxy_for_with_env(&u("https://intranet.corp/x"), &[]), None);
        assert_eq!(p.proxy_for_with_env(&u("https://git.internal/x"), &[]), None);
        let env = vec!["models.example.com".to_string()];
        assert_eq!(p.proxy_for_with_env(&u("https://models.example.com/v1"), &env), None);
        assert!(p.proxy_for_with_env(&u("https://other.example.com/v1"), &env).is_some());
    }

    #[test]
    fn off_or_empty_or_bad_settings_give_no_proxy() {
        assert!(settings(r#"{"state":{"proxyEnabled":false,"proxyUrl":"http://p:1"}}"#, None).is_none());
        assert!(settings(r#"{"state":{"proxyEnabled":true,"proxyUrl":"  "}}"#, None).is_none());
        assert!(settings(r#"{"state":{"proxyEnabled":true,"proxyUrl":"ftp://p:1"}}"#, None).is_none());
        assert!(settings("not json", None).is_none());
        assert!(ProxySettings::parse(None, || None).is_none());
    }

    #[test]
    fn a_bare_host_gets_http_and_credentials_are_added() {
        let blob = r#"{"state":{"proxyEnabled":true,"proxyUrl":"proxy.corp:8080","proxyUsername":"al ice"},"version":1}"#;
        let p = settings(blob, Some("p@ss:word")).unwrap();
        let via = p.proxy_for_with_env(&u("https://example.com/"), &[]).unwrap();
        assert_eq!(via.scheme(), "http");
        assert_eq!(via.username(), "al%20ice");
        assert_eq!(via.password(), Some("p%40ss%3Aword"));
        // Credentials never reach Debug output.
        assert!(!format!("{p:?}").contains("p%40ss"));
    }

    #[test]
    fn the_password_is_not_read_without_a_username() {
        let blob = r#"{"state":{"proxyEnabled":true,"proxyUrl":"http://p:1"}}"#;
        let p = ProxySettings::parse(Some(blob), || panic!("keyring read without a username")).unwrap();
        assert_eq!(p.url.username(), "");
    }

    #[test]
    fn fingerprint_changes_with_the_proxy() {
        let a = settings(ON, None).unwrap();
        let b = settings(&ON.replace("3128", "3129"), None).unwrap();
        assert_ne!(a.fingerprint(), b.fingerprint());
        assert_ne!(a.fingerprint(), 0);
    }

    /// End to end: a client carrying the custom proxy sends a public-host
    /// request to the proxy, and a loopback request straight to its target.
    #[tokio::test]
    async fn a_client_routes_public_through_the_proxy_and_loopback_direct() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        async fn serve(listener: tokio::net::TcpListener, body: &'static str) -> String {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = sock.read(&mut buf).await.unwrap();
            let reply = format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            sock.write_all(reply.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&buf[..n]).to_string()
        }
        let proxy = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let direct = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_port = proxy.local_addr().unwrap().port();
        let direct_port = direct.local_addr().unwrap().port();
        let blob = format!(
            r#"{{"state":{{"proxyEnabled":true,"proxyUrl":"http://127.0.0.1:{proxy_port}"}}}}"#
        );
        // The proxy itself is on loopback, so loopback is bypassed for it only
        // through the settings; the client below is given the setting by hand.
        let s = ProxySettings::parse(Some(&blob), || None).unwrap();
        let client = reqwest::Client::builder()
            .no_proxy()
            .proxy(reqwest::Proxy::custom(move |url| s.proxy_for_with_env(url, &[])))
            .build()
            .unwrap();
        let p = tokio::spawn(serve(proxy, "via-proxy"));
        let body = client.get("http://models.example.test/x").send().await.unwrap().text().await.unwrap();
        assert_eq!(body, "via-proxy");
        let seen = p.await.unwrap();
        assert!(seen.starts_with("GET http://models.example.test/x"), "{seen}");

        let d = tokio::spawn(serve(direct, "direct"));
        let body = client
            .get(format!("http://127.0.0.1:{direct_port}/models"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(body, "direct");
        assert!(d.await.unwrap().starts_with("GET /models"));
    }
}
