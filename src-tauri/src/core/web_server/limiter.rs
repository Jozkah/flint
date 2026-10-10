//! Limits on failed sign-in attempts.
//!
//! A bad guess costs the guesser nothing but cannot succeed against a 256-bit
//! credential, so the limit is there to keep one noisy client from filling the
//! log and to slow a distributed attempt, not to protect the secret. It must
//! therefore not let one client lock everyone else out: attempts are counted
//! per client, with a much higher ceiling over all of them.

use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const WINDOW: Duration = Duration::from_secs(5 * 60);
const PER_CLIENT: usize = 10;
const OVERALL: usize = 300;
/// How many clients are remembered at once; a flood of distinct addresses
/// cannot grow the table without bound.
const MAX_CLIENTS: usize = 4096;

#[derive(Default)]
pub struct LoginLimiter {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    clients: HashMap<IpAddr, VecDeque<Instant>>,
    overall: VecDeque<Instant>,
}

fn prune(failures: &mut VecDeque<Instant>, now: Instant) {
    while failures.front().is_some_and(|at| now.duration_since(*at) > WINDOW) {
        failures.pop_front();
    }
}

impl LoginLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether `client` may try to sign in now.
    pub fn blocked(&self, client: IpAddr) -> bool {
        self.blocked_at(client, Instant::now())
    }

    fn blocked_at(&self, client: IpAddr, now: Instant) -> bool {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        prune(&mut inner.overall, now);
        if inner.overall.len() >= OVERALL {
            return true;
        }
        match inner.clients.get_mut(&client) {
            Some(failures) => {
                prune(failures, now);
                failures.len() >= PER_CLIENT
            }
            None => false,
        }
    }

    pub fn record_failure(&self, client: IpAddr) {
        self.record_failure_at(client, Instant::now());
    }

    fn record_failure_at(&self, client: IpAddr, now: Instant) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        prune(&mut inner.overall, now);
        inner.overall.push_back(now);
        if inner.clients.len() >= MAX_CLIENTS && !inner.clients.contains_key(&client) {
            inner.clients.retain(|_, failures| {
                prune(failures, now);
                !failures.is_empty()
            });
            if inner.clients.len() >= MAX_CLIENTS {
                // Still full of live entries: this client is counted only
                // against the overall ceiling.
                return;
            }
        }
        let failures = inner.clients.entry(client).or_default();
        prune(failures, now);
        failures.push_back(now);
    }
}

/// The address a request really comes from. Behind a proxy on this machine
/// (Tailscale Serve, Caddy) every connection arrives from loopback and the
/// proxy names the client in `X-Forwarded-For`; that header is believed only
/// from a loopback peer, since only a process on this machine can be one.
pub fn client_ip(peer: IpAddr, forwarded_for: Option<&str>) -> IpAddr {
    if peer.is_loopback() {
        if let Some(client) = forwarded_for
            // The last entry is the one the nearest proxy added: a proxy that
            // appends (rather than replaces) keeps whatever the client sent in
            // the earlier ones, and those are the client's to forge.
            .and_then(|list| list.rsplit(',').next())
            .and_then(|last| last.trim().parse::<IpAddr>().ok())
        {
            return client;
        }
    }
    peer
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(last: u8) -> IpAddr {
        IpAddr::from([100, 64, 0, last])
    }

    #[test]
    fn one_noisy_client_is_stopped_without_stopping_the_others() {
        let limiter = LoginLimiter::new();
        for _ in 0..PER_CLIENT {
            assert!(!limiter.blocked(ip(1)));
            limiter.record_failure(ip(1));
        }
        assert!(limiter.blocked(ip(1)));
        assert!(!limiter.blocked(ip(2)), "another client is unaffected");
    }

    #[test]
    fn a_block_lapses_after_the_window() {
        let limiter = LoginLimiter::new();
        let start = Instant::now();
        for _ in 0..PER_CLIENT {
            limiter.record_failure_at(ip(1), start);
        }
        assert!(limiter.blocked_at(ip(1), start));
        assert!(!limiter.blocked_at(ip(1), start + WINDOW + Duration::from_secs(1)));
    }

    #[test]
    fn many_clients_together_still_hit_the_overall_ceiling() {
        let limiter = LoginLimiter::new();
        for n in 0..OVERALL {
            limiter.record_failure(IpAddr::from([10, 0, (n / 250) as u8, (n % 250) as u8]));
        }
        assert!(limiter.blocked(ip(200)), "a stranger is held back once the ceiling is reached");
    }

    #[test]
    fn the_table_does_not_grow_without_bound() {
        let limiter = LoginLimiter::new();
        for n in 0..(MAX_CLIENTS + 500) {
            limiter.record_failure(IpAddr::from([172, (n / 65536) as u8, (n / 256) as u8, (n % 256) as u8]));
        }
        assert!(limiter.inner.lock().unwrap().clients.len() <= MAX_CLIENTS);
    }

    #[test]
    fn a_proxy_on_this_machine_names_the_client_and_nobody_else_can() {
        let loopback = IpAddr::from([127, 0, 0, 1]);
        let remote = IpAddr::from([203, 0, 113, 9]);
        // The entry the trusted proxy added is the last one; what a client put in
        // front of it is not believed.
        assert_eq!(client_ip(loopback, Some("10.0.0.1, 100.64.0.7")), ip(7));
        assert_eq!(client_ip(loopback, Some("not an address")), loopback);
        assert_eq!(client_ip(loopback, None), loopback);
        assert_eq!(client_ip(remote, Some("100.64.0.7")), remote, "a remote peer cannot pick its own address");
    }
}
