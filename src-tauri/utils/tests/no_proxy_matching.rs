use jan_utils::network::should_bypass_proxy_with_env;

fn bypass(url: &str, entry: &str) -> bool {
    should_bypass_proxy_with_env(url, &[entry.to_string()], &[])
}

#[test]
fn star_dot_does_not_match_notexample() {
    assert!(!bypass("http://notexample.com/", "*.example.com"));
    assert!(!bypass("http://notexample.com/", "example.com"));
}

#[test]
fn leading_dot_form_matches_subdomain() {
    assert!(bypass("http://api.example.com/", ".example.com"));
}

#[test]
fn case_insensitive_entry() {
    assert!(bypass("http://api.example.com/", "API.Example.COM"));
}

#[test]
fn bare_domain_matches_subdomain() {
    assert!(bypass("http://a.b.example.com/", "example.com"));
    assert!(bypass("http://example.com/", "example.com"));
}

#[test]
fn star_wildcard_keeps_apex_match() {
    assert!(bypass("http://example.com/", "*.example.com"));
}

#[test]
fn cidr_10_0_0_0_8_matches_10_1_2_3() {
    assert!(bypass("http://10.1.2.3/", "10.0.0.0/8"));
    assert!(!bypass("http://11.1.2.3/", "10.0.0.0/8"));
}

#[test]
fn port_entry_matches_only_that_port() {
    assert!(bypass("http://example.com:8080/", "example.com:8080"));
    assert!(!bypass("http://example.com:9090/", "example.com:8080"));
}

#[test]
fn star_matches_all() {
    assert!(bypass("http://anything.test/", "*"));
}
