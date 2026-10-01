//! What the agent browser remembers: the user's saved domain rules (on disk),
//! the grants that last a session or a visit, the per-run action counters, and
//! the lease that tells the navigation handler the agent is driving the pane.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::policy::{normalize_pattern, pattern_matches, DomainRule, Inputs, NetworkPolicy, RuleSet, Verdict};

/// A "once" grant covers one visit: it ends when the agent opens a site it does
/// not cover, or after this long.
pub const VISIT_TTL: Duration = Duration::from_secs(15 * 60);
/// The pane counts as the agent's for this long after its last call.
pub const LEASE_TTL: Duration = Duration::from_secs(10 * 60);
/// Actions (click / type / press / select) one run may take.
pub const DEFAULT_MAX_ACTIONS: u32 = 40;
pub const MAX_ACTIONS_CEILING: u32 = 200;
const MAX_RUN_COUNTERS: usize = 256;
const MAX_RULES: usize = 500;

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

/// The agent holds the pane. The navigation handler reads it.
#[derive(Debug, Clone)]
pub struct Lease {
    pub network: NetworkPolicy,
    pub unattended: bool,
    pub enabled: bool,
    pub until: Instant,
}

#[derive(Default)]
struct Inner {
    rules: RuleSet,
    path: Option<PathBuf>,
    loaded: bool,
    session: Vec<String>,
    once: Vec<(String, Instant)>,
    actions: HashMap<String, (u32, Instant)>,
    lease: Option<Lease>,
    paused: bool,
}

#[derive(Default)]
pub struct Store {
    inner: Mutex<Inner>,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl Store {
    /// Point the store at its file and read it. A second call does nothing.
    pub fn open(&self, path: &Path) {
        let mut g = self.inner.lock().unwrap();
        if g.loaded {
            return;
        }
        g.loaded = true;
        g.path = Some(path.to_path_buf());
        match std::fs::read_to_string(path) {
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
                    g.rules = set;
                }
                Err(e) => log::warn!("browser agent: could not read {}: {e}", path.display()),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => log::warn!("browser agent: could not read {}: {e}", path.display()),
        }
    }

    fn save(g: &Inner) -> Result<(), String> {
        let Some(path) = &g.path else { return Ok(()) };
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = path.with_extension("json.tmp");
        let body = serde_json::to_string_pretty(&g.rules).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())
    }

    pub fn rules(&self) -> Vec<DomainRule> {
        self.inner.lock().unwrap().rules.rules.clone()
    }

    pub fn rule_set(&self, pattern: &str, verdict: Verdict, private_ok: bool) -> Result<DomainRule, String> {
        let pattern = normalize_pattern(pattern)?;
        let mut g = self.inner.lock().unwrap();
        if g.rules.rules.len() >= MAX_RULES && !g.rules.rules.iter().any(|r| r.pattern == pattern) {
            return Err(format!("at most {MAX_RULES} rules"));
        }
        let rule = DomainRule { pattern, verdict, private_ok: private_ok && verdict == Verdict::Allow, added_at: now_secs() };
        g.rules.set(rule.clone());
        Self::save(&g)?;
        Ok(rule)
    }

    /// Whether the user saved an allow rule for this host that also lets it be
    /// a local / private address.
    pub fn private_ok(&self, host: &str) -> bool {
        let g = self.inner.lock().unwrap();
        g.rules.verdict_for(host).is_some_and(|r| r.verdict == Verdict::Allow && r.private_ok)
    }

    pub fn rule_remove(&self, pattern: &str) -> Result<bool, String> {
        let mut g = self.inner.lock().unwrap();
        let removed = g.rules.remove(pattern);
        if removed {
            Self::save(&g)?;
        }
        Ok(removed)
    }

    /// Record a grant. `Always` becomes a saved rule; the rest live in memory.
    pub fn grant(&self, pattern: &str, scope: Scope) -> Result<String, String> {
        let pattern = normalize_pattern(pattern)?;
        match scope {
            Scope::Always => {
                self.rule_set(&pattern, Verdict::Allow, false)?;
            }
            Scope::Session => {
                let mut g = self.inner.lock().unwrap();
                if !g.session.contains(&pattern) {
                    g.session.push(pattern.clone());
                }
            }
            Scope::Once => {
                let mut g = self.inner.lock().unwrap();
                g.once.retain(|(p, _)| p != &pattern);
                g.once.push((pattern.clone(), Instant::now()));
            }
        }
        Ok(pattern)
    }

    pub fn clear_session_grants(&self) {
        let mut g = self.inner.lock().unwrap();
        g.session.clear();
        g.once.clear();
    }

    fn granted_in(g: &Inner, host: &str) -> bool {
        g.session.iter().any(|p| pattern_matches(p, host))
            || g.once.iter().any(|(p, at)| at.elapsed() < VISIT_TTL && pattern_matches(p, host))
    }

    /// A visit that is not covered by a "once" grant ends those grants.
    pub fn note_visit(&self, host: &str) {
        let mut g = self.inner.lock().unwrap();
        g.once.retain(|(p, at)| at.elapsed() < VISIT_TTL && pattern_matches(p, host));
    }

    /// Run `f` with the inputs a decision needs, under one lock.
    pub fn with_inputs<T>(&self, enabled: bool, network: &NetworkPolicy, unattended: bool, f: impl FnOnce(&Inputs) -> T) -> T {
        let g = self.inner.lock().unwrap();
        let granted = |host: &str| Self::granted_in(&g, host);
        let inputs = Inputs { enabled, network, rules: &g.rules, granted: &granted, unattended };
        f(&inputs)
    }

    // --- action counter ---

    /// Count one action for `run`. Err(used) once the run is at its cap.
    pub fn take_action(&self, run: &str, cap: u32) -> Result<u32, u32> {
        let cap = cap.clamp(1, MAX_ACTIONS_CEILING);
        let mut g = self.inner.lock().unwrap();
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
        let mut g = self.inner.lock().unwrap();
        g.lease = Some(Lease { network: network.clone(), unattended, enabled, until: Instant::now() + LEASE_TTL });
    }

    pub fn lease(&self) -> Option<Lease> {
        let mut g = self.inner.lock().unwrap();
        match &g.lease {
            Some(l) if l.until > Instant::now() => Some(l.clone()),
            Some(_) => {
                g.lease = None;
                None
            }
            None => None,
        }
    }

    pub fn clear_lease(&self) {
        self.inner.lock().unwrap().lease = None;
    }

    pub fn set_paused(&self, paused: bool) {
        let mut g = self.inner.lock().unwrap();
        g.paused = paused;
        if paused {
            g.lease = None;
        }
    }

    pub fn paused(&self) -> bool {
        self.inner.lock().unwrap().paused
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::browser_agent::policy::{decide, Decision, DenyReason};
    use url::Url;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("flint-ba-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("rules.json")
    }

    fn d(store: &Store, url: &str, unattended: bool) -> Decision {
        store.with_inputs(true, &NetworkPolicy::open(), unattended, |i| decide(&Url::parse(url).unwrap(), i))
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
        s.note_visit("a.test");
        assert!(matches!(d(&s, "https://b.test/", false), Decision::Ask { .. }));
        assert_eq!(d(&s, "https://a.test/", false), Decision::Allow, "session grants stay");
        s.clear_session_grants();
        assert!(matches!(d(&s, "https://a.test/", false), Decision::Ask { .. }));
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
}
