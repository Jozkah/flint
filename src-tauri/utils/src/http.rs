/// Extracts the host (with port if present) from an Origin header value.
pub fn extract_host_from_origin(origin: &str) -> String {
    // Origin format: scheme "://" host [ ":" port ]
    if let Some(after_scheme) = origin.split("://").nth(1) {
        // Take everything up to the first '/' (path), if any
        after_scheme.split('/').next().unwrap_or(after_scheme).to_string()
    } else {
        origin.to_string()
    }
}

/// Checks if header name is a CORS-related header
pub fn is_cors_header(header_name: &str) -> bool {
    let header_lower = header_name.to_lowercase();
    header_lower.starts_with("access-control-")
}

/// Whether `ip` is assigned to one of this machine's own network interfaces
/// (a public or CGNAT address such as a Tailscale 100.x one, which the
/// private-range check does not cover). A UDP bind only succeeds on an address
/// the host owns, so it answers this without enumerating interfaces. Wildcard,
/// multicast and broadcast addresses are refused up front because some
/// platforms let a socket bind to them.
fn is_local_interface_ip(ip: std::net::IpAddr) -> bool {
    let bindable = match ip {
        std::net::IpAddr::V4(v4) => {
            !(v4.is_unspecified() || v4.is_multicast() || v4.is_broadcast())
        }
        std::net::IpAddr::V6(v6) => !(v6.is_unspecified() || v6.is_multicast()),
    };
    bindable && std::net::UdpSocket::bind((ip, 0)).is_ok()
}

/// Validates if host is in trusted hosts list
pub fn is_valid_host(host: &str, trusted_hosts: &[Vec<String>]) -> bool {
    if trusted_hosts.iter().any(|hosts| hosts.contains(&"*".to_string())) {
        return true;
    }

    if host.is_empty() {
        return false;
    }

    let host_without_port = if host.starts_with('[') {
        host.split(']')
            .next()
            .unwrap_or(host)
            .trim_start_matches('[')
    } else {
        host.split(':').next().unwrap_or(host)
    };
    let default_valid_hosts = ["localhost", "127.0.0.1", "0.0.0.0", "host.docker.internal"];

    if default_valid_hosts
        .iter()
        .any(|&valid| host_without_port.to_lowercase() == valid.to_lowercase())
    {
        return true;
    }

    // Accept a Host that is a literal loopback or private-range IP. This covers LAN
    // clients hitting a 0.0.0.0-bound server via http://192.168.x.x:port without
    // wildcarding the allowlist. DNS rebinding sends an attacker *hostname* in Host,
    // not an IP, so this does not reopen that hole.
    // ponytail: IPv4 private/link-local + any loopback; add IPv6 ULA (fc00::/7) if a
    // user reports it, since Ipv6Addr::is_unique_local is still unstable in std.
    if let Ok(ip) = host_without_port.parse::<std::net::IpAddr>() {
        let private = match ip {
            std::net::IpAddr::V4(v4) => v4.is_private() || v4.is_link_local(),
            std::net::IpAddr::V6(_) => false,
        };
        if ip.is_loopback() || private || is_local_interface_ip(ip) {
            return true;
        }
    }

    trusted_hosts.iter().flatten().any(|valid| {
        // A user may enter a full origin (chrome-extension://<id>,
        // http://host:3000); compare on the host part, as `host` is (#155).
        let valid = extract_host_from_origin(valid.trim());
        let valid = valid.as_str();
        let host_lower = host.to_lowercase();
        let valid_lower = valid.to_lowercase();

        if host_lower == valid_lower {
            return true;
        }

        let valid_without_port = if valid.starts_with('[') {
            valid
                .split(']')
                .next()
                .unwrap_or(valid)
                .trim_start_matches('[')
        } else {
            valid.split(':').next().unwrap_or(valid)
        };

        host_without_port.to_lowercase() == valid_without_port.to_lowercase()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Scenario A from GHSA-x6p8-7cp8-c3p6: default bind, empty allowlist stays safe.
    #[test]
    fn default_empty_allowlist_is_safe() {
        let trusted: Vec<Vec<String>> = vec![vec![]];
        assert!(is_valid_host("127.0.0.1:1337", &trusted));
        assert!(!is_valid_host("evil-rebind.attacker.com", &trusted));
        // CORS path: origin host of https://evil.com must not be trusted.
        assert!(!is_valid_host(
            &extract_host_from_origin("https://evil.com"),
            &trusted
        ));
    }

    // Scenario B: 0.0.0.0 bind must NOT wildcard. The user's allowlist is enforced;
    // attacker hostnames/origins are rejected, LAN IP literals are accepted.
    #[test]
    fn zero_bind_enforces_allowlist_no_wildcard() {
        let trusted = vec![vec!["myserver.local".to_string()]];
        assert!(is_valid_host("myserver.local", &trusted));
        assert!(!is_valid_host("attacker-controlled-rebind.com", &trusted));
        assert!(!is_valid_host("anything.evil", &trusted));
        assert!(!is_valid_host(
            &extract_host_from_origin("https://evil.com"),
            &trusted
        ));
        assert!(!is_valid_host(
            &extract_host_from_origin("http://malicious.example.org:8080"),
            &trusted
        ));
    }

    // LAN reachability preserved: private/loopback IP literals are accepted even
    // with an empty allowlist, so a 0.0.0.0 bind still serves LAN clients.
    #[test]
    fn private_and_loopback_ip_literals_accepted() {
        let trusted: Vec<Vec<String>> = vec![vec![]];
        assert!(is_valid_host("192.168.1.20:1337", &trusted));
        assert!(is_valid_host("10.0.0.5", &trusted));
        assert!(is_valid_host("172.16.4.4:8080", &trusted));
        assert!(is_valid_host("169.254.1.1", &trusted)); // link-local
        assert!(is_valid_host("[::1]:1337", &trusted)); // IPv6 loopback
        // A public IP literal is NOT auto-trusted.
        assert!(!is_valid_host("8.8.8.8:1337", &trusted));
    }

    // A full origin typed into the allowlist must match the origin's host part.
    #[test]
    fn full_origin_entry_matches_origin_host() {
        let trusted = vec![vec!["chrome-extension://abcdefghijklmnop".to_string()]];
        let host = extract_host_from_origin("chrome-extension://abcdefghijklmnop");
        assert!(is_valid_host(&host, &trusted));
        let other = extract_host_from_origin("chrome-extension://zzzz");
        assert!(!is_valid_host(&other, &trusted));
    }

    // The machine's own interface address is trusted even when it is not in a
    // private range (Swagger UI opened from the LAN/VPN address, #8216), but
    // an address that belongs to someone else, or a hostname, is not.
    #[test]
    fn own_interface_address_accepted_foreign_rejected() {
        let trusted: Vec<Vec<String>> = vec![vec![]];

        // Learn an address this machine owns without sending a packet.
        let own = std::net::UdpSocket::bind("0.0.0.0:0")
            .and_then(|s| s.connect("192.0.2.1:9").map(|_| s))
            .and_then(|s| s.local_addr())
            .ok()
            .map(|a| a.ip());
        if let Some(ip) = own {
            assert!(is_valid_host(&format!("{ip}:1337"), &trusted), "{ip}");
            assert!(is_valid_host(&ip.to_string(), &trusted), "{ip}");
        }

        // The probe itself: loopback is always an owned address.
        assert!(is_local_interface_ip("127.0.0.1".parse().unwrap()));
        assert!(!is_local_interface_ip("203.0.113.77".parse().unwrap()));

        // Public addresses that are not ours (documentation + DNS resolvers).
        assert!(!is_valid_host("203.0.113.77:1337", &trusted));
        assert!(!is_valid_host("198.51.100.9", &trusted));
        assert!(!is_valid_host("8.8.4.4", &trusted));
        assert!(!is_valid_host("[2001:db8::1]:1337", &trusted));
        // Hostnames never take this path, even ones that embed an IP.
        assert!(!is_valid_host("evil.example.com", &trusted));
        assert!(!is_valid_host("203.0.113.77.nip.io", &trusted));
        assert!(!is_valid_host("rebind.attacker.com:1337", &trusted));
        // Addresses a socket may bind to without them being interfaces.
        assert!(!is_valid_host("255.255.255.255", &trusted));
        assert!(!is_valid_host("224.0.0.1", &trusted));
        assert!(!is_valid_host("[::]:1337", &trusted));
        assert!(!is_valid_host("[ff02::1]", &trusted));
    }
}
