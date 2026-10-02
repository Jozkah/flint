//! What the agent browser remembers: the user's saved domain rules (on disk),
//! the grants that last a session or a visit, the per-run action counters, and
//! the lease that tells the navigation handler the agent is driving the pane.
//!
//! Locking, because this file once sat in a freeze:
//! - `inner` is a plain mutex held only for in-memory edits. It is never held
//!   across an `.await`, file IO, DNS, or a call into the webview.
//! - The navigation handler runs on the webview's own thread, which every
//!   command and every page load also needs. It therefore never touches
//!   `inner`: it reads `nav`, an immutable snapshot (`Arc<NavPolicy>`) that
//!   each edit publishes, with `try_read`, and answers "block" rather than wait.
//! - Disk writes happen after `inner` is released, under their own `io` mutex,
//!   so a slow disk blocks other writers and nothing else.
//! - Every lock is poison-tolerant: a panic elsewhere must not turn into a
//!   panic (an abort) on the UI thread.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, RwLock, TryLockError};
use std::time::{Duration, Instant};

use url::Url;

use super::policy::{
    hop_verdict, normalize_pattern, pattern_matches, DomainRule, Hop, Inputs, NetworkPolicy, RuleSet, Verdict,
};

/// A "once" grant covers one visit: it ends when the agent opens a site it does
/// not cover, or after this long.
pub const VISIT_TTL: Duration = Duration::from_secs(15 * 60);
/// The pane counts as the agent's for this long after its last call.
pub const LEASE_TTL: Duration = Duration::from_secs(10 * 60);
/// Actions (click / type / press / select / scroll) one run may take.
pub const DEFAULT_MAX_ACTIONS: u32 = 40;
pub const MAX_ACTIONS_CEILING: u32 = 200;
const MAX_RUN_COUNTERS: usize = 256;
const MAX_RULES: usize = 500;
/// Sites the agent was approved to open that the pane may stay within.
const MAX_VISITS: usize = 4;

/// The scope of a grant, as the dialog offers it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Once,
    Session,
    Always,
}

impl Scope {
    pub fn parse(s: &str) -> Option<Scope> {
        match s {
            "once" => Some(Scope::Once),
            "session" => Some(Scope::Session),
            "always" => Some(Scope::Always),
            _ => None,
        }
    }
}

/// The agent holds the pane.
#[derive(Debug, Clone)]
pub struct Lease {
    pub network: NetworkPolicy,
    pub unattended: bool,
    pub enabled: bool,
    pub until: Instant,
}

/// A grant that is not saved, as the settings list shows it.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct GrantView {
    pub pattern: String,
    /// `session` or `once`.
    pub scope: &'static str,
    pub age_secs: u64,
}

/// Everything the navigation handler needs, frozen. Built under `inner` after
/// each edit and published for the handler to read without any lock on `inner`.
#[derive(Debug, Clone)]
pub struct NavPolicy {
    until: Instant,
    enabled: bool,
    unattended: bool,
    network: NetworkPolicy,
    rules: RuleSet,
    session: Vec<String>,
    once: Vec<(String, Instant)>,
    visits: Vec<String>,
}

impl NavPolicy {
    pub fn hop(&self, url: &Url) -> Hop {
        let granted = |host: &str| {
            self.session.iter().any(|p| pattern_matches(p, host))
                || self.once.iter().any(|(p, at)| at.elapsed() < VISIT_TTL && pattern_matches(p, host))
        };
        let inputs = Inputs { enabled: self.enabled, network: &self.network, rules: &self.rules, granted: &granted, unattended: self.unattended };
        hop_verdict(url, &inputs, &self.visits)
    }

    pub fn live(&self) -> bool {
        self.until > Instant::now()
    }
}

/// What the navigation handler learns without blocking.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NavCheck {
    /// The agent does not hold the pane: the pane behaves as it always has.
    NoLease,
    Verdict(Hop),
    /// The snapshot was being swapped. Treated as a refusal; the page can retry.
    Busy,
}

#[derive(Default)]
struct Inner {
    rules: RuleSet,
    path: Option<PathBuf>,
    loaded: bool,
    session: Vec<(String, Instant)>,
    once: Vec<(String, Instant)>,
    actions: HashMap<String, (u32, Instant)>,
    lease: Option<Lease>,
    paused: bool,
    visits: Vec<String>,
}

#[derive(Default)]
pub struct Store {
    inner: Mutex<Inner>,
    nav: RwLock<Option<Arc<NavPolicy>>>,
    io: Mutex<()>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl Store {
    /// Rebuild and publish the navigation snapshot. Called with `inner` held,
    /// after the edit; the handler only ever try-reads `nav`.
    fn publish(&self, g: &Inner) {
        let snapshot = match (&g.lease, g.paused) {
            (Some(l), false) => Some(Arc::new(NavPolicy {
                until: l.until,
                enabled: l.enabled,
                unattended: l.unattended,
                network: l.network.clone(),
                rules: g.rules.clone(),
                session: g.session.iter().map(|(p, _)| p.clone()).collect(),
                once: g.once.clone(),
                visits: g.visits.clone(),
            })),
            _ => None,
        };
        *self.nav.write().unwrap_or_else(|e| e.into_inner()) = snapshot;
    }

    /// The handler's whole interface to the store: no `inner`, no waiting.
    pub fn nav_check(&self, url: &Url) -> NavCheck {
        let snap = match self.nav.try_read() {
            Ok(g) => g.clone(),
            Err(TryLockError::Poisoned(p)) => p.into_inner().clone(),
            Err(TryLockError::WouldBlock) => return NavCheck::Busy,
        };
        match snap {
            Some(p) if p.live() => NavCheck::Verdict(p.hop(url)),
            _ => NavCheck::NoLease,
        }
    }

    /// Point the store at its file and read it. A second call does nothing.
    /// The file is read before `inner` is taken.
    pub fn open(&self, path: &Path) {
        if lock(&self.inner).loaded {
            return;
        }
        let parsed = match std::fs::read_to_string(path) {
            Ok(raw) => match serde_json::from_str::<RuleSet>(&raw) {
                Ok(mut set) => {
                    // A rule that no longer normalizes (a hand edit) is dropped
                    // rather than matched loosely.
                    set.rules.retain_mut(|r| match normalize_pattern(&r.pattern) {
                        Ok(p) => {
                            r.pattern = p;
                            true
                        }
                        Err(_) => false,
                    });
                    Some(set)
                }
                Err(e) => {
                    log::warn!("browser agent: could not read {}: {e}", path.display());
                    None
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                log::warn!("browser agent: could not read {}: {e}", path.display());
                None
            }
        };
        let mut g = lock(&self.inner);
        if g.loaded {
            return;
        }
        g.loaded = true;
        g.path = Some(path.to_path_buf());
        if let Some(set) = parsed {
            g.rules = set;
        }
        self.publish(&g);
    }

    /// Write the rules file. Called after `inner` is released.
    fn write_rules(&self, path: Option<PathBuf>, body: Result<String, String>) -> Result<(), String> {
        let Some(path) = path else { return Ok(()) };
        let body = body?;
        let _io = lock(&self.io);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
    }

    pub fn rules(&self) -> Vec<DomainRule> {
        lock(&self.inner).rules.rules.clone()
    }

    pub fn rule_set(&self, pattern: &str, verdict: Verdict, private_ok: bool) -> Result<DomainRule, String> {
        let pattern = normalize_pattern(pattern)?;
        let (rule, path, body) = {
            let mut g = lock(&self.inner);
            if g.rules.rules.len() >= MAX_RULES && !g.rules.rules.iter().any(|r| r.pattern == pattern) {
                return Err(format!("at most {MAX_RULES} rules"));
            }
            let rule = DomainRule { pattern, verdict, private_ok: private_ok && verdict == Verdict::Allow, added_at: now_secs() };
            g.rules.set(rule.clone());
            self.publish(&g);
            (rule, g.path.clone(), serde_json::to_string_pretty(&g.rules).map_err(|e| e.to_string()))
        };
        self.write_rules(path, body)?;
        Ok(rule)
    }

    /// Whether the user saved an allow rule for this host that also lets it be
    /// a local / private address.
    pub fn private_ok(&self, host: &str) -> bool {
        let g = lock(&self.inner);
        g.rules.verdict_for(host).is_some_and(|r| r.verdict == Verdict::Allow && r.private_ok)
    }

    pub fn rule_remove(&self, pattern: &str) -> Result<bool, String> {
        let (removed, path, body) = {
            let mut g = lock(&self.inner);
            let removed = g.rules.remove(pattern);
            if removed {
                self.publish(&g);
            }
            (removed, g.path.clone(), serde_json::to_string_pretty(&g.rules).map_err(|e| e.to_string()))
        };
        if removed {
            self.write_rules(path, body)?;
        }
        Ok(removed)
    }

    /// Record a grant. `Always` becomes a saved rule; the rest live in memory.
    pub fn grant(&self, pattern: &str, scope: Scope) -> Result<String, String> {
        let pattern = normalize_pattern(pattern)?;
        log::info!("browser agent: grant {pattern} ({scope:?})");
        match scope {
            Scope::Always => {
                self.rule_set(&pattern, Verdict::Allow, false)?;
            }
            Scope::Session => {
                let mut g = lock(&self.inner);
                if !g.session.iter().any(|(p, _)| p == &pattern) {
                    g.session.push((pattern.clone(), Instant::now()));
                }
                self.publish(&g);
            }
            Scope::Once => {
                let mut g = lock(&self.inner);
                g.once.retain(|(p, _)| p != &pattern);
                g.once.push((pattern.clone(), Instant::now()));
                self.publish(&g);
            }
        }
        Ok(pattern)
    }

    /// The grants that are not saved, with their age, so one never has to wonder
    /// why a site did not ask.
    pub fn grants(&self) -> Vec<GrantView> {
        let g = lock(&self.inner);
        let mut out: Vec<GrantView> = g
            .session
            .iter()
            .map(|(p, at)| GrantView { pattern: p.clone(), scope: "session", age_secs: at.elapsed().as_secs() })
            .collect();
        out.extend(
            g.once
                .iter()
                .filter(|(_, at)| at.elapsed() < VISIT_TTL)
                .map(|(p, at)| GrantView { pattern: p.clone(), scope: "once", age_secs: at.elapsed().as_secs() }),
        );
        out
    }

    pub fn clear_session_grants(&self) {
        let mut g = lock(&self.inner);
        g.session.clear();
        g.once.clear();
        g.visits.clear();
        self.publish(&g);
    }

    fn granted_in(g: &Inner, host: &str) -> bool {
        g.session.iter().any(|(p, _)| pattern_matches(p, host))
            || g.once.iter().any(|(p, at)| at.elapsed() < VISIT_TTL && pattern_matches(p, host))
    }

    /// A visit to `host` ends the "once" grants that do not cover it, except
    /// ones made within `grace`: the user may just have approved a redirect
    /// target while the same page was being opened, and that approval must
    /// still be there when the page is opened again.
    pub fn note_visit(&self, host: &str, grace: Duration) {
        let mut g = lock(&self.inner);
        g.once.retain(|(p, at)| at.elapsed() < VISIT_TTL && (at.elapsed() < grace || pattern_matches(p, host)));
        self.publish(&g);
    }

    /// `host` was approved for the agent to open (or is the page it is on): the
    /// pane may follow links and redirects within it.
    pub fn add_visit(&self, host: &str) {
        let mut g = lock(&self.inner);
        g.visits.retain(|v| v != host);
        g.visits.push(host.to_string());
        let excess = g.visits.len().saturating_sub(MAX_VISITS);
        g.visits.drain(..excess);
        self.publish(&g);
    }

    pub fn visits(&self) -> Vec<String> {
        lock(&self.inner).visits.clone()
    }

    /// Run `f` with the inputs a decision needs, under one lock. `f` must be
    /// quick and must not wait on anything.
    pub fn with_inputs<T>(&self, enabled: bool, network: &NetworkPolicy, unattended: bool, f: impl FnOnce(&Inputs) -> T) -> T {
        let g = lock(&self.inner);
        let granted = |host: &str| Self::granted_in(&g, host);
        let inputs = Inputs { enabled, network, rules: &g.rules, granted: &granted, unattended };
        f(&inputs)
    }

    // --- action counter ---

    /// Count one action for `run`. Err(used) once the run is at its cap.
    pub fn take_action(&self, run: &str, cap: u32) -> Result<u32, u32> {
        let cap = cap.clamp(1, MAX_ACTIONS_CEILING);
        let mut g = lock(&self.inner);
        if g.actions.len() >= MAX_RUN_COUNTERS {
            g.actions.retain(|_, (_, at)| at.elapsed() < Duration::from_secs(3600));
            if g.actions.len() >= MAX_RUN_COUNTERS {
                g.actions.clear();
            }
        }
        let entry = g.actions.entry(run.to_string()).or_insert((0, Instant::now()));
        if entry.0 >= cap {
            return Err(entry.0);
        }
        entry.0 += 1;
        entry.1 = Instant::now();
        Ok(entry.0)
    }

    // --- lease / pause ---

    pub fn set_lease(&self, network: &NetworkPolicy, unattended: bool, enabled: bool) {
        let mut g = lock(&self.inner);
        g.lease = Some(Lease { network: network.clone(), unattended, enabled, until: Instant::now() + LEASE_TTL });
        self.publish(&g);
    }

    pub fn lease(&self) -> Option<Lease> {
        let mut g = lock(&self.inner);
        match &g.lease {
            Some(l) if l.until > Instant::now() => Some(l.clone()),
            Some(_) => {
                g.lease = None;
                self.publish(&g);
                None
            }
            None => None,
        }
    }

    pub fn clear_lease(&self) {
        let mut g = lock(&self.inner);
        g.lease = None;
        self.publish(&g);
    }

    pub fn set_paused(&self, paused: bool) {
        let mut g = lock(&self.inner);
        g.paused = paused;
        if paused {
            g.lease = None;
        }
        self.publish(&g);
    }

    pub fn paused(&self) -> bool {
        lock(&self.inner).paused
    }

    /// Test hook: hold `inner` for as long as the guard lives.
    #[cfg(test)]
    fn hold_inner(&self) -> MutexGuard<'_, Inner> {
        lock(&self.inner)
    }

    /// Test hook: hold the snapshot cell for writing for as long as the guard lives.
    #[cfg(test)]
    fn hold_nav_for_write(&self) -> std::sync::RwLockWriteGuard<'_, Option<Arc<NavPolicy>>> {
        self.nav.write().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::browser_agent::policy::{decide, Decision, DenyReason};
    use std::sync::mpsc;
    use std::thread;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("flint-ba-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("rules.json")
    }

    fn d(store: &Store, url: &str, unattended: bool) -> Decision {
        store.with_inputs(true, &NetworkPolicy::open(), unattended, |i| decide(&Url::parse(url).unwrap(), i))
    }

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn always_persists_and_survives_a_restart() {
        let path = tmp("persist");
        let s = Store::default();
        s.open(&path);
        s.grant("Example.com", Scope::Always).unwrap();
        s.rule_set("*.cdn.test", Verdict::Deny, false).unwrap();
        assert_eq!(d(&s, "https://example.com/", false), Decision::Allow);

        let s2 = Store::default();
        s2.open(&path);
        assert_eq!(s2.rules().len(), 2);
        assert_eq!(d(&s2, "https://example.com/", false), Decision::Allow);
        assert!(matches!(d(&s2, "https://a.cdn.test/", false), Decision::Deny(DenyReason::RuleDenied(_))));

        // Revoking removes it from disk too.
        assert!(s2.rule_remove("example.com").unwrap());
        let s3 = Store::default();
        s3.open(&path);
        assert_eq!(s3.rules().len(), 1);
        assert!(matches!(d(&s3, "https://example.com/", false), Decision::Ask { .. }));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn session_and_once_grants_are_memory_only() {
        let path = tmp("mem");
        let s = Store::default();
        s.open(&path);
        s.grant("a.test", Scope::Session).unwrap();
        s.grant("b.test", Scope::Once).unwrap();
        assert_eq!(d(&s, "https://a.test/", false), Decision::Allow);
        assert_eq!(d(&s, "https://b.test/", false), Decision::Allow);
        assert!(!path.exists(), "nothing written for non-persistent grants");
        // Visiting somewhere a once-grant does not cover ends it.
        s.note_visit("a.test", Duration::ZERO);
        assert!(matches!(d(&s, "https://b.test/", false), Decision::Ask { .. }));
        assert_eq!(d(&s, "https://a.test/", false), Decision::Allow, "session grants stay");
        s.clear_session_grants();
        assert!(matches!(d(&s, "https://a.test/", false), Decision::Ask { .. }));
    }

    /// A grant is exactly the host it names: no registrable-domain or TLD
    /// widening. (Live QA once saw example.org and example.net skip the prompt;
    /// the cause was grants made earlier in that app session, not widening.)
    #[test]
    fn a_grant_covers_exactly_the_host_it_names() {
        let s = Store::default();
        s.grant("example.com", Scope::Session).unwrap();
        s.grant("www.example.org", Scope::Once).unwrap();
        for other in ["https://example.org/", "https://example.net/", "https://www.example.com/", "https://sub.example.com/", "https://example.com.evil.test/", "https://org/"] {
            assert!(!matches!(d(&s, other, false), Decision::Allow), "{other}");
        }
        assert_eq!(d(&s, "https://example.com/", false), Decision::Allow);
        assert!(matches!(d(&s, "https://example.org/", false), Decision::Ask { .. }));
    }

    #[test]
    fn unsaved_grants_are_listed_with_their_age_and_scope() {
        let s = Store::default();
        assert!(s.grants().is_empty());
        s.grant("a.test", Scope::Session).unwrap();
        s.grant("b.test", Scope::Once).unwrap();
        s.grant("saved.test", Scope::Always).unwrap(); // saved rules are not "unsaved grants"
        let mut g = s.grants();
        g.sort_by(|a, b| a.pattern.cmp(&b.pattern));
        assert_eq!(g.iter().map(|x| (x.pattern.as_str(), x.scope)).collect::<Vec<_>>(), vec![("a.test", "session"), ("b.test", "once")]);
        s.clear_session_grants();
        assert!(s.grants().is_empty());
    }

    #[test]
    fn a_fresh_store_grants_nothing_and_a_default_rule_set_is_empty() {
        let s = Store::default();
        assert!(s.rules().is_empty());
        assert!(s.grants().is_empty());
        for url in ["https://example.com/", "https://example.org/", "https://example.net/"] {
            assert!(matches!(d(&s, url, false), Decision::Ask { .. }), "{url}");
        }
    }

    #[test]
    fn a_just_made_once_grant_survives_the_visit_it_was_made_for() {
        let s = Store::default();
        s.grant("redirect-target.test", Scope::Once).unwrap();
        // The page is opened again right after the user approved its redirect.
        s.note_visit("original.test", Duration::from_secs(60));
        assert_eq!(d(&s, "https://redirect-target.test/", false), Decision::Allow);
        // Without the grace it would have ended.
        s.note_visit("original.test", Duration::ZERO);
        assert!(matches!(d(&s, "https://redirect-target.test/", false), Decision::Ask { .. }));
    }

    #[test]
    fn wildcard_session_grant_covers_subdomains_only() {
        let s = Store::default();
        s.grant("*.docs.test", Scope::Session).unwrap();
        assert_eq!(d(&s, "https://api.docs.test/", false), Decision::Allow);
        assert!(matches!(d(&s, "https://docs.test/", false), Decision::Ask { .. }));
    }

    #[test]
    fn bad_patterns_are_rejected_everywhere() {
        let s = Store::default();
        assert!(s.grant("https://x.test", Scope::Always).is_err());
        assert!(s.grant("*.com", Scope::Session).is_err());
        assert!(s.rule_set("", Verdict::Allow, false).is_err());
    }

    #[test]
    fn private_ok_is_kept_only_on_allow() {
        let s = Store::default();
        let r = s.rule_set("localhost", Verdict::Allow, true).unwrap();
        assert!(r.private_ok);
        let r = s.rule_set("localhost", Verdict::Deny, true).unwrap();
        assert!(!r.private_ok);
    }

    #[test]
    fn a_hand_edited_bad_rule_is_dropped_on_load() {
        let path = tmp("bad");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"rules":[{"pattern":"*.com","verdict":"allow"},{"pattern":"OK.test","verdict":"allow"},{"pattern":"https://x.test","verdict":"allow"}]}"#,
        )
        .unwrap();
        let s = Store::default();
        s.open(&path);
        let r = s.rules();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].pattern, "ok.test");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_corrupt_file_leaves_no_rules_and_does_not_panic() {
        let path = tmp("corrupt");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{not json").unwrap();
        let s = Store::default();
        s.open(&path);
        assert!(s.rules().is_empty());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn action_cap_is_per_run() {
        let s = Store::default();
        assert_eq!(s.take_action("run-a", 2), Ok(1));
        assert_eq!(s.take_action("run-a", 2), Ok(2));
        assert_eq!(s.take_action("run-a", 2), Err(2));
        assert_eq!(s.take_action("run-b", 2), Ok(1), "another run has its own budget");
        // The cap itself is bounded so a caller cannot ask for unlimited.
        assert_eq!(s.take_action("run-c", u32::MAX), Ok(1));
        for _ in 1..MAX_ACTIONS_CEILING {
            s.take_action("run-c", u32::MAX).unwrap();
        }
        assert_eq!(s.take_action("run-c", u32::MAX), Err(MAX_ACTIONS_CEILING));
    }

    #[test]
    fn lease_and_pause() {
        let s = Store::default();
        assert!(s.lease().is_none());
        s.set_lease(&NetworkPolicy::open(), true, true);
        assert!(s.lease().unwrap().unattended);
        s.set_paused(true);
        assert!(s.lease().is_none(), "taking over releases the pane");
        assert!(s.paused());
        s.set_paused(false);
        assert!(!s.paused());
    }

    // --- the navigation snapshot ---

    #[test]
    fn without_a_lease_the_pane_is_not_restricted() {
        let s = Store::default();
        assert_eq!(s.nav_check(&u("https://anything.test/")), NavCheck::NoLease);
        s.set_lease(&NetworkPolicy::open(), false, true);
        s.clear_lease();
        assert_eq!(s.nav_check(&u("https://anything.test/")), NavCheck::NoLease);
        s.set_lease(&NetworkPolicy::open(), false, true);
        s.set_paused(true);
        assert_eq!(s.nav_check(&u("http://169.254.169.254/")), NavCheck::NoLease, "taken over: the user's pane");
    }

    #[test]
    fn the_snapshot_follows_every_edit() {
        let s = Store::default();
        s.set_lease(&NetworkPolicy::open(), false, true);
        s.add_visit("example.com");
        // Inside the approved site: fine. A redirect elsewhere: stopped.
        assert_eq!(s.nav_check(&u("https://docs.example.com/")), NavCheck::Verdict(Hop::Allow));
        assert_eq!(
            s.nav_check(&u("https://collector.evil.test/?d=1")),
            NavCheck::Verdict(Hop::NeedsApproval { host: "collector.evil.test".into() })
        );
        // The user approves it: the next hop there is allowed.
        s.grant("collector.evil.test", Scope::Once).unwrap();
        assert_eq!(s.nav_check(&u("https://collector.evil.test/?d=1")), NavCheck::Verdict(Hop::Allow));
        // Forgetting approvals closes it again.
        s.clear_session_grants();
        assert!(matches!(s.nav_check(&u("https://collector.evil.test/")), NavCheck::Verdict(Hop::NeedsApproval { .. })));
        // A saved rule is picked up as soon as it is made.
        s.rule_set("partner.test", Verdict::Allow, false).unwrap();
        assert_eq!(s.nav_check(&u("https://partner.test/")), NavCheck::Verdict(Hop::Allow));
        s.rule_remove("partner.test").unwrap();
        assert!(matches!(s.nav_check(&u("https://partner.test/")), NavCheck::Verdict(Hop::NeedsApproval { .. })));
        // Internal addresses are never allowed.
        assert!(matches!(s.nav_check(&u("http://169.254.169.254/")), NavCheck::Verdict(Hop::Refused(_))));
    }

    #[test]
    fn only_the_most_recent_visits_are_kept() {
        let s = Store::default();
        s.set_lease(&NetworkPolicy::open(), false, true);
        for h in ["a.test", "b.test", "c.test", "d.test", "e.test"] {
            s.add_visit(h);
        }
        assert_eq!(s.visits(), vec!["b.test", "c.test", "d.test", "e.test"]);
        assert!(matches!(s.nav_check(&u("https://a.test/")), NavCheck::Verdict(Hop::NeedsApproval { .. })));
    }

    // --- the freeze: the navigation handler must never wait ---

    /// Run `f` on another thread and fail if it does not finish promptly.
    fn within<T: Send + 'static>(what: &str, f: impl FnOnce() -> T + Send + 'static) -> T {
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let _ = tx.send(f());
        });
        rx.recv_timeout(Duration::from_secs(3)).unwrap_or_else(|_| panic!("{what} blocked: the navigation handler must never wait on the store"))
    }

    #[test]
    fn navigation_does_not_wait_for_a_command_holding_the_store() {
        let store = Arc::new(Store::default());
        store.set_lease(&NetworkPolicy::open(), false, true);
        store.add_visit("example.com");
        // A command (rule removal, grant, status...) is inside the store, as the
        // freeze had it, while a page navigates.
        let held = store.hold_inner();
        let s = store.clone();
        let verdict = within("nav_check while the store is held", move || s.nav_check(&u("https://docs.example.com/")));
        assert_eq!(verdict, NavCheck::Verdict(Hop::Allow));
        // The module-level entry point the pane calls is the same path.
        let s = store.clone();
        let again = within("nav_check (second)", move || s.nav_check(&u("https://elsewhere.test/")));
        assert!(matches!(again, NavCheck::Verdict(Hop::NeedsApproval { .. })));
        drop(held);
    }

    #[test]
    fn navigation_answers_busy_instead_of_waiting_when_the_snapshot_is_being_swapped() {
        let store = Arc::new(Store::default());
        store.set_lease(&NetworkPolicy::open(), false, true);
        let writing = store.hold_nav_for_write();
        let s = store.clone();
        let verdict = within("nav_check while the snapshot is write-locked", move || s.nav_check(&u("https://example.com/")));
        assert_eq!(verdict, NavCheck::Busy);
        drop(writing);
        assert!(matches!(store.nav_check(&u("https://example.com/")), NavCheck::Verdict(_)));
    }

    #[test]
    fn a_panic_while_the_store_is_held_does_not_poison_the_ui_path() {
        let store = Arc::new(Store::default());
        store.set_lease(&NetworkPolicy::open(), false, true);
        let s = store.clone();
        let _ = thread::spawn(move || {
            let _g = s.hold_inner();
            panic!("a command panicked inside the store");
        })
        .join();
        // Later calls (any thread) still work rather than panicking.
        assert!(store.grants().is_empty());
        store.grant("a.test", Scope::Session).unwrap();
        assert!(matches!(store.nav_check(&u("https://a.test/")), NavCheck::Verdict(Hop::Allow)));
        assert!(!store.paused());
    }

    #[test]
    fn hammering_commands_and_navigation_together_finishes() {
        let store = Arc::new(Store::default());
        store.set_lease(&NetworkPolicy::open(), false, true);
        store.add_visit("example.com");
        let (tx, rx) = mpsc::channel::<&'static str>();
        let mut handles = Vec::new();
        // The "UI thread": navigation checks, as fast as it can.
        for _ in 0..2 {
            let (s, tx) = (store.clone(), tx.clone());
            handles.push(thread::spawn(move || {
                for i in 0..4000 {
                    let _ = s.nav_check(&u(&format!("https://h{}.example.com/p", i % 7)));
                    let _ = s.nav_check(&u("https://elsewhere.test/"));
                }
                let _ = tx.send("nav");
            }));
        }
        // Commands: clear_grants, status, grants, rules, lease refreshes, visits.
        for t in 0..4 {
            let (s, tx) = (store.clone(), tx.clone());
            handles.push(thread::spawn(move || {
                for i in 0..2000 {
                    match (t + i) % 6 {
                        0 => s.clear_session_grants(),
                        1 => {
                            let _ = (s.paused(), s.lease().is_some(), s.grants().len());
                        }
                        2 => {
                            let _ = s.grant(&format!("h{}.test", i % 5), if i % 2 == 0 { Scope::Session } else { Scope::Once });
                        }
                        3 => s.set_lease(&NetworkPolicy::open(), false, true),
                        4 => s.add_visit(&format!("v{}.test", i % 6)),
                        _ => {
                            let _ = s.rules();
                            let _ = s.take_action("run", 100_000);
                        }
                    }
                }
                let _ = tx.send("cmd");
            }));
        }
        drop(tx);
        for _ in 0..6 {
            rx.recv_timeout(Duration::from_secs(60)).expect("a worker stalled: deadlock between commands and navigation");
        }
        for h in handles {
            h.join().unwrap();
        }
        // And it is still coherent.
        store.clear_session_grants();
        assert!(store.grants().is_empty());
    }

    #[test]
    fn saving_rules_happens_outside_the_store_lock() {
        // Point the file at a directory that cannot be created, so the write
        // fails: the in-memory edit stands, the lock is free, navigation works.
        let store = Arc::new(Store::default());
        let blocker = std::env::temp_dir().join(format!("flint-ba-block-{}", std::process::id()));
        std::fs::write(&blocker, "a file, not a folder").unwrap();
        store.open(&blocker.join("rules.json"));
        store.set_lease(&NetworkPolicy::open(), false, true);
        assert!(store.rule_set("example.com", Verdict::Allow, false).is_err());
        let s = store.clone();
        assert!(matches!(
            within("nav after a failed save", move || s.nav_check(&u("https://example.com/"))),
            NavCheck::Verdict(Hop::Allow)
        ));
        let _ = std::fs::remove_file(blocker);
    }
}
