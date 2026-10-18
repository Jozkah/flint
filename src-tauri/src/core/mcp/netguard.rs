//! Which hosts a remote MCP server may reach.
//!
//! Three rules, all on the HTTP transports (`http` / `sse`):
//!
//! * `[mcp] allow_hosts` in `agent.toml` limits the server URL to the listed
//!   hosts (`example.com`, or `*.example.com` for subdomains). Absent or empty
//!   is today's behaviour: any host. Read from the global agent config, like
//!   `allow_commands`, because MCP servers are configured for the whole app.
//! * A name whose DNS answer mixes public and private/loopback addresses is
//!   refused outright. Filtering the private ones out and dialling the rest is
//!   what a rebinding attack hopes for; the honest answer is "this name is not
//!   what it says".
//! * A redirect may not leave the host it started at, may not downgrade https
//!   to http, and may not land on a private or loopback address. The request's
//!   headers carry the server's credentials; they stay with the server.

use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::sync::Arc;

use url::{Host, Url};

use crate::core::net::resolver::classify;

/// Redirect hops followed at most.
const MAX_REDIRECTS: usize = 5;

fn norm(host: &str) -> String {
    host.trim()
        .trim_matches(|c| c == '[' || c == ']')
        .trim_end_matches('.')
        .to_ascii_lowercase()
}

/// `example.com` matches only itself; `*.example.com` matches any subdomain of
/// it but not `example.com` itself.
pub(crate) fn host_matches(pattern: &str, host: &str) -> bool {
    let (pattern, host) = (norm(pattern), norm(host));
    if pattern.is_empty() || host.is_empty() {
        return false;
    }
    match pattern.strip_prefix("*.") {
        Some(suffix) if !suffix.is_empty() => {
            host.len() > suffix.len() + 1 && host.ends_with(&format!(".{suffix}"))
        }
        _ => pattern == host,
    }
}

/// `Ok` when `allow` is empty or lists the URL's host; otherwise an error
/// naming the host and the list.
pub(crate) fn check_url(url: &str, allow: &[String]) -> Result<(), String> {
    let allowed: Vec<&str> = allow.iter().map(|a| a.trim()).filter(|a| !a.is_empty()).collect();
    if allowed.is_empty() {
        return Ok(());
    }
    let parsed = Url::parse(url).map_err(|e| {
        format!("MCP server URL {url:?} cannot be checked against agent.toml [mcp] allow_hosts ({e})")
    })?;
    let host = parsed.host_str().map(norm).unwrap_or_default();
    if allowed.iter().any(|p| host_matches(p, &host)) {
        return Ok(());
    }
    Err(format!(
        "MCP server host {host:?} is not allowed: agent.toml [mcp] allow_hosts only permits {}",
        allowed.join(", ")
    ))
}

/// The `[mcp].allow_hosts` list of the agent.toml text `raw`, read loosely so a
/// mistake in an unrelated section cannot switch the restriction off.
pub(crate) fn allow_hosts_from_toml(raw: &str) -> Vec<String> {
    let Ok(doc) = raw.parse::<toml::Value>() else {
        return Vec::new();
    };
    doc.get("mcp")
        .and_then(|m| m.get("allow_hosts"))
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// [`check_url`] against the allowlist in the agent.toml at `path`.
pub(crate) fn enforce_url_at(url: &str, path: &Path) -> Result<(), String> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Ok(());
    };
    // A restriction the user wrote but that cannot be read is a refusal, not a
    // quiet "anything goes".
    if raw.contains("allow_hosts") && raw.parse::<toml::Value>().is_err() {
        return Err(format!(
            "MCP server URL {url:?} cannot be checked: {} mentions allow_hosts but is not valid TOML",
            path.display()
        ));
    }
    check_url(url, &allow_hosts_from_toml(&raw)).map_err(|e| format!("{e} ({})", path.display()))
}

/// The launch-time check: the URL against the global agent.toml.
pub(crate) fn enforce_url(url: &str) -> Result<(), String> {
    enforce_url_at(url, &crate::core::agent::plugins::global_agent_toml_path())
}

/// Not routable on the public internet, in any spelling.
fn internal(ip: IpAddr) -> bool {
    let unspecified = match ip {
        IpAddr::V4(v4) => v4.is_unspecified() || v4.octets()[0] == 0,
        IpAddr::V6(v6) => v6.is_unspecified(),
    };
    unspecified || classify(ip).is_local()
}

/// An error when `answers` (what `host` resolved to) mixes public addresses
/// with private or loopback ones. A name that resolves wholly to one side is
/// not this function's business: a LAN server and a public server are both
/// ordinary.
pub(crate) fn mixed_answers_error(host: &str, answers: &[IpAddr]) -> Option<String> {
    let inner: Vec<&IpAddr> = answers.iter().filter(|ip| internal(**ip)).collect();
    if inner.is_empty() || inner.len() == answers.len() {
        return None;
    }
    Some(format!(
        "refused to connect to {host:?}: its DNS answer mixes public and private/loopback addresses ({}), \
         which is how a name is made to reach a machine it should not",
        inner.iter().map(|ip| ip.to_string()).collect::<Vec<_>>().join(", ")
    ))
}

/// Why a redirect from `first` (where the request started) to `to` is refused.
pub(crate) fn redirect_refusal(first: &Url, to: &Url, hops: usize) -> Option<String> {
    if hops > MAX_REDIRECTS {
        return Some("too many redirects".into());
    }
    let from_host = first.host_str().map(norm).unwrap_or_default();
    let to_host = to.host_str().map(norm).unwrap_or_default();
    if from_host != to_host {
        return Some(format!(
            "refused to follow a redirect from {from_host:?} to another host ({to_host:?}): \
             the server's credentials would have gone there too"
        ));
    }
    if first.scheme() == "https" && to.scheme() != "https" {
        return Some(format!("refused a redirect from https to {}", to.scheme()));
    }
    let literal = match to.host() {
        Some(Host::Ipv4(ip)) => Some(IpAddr::V4(ip)),
        Some(Host::Ipv6(ip)) => Some(IpAddr::V6(ip)),
        _ => None,
    };
    // Same host as the request began at, so a private target here means the
    // server itself was configured at a private address; a redirect may stay
    // there but never move into a different private range or name.
    if let Some(ip) = literal {
        let started = match first.host() {
            Some(Host::Ipv4(a)) => Some(IpAddr::V4(a)),
            Some(Host::Ipv6(a)) => Some(IpAddr::V6(a)),
            _ => None,
        };
        if internal(ip) && started != Some(ip) {
            return Some(format!("refused a redirect to the private address {ip}"));
        }
    }
    None
}

/// reqwest redirect policy applying [`redirect_refusal`].
pub(crate) fn redirect_policy13() -> reqwest13::redirect::Policy {
    reqwest13::redirect::Policy::custom(|attempt| {
        let hops = attempt.previous().len();
        let Some(first) = attempt.previous().first() else {
            return attempt.follow();
        };
        match redirect_refusal(first, attempt.url(), hops) {
            Some(why) => attempt.error(why),
            None => attempt.follow(),
        }
    })
}

/// A resolver that fails a lookup whose answer [`mixed_answers_error`] refuses.
pub(crate) struct GuardedResolver;

impl reqwest13::dns::Resolve for GuardedResolver {
    fn resolve(&self, name: reqwest13::dns::Name) -> reqwest13::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0))
                .await
                .map_err(|e| format!("could not resolve {host:?}: {e}"))?
                .collect();
            let ips: Vec<IpAddr> = addrs.iter().map(|a| a.ip()).collect();
            if let Some(why) = mixed_answers_error(&host, &ips) {
                return Err(why.into());
            }
            Ok(Box::new(addrs.into_iter()) as reqwest13::dns::Addrs)
        })
    }
}

/// `builder` with the redirect guard and the DNS guard attached.
pub(crate) fn guard13(builder: reqwest13::ClientBuilder) -> reqwest13::ClientBuilder {
    builder
        .redirect(redirect_policy13())
        .dns_resolver(Arc::new(GuardedResolver))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn a_host_outside_the_list_is_refused_with_the_list_in_the_message() {
        let allow = list(&["mcp.example.com", "*.corp.example"]);
        let err = check_url("https://evil.test/mcp", &allow).unwrap_err();
        assert!(err.contains("evil.test") && err.contains("allow_hosts"), "{err}");
        assert!(err.contains("mcp.example.com, *.corp.example"), "{err}");
        assert!(check_url("https://MCP.example.com./x", &allow).is_ok());
        assert!(check_url("https://a.b.corp.example/x", &allow).is_ok());
    }

    #[test]
    fn a_wildcard_does_not_match_the_bare_domain_or_a_lookalike() {
        assert!(!host_matches("*.example.com", "example.com"));
        assert!(!host_matches("*.example.com", "badexample.com"));
        assert!(!host_matches("*.example.com", "example.com.evil.test"));
        assert!(host_matches("*.example.com", "a.example.com"));
        assert!(!host_matches("*.", "a.b"));
    }

    #[test]
    fn an_unparseable_url_is_refused_when_a_list_exists_and_ignored_without_one() {
        assert!(check_url("not a url", &list(&["a.com"])).is_err());
        assert!(check_url("not a url", &[]).is_ok());
        assert!(check_url("https://x.test", &list(&["", "  "])).is_ok());
    }

    #[test]
    fn the_section_parses_and_a_broken_file_that_mentions_it_refuses() {
        assert_eq!(
            allow_hosts_from_toml("[mcp]\nallow_hosts = [\"a.com\", \" b.com \", \"\"]\nlater = 1\n"),
            ["a.com", "b.com"]
        );
        let dir = std::env::temp_dir().join(format!("flint_mcp_hosts_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("agent.toml");
        assert!(enforce_url_at("https://x.test", &file).is_ok(), "no file, no restriction");
        std::fs::write(&file, "[mcp]\nallow_hosts = [\"a.com\"\n").unwrap();
        let err = enforce_url_at("https://a.com", &file).unwrap_err();
        assert!(err.contains("not valid TOML"), "{err}");
        std::fs::write(&file, "[mcp]\nallow_hosts = [\"a.com\"]\n").unwrap();
        assert!(enforce_url_at("https://a.com/m", &file).is_ok());
        assert!(enforce_url_at("https://b.com/m", &file).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_typed_agent_toml_section_carries_allow_hosts() {
        let cfg: crate::core::agent::project::AgentToml =
            toml::from_str("[mcp]\nallow_hosts = [\"a.com\"]\nlater = 1\n").expect("parses");
        assert_eq!(cfg.mcp.allow_hosts, ["a.com"]);
    }

    #[test]
    fn mixed_public_and_private_answers_are_refused_not_filtered() {
        let err = mixed_answers_error("rebind.test", &[ip("93.184.216.34"), ip("127.0.0.1")]).unwrap();
        assert!(err.contains("rebind.test") && err.contains("127.0.0.1"), "{err}");
        for private in ["10.0.0.5", "192.168.1.9", "169.254.169.254", "100.64.1.1", "::1", "fd00::1", "::ffff:10.0.0.1", "0.0.0.0"] {
            assert!(
                mixed_answers_error("h", &[ip("93.184.216.34"), ip(private)]).is_some(),
                "{private}"
            );
        }
    }

    #[test]
    fn a_wholly_public_or_wholly_private_answer_is_left_alone() {
        assert!(mixed_answers_error("h", &[ip("93.184.216.34"), ip("2606:2800:220:1::1")]).is_none());
        assert!(mixed_answers_error("h", &[ip("10.0.0.5"), ip("127.0.0.1")]).is_none());
        assert!(mixed_answers_error("h", &[]).is_none());
    }

    #[test]
    fn a_redirect_to_another_host_is_refused() {
        let why = redirect_refusal(&url("https://mcp.a.test/x"), &url("https://mcp.b.test/x"), 1).unwrap();
        assert!(why.contains("another host") && why.contains("mcp.b.test"), "{why}");
        assert!(redirect_refusal(&url("https://mcp.a.test/x"), &url("https://MCP.a.test/y"), 1).is_none());
    }

    #[test]
    fn a_redirect_to_a_private_address_or_down_to_http_is_refused() {
        let from = url("https://mcp.a.test/x");
        assert!(redirect_refusal(&from, &url("http://mcp.a.test/x"), 1).unwrap().contains("https"));
        assert!(redirect_refusal(&from, &url("https://127.0.0.1/x"), 1).is_some());
        assert!(redirect_refusal(&from, &url("https://169.254.169.254/latest"), 1).is_some());
        // A server configured at a private literal may redirect within itself.
        assert!(redirect_refusal(&url("http://10.0.0.5/a"), &url("http://10.0.0.5/b"), 1).is_none());
        assert!(redirect_refusal(&url("http://10.0.0.5/a"), &url("http://10.0.0.6/b"), 1).is_some());
        assert!(redirect_refusal(&from, &from, MAX_REDIRECTS + 1).unwrap().contains("too many"));
    }

    #[tokio::test]
    async fn a_client_with_the_guard_refuses_a_cross_host_redirect_end_to_end() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf).await;
                let resp = "HTTP/1.1 302 Found\r\nLocation: http://localhost:9/other\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                let _ = s.write_all(resp.as_bytes()).await;
            }
        });
        let client = guard13(reqwest13::Client::builder()).build().unwrap();
        let err = client.get(format!("http://127.0.0.1:{port}/m")).send().await.unwrap_err();
        assert!(err.is_redirect(), "{err}");
        assert!(format!("{err:?}").contains("another host"), "{err:?}");
    }
}
