//! Address selection for provider endpoints.
//!
//! A short hostname like `v100` can resolve to more than one thing on a machine
//! with a DNS search domain: the correct private address on the tailnet, and a
//! public address that belongs to whatever `v100.<search-domain>` happens to
//! point at. The OS resolver returns both and the connector takes whichever came
//! first, so a request meant for a machine on the LAN can leave the network
//! entirely and come back as somebody else's 403.
//!
//! This module resolves the name itself, classifies every answer, and orders
//! them by how local they are. For a name that looks local, a public answer is
//! discarded outright rather than merely deprioritised -- reaching a stranger is
//! not a worse-but-acceptable outcome, it is the wrong machine.
//!
//! Nothing here rewrites a URL. The selection is handed to the connector as the
//! set of addresses to dial, so the hostname, port, `Host` header and TLS server
//! name are exactly what the user configured.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How long a successful resolution is reused. Short enough that a machine
/// coming up on the tailnet is picked up without a restart, long enough that a
/// streaming conversation does not re-resolve per request.
pub const CACHE_TTL: Duration = Duration::from_secs(30);

/// What kind of address an answer is. The order of the variants is the
/// preference order, closest first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum AddrClass {
    Loopback,
    /// Tailscale's CGNAT range, `100.64.0.0/10`.
    Tailscale,
    /// RFC1918 v4, plus IPv4 link-local.
    PrivateLan,
    /// IPv6 unique-local (`fc00::/7`) and link-local (`fe80::/10`).
    LocalV6,
    Public,
}

impl AddrClass {
    pub fn as_str(self) -> &'static str {
        match self {
            AddrClass::Loopback => "loopback",
            AddrClass::Tailscale => "tailscale",
            AddrClass::PrivateLan => "private-lan",
            AddrClass::LocalV6 => "local-ipv6",
            AddrClass::Public => "public",
        }
    }

    /// Everything that is not routable on the public internet.
    pub fn is_local(self) -> bool {
        self != AddrClass::Public
    }
}

pub fn classify(ip: IpAddr) -> AddrClass {
    match ip {
        IpAddr::V4(v4) => classify_v4(v4),
        IpAddr::V6(v6) => classify_v6(v6),
    }
}

fn classify_v4(v4: Ipv4Addr) -> AddrClass {
    if v4.is_loopback() {
        return AddrClass::Loopback;
    }
    let [a, b, ..] = v4.octets();
    // 100.64.0.0/10 -- shared address space, which is what Tailscale hands out.
    if a == 100 && (64..128).contains(&b) {
        return AddrClass::Tailscale;
    }
    if v4.is_private() || v4.is_link_local() {
        return AddrClass::PrivateLan;
    }
    AddrClass::Public
}

fn classify_v6(v6: Ipv6Addr) -> AddrClass {
    if v6.is_loopback() {
        return AddrClass::Loopback;
    }
    // An IPv4 address delivered over v6 is still that IPv4 address.
    if let Some(v4) = v6.to_ipv4_mapped() {
        return classify_v4(v4);
    }
    let first = v6.segments()[0];
    // fc00::/7 unique-local, fe80::/10 link-local.
    if (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80 {
        return AddrClass::LocalV6;
    }
    AddrClass::Public
}

/// Whether a configured host is one we should refuse to leave the network for.
///
/// A single-label name (`v100`) is the case that started this: it cannot be a
/// public name on its own, so anything public it resolves to arrived through a
/// search-domain collision. The private-use suffixes are included for the same
/// reason, and a literal private address obviously qualifies.
pub fn is_local_hostname(host: &str) -> bool {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return false;
    }
    if let Ok(ip) = host.trim_matches(|c| c == '[' || c == ']').parse::<IpAddr>() {
        return classify(ip).is_local();
    }
    if !host.contains('.') {
        return true;
    }
    const LOCAL_SUFFIXES: [&str; 6] = [
        ".local",
        ".internal",
        ".lan",
        ".home.arpa",
        ".ts.net",
        ".localhost",
    ];
    LOCAL_SUFFIXES.iter().any(|s| host.ends_with(s))
}

/// One answer from the resolver, with the judgement made about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub addr: SocketAddr,
    pub class: AddrClass,
    /// False when the address was dropped for being public on a local name.
    pub eligible: bool,
}

/// What was decided for one endpoint, in a form that can be shown to the user.
///
/// Carries no credentials: it is built from the hostname and the resolver's
/// answers, neither of which has ever seen a key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolution {
    pub host: String,
    pub port: u16,
    pub local_name: bool,
    pub candidates: Vec<Candidate>,
    /// Eligible addresses in dial order.
    pub order: Vec<SocketAddr>,
    pub suppressed_public: bool,
    /// Set once a request over this endpoint has actually reached a peer.
    pub responded: Option<SocketAddr>,
}

impl Resolution {
    pub fn selected(&self) -> Option<SocketAddr> {
        self.order.first().copied()
    }
}

/// The system resolver, or a stand-in.
///
/// Injected so the ordering rules can be tested against a machine that resolves
/// `v100` to a Cloudflare address without owning that machine.
pub trait DnsProbe: Send + Sync {
    fn lookup(&self, host: &str, port: u16) -> Result<Vec<SocketAddr>, String>;
}

/// `getaddrinfo`, which is what the rest of the app would have used anyway.
pub struct SystemDns;

impl DnsProbe for SystemDns {
    fn lookup(&self, host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
        (host, port)
            .to_socket_addrs()
            .map(|it| it.collect())
            .map_err(|e| e.to_string())
    }
}

/// Apply the preference rules to a set of answers.
pub fn decide(host: &str, port: u16, answers: Vec<SocketAddr>) -> Resolution {
    let local_name = is_local_hostname(host);
    let mut candidates: Vec<Candidate> = Vec::new();
    for addr in answers {
        // A name with both an A and a AAAA record often comes back twice
        // through different resolver paths.
        if candidates.iter().any(|c: &Candidate| c.addr == addr) {
            continue;
        }
        candidates.push(Candidate {
            addr,
            class: classify(addr.ip()),
            eligible: true,
        });
    }

    let has_local = candidates.iter().any(|c| c.class.is_local());
    let suppressed_public = local_name && has_local;
    if suppressed_public {
        for c in candidates.iter_mut() {
            if c.class == AddrClass::Public {
                c.eligible = false;
            }
        }
    }

    // Only reorder when the name is one we have an opinion about. An ordinary
    // public API hostname keeps whatever order the OS gave, which is where
    // Happy Eyeballs and the system's own address-selection policy live.
    let mut eligible: Vec<&Candidate> = candidates.iter().filter(|c| c.eligible).collect();
    if local_name {
        eligible.sort_by_key(|c| c.class);
    }
    let order = eligible.iter().map(|c| c.addr).collect();

    Resolution {
        host: host.to_string(),
        port,
        local_name,
        candidates,
        order,
        suppressed_public,
        responded: None,
    }
}

struct Entry {
    at: Instant,
    resolution: Resolution,
}

/// Resolutions, kept per host and port and thrown away readily.
#[derive(Default)]
pub struct ResolverCache {
    entries: Mutex<HashMap<(String, u16), Entry>>,
}

impl ResolverCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// The cached decision if it is still fresh, otherwise a new one.
    pub fn resolve(
        &self,
        probe: &dyn DnsProbe,
        host: &str,
        port: u16,
    ) -> Result<Resolution, String> {
        let key = (host.to_ascii_lowercase(), port);
        let cached = self.entries.lock().ok().and_then(|entries| {
            entries
                .get(&key)
                .filter(|e| e.at.elapsed() < CACHE_TTL)
                .map(|e| e.resolution.clone())
        });
        if let Some(hit) = cached {
            return Ok(hit);
        }

        let answers = probe.lookup(host, port)?;
        if answers.is_empty() {
            return Err(format!("{host} did not resolve to any address"));
        }
        let resolution = decide(host, port, answers);
        if resolution.order.is_empty() {
            // Every answer was suppressed. Cannot happen while suppression
            // requires a local candidate to exist, but say so rather than
            // handing the connector an empty list.
            return Err(format!(
                "{host} resolved only to public addresses, which are not used for a local endpoint"
            ));
        }
        if let Ok(mut entries) = self.entries.lock() {
            entries.insert(
                key,
                Entry {
                    at: Instant::now(),
                    resolution: resolution.clone(),
                },
            );
        }
        Ok(resolution)
    }

    /// The last decision made for an endpoint, without resolving.
    pub fn peek(&self, host: &str, port: u16) -> Option<Resolution> {
        let key = (host.to_ascii_lowercase(), port);
        self.entries
            .lock()
            .ok()
            .and_then(|e| e.get(&key).map(|e| e.resolution.clone()))
    }

    /// Record which address actually answered, for diagnostics.
    pub fn record_peer(&self, host: &str, port: u16, peer: SocketAddr) {
        let key = (host.to_ascii_lowercase(), port);
        if let Ok(mut entries) = self.entries.lock() {
            if let Some(entry) = entries.get_mut(&key) {
                entry.resolution.responded = Some(peer);
            }
        }
    }

    /// Drop one endpoint's decision: a transport failure, a provider edit, or
    /// an explicit refresh.
    pub fn invalidate(&self, host: &str, port: u16) {
        let key = (host.to_ascii_lowercase(), port);
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(&key);
        }
    }

    /// Drop everything: the network changed underneath us.
    pub fn invalidate_all(&self) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.clear();
        }
    }
}

/// The process-wide cache the production transport uses.
pub fn shared() -> &'static Arc<ResolverCache> {
    static SHARED: OnceLock<Arc<ResolverCache>> = OnceLock::new();
    SHARED.get_or_init(|| Arc::new(ResolverCache::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixed(Vec<SocketAddr>);
    impl DnsProbe for Fixed {
        fn lookup(&self, _host: &str, _port: u16) -> Result<Vec<SocketAddr>, String> {
            Ok(self.0.clone())
        }
    }

    fn sock(s: &str, port: u16) -> SocketAddr {
        SocketAddr::new(s.parse().unwrap(), port)
    }

    #[test]
    fn a_short_name_that_resolves_to_cloudflare_and_tailscale_takes_the_tailnet() {
        // The reported failure exactly: `v100` answers with a public Cloudflare
        // IPv6 address through a search-domain collision, and with the correct
        // Tailscale IPv4 address.
        let r = decide(
            "v100",
            8080,
            vec![
                sock("2606:4700:3033::6815:1b7f", 8080),
                sock("100.86.12.4", 8080),
            ],
        );
        assert_eq!(r.selected(), Some(sock("100.86.12.4", 8080)));
        assert!(r.suppressed_public);
        assert_eq!(r.order, vec![sock("100.86.12.4", 8080)]);
    }

    #[test]
    fn a_public_answer_is_never_dialled_when_a_local_one_exists() {
        let r = decide(
            "v100",
            8080,
            vec![sock("93.184.216.34", 8080), sock("192.168.1.9", 8080)],
        );
        assert!(!r.order.contains(&sock("93.184.216.34", 8080)));
        assert!(r
            .candidates
            .iter()
            .any(|c| c.addr.ip().to_string() == "93.184.216.34" && !c.eligible));
    }

    #[test]
    fn a_private_ipv6_answer_wins_over_a_public_ipv4_one() {
        let r = decide(
            "box.local",
            8080,
            vec![sock("93.184.216.34", 8080), sock("fd7a:115c:a1e0::1", 8080)],
        );
        assert_eq!(r.selected(), Some(sock("fd7a:115c:a1e0::1", 8080)));
    }

    #[test]
    fn loopback_outranks_every_other_local_answer() {
        let r = decide(
            "v100",
            8080,
            vec![
                sock("192.168.1.9", 8080),
                sock("100.86.12.4", 8080),
                sock("127.0.0.1", 8080),
            ],
        );
        assert_eq!(
            r.order,
            vec![
                sock("127.0.0.1", 8080),
                sock("100.86.12.4", 8080),
                sock("192.168.1.9", 8080),
            ]
        );
    }

    #[test]
    fn every_eligible_address_stays_in_the_dial_order_so_a_refusal_can_fall_through() {
        // Requirement: a connection refused on the first address must be
        // followed by the next eligible one, which means it has to be offered.
        let r = decide(
            "v100",
            8080,
            vec![sock("100.86.12.4", 8080), sock("192.168.1.9", 8080)],
        );
        assert_eq!(r.order.len(), 2);
    }

    #[test]
    fn an_ordinary_public_hostname_is_left_exactly_as_the_system_resolved_it() {
        let answers = vec![
            sock("2606:4700::6810:85e5", 443),
            sock("104.16.133.229", 443),
        ];
        let r = decide("api.openai.com", 443, answers.clone());
        assert!(!r.local_name);
        assert!(!r.suppressed_public);
        assert_eq!(r.order, answers);
    }

    #[test]
    fn a_public_name_with_no_local_answer_is_not_left_with_nothing_to_dial() {
        let r = decide("api.openai.com", 443, vec![sock("104.16.133.229", 443)]);
        assert_eq!(r.order, vec![sock("104.16.133.229", 443)]);
    }

    #[test]
    fn a_local_name_that_only_resolves_publicly_is_refused_rather_than_dialled() {
        // Nothing local came back, so there is no suppression -- but this is
        // the case worth watching, and the candidate list says what happened.
        let r = decide("v100", 8080, vec![sock("104.16.133.229", 8080)]);
        assert!(r.local_name);
        assert!(!r.suppressed_public);
        assert_eq!(r.candidates[0].class, AddrClass::Public);
    }

    #[test]
    fn classification_covers_the_ranges_the_ordering_depends_on() {
        assert_eq!(classify("127.0.0.1".parse().unwrap()), AddrClass::Loopback);
        assert_eq!(classify("::1".parse().unwrap()), AddrClass::Loopback);
        assert_eq!(classify("100.64.0.1".parse().unwrap()), AddrClass::Tailscale);
        assert_eq!(
            classify("100.127.255.254".parse().unwrap()),
            AddrClass::Tailscale
        );
        // Just outside the /10 on both sides.
        assert_eq!(
            classify("100.63.255.255".parse().unwrap()),
            AddrClass::Public
        );
        assert_eq!(classify("100.128.0.1".parse().unwrap()), AddrClass::Public);
        assert_eq!(classify("10.0.0.5".parse().unwrap()), AddrClass::PrivateLan);
        assert_eq!(classify("172.16.0.5".parse().unwrap()), AddrClass::PrivateLan);
        assert_eq!(classify("172.32.0.5".parse().unwrap()), AddrClass::Public);
        assert_eq!(
            classify("192.168.0.5".parse().unwrap()),
            AddrClass::PrivateLan
        );
        assert_eq!(classify("fd00::1".parse().unwrap()), AddrClass::LocalV6);
        assert_eq!(classify("fe80::1".parse().unwrap()), AddrClass::LocalV6);
        assert_eq!(classify("2606:4700::1".parse().unwrap()), AddrClass::Public);
        // A v4-mapped address is judged as the v4 address it carries.
        assert_eq!(
            classify("::ffff:192.168.1.1".parse().unwrap()),
            AddrClass::PrivateLan
        );
    }

    #[test]
    fn a_single_label_name_is_local_and_a_dotted_public_one_is_not() {
        assert!(is_local_hostname("v100"));
        assert!(is_local_hostname("V100."));
        assert!(is_local_hostname("box.local"));
        assert!(is_local_hostname("host.ts.net"));
        assert!(is_local_hostname("thing.home.arpa"));
        assert!(is_local_hostname("192.168.1.9"));
        assert!(is_local_hostname("100.86.12.4"));
        assert!(!is_local_hostname("api.openai.com"));
        assert!(!is_local_hostname("104.16.133.229"));
        assert!(!is_local_hostname(""));
    }

    #[test]
    fn a_resolution_is_reused_until_it_is_invalidated() {
        struct Counting(Mutex<usize>);
        impl DnsProbe for Counting {
            fn lookup(&self, _h: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
                *self.0.lock().unwrap() += 1;
                Ok(vec![SocketAddr::new("100.86.12.4".parse().unwrap(), port)])
            }
        }
        let probe = Counting(Mutex::new(0));
        let cache = ResolverCache::new();
        cache.resolve(&probe, "v100", 8080).unwrap();
        cache.resolve(&probe, "v100", 8080).unwrap();
        assert_eq!(*probe.0.lock().unwrap(), 1);

        // Scoped by port: a different port is a different endpoint.
        cache.resolve(&probe, "v100", 9090).unwrap();
        assert_eq!(*probe.0.lock().unwrap(), 2);

        cache.invalidate("v100", 8080);
        cache.resolve(&probe, "v100", 8080).unwrap();
        assert_eq!(*probe.0.lock().unwrap(), 3);

        cache.invalidate_all();
        cache.resolve(&probe, "v100", 9090).unwrap();
        assert_eq!(*probe.0.lock().unwrap(), 4);
    }

    #[test]
    fn the_case_of_a_hostname_does_not_split_the_cache() {
        let probe = Fixed(vec![sock("100.86.12.4", 8080)]);
        let cache = ResolverCache::new();
        cache.resolve(&probe, "V100", 8080).unwrap();
        assert!(cache.peek("v100", 8080).is_some());
    }

    #[test]
    fn a_name_with_no_answers_is_an_error_not_an_empty_dial_list() {
        let cache = ResolverCache::new();
        let err = cache.resolve(&Fixed(vec![]), "v100", 8080).unwrap_err();
        assert!(err.contains("did not resolve"), "{err}");
    }

    #[test]
    fn the_responding_peer_is_recorded_against_the_endpoint() {
        let probe = Fixed(vec![sock("100.86.12.4", 8080)]);
        let cache = ResolverCache::new();
        cache.resolve(&probe, "v100", 8080).unwrap();
        cache.record_peer("v100", 8080, sock("100.86.12.4", 8080));
        assert_eq!(
            cache.peek("v100", 8080).unwrap().responded,
            Some(sock("100.86.12.4", 8080))
        );
    }
}
