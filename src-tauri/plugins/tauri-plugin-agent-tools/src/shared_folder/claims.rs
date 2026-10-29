//! Soft file claims and holds: advisory, in process memory.
//!
//! Every method takes `now` (epoch ms) so tests drive time by hand. Who is
//! alive is the caller's knowledge (the session registry); it is passed in.

use std::collections::{HashMap, VecDeque};

use serde::Serialize;

/// A claim is dropped when its owner has not written for this long.
pub const CLAIM_IDLE_MS: i64 = 5 * 60_000;
/// Edits older than this are not "recent".
pub const RECENT_WINDOW_MS: i64 = 10 * 60_000;
/// A hold is forgotten after this long without a retry.
pub const HOLD_TTL_MS: i64 = 10 * 60_000;
/// Holds on one thing before the next attempt passes whatever happened.
pub const MAX_HOLDS: u32 = 2;
/// Recent edits kept per session.
pub const MAX_RECENT: usize = 20;
/// Held writes remembered per session for the UI.
pub const MAX_HOLD_LOG: usize = 5;
/// Longest "allow anyway" a user can grant.
pub const MAX_ALLOW_MINUTES: u32 = 240;
pub const DEFAULT_ALLOW_MINUTES: u32 = 30;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claim {
    pub session: String,
    pub at: i64,
}

/// One file a session changed, newest data only per file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEdit {
    /// The file key (resolved, normalised path).
    pub path: String,
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Hold {
    count: u32,
    at: i64,
}

/// A hold, as the UI lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldRecord {
    /// `edit` or `git`.
    pub kind: String,
    /// The file key for an edit, the command kind for git.
    pub target: String,
    pub owner_id: String,
    pub owner_name: String,
    pub at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Edit,
    Git,
    All,
}

impl Scope {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "edit" | "edits" => Some(Scope::Edit),
            "git" => Some(Scope::Git),
            "all" => Some(Scope::All),
            _ => None,
        }
    }
    fn covers(self, kind: Scope) -> bool {
        self == Scope::All || self == kind
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Hold { owner_id: String },
}

#[derive(Debug, Default)]
pub struct ClaimTable {
    claims: HashMap<String, Claim>,
    recent: HashMap<String, VecDeque<RecentEdit>>,
    holds: HashMap<(String, String), Hold>,
    hold_log: HashMap<String, VecDeque<HoldRecord>>,
    /// When a session last sent a message.
    messaged: HashMap<String, i64>,
    /// When a session last read a file.
    reads: HashMap<(String, String), i64>,
    /// Session -> (scope, until).
    allowed: HashMap<String, Vec<(Scope, i64)>>,
    /// The branch a session saw after its last tool: (branch label, sha).
    heads: HashMap<String, (String, Option<String>)>,
}

impl ClaimTable {
    pub fn new() -> Self {
        Self::default()
    }

    // -- evidence the agent coordinated ------------------------------------

    pub fn note_message_sent(&mut self, session: &str, now: i64) {
        self.messaged.insert(session.to_string(), now);
    }

    pub fn note_read(&mut self, session: &str, file: &str, now: i64) {
        if self.reads.len() > 4096 {
            // Drop the oldest read, not all of them: clearing would make every
            // session look as if it had read nothing.
            if let Some(oldest) = self.reads.iter().min_by_key(|(_, at)| **at).map(|(k, _)| k.clone()) {
                self.reads.remove(&oldest);
            }
        }
        self.reads.insert((session.to_string(), file.to_string()), now);
    }

    // -- user override ------------------------------------------------------

    /// Let `session` through for `minutes` (0 withdraws). Returns the expiry.
    pub fn allow(&mut self, session: &str, scope: Scope, minutes: u32, now: i64) -> Option<i64> {
        let list = self.allowed.entry(session.to_string()).or_default();
        list.retain(|(s, _)| *s != scope);
        if minutes == 0 {
            return None;
        }
        let until = now + i64::from(minutes.min(MAX_ALLOW_MINUTES)) * 60_000;
        list.push((scope, until));
        Some(until)
    }

    pub fn is_allowed(&self, session: &str, kind: Scope, now: i64) -> bool {
        self.allowed
            .get(session)
            .is_some_and(|l| l.iter().any(|(s, until)| s.covers(kind) && *until > now))
    }

    /// Active overrides as `(scope, until)`.
    pub fn allowances(&self, session: &str, now: i64) -> Vec<(Scope, i64)> {
        self.allowed
            .get(session)
            .map(|l| l.iter().copied().filter(|(_, u)| *u > now).collect())
            .unwrap_or_default()
    }

    // -- the one-retry rule -------------------------------------------------

    /// Hold the first attempt; pass a retry that follows a message or a
    /// re-read (`reread`), or the attempt after `MAX_HOLDS` holds.
    fn gate(&mut self, session: &str, target: &str, reread: Option<i64>, now: i64) -> bool {
        let key = (session.to_string(), target.to_string());
        let live = self.holds.get(&key).filter(|h| now - h.at <= HOLD_TTL_MS).cloned();
        match live {
            None => {
                self.holds.insert(key, Hold { count: 1, at: now });
                true
            }
            Some(h) => {
                let messaged = self.messaged.get(session).is_some_and(|t| *t > h.at);
                let reread = reread.is_some_and(|t| t > h.at);
                if messaged || reread || h.count >= MAX_HOLDS {
                    self.holds.remove(&key);
                    false
                } else {
                    self.holds.insert(key, Hold { count: h.count + 1, at: now });
                    true
                }
            }
        }
    }

    fn log_hold(&mut self, session: &str, record: HoldRecord) {
        let log = self.hold_log.entry(session.to_string()).or_default();
        log.retain(|r| !(r.kind == record.kind && r.target == record.target));
        log.push_back(record);
        while log.len() > MAX_HOLD_LOG {
            log.pop_front();
        }
    }

    /// Recent held operations of a session, newest last.
    pub fn holds_of(&self, session: &str, now: i64) -> Vec<HoldRecord> {
        self.hold_log
            .get(session)
            .map(|l| l.iter().filter(|r| now - r.at <= HOLD_TTL_MS).cloned().collect())
            .unwrap_or_default()
    }

    // -- file claims --------------------------------------------------------

    /// May `me` write `file`? `owner_live` says whether a claim's owner is a
    /// live, non-isolated session. A claim by a dead, idle or expired owner is
    /// dropped here.
    pub fn check_write(
        &mut self,
        me: &str,
        file: &str,
        owner_name: &dyn Fn(&str) -> String,
        owner_live: &dyn Fn(&str) -> bool,
        now: i64,
    ) -> Decision {
        if self.is_allowed(me, Scope::Edit, now) {
            return Decision::Allow;
        }
        let Some(claim) = self.claims.get(file).cloned() else {
            return Decision::Allow;
        };
        if claim.session == me {
            return Decision::Allow;
        }
        if now - claim.at > CLAIM_IDLE_MS || !owner_live(&claim.session) {
            self.claims.remove(file);
            return Decision::Allow;
        }
        let reread = self.reads.get(&(me.to_string(), file.to_string())).copied();
        if self.gate(me, file, reread, now) {
            self.log_hold(
                me,
                HoldRecord {
                    kind: "edit".into(),
                    target: file.to_string(),
                    owner_id: claim.session.clone(),
                    owner_name: owner_name(&claim.session),
                    at: now,
                },
            );
            return Decision::Hold { owner_id: claim.session };
        }
        Decision::Allow
    }

    /// `me` wrote `file`. Takes (or refreshes) the claim when `claim` is set
    /// (false for an isolated session, which holds none).
    pub fn record_write(&mut self, me: &str, file: &str, claim: bool, now: i64) {
        if claim {
            self.claims.insert(
                file.to_string(),
                Claim { session: me.to_string(), at: now },
            );
        }
        let list = self.recent.entry(me.to_string()).or_default();
        list.retain(|e| e.path != file);
        list.push_back(RecentEdit { path: file.to_string(), at: now });
        while list.len() > MAX_RECENT {
            list.pop_front();
        }
    }

    pub fn claim_of(&self, file: &str) -> Option<&Claim> {
        self.claims.get(file)
    }

    /// Files `session` changed in the last `window_ms`, newest first.
    pub fn recent_of(&self, session: &str, window_ms: i64, now: i64) -> Vec<RecentEdit> {
        let mut out: Vec<RecentEdit> = self
            .recent
            .get(session)
            .map(|l| l.iter().filter(|e| now - e.at <= window_ms).cloned().collect())
            .unwrap_or_default();
        out.sort_by(|a, b| b.at.cmp(&a.at));
        out
    }

    /// Claims currently held by `session`.
    pub fn claims_of(&self, session: &str, now: i64) -> Vec<String> {
        let mut files: Vec<String> = self
            .claims
            .iter()
            .filter(|(_, c)| c.session == session && now - c.at <= CLAIM_IDLE_MS)
            .map(|(f, _)| f.clone())
            .collect();
        files.sort();
        files
    }

    // -- git guard ----------------------------------------------------------

    /// Same one-retry rule for a held git operation. `kind` is the
    /// classification (`checkout`, `stash`...); the retry evidence is a
    /// message only.
    pub fn check_git(
        &mut self,
        me: &str,
        kind: &str,
        owner_id: &str,
        owner_name: &str,
        now: i64,
    ) -> Decision {
        if self.is_allowed(me, Scope::Git, now) {
            return Decision::Allow;
        }
        let target = format!("git:{kind}");
        if self.gate(me, &target, None, now) {
            self.log_hold(
                me,
                HoldRecord {
                    kind: "git".into(),
                    target: kind.to_string(),
                    owner_id: owner_id.to_string(),
                    owner_name: owner_name.to_string(),
                    at: now,
                },
            );
            return Decision::Hold { owner_id: owner_id.to_string() };
        }
        Decision::Allow
    }

    // -- HEAD tracking ------------------------------------------------------

    /// What the session saw last, if anything.
    pub fn head_seen(&self, session: &str) -> Option<&(String, Option<String>)> {
        self.heads.get(session)
    }

    pub fn set_head_seen(&mut self, session: &str, label: String, sha: Option<String>) {
        self.heads.insert(session.to_string(), (label, sha));
    }

    // -- lifecycle ----------------------------------------------------------

    /// A run ended or started: its claims, holds and HEAD baseline go. Recent
    /// edits stay, they are history.
    pub fn release_session(&mut self, session: &str) {
        self.claims.retain(|_, c| c.session != session);
        self.holds.retain(|(s, _), _| s != session);
        self.heads.remove(session);
    }

    /// The session is gone: everything about it.
    pub fn forget_session(&mut self, session: &str) {
        self.release_session(session);
        self.recent.remove(session);
        self.hold_log.remove(session);
        self.messaged.remove(session);
        self.reads.retain(|(s, _), _| s != session);
        self.allowed.remove(session);
    }

    /// Drop expired claims and holds (housekeeping; checks also expire lazily).
    pub fn sweep(&mut self, now: i64) {
        self.claims.retain(|_, c| now - c.at <= CLAIM_IDLE_MS);
        self.holds.retain(|_, h| now - h.at <= HOLD_TTL_MS);
        for list in self.allowed.values_mut() {
            list.retain(|(_, until)| *until > now);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_000_000;

    fn name(id: &str) -> String {
        format!("name-{id}")
    }

    fn live(_: &str) -> bool {
        true
    }

    fn dead(_: &str) -> bool {
        false
    }

    #[test]
    fn nobody_else_claimed_it() {
        let mut t = ClaimTable::new();
        assert_eq!(t.check_write("b", "f", &name, &live, T0), Decision::Allow);
    }

    #[test]
    fn own_claim_never_holds() {
        let mut t = ClaimTable::new();
        t.record_write("a", "f", true, T0);
        assert_eq!(t.check_write("a", "f", &name, &live, T0 + 1), Decision::Allow);
    }

    #[test]
    fn another_sessions_claim_holds_once_then_a_message_lets_the_retry_through() {
        let mut t = ClaimTable::new();
        t.record_write("a", "f", true, T0);
        assert_eq!(
            t.check_write("b", "f", &name, &live, T0 + 1000),
            Decision::Hold { owner_id: "a".into() }
        );
        // A retry with nothing in between is held again.
        assert!(matches!(t.check_write("b", "f", &name, &live, T0 + 2000), Decision::Hold { .. }));
        t.note_message_sent("b", T0 + 3000);
        assert_eq!(t.check_write("b", "f", &name, &live, T0 + 4000), Decision::Allow);
        // The pass consumed the hold: a fresh claim by a starts over.
        t.record_write("a", "f", true, T0 + 5000);
        assert!(matches!(t.check_write("b", "f", &name, &live, T0 + 6000), Decision::Hold { .. }));
    }

    #[test]
    fn a_message_sent_before_the_hold_is_not_evidence() {
        let mut t = ClaimTable::new();
        t.record_write("a", "f", true, T0);
        t.note_message_sent("b", T0);
        assert!(matches!(t.check_write("b", "f", &name, &live, T0 + 10), Decision::Hold { .. }));
        assert!(matches!(t.check_write("b", "f", &name, &live, T0 + 20), Decision::Hold { .. }));
    }

    #[test]
    fn a_reread_after_the_hold_counts() {
        let mut t = ClaimTable::new();
        t.record_write("a", "f", true, T0);
        assert!(matches!(t.check_write("b", "f", &name, &live, T0 + 10), Decision::Hold { .. }));
        t.note_read("b", "f", T0 + 20);
        assert_eq!(t.check_write("b", "f", &name, &live, T0 + 30), Decision::Allow);
    }

    #[test]
    fn a_read_of_another_file_does_not_count() {
        let mut t = ClaimTable::new();
        t.record_write("a", "f", true, T0);
        assert!(matches!(t.check_write("b", "f", &name, &live, T0 + 10), Decision::Hold { .. }));
        t.note_read("b", "g", T0 + 20);
        assert!(matches!(t.check_write("b", "f", &name, &live, T0 + 30), Decision::Hold { .. }));
    }

    #[test]
    fn never_a_permanent_block() {
        let mut t = ClaimTable::new();
        t.record_write("a", "f", true, T0);
        let mut passed_at = None;
        for i in 0..6 {
            if t.check_write("b", "f", &name, &live, T0 + 100 * (i + 1)) == Decision::Allow {
                passed_at = Some(i);
                break;
            }
        }
        // Two holds, then the next attempt passes with no evidence at all.
        assert_eq!(passed_at, Some(2));
    }

    #[test]
    fn a_dead_owner_cannot_wedge_anyone() {
        let mut t = ClaimTable::new();
        t.record_write("a", "f", true, T0);
        assert_eq!(t.check_write("b", "f", &name, &dead, T0 + 10), Decision::Allow);
        assert!(t.claim_of("f").is_none());
    }

    #[test]
    fn an_idle_claim_expires() {
        let mut t = ClaimTable::new();
        t.record_write("a", "f", true, T0);
        assert!(matches!(t.check_write("b", "f", &name, &live, T0 + CLAIM_IDLE_MS), Decision::Hold { .. }));
        let mut t = ClaimTable::new();
        t.record_write("a", "f", true, T0);
        assert_eq!(
            t.check_write("b", "f", &name, &live, T0 + CLAIM_IDLE_MS + 1),
            Decision::Allow
        );
    }

    #[test]
    fn the_owners_next_write_keeps_the_claim_fresh() {
        let mut t = ClaimTable::new();
        t.record_write("a", "f", true, T0);
        t.record_write("a", "f", true, T0 + CLAIM_IDLE_MS);
        assert!(matches!(
            t.check_write("b", "f", &name, &live, T0 + CLAIM_IDLE_MS + 1000),
            Decision::Hold { .. }
        ));
        assert_eq!(t.claim_of("f").unwrap().at, T0 + CLAIM_IDLE_MS);
    }

    #[test]
    fn run_end_releases_claims_but_keeps_history() {
        let mut t = ClaimTable::new();
        t.record_write("a", "f", true, T0);
        t.release_session("a");
        assert_eq!(t.check_write("b", "f", &name, &live, T0 + 10), Decision::Allow);
        assert_eq!(t.recent_of("a", RECENT_WINDOW_MS, T0 + 10).len(), 1);
    }

    #[test]
    fn an_isolated_writer_holds_no_claim() {
        let mut t = ClaimTable::new();
        t.record_write("iso", "f", false, T0);
        assert!(t.claim_of("f").is_none());
        assert_eq!(t.recent_of("iso", RECENT_WINDOW_MS, T0).len(), 1);
    }

    #[test]
    fn user_override_passes_and_expires() {
        let mut t = ClaimTable::new();
        t.record_write("a", "f", true, T0);
        let until = t.allow("b", Scope::Edit, 10, T0).unwrap();
        assert_eq!(until, T0 + 600_000);
        assert_eq!(t.check_write("b", "f", &name, &live, T0 + 10), Decision::Allow);
        t.record_write("a", "f", true, T0 + 700_000);
        assert!(matches!(t.check_write("b", "f", &name, &live, T0 + 700_001), Decision::Hold { .. }));
        // Withdrawn early.
        t.allow("b", Scope::Edit, 10, T0 + 700_002);
        t.allow("b", Scope::Edit, 0, T0 + 700_003);
        assert!(!t.is_allowed("b", Scope::Edit, T0 + 700_004));
    }

    #[test]
    fn override_is_capped_and_scoped() {
        let mut t = ClaimTable::new();
        let until = t.allow("b", Scope::Git, 100_000, T0).unwrap();
        assert_eq!(until, T0 + i64::from(MAX_ALLOW_MINUTES) * 60_000);
        assert!(t.is_allowed("b", Scope::Git, T0));
        assert!(!t.is_allowed("b", Scope::Edit, T0));
        t.allow("c", Scope::All, 5, T0);
        assert!(t.is_allowed("c", Scope::Edit, T0) && t.is_allowed("c", Scope::Git, T0));
    }

    #[test]
    fn git_holds_follow_the_same_one_retry_rule() {
        let mut t = ClaimTable::new();
        assert!(matches!(t.check_git("b", "checkout", "a", "A", T0), Decision::Hold { .. }));
        assert!(matches!(t.check_git("b", "checkout", "a", "A", T0 + 1), Decision::Hold { .. }));
        t.note_message_sent("b", T0 + 2);
        assert_eq!(t.check_git("b", "checkout", "a", "A", T0 + 3), Decision::Allow);
        // A different operation is its own hold.
        assert!(matches!(t.check_git("b", "stash", "a", "A", T0 + 4), Decision::Hold { .. }));
    }

    #[test]
    fn hold_log_for_the_ui() {
        let mut t = ClaimTable::new();
        t.record_write("a", "f", true, T0);
        let _ = t.check_write("b", "f", &name, &live, T0 + 10);
        let log = t.holds_of("b", T0 + 20);
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].owner_name, "name-a");
        assert_eq!(log[0].kind, "edit");
        assert!(t.holds_of("b", T0 + HOLD_TTL_MS + 100).is_empty());
    }

    #[test]
    fn recent_edits_are_bounded_windowed_and_newest_first() {
        let mut t = ClaimTable::new();
        for i in 0..30 {
            t.record_write("a", &format!("f{i}"), true, T0 + i);
        }
        let all = t.recent_of("a", RECENT_WINDOW_MS, T0 + 100);
        assert_eq!(all.len(), MAX_RECENT);
        assert_eq!(all[0].path, "f29");
        assert!(t.recent_of("a", 50, T0 + 100).is_empty());
    }

    #[test]
    fn forgetting_a_session_clears_everything() {
        let mut t = ClaimTable::new();
        t.record_write("a", "f", true, T0);
        t.note_message_sent("a", T0);
        t.allow("a", Scope::All, 5, T0);
        t.forget_session("a");
        assert!(t.recent_of("a", RECENT_WINDOW_MS, T0).is_empty());
        assert!(!t.is_allowed("a", Scope::Edit, T0));
        assert!(t.claim_of("f").is_none());
    }

    #[test]
    fn the_read_record_evicts_the_oldest_instead_of_clearing() {
        let mut t = ClaimTable::new();
        for i in 0..4200 {
            t.note_read("s", &format!("f{i}"), T0 + i);
        }
        assert!(t.reads.len() <= 4097);
        assert!(t.reads.contains_key(&("s".to_string(), "f4199".to_string())));
        assert!(!t.reads.contains_key(&("s".to_string(), "f0".to_string())));
    }

    #[test]
    fn sweep_drops_the_expired() {
        let mut t = ClaimTable::new();
        t.record_write("a", "f", true, T0);
        t.sweep(T0 + CLAIM_IDLE_MS + 1);
        assert!(t.claim_of("f").is_none());
    }
}
