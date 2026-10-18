//! A read-only health report over a set of memory records: what is stored,
//! what is redundant, what is stale, and what it would cost in a prompt.
//!
//! Pure over `&[MemoryRecord]` so it is testable without a store, and it never
//! prints or returns more of a record than an id, a scope and a short excerpt.
//! It is advice, not a gate: nothing here changes a record.

use std::collections::BTreeMap;

use serde::Serialize;

use super::record::{normalise, Creator, MemoryId, MemoryRecord, Scope, Status};

/// Token overlap (Jaccard) at or above which two records count as near-duplicates.
pub const NEAR_DUPLICATE_OVERLAP: f64 = 0.9;
/// Default age after which an untouched record is reported as stale.
pub const DEFAULT_STALE_DAYS: u32 = 90;
/// Past this many live records in one group the pairwise duplicate scan is
/// skipped (and said so), so a huge store cannot make an advice command crawl.
pub const MAX_PAIRWISE: usize = 2_000;
const EXCERPT: usize = 60;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DuplicatePair {
    pub scope: String,
    pub a: MemoryId,
    pub b: MemoryId,
    /// `identical` (same normalised words) or `overlap` (token overlap >= 0.9).
    pub kind: &'static str,
    pub excerpt: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SupersededLeftover {
    pub id: MemoryId,
    pub scope: String,
    pub superseded_by: MemoryId,
    pub chars: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Quiet {
    pub id: MemoryId,
    pub scope: String,
    pub excerpt: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct AuditReport {
    pub total: usize,
    /// Records of each scope, whatever their status.
    pub by_scope: BTreeMap<String, usize>,
    pub by_creator: BTreeMap<String, usize>,
    pub by_status: BTreeMap<String, usize>,
    pub near_duplicates: Vec<DuplicatePair>,
    /// Superseded records still holding their text.
    pub superseded_still_present: Vec<SupersededLeftover>,
    /// Active records never injected (`use_count == 0` and no `last_used_at`).
    pub never_recalled: Vec<Quiet>,
    /// Active, unpinned records last touched more than `stale_days` ago.
    pub stale: Vec<Quiet>,
    pub stale_days: u32,
    /// Characters the usable records would add to a prompt if all were
    /// selected (one extra per record for the separator, as retrieval counts).
    /// An upper bound: conflicts and the budget can only lower it.
    pub prompt_chars: usize,
    pub prompt_records: usize,
    /// Scopes whose duplicate scan was skipped for size.
    pub skipped_duplicate_scan: Vec<String>,
}

fn scope_name(s: Scope) -> &'static str {
    match s {
        Scope::User => "user",
        Scope::Project => "project",
        Scope::Session => "chat",
    }
}

fn creator_name(c: Creator) -> &'static str {
    match c {
        Creator::User => "user",
        Creator::Agent => "agent",
        Creator::Import => "import",
        Creator::System => "system",
    }
}

fn status_name(s: &Status) -> &'static str {
    match s {
        Status::Active => "active",
        Status::Proposed { .. } => "proposed",
        Status::Superseded { .. } => "superseded",
        Status::Conflicted { .. } => "conflicted",
        Status::Expired => "expired",
        Status::Deleted => "forgotten",
    }
}

fn excerpt(text: &str) -> String {
    let one: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= EXCERPT {
        one
    } else {
        format!("{}...", one.chars().take(EXCERPT).collect::<String>())
    }
}

/// Lowercased alphanumeric words, sorted and deduplicated, for equality and overlap.
fn tokens(text: &str) -> Vec<String> {
    let mut t: Vec<String> = normalise(text)
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect();
    t.sort();
    t.dedup();
    t
}

/// Jaccard overlap of two sorted, deduplicated token lists. An empty side is 0.
pub fn overlap(a: &[String], b: &[String]) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let (mut i, mut j, mut both) = (0, 0, 0usize);
    while i < a.len() && j < b.len() {
        match a[i].cmp(&b[j]) {
            std::cmp::Ordering::Equal => {
                both += 1;
                i += 1;
                j += 1;
            }
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
        }
    }
    both as f64 / (a.len() + b.len() - both) as f64
}

/// The latest moment anything touched the record.
fn last_touch(r: &MemoryRecord) -> i64 {
    [Some(r.updated_at), r.last_used_at, r.last_confirmed_at, Some(r.created_at)]
        .into_iter()
        .flatten()
        .max()
        .unwrap_or(0)
}

/// Build the report. `now` is Unix seconds.
pub fn audit(records: &[MemoryRecord], now: i64, stale_days: u32) -> AuditReport {
    let mut rep = AuditReport { total: records.len(), stale_days, ..AuditReport::default() };
    for r in records {
        *rep.by_scope.entry(scope_name(r.scope).into()).or_default() += 1;
        *rep.by_creator.entry(creator_name(r.creator).into()).or_default() += 1;
        *rep.by_status.entry(status_name(&r.status).into()).or_default() += 1;
    }

    // Sorted by id so the report does not depend on storage order.
    let mut sorted: Vec<&MemoryRecord> = records.iter().collect();
    sorted.sort_by(|a, b| a.id.cmp(&b.id));

    let cutoff = now.saturating_sub(i64::from(stale_days) * 86_400);
    for r in &sorted {
        if let Status::Superseded { by } = &r.status {
            if !r.content.is_empty() {
                rep.superseded_still_present.push(SupersededLeftover {
                    id: r.id.clone(),
                    scope: scope_name(r.scope).into(),
                    superseded_by: by.clone(),
                    chars: r.content.chars().count(),
                });
            }
        }
        if r.is_usable(now) {
            rep.prompt_chars += r.content.chars().count() + 1;
            rep.prompt_records += 1;
        }
        if !matches!(r.status, Status::Active) {
            continue;
        }
        let quiet = || Quiet { id: r.id.clone(), scope: scope_name(r.scope).into(), excerpt: excerpt(&r.content) };
        if r.use_count == 0 && r.last_used_at.is_none() {
            rep.never_recalled.push(quiet());
        }
        if !r.pinned && last_touch(r) < cutoff {
            rep.stale.push(quiet());
        }
    }

    // Near-duplicates: live (not forgotten, not superseded) records that share
    // a scope, and for project and chat scope the same project or chat.
    #[allow(clippy::type_complexity)]
    let mut groups: BTreeMap<(Scope, Option<&str>, Option<&str>), Vec<&MemoryRecord>> = BTreeMap::new();
    for r in &sorted {
        if matches!(r.status, Status::Deleted | Status::Superseded { .. }) || r.content.trim().is_empty() {
            continue;
        }
        groups.entry((r.scope, r.project_id.as_deref(), r.session_id.as_deref())).or_default().push(r);
    }
    for ((scope, _, _), group) in groups {
        if group.len() > MAX_PAIRWISE {
            let name = scope_name(scope).to_string();
            if !rep.skipped_duplicate_scan.contains(&name) {
                rep.skipped_duplicate_scan.push(name);
            }
            continue;
        }
        let toks: Vec<Vec<String>> = group.iter().map(|r| tokens(&r.content)).collect();
        for i in 0..group.len() {
            for j in (i + 1)..group.len() {
                let kind = if toks[i] == toks[j] {
                    "identical"
                } else if overlap(&toks[i], &toks[j]) >= NEAR_DUPLICATE_OVERLAP {
                    "overlap"
                } else {
                    continue;
                };
                rep.near_duplicates.push(DuplicatePair {
                    scope: scope_name(scope).into(),
                    a: group[i].id.clone(),
                    b: group[j].id.clone(),
                    kind,
                    excerpt: excerpt(&group[i].content),
                });
            }
        }
    }
    rep
}

/// Plain-text rendering of the report.
pub fn render(rep: &AuditReport) -> String {
    fn map(m: &BTreeMap<String, usize>) -> String {
        if m.is_empty() {
            return "none".into();
        }
        m.iter().map(|(k, v)| format!("{k} {v}")).collect::<Vec<_>>().join(", ")
    }
    let mut o = String::new();
    o.push_str(&format!("Memory audit: {} record(s)\n", rep.total));
    o.push_str(&format!("  by scope:   {}\n", map(&rep.by_scope)));
    o.push_str(&format!("  by creator: {}\n", map(&rep.by_creator)));
    o.push_str(&format!("  by status:  {}\n", map(&rep.by_status)));
    o.push_str(&format!(
        "  prompt cost: up to {} chars across {} usable record(s)\n",
        rep.prompt_chars, rep.prompt_records
    ));
    o.push_str(&format!("Near-duplicates: {}\n", rep.near_duplicates.len()));
    for d in &rep.near_duplicates {
        o.push_str(&format!("  [{}] {} ~ {} ({}): {}\n", d.scope, d.a, d.b, d.kind, d.excerpt));
    }
    for s in &rep.skipped_duplicate_scan {
        o.push_str(&format!("  (duplicate scan skipped for {s}: too many records)\n"));
    }
    o.push_str(&format!("Superseded but still stored: {}\n", rep.superseded_still_present.len()));
    for s in &rep.superseded_still_present {
        o.push_str(&format!("  [{}] {} replaced by {} ({} chars)\n", s.scope, s.id, s.superseded_by, s.chars));
    }
    o.push_str(&format!("Never recalled: {}\n", rep.never_recalled.len()));
    for q in &rep.never_recalled {
        o.push_str(&format!("  [{}] {}: {}\n", q.scope, q.id, q.excerpt));
    }
    o.push_str(&format!("Not touched for over {} days: {}\n", rep.stale_days, rep.stale.len()));
    for q in &rep.stale {
        o.push_str(&format!("  [{}] {}: {}\n", q.scope, q.id, q.excerpt));
    }
    o
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::record::Origin;

    fn rec(id: &str, content: &str, scope: Scope) -> MemoryRecord {
        MemoryRecord::new(MemoryId::new(id), content, scope, Creator::User, Origin::Explicit, 1_000)
    }
    const DAY: i64 = 86_400;

    #[test]
    fn counts_by_scope_creator_and_status() {
        let mut a = rec("a", "alpha one", Scope::User);
        a.creator = Creator::Agent;
        let b = rec("b", "beta two", Scope::Project);
        let mut c = rec("c", "gamma", Scope::Project);
        c.status = Status::Deleted;
        c.content.clear();
        let r = audit(&[a, b, c], 2_000, 90);
        assert_eq!(r.total, 3);
        assert_eq!(r.by_scope["project"], 2);
        assert_eq!(r.by_scope["user"], 1);
        assert_eq!(r.by_creator["agent"], 1);
        assert_eq!(r.by_creator["user"], 2);
        assert_eq!(r.by_status["forgotten"], 1);
        assert_eq!(r.by_status["active"], 2);
    }

    #[test]
    fn finds_identical_and_overlapping_pairs_within_a_scope_only() {
        let a = rec("a", "Use yarn, not npm.", Scope::User);
        let b = rec("b", "use  YARN not npm", Scope::User);
        // 9 shared words of 10 -> 0.9
        let c = rec("c", "one two three four five six seven eight nine", Scope::User);
        let d = rec("d", "one two three four five six seven eight nine ten", Scope::User);
        let other_scope = rec("e", "Use yarn, not npm.", Scope::Project);
        let r = audit(&[a, b, c, d, other_scope], 2_000, 90);
        let kinds: Vec<(&str, &str, &str)> =
            r.near_duplicates.iter().map(|p| (p.a.as_str(), p.b.as_str(), p.kind)).collect();
        assert_eq!(kinds, vec![("a", "b", "identical"), ("c", "d", "overlap")]);
    }

    #[test]
    fn overlap_below_the_threshold_is_not_a_duplicate() {
        let a = rec("a", "one two three four five", Scope::User);
        let b = rec("b", "one two three four six", Scope::User);
        assert!(audit(&[a, b], 2_000, 90).near_duplicates.is_empty());
        assert_eq!(overlap(&[], &[]), 0.0);
    }

    #[test]
    fn project_records_of_different_projects_are_not_compared() {
        let mut a = rec("a", "same words here", Scope::Project);
        a.project_id = Some("p1".into());
        let mut b = rec("b", "same words here", Scope::Project);
        b.project_id = Some("p2".into());
        assert!(audit(&[a, b], 2_000, 90).near_duplicates.is_empty());
    }

    #[test]
    fn superseded_with_text_is_reported_and_not_paired_or_costed() {
        let mut old = rec("old", "Use npm", Scope::User);
        old.status = Status::Superseded { by: MemoryId::new("new") };
        let new = rec("new", "Use npm", Scope::User);
        let r = audit(&[old, new], 2_000, 90);
        assert_eq!(r.superseded_still_present.len(), 1);
        assert_eq!(r.superseded_still_present[0].superseded_by.as_str(), "new");
        assert!(r.near_duplicates.is_empty());
        assert_eq!(r.prompt_records, 1);
    }

    #[test]
    fn never_recalled_and_stale() {
        let mut used = rec("used", "used", Scope::User);
        used.use_count = 2;
        used.last_used_at = Some(1_000 + 200 * DAY);
        let fresh = rec("fresh", "fresh", Scope::User);
        let mut pinned = rec("pinned", "pinned old", Scope::User);
        pinned.pinned = true;
        let now = 1_000 + 200 * DAY;
        let r = audit(&[used, fresh, pinned], now, 90);
        let never: Vec<&str> = r.never_recalled.iter().map(|q| q.id.as_str()).collect();
        assert_eq!(never, ["fresh", "pinned"]);
        let stale: Vec<&str> = r.stale.iter().map(|q| q.id.as_str()).collect();
        assert_eq!(stale, ["fresh"], "used is recent by last_used_at, pinned is exempt");
    }

    #[test]
    fn prompt_cost_counts_usable_records_with_a_separator_each() {
        let a = rec("a", "12345", Scope::User); // 5 + 1
        let mut b = rec("b", "abc", Scope::User); // 3 + 1
        let mut expired = rec("x", "zzzzzzzz", Scope::User);
        expired.expires_at = Some(1_500);
        let mut proposed = rec("p", "nope", Scope::User);
        proposed.status = Status::Proposed { reason: "r".into() };
        b.creator = Creator::Import;
        let r = audit(&[a, b, expired, proposed], 2_000, 90);
        assert_eq!((r.prompt_chars, r.prompt_records), (10, 2));
    }

    #[test]
    fn the_report_is_stable_for_any_input_order_and_serialises() {
        let a = rec("a", "same text", Scope::User);
        let b = rec("b", "same text", Scope::User);
        let fwd = audit(&[a.clone(), b.clone()], 2_000, 90);
        let rev = audit(&[b, a], 2_000, 90);
        assert_eq!(fwd, rev);
        let v = serde_json::to_value(&fwd).unwrap();
        assert_eq!(v["near_duplicates"][0]["kind"], "identical");
        assert!(render(&fwd).contains("Near-duplicates: 1"));
    }

    #[test]
    fn an_empty_store_gives_an_empty_report() {
        let r = audit(&[], 0, 90);
        assert_eq!((r.total, r.prompt_chars), (0, 0));
        assert!(render(&r).contains("0 record(s)"));
    }
}
