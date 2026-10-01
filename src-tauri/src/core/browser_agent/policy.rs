//! Who the agent's browser may talk to.
//!
//! Pure decisions, no webview: this file answers "may the agent load / act on
//! this URL?" and is the only place that does. The same predicates run at every
//! hop (the navigation handler sees redirects), before every tool call (the
//! pane may have been moved by the user or by a redirect), and after a load.
//!
//! Layers, in order:
//! 1. the feature switch and the project/machine network switch;
//! 2. the target itself: http(s) only, no credentials in the URL, and no
//!    loopback / private / link-local / cloud-metadata address in any spelling
//!    (decimal, hex, octal, IPv4-mapped IPv6, NAT64, 6to4), unless the user
//!    saved a rule that says that address is fine;
//! 3. the project's and the machine's `deny_domains` / `allow_domains`
//!    (`tauri_plugin_agent_tools::tools::gate::NetworkPolicy`, the same lists
//!    the Rust gate applies to `web_fetch`);
//! 4. the user's saved domain rules (deny beats allow);
//! 5. grants made for this session or this visit;
//! 6. otherwise: ask the user, or refuse when nobody is there to ask.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use serde::{Deserialize, Serialize};
use url::{Host, Url};

pub use tauri_plugin_agent_tools::tools::gate::NetworkPolicy;

/// Longest URL the agent may open. Longer ones are query-string exfiltration or
/// a mistake, and either way they are not shown whole in a prompt.
pub const MAX_URL_LEN: usize = 2048;

/// Why a target is refused regardless of any domain rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Block {
    NotHttp,
    Credentials,
    NoHost,
    TooLong,
    /// A loopback, private, link-local, metadata or otherwise internal address
    /// or name. The text says which kind.
    Private(String),
}

impl Block {
    pub fn message(&self) -> String {
        match self {
            Block::NotHttp => "only http and https pages can be opened".into(),
            Block::Credentials => "a URL with a username or password in it is not opened".into(),
            Block::NoHost => "the URL has no host".into(),
            Block::TooLong => format!("the URL is longer than {MAX_URL_LEN} characters"),
            Block::Private(kind) => format!(
                "{kind} addresses are blocked for the agent's browser (they reach services on this machine or its network)"
            ),
        }
    }
}

// --- addresses ---------------------------------------------------------------

fn v4_block(ip: Ipv4Addr) -> Option<&'static str> {
    let o = ip.octets();
    if ip.is_loopback() {
        return Some("loopback");
    }
    if ip.is_unspecified() || o[0] == 0 {
        return Some("unspecified");
    }
    if ip.is_private() {
        return Some("private network");
    }
    if ip.is_link_local() {
        // 169.254.0.0/16 holds the cloud metadata endpoint (169.254.169.254).
        return Some("link-local / cloud metadata");
    }
    if o[0] == 100 && (o[1] & 0xC0) == 64 {
        // 100.64.0.0/10 shared address space; Alibaba's metadata is 100.100.100.200.
        return Some("carrier-grade NAT / cloud metadata");
    }
    if o[0] == 192 && o[1] == 0 && o[2] == 0 {
        return Some("reserved");
    }
    if o[0] == 198 && (o[1] & 0xFE) == 18 {
        return Some("benchmarking");
    }
    if ip.is_documentation() {
        return Some("documentation");
    }
    if ip.is_multicast() {
        return Some("multicast");
    }
    if o[0] >= 240 {
        return Some("reserved");
    }
    None
}

fn embedded_v4(segs: &[u16; 8]) -> Ipv4Addr {
    Ipv4Addr::new(
        (segs[6] >> 8) as u8,
        (segs[6] & 0xFF) as u8,
        (segs[7] >> 8) as u8,
        (segs[7] & 0xFF) as u8,
    )
}

fn v6_block(ip: Ipv6Addr) -> Option<&'static str> {
    if ip.is_loopback() {
        return Some("loopback");
    }
    if ip.is_unspecified() {
        return Some("unspecified");
    }
    let s = ip.segments();
    // IPv4-mapped (::ffff:a.b.c.d): judged as the IPv4 address it carries.
    if s[..5] == [0; 5] && s[5] == 0xFFFF {
        return v4_block(embedded_v4(&s));
    }
    // IPv4-compatible (::a.b.c.d, deprecated) and NAT64 (64:ff9b::/96).
    if s[..6] == [0; 6] {
        return Some(v4_block(embedded_v4(&s)).unwrap_or("IPv4-compatible"));
    }
    if s[0] == 0x0064 && s[1] == 0xFF9B && s[2..6] == [0; 4] {
        return Some(v4_block(embedded_v4(&s)).unwrap_or("NAT64"));
    }
    if s[0] == 0x0064 && s[1] == 0xFF9B && s[2] == 1 {
        return Some("NAT64");
    }
    // 6to4 (2002::/16) embeds the IPv4 address in bits 16..48.
    if s[0] == 0x2002 {
        let v4 = Ipv4Addr::new((s[1] >> 8) as u8, (s[1] & 0xFF) as u8, (s[2] >> 8) as u8, (s[2] & 0xFF) as u8);
        return Some(v4_block(v4).unwrap_or("6to4"));
    }
    // Teredo (2001::/32) tunnels to arbitrary IPv4 hosts.
    if s[0] == 0x2001 && s[1] == 0 {
        return Some("Teredo");
    }
    if s[0] == 0x2001 && s[1] == 0x0DB8 {
        return Some("documentation");
    }
    if (s[0] & 0xFE00) == 0xFC00 {
        // fc00::/7 unique local; fd00:ec2::254 (AWS metadata) is inside it.
        return Some("unique local / cloud metadata");
    }
    if (s[0] & 0xFFC0) == 0xFE80 {
        return Some("link-local");
    }
    if (s[0] & 0xFFC0) == 0xFEC0 {
        return Some("site-local");
    }
    if (s[0] & 0xFF00) == 0xFF00 {
        return Some("multicast");
    }
    None
}

/// Why an address may not be dialled, if it may not. Used for literal hosts and
/// for what a name resolves to.
pub fn addr_block(ip: IpAddr) -> Option<&'static str> {
    match ip {
        IpAddr::V4(v4) => v4_block(v4),
        IpAddr::V6(v6) => v6_block(v6),
    }
}

/// Names that are internal by construction, whatever DNS says today.
fn name_block(domain: &str) -> Option<&'static str> {
    const SUFFIXES: &[(&str, &str)] = &[
        (".localhost", "loopback"),
        (".local", "local network"),
        (".localdomain", "local network"),
        (".internal", "internal"),
        (".lan", "local network"),
        (".home.arpa", "local network"),
        (".intranet", "internal"),
        (".corp", "internal"),
        (".home", "local network"),
    ];
    if domain == "localhost" {
        return Some("loopback");
    }
    for (suffix, kind) in SUFFIXES {
        if domain.ends_with(suffix) {
            return Some(kind);
        }
    }
    if !domain.contains('.') {
        // `intranet`, `router`, `metadata`: single-label names resolve through
        // the machine's search domains to something on its own network.
        return Some("single-label host");
    }
    None
}

/// The lower-cased host of a URL as rules compare it: no brackets around an
/// IPv6 address, no trailing dot, IDN in its punycode form (the `url` crate
/// already normalizes decimal / hex / octal IPv4 spellings to dotted quads).
pub fn host_key(url: &Url) -> Option<String> {
    Some(match url.host()? {
        Host::Domain(d) => d.trim_end_matches('.').to_ascii_lowercase(),
        Host::Ipv4(ip) => ip.to_string(),
        Host::Ipv6(ip) => ip.to_string(),
    })
}

/// Whether the URL itself may never be loaded by the agent's browser.
/// `private_ok` is the user's explicit "this local address is fine" rule.
pub fn target_block(url: &Url, private_ok: bool) -> Option<Block> {
    if !matches!(url.scheme(), "http" | "https") {
        return Some(Block::NotHttp);
    }
    if url.as_str().len() > MAX_URL_LEN {
        return Some(Block::TooLong);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Some(Block::Credentials);
    }
    let Some(host) = url.host() else {
        return Some(Block::NoHost);
    };
    if private_ok {
        return None;
    }
    let kind = match host {
        Host::Domain(d) => name_block(d.trim_end_matches('.').to_ascii_lowercase().as_str()),
        Host::Ipv4(ip) => v4_block(ip),
        Host::Ipv6(ip) => v6_block(ip),
    };
    kind.map(|k| Block::Private(k.to_string()))
}

/// Resolve `host` and refuse it when any answer is an internal address. DNS
/// can be pointed at 127.0.0.1 by anyone who owns a domain, so the name alone
/// is not enough. Returns the kind of address found.
pub async fn resolved_block(host: &str, port: u16) -> Option<String> {
    use std::time::Duration;
    let target = if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") };
    let answers = tokio::time::timeout(Duration::from_secs(5), tokio::net::lookup_host(target)).await;
    let Ok(Ok(addrs)) = answers else {
        // A name that does not resolve loads nothing; the page load reports it.
        return None;
    };
    for addr in addrs {
        if let Some(kind) = addr_block(addr.ip()) {
            return Some(format!("{host} resolves to a {kind} address ({})", addr.ip()));
        }
    }
    None
}

// --- rules -------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Allow,
    Deny,
}

/// One saved rule. `pattern` is `example.com` (that host only) or
/// `*.example.com` (any subdomain, not the bare domain).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DomainRule {
    pub pattern: String,
    pub verdict: Verdict,
    /// Also lets this host be a loopback / private address (a dev server the
    /// user wants the agent to test). Only meaningful for `allow`.
    #[serde(default)]
    pub private_ok: bool,
    /// Unix seconds.
    #[serde(default)]
    pub added_at: u64,
}

/// A rule pattern in the form rules are stored and matched in, or why it is not
/// acceptable.
pub fn normalize_pattern(raw: &str) -> Result<String, String> {
    let raw = raw.trim().to_ascii_lowercase();
    if raw.is_empty() {
        return Err("empty pattern".into());
    }
    if raw.contains("://") || raw.contains('/') || raw.contains('?') || raw.contains('#') || raw.contains('@') {
        return Err("a rule is a host name like example.com or *.example.com, not a URL".into());
    }
    let (wild, rest) = match raw.strip_prefix("*.") {
        Some(rest) => (true, rest),
        None => (false, raw.as_str()),
    };
    if rest.contains('*') {
        return Err("only a leading *. wildcard is supported".into());
    }
    let parsed = Url::parse(&format!("http://{rest}/")).map_err(|_| "not a valid host name".to_string())?;
    if parsed.port().is_some() {
        return Err("a rule covers a host, not a port".into());
    }
    let key = host_key(&parsed).ok_or_else(|| "not a valid host name".to_string())?;
    if wild {
        if !matches!(parsed.host(), Some(Host::Domain(_))) {
            return Err("a wildcard needs a domain name".into());
        }
        if !key.contains('.') {
            return Err("a wildcard over a whole top-level domain is too broad".into());
        }
        Ok(format!("*.{key}"))
    } else {
        Ok(key)
    }
}

/// Whether `pattern` (already normalized) covers `host` (a `host_key`).
pub fn pattern_matches(pattern: &str, host: &str) -> bool {
    match pattern.strip_prefix("*.") {
        Some(rest) => host.len() > rest.len() + 1 && host.ends_with(rest) && host.as_bytes()[host.len() - rest.len() - 1] == b'.',
        None => pattern == host,
    }
}

/// The saved rules, deny first.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuleSet {
    #[serde(default)]
    pub rules: Vec<DomainRule>,
}

impl RuleSet {
    pub fn verdict_for(&self, host: &str) -> Option<&DomainRule> {
        let mut allow = None;
        for r in &self.rules {
            if pattern_matches(&r.pattern, host) {
                if r.verdict == Verdict::Deny {
                    return Some(r);
                }
                allow = allow.or(Some(r));
            }
        }
        allow
    }

    /// Insert or replace the rule for a pattern.
    pub fn set(&mut self, rule: DomainRule) {
        self.rules.retain(|r| r.pattern != rule.pattern);
        self.rules.push(rule);
        self.rules.sort_by(|a, b| a.pattern.cmp(&b.pattern));
    }

    pub fn remove(&mut self, pattern: &str) -> bool {
        let before = self.rules.len();
        self.rules.retain(|r| r.pattern != pattern);
        self.rules.len() != before
    }
}

// --- the decision ------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DenyReason {
    FeatureOff,
    NetworkOff,
    Blocked(Block),
    ProjectDenied(String),
    ProjectNotAllowed(String),
    RuleDenied(String),
    /// Nobody is there to approve a first visit.
    Unattended(String),
}

impl DenyReason {
    pub fn message(&self) -> String {
        match self {
            DenyReason::FeatureOff => "the agent browser is turned off in Settings".into(),
            DenyReason::NetworkOff => "network access is turned off for this project".into(),
            DenyReason::Blocked(b) => b.message(),
            DenyReason::ProjectDenied(h) => format!("{h} is on this project's or the machine's blocked domain list"),
            DenyReason::ProjectNotAllowed(h) => format!("{h} is not on this project's allowed domain list"),
            DenyReason::RuleDenied(p) => format!("blocked by your saved rule for {p}"),
            DenyReason::Unattended(h) => format!(
                "{h} has not been approved, and this run has nobody to ask. Add it to the allowed domains first"
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allow,
    /// First visit: the user must choose. `host` is what a grant would cover.
    Ask { host: String },
    Deny(DenyReason),
}

/// Everything a decision depends on besides the URL.
pub struct Inputs<'a> {
    pub enabled: bool,
    pub network: &'a NetworkPolicy,
    pub rules: &'a RuleSet,
    /// Hosts approved for this app session or this visit.
    pub granted: &'a dyn Fn(&str) -> bool,
    /// No user is watching (auto mode, a scheduled run): never ask.
    pub unattended: bool,
}

pub fn decide(url: &Url, i: &Inputs) -> Decision {
    if !i.enabled {
        return Decision::Deny(DenyReason::FeatureOff);
    }
    if !i.network.allowed {
        return Decision::Deny(DenyReason::NetworkOff);
    }
    let host = match host_key(url) {
        Some(h) => h,
        None => return Decision::Deny(DenyReason::Blocked(target_block(url, false).unwrap_or(Block::NoHost))),
    };
    let rule = i.rules.verdict_for(&host);
    if let Some(r) = rule {
        if r.verdict == Verdict::Deny {
            return Decision::Deny(DenyReason::RuleDenied(r.pattern.clone()));
        }
    }
    let private_ok = rule.is_some_and(|r| r.verdict == Verdict::Allow && r.private_ok);
    if let Some(block) = target_block(url, private_ok) {
        return Decision::Deny(DenyReason::Blocked(block));
    }
    if i.network.deny_domains.iter().any(|d| covered_by(d, &host)) {
        return Decision::Deny(DenyReason::ProjectDenied(host));
    }
    let project_allow_preset = !i.network.allow_domains.is_empty();
    let project_allowed = project_allow_preset && i.network.allow_domains.iter().any(|d| covered_by(d, &host));
    if project_allow_preset && !project_allowed {
        return Decision::Deny(DenyReason::ProjectNotAllowed(host));
    }
    // A saved "always" rule or the project's preset list is the user having
    // decided in advance. A session or one-visit grant is not: those exist
    // because someone was watching.
    if project_allowed || rule.is_some() {
        return Decision::Allow;
    }
    if i.unattended {
        return Decision::Deny(DenyReason::Unattended(host));
    }
    if (i.granted)(&host) {
        return Decision::Allow;
    }
    Decision::Ask { host }
}

/// `NetworkPolicy`'s own matching: the name, or any domain under it.
fn covered_by(rule: &str, host: &str) -> bool {
    let rule = rule.trim().trim_start_matches("*.").trim_end_matches('.').to_ascii_lowercase();
    !rule.is_empty() && (host == rule || host.ends_with(&format!(".{rule}")))
}

// --- redirects ---------------------------------------------------------------

/// Whether a navigation hop (a redirect, a link, a script) may load while the
/// agent holds the pane. Only a hard refusal stops a hop: a first visit cannot
/// be approved from inside a navigation callback, and loading a page nobody
/// has read yet gives the agent nothing -- the next tool call on it asks. What
/// must never load is the same list `decide` refuses outright: an internal
/// address, a denied or off-list domain, anything with the feature or the
/// network switched off, and (for a run with nobody to ask) an unapproved host.
pub fn hop_allowed(url: &Url, i: &Inputs) -> bool {
    !matches!(decide(url, i), Decision::Deny(_))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    fn net() -> NetworkPolicy {
        NetworkPolicy::open()
    }

    fn run(url: &str, rules: &RuleSet, net: &NetworkPolicy, granted: &[&str], unattended: bool) -> Decision {
        let g = |h: &str| granted.contains(&h);
        decide(&u(url), &Inputs { enabled: true, network: net, rules, granted: &g, unattended })
    }

    fn rules(items: &[(&str, Verdict, bool)]) -> RuleSet {
        let mut r = RuleSet::default();
        for (p, v, pk) in items {
            r.set(DomainRule { pattern: normalize_pattern(p).unwrap(), verdict: *v, private_ok: *pk, added_at: 0 });
        }
        r
    }

    // --- addresses: every spelling of 127.0.0.1 and friends ---

    #[test]
    fn blocks_loopback_in_every_spelling() {
        for s in [
            "http://127.0.0.1/",
            "http://127.1/",
            "http://0x7f.0.0.1/",
            "http://0177.0.0.1/",
            "http://2130706433/",
            "http://017700000001/",
            "http://0x7f000001/",
            "http://[::1]/",
            "http://[0:0:0:0:0:0:0:1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[::ffff:7f00:1]/",
            "http://[::127.0.0.1]/",
            "http://[64:ff9b::7f00:1]/",
            "http://[2002:7f00:1::]/",
            "http://localhost/",
            "http://LOCALHOST./",
            "http://app.localhost/",
            "http://127.0.0.1.:8080/",
            "http://0.0.0.0/",
            "http://0/",
        ] {
            assert!(
                matches!(target_block(&u(s), false), Some(Block::Private(_))),
                "{s} must be blocked, got {:?}",
                target_block(&u(s), false)
            );
        }
    }

    #[test]
    fn blocks_private_link_local_and_metadata() {
        for s in [
            "http://10.0.0.1/",
            "http://172.16.0.1/",
            "http://172.31.255.255/",
            "http://192.168.1.1/",
            "http://169.254.169.254/latest/meta-data/",
            "http://2852039166/", // 169.254.169.254 as a decimal
            "http://0xa9fea9fe/",
            "http://100.100.100.200/", // Alibaba metadata, CGNAT range
            "http://100.64.0.1/",
            "http://[fe80::1]/",
            "http://[fd00:ec2::254]/", // AWS IPv6 metadata
            "http://[fc00::1]/",
            "http://[::ffff:169.254.169.254]/",
            "http://[::ffff:a9fe:a9fe]/",
            "http://[2002:a9fe:a9fe::1]/",
            "http://[64:ff9b::a9fe:a9fe]/",
            "http://metadata.google.internal/",
            "http://metadata/",
            "http://printer.local/",
            "http://router/",
            "http://nas.lan/",
            "http://224.0.0.1/",
            "http://255.255.255.255/",
            "http://[ff02::1]/",
            "http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/", // Teredo
        ] {
            assert!(
                matches!(target_block(&u(s), false), Some(Block::Private(_))),
                "{s} must be blocked, got {:?}",
                target_block(&u(s), false)
            );
        }
    }

    #[test]
    fn public_addresses_pass() {
        for s in [
            "https://example.com/",
            "https://sub.example.co.uk:8443/x?y=1",
            "http://93.184.216.34/",
            "http://[2606:2800:220:1:248:1893:25c8:1946]/",
            "http://172.32.0.1/",    // just outside 172.16/12
            "http://100.128.0.1/",   // just outside 100.64/10
            "http://[::ffff:8.8.8.8]/",
            "https://xn--bcher-kva.example/",
        ] {
            assert_eq!(target_block(&u(s), false), None, "{s}");
        }
    }

    #[test]
    fn lookalike_hosts_are_not_internal_by_accident() {
        // "internal" as a label inside a public name is fine; only the suffix counts.
        assert_eq!(target_block(&u("https://internal.example.com/"), false), None);
        assert_eq!(target_block(&u("https://localhost.example.com/"), false), None);
        assert_eq!(target_block(&u("https://notlocalhost.com/"), false), None);
    }

    #[test]
    fn userinfo_tricks_are_refused() {
        for s in [
            "https://user:pw@example.com/",
            "https://example.com@evil.test/",
            "http://trusted.com:80@127.0.0.1/",
        ] {
            assert!(target_block(&u(s), false).is_some(), "{s}");
        }
        // The host of the last one is what the browser connects to.
        assert_eq!(host_key(&u("http://trusted.com:80@127.0.0.1/")).unwrap(), "127.0.0.1");
    }

    #[test]
    fn non_http_schemes_and_long_urls_are_refused() {
        for s in ["file:///etc/passwd", "ftp://example.com/", "javascript:alert(1)", "data:text/html,x", "tauri://localhost/", "about:blank"] {
            assert!(target_block(&u(s), false).is_some(), "{s}");
        }
        let long = format!("https://example.com/?q={}", "a".repeat(MAX_URL_LEN));
        assert_eq!(target_block(&u(&long), false), Some(Block::TooLong));
    }

    #[test]
    fn private_ok_lifts_only_the_address_check() {
        assert_eq!(target_block(&u("http://localhost:5173/"), true), None);
        assert_eq!(target_block(&u("http://10.0.0.5/"), true), None);
        assert_eq!(target_block(&u("http://u:p@localhost/"), true), Some(Block::Credentials));
        assert_eq!(target_block(&u("file:///x"), true), Some(Block::NotHttp));
    }

    #[test]
    fn resolved_addresses_are_judged_like_literals() {
        for ip in ["127.0.0.1", "::1", "10.1.2.3", "169.254.169.254", "::ffff:10.0.0.1"] {
            assert!(addr_block(ip.parse().unwrap()).is_some(), "{ip}");
        }
        for ip in ["8.8.8.8", "2606:4700:4700::1111"] {
            assert!(addr_block(ip.parse().unwrap()).is_none(), "{ip}");
        }
    }

    #[tokio::test]
    async fn a_name_resolving_to_loopback_is_caught() {
        // `localhost` resolves without any network.
        let r = resolved_block("localhost", 80).await;
        assert!(r.is_some(), "{r:?}");
        assert!(r.unwrap().contains("loopback"));
    }

    // --- rules ---

    #[test]
    fn patterns_exact_and_wildcard() {
        assert!(pattern_matches("example.com", "example.com"));
        assert!(!pattern_matches("example.com", "www.example.com"));
        assert!(pattern_matches("*.example.com", "www.example.com"));
        assert!(pattern_matches("*.example.com", "a.b.example.com"));
        assert!(!pattern_matches("*.example.com", "example.com"));
        assert!(!pattern_matches("*.example.com", "badexample.com"));
        assert!(!pattern_matches("*.example.com", "evilexample.com"));
        assert!(!pattern_matches("*.example.com", "example.com.evil.test"));
        assert!(pattern_matches("127.0.0.1", "127.0.0.1"));
    }

    #[test]
    fn pattern_normalization() {
        assert_eq!(normalize_pattern(" Example.COM. ").unwrap(), "example.com");
        assert_eq!(normalize_pattern("*.Example.com").unwrap(), "*.example.com");
        assert_eq!(normalize_pattern("bücher.example").unwrap(), "xn--bcher-kva.example");
        assert_eq!(normalize_pattern("[::1]").unwrap(), "::1");
        for bad in ["", "*", "*.com", "https://example.com", "example.com/path", "a*b.com", "*.*.com", "user@example.com", "example.com:8080", "*.127.0.0.1"] {
            assert!(normalize_pattern(bad).is_err(), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn deny_beats_allow() {
        let r = rules(&[("*.example.com", Verdict::Allow, false), ("evil.example.com", Verdict::Deny, false)]);
        assert_eq!(r.verdict_for("evil.example.com").unwrap().verdict, Verdict::Deny);
        assert_eq!(r.verdict_for("docs.example.com").unwrap().verdict, Verdict::Allow);
        assert!(r.verdict_for("example.com").is_none());
    }

    #[test]
    fn set_replaces_and_remove_removes() {
        let mut r = rules(&[("a.com", Verdict::Allow, false)]);
        r.set(DomainRule { pattern: "a.com".into(), verdict: Verdict::Deny, private_ok: false, added_at: 1 });
        assert_eq!(r.rules.len(), 1);
        assert_eq!(r.rules[0].verdict, Verdict::Deny);
        assert!(r.remove("a.com"));
        assert!(!r.remove("a.com"));
    }

    // --- the decision ---

    #[test]
    fn first_visit_asks_then_a_grant_allows() {
        let r = RuleSet::default();
        assert_eq!(run("https://example.com/a", &r, &net(), &[], false), Decision::Ask { host: "example.com".into() });
        assert_eq!(run("https://example.com/a", &r, &net(), &["example.com"], false), Decision::Allow);
        // A grant for the apex is not a grant for a subdomain.
        assert_eq!(run("https://www.example.com/", &r, &net(), &["example.com"], false), Decision::Ask { host: "www.example.com".into() });
    }

    #[test]
    fn saved_rules_decide_without_asking() {
        let r = rules(&[("example.com", Verdict::Allow, false), ("*.shady.test", Verdict::Deny, false)]);
        assert_eq!(run("https://example.com/", &r, &net(), &[], false), Decision::Allow);
        assert!(matches!(run("https://a.shady.test/", &r, &net(), &["a.shady.test"], false), Decision::Deny(DenyReason::RuleDenied(_))));
    }

    #[test]
    fn a_private_address_is_denied_not_asked() {
        let r = RuleSet::default();
        assert!(matches!(run("http://127.0.0.1:3000/", &r, &net(), &["127.0.0.1"], false), Decision::Deny(DenyReason::Blocked(Block::Private(_)))));
        assert!(matches!(run("http://[::ffff:10.0.0.1]/", &r, &net(), &[], false), Decision::Deny(DenyReason::Blocked(_))));
    }

    #[test]
    fn an_explicit_private_allow_rule_lets_a_dev_server_through() {
        let r = rules(&[("localhost", Verdict::Allow, true)]);
        // `localhost` is itself a private name: only the private_ok rule opens it.
        assert_eq!(run("http://localhost:5173/", &r, &net(), &[], false), Decision::Allow);
        // Not 127.0.0.1, which has no rule.
        assert!(matches!(run("http://127.0.0.1:5173/", &r, &net(), &[], false), Decision::Deny(_)));
        // And an allow rule without private_ok does not open it.
        let r2 = rules(&[("localhost", Verdict::Allow, false)]);
        assert!(matches!(run("http://localhost:5173/", &r2, &net(), &[], false), Decision::Deny(DenyReason::Blocked(_))));
    }

    #[test]
    fn network_switch_and_feature_switch() {
        let r = rules(&[("example.com", Verdict::Allow, false)]);
        let off = NetworkPolicy { allowed: false, allow_domains: vec![], deny_domains: vec![] };
        assert_eq!(run("https://example.com/", &r, &off, &[], false), Decision::Deny(DenyReason::NetworkOff));
        let g = |_: &str| true;
        let d = decide(&u("https://example.com/"), &Inputs { enabled: false, network: &net(), rules: &r, granted: &g, unattended: false });
        assert_eq!(d, Decision::Deny(DenyReason::FeatureOff));
    }

    #[test]
    fn project_lists_apply_and_deny_wins() {
        let n = NetworkPolicy { allowed: true, allow_domains: vec!["docs.rs".into()], deny_domains: vec!["static.docs.rs".into()] };
        let r = RuleSet::default();
        // On the project's allow list: no prompt (the user already decided).
        assert_eq!(run("https://docs.rs/x", &r, &n, &[], false), Decision::Allow);
        assert_eq!(run("https://api.docs.rs/x", &r, &n, &[], false), Decision::Allow);
        // Deny list beats the allow list.
        assert!(matches!(run("https://static.docs.rs/", &r, &n, &[], false), Decision::Deny(DenyReason::ProjectDenied(_))));
        // Off the list: a saved allow rule cannot widen the project's list.
        let wide = rules(&[("example.com", Verdict::Allow, false)]);
        assert!(matches!(run("https://example.com/", &wide, &n, &["example.com"], false), Decision::Deny(DenyReason::ProjectNotAllowed(_))));
        // Lookalike is not covered.
        assert!(matches!(run("https://notdocs.rs/", &r, &n, &[], false), Decision::Deny(DenyReason::ProjectNotAllowed(_))));
    }

    #[test]
    fn deny_domains_cover_subdomains() {
        let n = NetworkPolicy { allowed: true, allow_domains: vec![], deny_domains: vec!["pastebin.com".into()] };
        let r = RuleSet::default();
        assert!(matches!(run("https://pastebin.com/x", &r, &n, &[], false), Decision::Deny(DenyReason::ProjectDenied(_))));
        assert!(matches!(run("https://www.pastebin.com/x", &r, &n, &[], false), Decision::Deny(DenyReason::ProjectDenied(_))));
        assert!(matches!(run("https://notpastebin.com/x", &r, &n, &[], false), Decision::Ask { .. }));
    }

    #[test]
    fn unattended_runs_never_ask_and_session_grants_do_not_count() {
        let r = RuleSet::default();
        assert!(matches!(run("https://example.com/", &r, &net(), &[], true), Decision::Deny(DenyReason::Unattended(_))));
        // A session grant was made by a watcher; it does not authorize an unattended run.
        assert!(matches!(run("https://example.com/", &r, &net(), &["example.com"], true), Decision::Deny(DenyReason::Unattended(_))));
        // A saved always-rule or the project's preset list does.
        let saved = rules(&[("example.com", Verdict::Allow, false)]);
        assert_eq!(run("https://example.com/", &saved, &net(), &[], true), Decision::Allow);
        let preset = NetworkPolicy { allowed: true, allow_domains: vec!["example.com".into()], deny_domains: vec![] };
        assert_eq!(run("https://example.com/", &r, &preset, &[], true), Decision::Allow);
    }

    #[test]
    fn redirect_hops_are_judged_like_any_url() {
        let r = rules(&[("example.com", Verdict::Allow, false)]);
        let g = |_: &str| false;
        let i = Inputs { enabled: true, network: &net(), rules: &r, granted: &g, unattended: false };
        assert!(hop_allowed(&u("https://example.com/next"), &i));
        // A redirect to a metadata address, a loopback one, or a file never loads.
        assert!(!hop_allowed(&u("http://169.254.169.254/latest/"), &i));
        assert!(!hop_allowed(&u("http://[::ffff:a9fe:a9fe]/"), &i));
        assert!(!hop_allowed(&u("http://2130706433/"), &i));
        assert!(!hop_allowed(&u("file:///etc/passwd"), &i));
        assert!(!hop_allowed(&u("https://user@example.com/"), &i));
        // A site nobody has approved yet may load (the next tool call asks)...
        assert!(hop_allowed(&u("https://other.test/"), &i));
        // ...unless nobody is there to ask.
        let unattended = Inputs { unattended: true, ..i };
        assert!(!hop_allowed(&u("https://other.test/"), &unattended));
        assert!(hop_allowed(&u("https://example.com/next"), &unattended));
        // A project allow list turns every off-list hop into a refusal.
        let listed = NetworkPolicy { allowed: true, allow_domains: vec!["example.com".into()], deny_domains: vec![] };
        let g2 = |_: &str| false;
        let strict = Inputs { enabled: true, network: &listed, rules: &r, granted: &g2, unattended: false };
        assert!(!hop_allowed(&u("https://example.com.evil.test/"), &strict));
        assert!(hop_allowed(&u("https://cdn.example.com/"), &strict));
    }
}
