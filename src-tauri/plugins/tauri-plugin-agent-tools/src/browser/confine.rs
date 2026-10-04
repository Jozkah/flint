//! What a confined browser may load.
//!
//! Only the local origin being driven (and any other loopback origin the caller
//! explicitly lists) may be loaded:
//! - every request -- navigations, redirects, subresources, frames, workers
//!   (auto-attached) -- is paused through the DevTools `Fetch` domain and
//!   failed unless its origin is allowed (see `events`);
//! - underneath that, every connection -- including WebSockets, popups and
//!   service workers, which the interception does not see -- goes to a dead
//!   proxy, except to the exact `host:port` of an allowed origin. Chromium
//!   normally sends loopback traffic around a proxy; that implicit bypass is
//!   removed (`<-loopback>`), so another port on this machine is refused too.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::Path;

use url::{Host, Url};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origin {
    pub scheme: String,
    pub host: String,
    pub port: u16,
}

impl Origin {
    pub fn of(url: &Url) -> Option<Origin> {
        if !matches!(url.scheme(), "http" | "https") {
            return None;
        }
        Some(Origin {
            scheme: url.scheme().to_string(),
            host: url.host_str()?.to_ascii_lowercase(),
            port: url.port_or_known_default()?,
        })
    }

    pub fn serialize(&self) -> String {
        format!("{}://{}:{}", self.scheme, self.host, self.port)
    }

    /// `host:port` to open a TCP connection to (IPv6 unbracketed).
    pub fn socket_host(&self) -> String {
        self.host.trim_start_matches('[').trim_end_matches(']').to_string()
    }
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// The run's URL and origin, if it is an http(s) URL on this machine.
pub fn local_origin(raw: &str) -> Result<(Url, Origin), String> {
    let url = Url::parse(raw.trim()).map_err(|e| format!("not a URL: {e}"))?;
    let origin = Origin::of(&url).ok_or("only http and https pages can be verified")?;
    if !is_loopback(&url) {
        return Err(format!(
            "{} is not a local address; only an app running on this machine (localhost, 127.0.0.1, [::1]) can be verified",
            origin.serialize()
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("a URL with credentials in it is not verified".to_string());
    }
    Ok((url, origin))
}

/// What the browser may load.
#[derive(Debug, Clone)]
pub struct OriginPolicy {
    allowed: Vec<Origin>,
}

impl OriginPolicy {
    /// `primary` plus the extra origins, each of which must itself be local.
    pub fn new(primary: Origin, extra: &[String]) -> Result<Self, String> {
        let mut allowed = vec![primary];
        for raw in extra {
            let (_, o) = local_origin(raw)?;
            if !allowed.contains(&o) {
                allowed.push(o);
            }
        }
        Ok(OriginPolicy { allowed })
    }

    pub fn allowed(&self) -> &[Origin] {
        &self.allowed
    }

    /// Whether a request for `raw` may go ahead. Same origin means same
    /// scheme, host and port: `localhost` and `127.0.0.1` are different
    /// origins, as they are to the browser.
    pub fn permits(&self, raw: &str) -> bool {
        let Ok(url) = Url::parse(raw) else { return false };
        match url.scheme() {
            "http" | "https" => Origin::of(&url).is_some_and(|o| self.allowed.contains(&o)),
            "data" => true,
            "about" => url.path() == "blank" || url.path() == "srcdoc",
            "blob" => Url::parse(url.path()).ok().and_then(|u| Origin::of(&u))
                .is_some_and(|o| self.allowed.contains(&o)),
            "ws" | "wss" => {
                let scheme = if url.scheme() == "ws" { "http" } else { "https" };
                url.host_str().is_some_and(|h| {
                    self.allowed.contains(&Origin {
                        scheme: scheme.to_string(),
                        host: h.to_ascii_lowercase(),
                        port: url.port().unwrap_or(if scheme == "http" { 80 } else { 443 }),
                    })
                })
            }
            _ => false,
        }
    }
}

/// A URL as shown in evidence: no query or fragment (they can carry tokens),
/// and bounded.
pub fn display_url(raw: &str) -> String {
    let shown = match Url::parse(raw) {
        Ok(mut u) if u.scheme() != "data" => {
            u.set_query(None);
            u.set_fragment(None);
            let _ = u.set_password(None);
            let _ = u.set_username("");
            u.to_string()
        }
        Ok(_) => "data:…".to_string(),
        Err(_) => raw.to_string(),
    };
    shown.chars().take(200).collect()
}

/// Whether this process runs as root, where Chrome refuses to start with its
/// sandbox (a container, typically).
pub fn running_as_root() -> bool {
    #[cfg(unix)]
    {
        // SAFETY: geteuid has no preconditions and cannot fail.
        unsafe { libc::geteuid() == 0 }
    }
    #[cfg(not(unix))]
    {
        false
    }
}

/// The proxy bypass list: no implicit loopback bypass, then exactly the
/// allowed origins' `host:port` (any scheme, so the app's own `ws://` works).
pub fn proxy_bypass_list(allowed: &[Origin]) -> String {
    let mut rules = vec!["<-loopback>".to_string()];
    rules.extend(allowed.iter().map(|o| format!("{}:{}", o.host, o.port)));
    rules.join(";")
}

/// Arguments for a throwaway, confined, headless browser that may connect
/// only to `allowed`.
pub fn browser_args(profile: &Path, as_root: bool, allowed: &[Origin]) -> Vec<String> {
    let mut args: Vec<String> = [
        "--headless=new",
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-sync",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-domain-reliability",
        "--disable-client-side-phishing-detection",
        "--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication",
        "--metrics-recording-only",
        "--no-pings",
        "--password-store=basic",
        "--use-mock-keychain",
        "--mute-audio",
        "--window-size=1280,800",
        "--proxy-server=http://127.0.0.1:9",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    args.push(format!("--proxy-bypass-list={}", proxy_bypass_list(allowed)));
    args.push(format!("--user-data-dir={}", profile.display()));
    if as_root {
        args.push("--no-sandbox".to_string());
    }
    args.push("about:blank".to_string());
    args
}

/// Loopback addresses, for tests and the app-server watchdog.
pub fn loopback_ip(host: &str) -> Option<IpAddr> {
    match host {
        "localhost" => Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        "::1" | "[::1]" => Some(IpAddr::V6(Ipv6Addr::LOCALHOST)),
        other => other.parse().ok().filter(|ip: &IpAddr| ip.is_loopback()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_loopback_http_url_is_verified() {
        assert!(local_origin("http://localhost:5173/app").is_ok());
        assert!(local_origin("http://127.0.0.1:3000").is_ok());
        assert!(local_origin("http://[::1]:8080/").is_ok());
        assert!(local_origin("https://example.com").is_err());
        assert!(local_origin("http://192.168.1.10:3000").is_err());
        assert!(local_origin("http://localhost.evil.com:3000").is_err());
        assert!(local_origin("file:///etc/passwd").is_err());
        assert!(local_origin("http://user:pw@localhost:3000").is_err());
    }

    #[test]
    fn the_policy_is_the_exact_origin() {
        let (_, o) = local_origin("http://localhost:5173/").unwrap();
        let p = OriginPolicy::new(o, &[]).unwrap();
        assert!(p.permits("http://localhost:5173/assets/app.js?v=1"));
        assert!(p.permits("ws://localhost:5173/@vite/client"));
        assert!(p.permits("data:image/png;base64,AAAA"));
        assert!(p.permits("about:blank"));
        assert!(p.permits("blob:http://localhost:5173/0f7c"));
        assert!(!p.permits("http://localhost:5174/"));
        assert!(!p.permits("http://127.0.0.1:5173/"));
        assert!(!p.permits("https://localhost:5173/"));
        assert!(!p.permits("https://fonts.googleapis.com/css"));
        assert!(!p.permits("ws://localhost:9229/"));
        assert!(!p.permits("blob:https://evil.example/0f7c"));
        assert!(!p.permits("file:///etc/passwd"));
        assert!(!p.permits("chrome://settings"));
        assert!(!p.permits("not a url"));
    }

    #[test]
    fn extra_origins_must_be_local_and_are_then_allowed() {
        let (_, o) = local_origin("http://localhost:5173/").unwrap();
        let p = OriginPolicy::new(o.clone(), &["http://localhost:8787".into()]).unwrap();
        assert!(p.permits("http://localhost:8787/api"));
        assert!(OriginPolicy::new(o, &["https://api.example.com".into()]).is_err());
    }

    #[test]
    fn a_fresh_profile_and_a_dead_proxy_every_time() {
        let (_, o) = local_origin("http://localhost:5173/").unwrap();
        let (_, v6) = local_origin("http://[::1]:8080/").unwrap();
        let args = browser_args(Path::new("/tmp/flint-verify-x"), false, &[o.clone(), v6]);
        assert!(args.contains(&"--user-data-dir=/tmp/flint-verify-x".to_string()));
        assert!(args.contains(&"--proxy-server=http://127.0.0.1:9".to_string()));
        assert!(args.contains(&"--proxy-bypass-list=<-loopback>;localhost:5173;[::1]:8080".to_string()));
        assert!(args.contains(&"--disable-extensions".to_string()));
        assert!(!args.contains(&"--no-sandbox".to_string()));
        assert!(browser_args(Path::new("/p"), true, &[o]).contains(&"--no-sandbox".to_string()));
    }

    #[test]
    fn evidence_urls_drop_queries_and_credentials() {
        assert_eq!(
            display_url("http://localhost:3000/cb?token=abc#x"),
            "http://localhost:3000/cb"
        );
        assert_eq!(display_url("data:text/html,<script>"), "data:…");
    }
}
