//! The canonical memory record shared by every scope (AH-081..AH-085).
//!
//! The existing project memory (AH-080) stores a note as `<name>.md` and uses
//! the filename as its identity. That works until anything needs to be said
//! *about* a memory: where it came from, who saved it, whether it was inferred,
//! which record replaced it, whether two of them disagree. Renaming a note
//! silently creates a different memory and orphans everything that referred to
//! the old one, because the display text was the key.
//!
//! So identity here is a [`MemoryId`] that is never derived from content and
//! never changes. Content is free to be edited, moved between scopes, or
//! superseded without breaking provenance.
//!
//! This module owns the record and the rules that operate on a set of them --
//! precedence and conflict detection. It deliberately owns no I/O: persistence
//! lives beside it, so the rules can be tested without a filesystem.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Bumped whenever a stored record's shape changes incompatibly. A record from
/// a newer version is not guessed at -- see `store::load`.
pub const SCHEMA_VERSION: u32 = 1;

/// Where a memory applies, and how far it reaches.
///
/// The order is the precedence order and is deliberately encoded in the type
/// rather than in a comparison function somewhere: `Session` is the most
/// specific and wins, `User` is the broadest and loses. Adding a scope means
/// deciding where it sits here, which is the right place to have to decide it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    /// Broadest: applies to every conversation on this machine.
    User,
    /// Applies to conversations attached to one project.
    Project,
    /// Narrowest: applies to one conversation only.
    Session,
}

impl Scope {
    /// Higher wins. Not `Ord` on the enum alone, so the intent is explicit at
    /// every call site that ranks.
    pub fn specificity(self) -> u8 {
        match self {
            Scope::User => 0,
            Scope::Project => 1,
            Scope::Session => 2,
        }
    }
}

/// Who put the memory there.
///
/// The distinction that matters is trust: what the user stated themselves
/// outranks what an agent inferred or what arrived in an import, and no
/// amount of recency changes that.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Creator {
    /// The user said so.
    User,
    /// An agent proposed it.
    Agent,
    /// It came from an import or a handoff bundle.
    Import,
    /// Jan itself recorded it (a migration, a default).
    System,
}

impl Creator {
    /// Whether a record from this creator may override one the user saved.
    ///
    /// Nothing may. An agent that infers "the user prefers npm" does not get to
    /// overrule the user having said "yarn", and an import does not get to
    /// overrule either -- imported memory arrives untrusted by definition,
    /// because it came from somewhere this machine cannot vouch for.
    pub fn trust(self) -> u8 {
        match self {
            Creator::User => 3,
            Creator::System => 2,
            Creator::Agent => 1,
            Creator::Import => 0,
        }
    }
}

/// How the memory came to exist.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    /// The user explicitly asked for it to be remembered.
    Explicit,
    /// Inferred from the conversation. Never authoritative on its own.
    Inferred,
}

/// Whether a record is usable, and why not when it is not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "state", content = "detail")]
pub enum Status {
    Active,
    /// Replaced by another record, kept for provenance rather than deleted.
    Superseded { by: MemoryId },
    /// Disagrees with another applicable record and has not been resolved.
    ///
    /// Never injected: an unresolved conflict is exactly the situation where
    /// picking one and saying nothing is the wrong thing to do.
    Conflicted { with: MemoryId },
    /// Past its expiry.
    Expired,
    /// Removed by the user. Retained briefly so deletion can be undone.
    Deleted,
}

/// A stable, opaque identity. Never derived from content, never reused.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct MemoryId(String);

impl MemoryId {
    pub fn new(raw: impl Into<String>) -> Self {
        Self(raw.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for MemoryId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Where a memory came from, kept so "why does Jan remember this?" has an
/// answer that does not depend on the conversation still existing.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Provenance {
    /// The session it was saved from, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// The message it was saved from, when known. May outlive the message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    /// True once the source message is known to be gone, so the UI can say the
    /// original is unavailable instead of offering a link that goes nowhere.
    #[serde(default)]
    pub source_deleted: bool,
    /// Sessions that have used this memory, for "which chats used it".
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub used_by_sessions: Vec<String>,
}

/// One remembered thing.
///
/// `PartialEq` but not `Eq`: `confidence` is a float, and a confidence that is
/// NaN is not equal to itself. Claiming total equality over a field that has no
/// total equality would be a lie the compiler is right to refuse.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryRecord {
    pub schema_version: u32,
    pub id: MemoryId,
    /// Normalised content. Never the identity.
    pub content: String,
    /// Digest of the normalised content, for duplicate detection.
    pub content_hash: String,
    pub scope: Scope,
    /// Free-form grouping (`preference`, `convention`, `decision`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// The project this belongs to, for `Scope::Project`. A stable identity,
    /// not a path: a project that moves keeps its memories.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    /// The session this belongs to, for `Scope::Session`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub creator: Creator,
    pub origin: Origin,
    /// Only meaningful for `Origin::Inferred`; `None` when the user said it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
    #[serde(default)]
    pub pinned: bool,
    pub status: Status,
    pub provenance: Provenance,
    /// Unix seconds.
    pub created_at: i64,
    pub updated_at: i64,
    /// When the user last confirmed this is still true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_confirmed_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<i64>,
    #[serde(default)]
    pub use_count: u32,
    /// Unix seconds after which the record stops applying.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    /// The record this one replaced, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supersedes: Option<MemoryId>,
    /// True when the redactor changed the content on the way in.
    #[serde(default)]
    pub redacted: bool,
}

/// Normalise content so two spellings of the same thing hash alike.
///
/// Whitespace only. Case is left alone: "use Yarn" and "use yarn" are the same
/// instruction, but lowering the text would also lower identifiers and paths
/// inside it, and a memory that says `README.md` must not come back as
/// `readme.md`.
pub fn normalise(content: &str) -> String {
    content
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// A stable digest of normalised content. FNV-1a: it only has to be stable
/// across processes and cheap, not cryptographic -- nothing authenticates a
/// memory by its hash.
pub fn content_hash(content: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in normalise(content).as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    format!("{hash:016x}")
}

impl MemoryRecord {
    /// A new active record. Content is normalised and hashed here so no caller
    /// can construct one whose hash disagrees with its content.
    pub fn new(
        id: MemoryId,
        content: &str,
        scope: Scope,
        creator: Creator,
        origin: Origin,
        now: i64,
    ) -> Self {
        let content = normalise(content);
        let content_hash = content_hash(&content);
        Self {
            schema_version: SCHEMA_VERSION,
            id,
            content,
            content_hash,
            scope,
            category: None,
            project_id: None,
            session_id: None,
            creator,
            origin,
            confidence: None,
            pinned: false,
            status: Status::Active,
            provenance: Provenance::default(),
            created_at: now,
            updated_at: now,
            last_confirmed_at: None,
            last_used_at: None,
            use_count: 0,
            expires_at: None,
            supersedes: None,
            redacted: false,
        }
    }

    /// Whether this record may be injected at `now`.
    ///
    /// Everything that is not plainly active is excluded, including an
    /// unresolved conflict: two records that disagree are not resolved by
    /// sending both to the model and hoping.
    pub fn is_usable(&self, now: i64) -> bool {
        if !matches!(self.status, Status::Active) {
            return false;
        }
        match self.expires_at {
            Some(at) => now < at,
            None => true,
        }
    }

    /// Whether this record applies to the given session and project.
    ///
    /// Scope is not a hint. A session memory belongs to one session and reaches
    /// no other; a project memory reaches only conversations attached to that
    /// project. A record whose scope requires an id it does not have applies to
    /// nothing -- it cannot be matched, so it cannot leak.
    pub fn applies_to(&self, session_id: Option<&str>, project_id: Option<&str>) -> bool {
        match self.scope {
            Scope::User => true,
            Scope::Project => match (&self.project_id, project_id) {
                (Some(mine), Some(theirs)) => mine == theirs,
                _ => false,
            },
            Scope::Session => match (&self.session_id, session_id) {
                (Some(mine), Some(theirs)) => mine == theirs,
                _ => false,
            },
        }
    }
}

/// Why one record was preferred over another, kept so the choice can be shown
/// rather than merely made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrecedenceReason {
    /// Different scopes: the more specific one wins.
    MoreSpecificScope,
    /// Same scope, one is pinned.
    Pinned,
    /// The user said it; the other was inferred or imported.
    MoreTrustedCreator,
    /// The user stated it explicitly; the other was inferred.
    ExplicitOverInferred,
    /// Everything above tied; the more recently updated one wins.
    MoreRecent,
    /// Everything tied, including timestamps. Broken by id so the result does
    /// not depend on iteration order.
    StableTieBreak,
}

impl PrecedenceReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            PrecedenceReason::MoreSpecificScope => "more specific scope",
            PrecedenceReason::Pinned => "pinned",
            PrecedenceReason::MoreTrustedCreator => "saved by the user",
            PrecedenceReason::ExplicitOverInferred => "explicitly saved rather than inferred",
            PrecedenceReason::MoreRecent => "more recently updated",
            PrecedenceReason::StableTieBreak => "stable tie-break on id",
        }
    }
}

/// Decide which of two applicable records wins, and say why.
///
/// Deterministic and total: for any pair it returns the same answer whichever
/// way round it is called, and never "neither". That is what makes the result
/// independent of the order records happen to be stored or iterated in, which
/// is the property the mutation tests below actually check.
pub fn prefer<'a>(
    a: &'a MemoryRecord,
    b: &'a MemoryRecord,
) -> (&'a MemoryRecord, PrecedenceReason) {
    // 1. Scope. A session memory beats a project memory beats a user memory.
    match a.scope.specificity().cmp(&b.scope.specificity()) {
        std::cmp::Ordering::Greater => return (a, PrecedenceReason::MoreSpecificScope),
        std::cmp::Ordering::Less => return (b, PrecedenceReason::MoreSpecificScope),
        std::cmp::Ordering::Equal => {}
    }

    // 2. Pinning, but only within a scope -- a pinned user memory does not
    //    outrank a project one, or pinning would be a way to widen reach.
    match (a.pinned, b.pinned) {
        (true, false) => return (a, PrecedenceReason::Pinned),
        (false, true) => return (b, PrecedenceReason::Pinned),
        _ => {}
    }

    // 3. Who saved it. Nothing inferred or imported overrides the user.
    match a.creator.trust().cmp(&b.creator.trust()) {
        std::cmp::Ordering::Greater => return (a, PrecedenceReason::MoreTrustedCreator),
        std::cmp::Ordering::Less => return (b, PrecedenceReason::MoreTrustedCreator),
        std::cmp::Ordering::Equal => {}
    }

    // 4. Explicit over inferred, for the same creator.
    match (a.origin, b.origin) {
        (Origin::Explicit, Origin::Inferred) => {
            return (a, PrecedenceReason::ExplicitOverInferred)
        }
        (Origin::Inferred, Origin::Explicit) => {
            return (b, PrecedenceReason::ExplicitOverInferred)
        }
        _ => {}
    }

    // 5. Recency, last: newer is a weak signal and must not beat any of the
    //    above. In particular it must not let a fresh inference overwrite a
    //    pinned record the user set deliberately.
    match a.updated_at.cmp(&b.updated_at) {
        std::cmp::Ordering::Greater => return (a, PrecedenceReason::MoreRecent),
        std::cmp::Ordering::Less => return (b, PrecedenceReason::MoreRecent),
        std::cmp::Ordering::Equal => {}
    }

    // 6. Fully tied. Break on id so two runs agree.
    if a.id <= b.id {
        (a, PrecedenceReason::StableTieBreak)
    } else {
        (b, PrecedenceReason::StableTieBreak)
    }
}

/// Records that make incompatible claims about the same subject.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conflict {
    pub left: MemoryId,
    pub right: MemoryId,
    /// The subject both are about, for the resolution UI.
    pub subject: String,
}

/// Instruction pairs that cannot both be followed. Compared on the normalised
/// content, so this catches the disagreements a user would recognise as one.
const INCOMPATIBLE: &[(&str, &str, &str)] = &[
    ("npm", "yarn", "package manager"),
    ("npm", "pnpm", "package manager"),
    ("yarn", "pnpm", "package manager"),
    ("briefly", "detailed", "response length"),
    ("brief", "verbose", "response length"),
    ("concise", "verbose", "response length"),
    ("tabs", "spaces", "indentation"),
];

/// Find conflicts among applicable records.
///
/// Deliberately conservative: it reports a pair only when both records mention
/// opposite sides of a known incompatible choice. A false conflict is worse
/// than a missed one here, because an unresolved conflict suppresses both
/// records -- being noisy would quietly stop good memories being used.
pub fn detect_conflicts(records: &[MemoryRecord]) -> Vec<Conflict> {
    let mut out = Vec::new();
    for (i, a) in records.iter().enumerate() {
        for b in records.iter().skip(i + 1) {
            // Records that cannot apply together cannot conflict: a memory in
            // another session or project is not in the argument.
            if a.scope != b.scope && a.project_id != b.project_id && a.session_id != b.session_id {
                continue;
            }
            let (ta, tb) = (a.content.to_lowercase(), b.content.to_lowercase());
            for (left, right, subject) in INCOMPATIBLE {
                let a_left = mentions(&ta, left) && !mentions(&ta, right);
                let b_right = mentions(&tb, right) && !mentions(&tb, left);
                let a_right = mentions(&ta, right) && !mentions(&ta, left);
                let b_left = mentions(&tb, left) && !mentions(&tb, right);
                if (a_left && b_right) || (a_right && b_left) {
                    out.push(Conflict {
                        left: a.id.clone(),
                        right: b.id.clone(),
                        subject: (*subject).to_string(),
                    });
                    break;
                }
            }
        }
    }
    out
}

/// Whole-word containment, so "npm" does not match inside "npmrc-free".
fn mentions(haystack: &str, needle: &str) -> bool {
    haystack
        .split(|c: char| !c.is_alphanumeric())
        .any(|word| word == needle)
}

/// Drop records that say the same thing, keeping the one precedence prefers.
///
/// Duplicates are decided on the content hash, not on display text or id, so a
/// memory saved twice in two scopes collapses to the one that actually applies.
pub fn deduplicate(records: Vec<MemoryRecord>) -> Vec<MemoryRecord> {
    let mut best: BTreeMap<String, MemoryRecord> = BTreeMap::new();
    for record in records {
        match best.remove(&record.content_hash) {
            Some(existing) => {
                let keep = {
                    let (winner, _) = prefer(&existing, &record);
                    winner.id.clone()
                };
                best.insert(
                    record.content_hash.clone(),
                    if keep == existing.id { existing } else { record },
                );
            }
            None => {
                best.insert(record.content_hash.clone(), record);
            }
        }
    }
    best.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(id: &str, content: &str, scope: Scope) -> MemoryRecord {
        MemoryRecord::new(
            MemoryId::new(id),
            content,
            scope,
            Creator::User,
            Origin::Explicit,
            1_000,
        )
    }

    #[test]
    fn identity_is_not_content() {
        let a = rec("m1", "Use yarn", Scope::User);
        let mut b = a.clone();
        b.content = normalise("Use yarn, always");
        b.content_hash = content_hash(&b.content);
        // Editing content leaves identity alone, so provenance survives.
        assert_eq!(a.id, b.id);
        assert_ne!(a.content_hash, b.content_hash);
    }

    #[test]
    fn normalisation_ignores_whitespace_but_not_case() {
        assert_eq!(content_hash("Use yarn"), content_hash("  Use yarn  \n"));
        assert_eq!(content_hash("a\nb"), content_hash("a   \nb"));
        assert_ne!(content_hash("Use yarn"), content_hash("use yarn"));
    }

    #[test]
    fn session_memory_never_reaches_another_session() {
        let mut m = rec("m1", "x", Scope::Session);
        m.session_id = Some("s1".into());
        assert!(m.applies_to(Some("s1"), None));
        assert!(!m.applies_to(Some("s2"), None));
        assert!(!m.applies_to(None, None));
    }

    #[test]
    fn project_memory_never_reaches_another_project() {
        let mut m = rec("m1", "x", Scope::Project);
        m.project_id = Some("p1".into());
        assert!(m.applies_to(None, Some("p1")));
        assert!(!m.applies_to(None, Some("p2")));
        // A similarly named project is a different id, so it does not match.
        assert!(!m.applies_to(None, Some("p1-old")));
        assert!(!m.applies_to(None, None));
    }

    #[test]
    fn user_memory_reaches_every_conversation() {
        let m = rec("m1", "x", Scope::User);
        assert!(m.applies_to(None, None));
        assert!(m.applies_to(Some("s9"), Some("p9")));
    }

    /// A scoped record with no id of its own matches nothing rather than
    /// everything: failing open here would leak one session into all of them.
    #[test]
    fn a_scoped_record_without_its_id_applies_to_nothing() {
        let session = rec("m1", "x", Scope::Session);
        let project = rec("m2", "x", Scope::Project);
        assert!(!session.applies_to(Some("s1"), Some("p1")));
        assert!(!project.applies_to(Some("s1"), Some("p1")));
    }

    #[test]
    fn only_active_unexpired_records_are_usable() {
        let mut m = rec("m1", "x", Scope::User);
        assert!(m.is_usable(1_000));

        m.expires_at = Some(2_000);
        assert!(m.is_usable(1_999));
        assert!(!m.is_usable(2_000));

        m.expires_at = None;
        for status in [
            Status::Superseded { by: MemoryId::new("m2") },
            Status::Conflicted { with: MemoryId::new("m2") },
            Status::Expired,
            Status::Deleted,
        ] {
            m.status = status;
            assert!(!m.is_usable(1_000), "{:?} was usable", m.status);
        }
    }

    #[test]
    fn scope_specificity_orders_session_over_project_over_user() {
        let session = rec("a", "x", Scope::Session);
        let project = rec("b", "x", Scope::Project);
        let user = rec("c", "x", Scope::User);
        assert_eq!(prefer(&session, &project).1, PrecedenceReason::MoreSpecificScope);
        assert_eq!(prefer(&session, &project).0.id, session.id);
        assert_eq!(prefer(&project, &user).0.id, project.id);
        assert_eq!(prefer(&user, &session).0.id, session.id);
    }

    #[test]
    fn pinning_ranks_within_a_scope_and_does_not_widen_reach() {
        let mut pinned_user = rec("a", "x", Scope::User);
        pinned_user.pinned = true;
        let project = rec("b", "x", Scope::Project);
        // Pinning does not lift a user memory above a project one.
        assert_eq!(prefer(&pinned_user, &project).0.id, project.id);

        let plain_user = rec("c", "x", Scope::User);
        assert_eq!(prefer(&pinned_user, &plain_user).0.id, pinned_user.id);
        assert_eq!(prefer(&pinned_user, &plain_user).1, PrecedenceReason::Pinned);
    }

    /// The negative-authority case: inference and imports cannot overrule the
    /// user, however new they are.
    #[test]
    fn inferred_and_imported_memory_never_overrides_the_user() {
        let mut user_said = rec("a", "x", Scope::User);
        user_said.updated_at = 1_000;

        for creator in [Creator::Agent, Creator::Import] {
            let mut other = MemoryRecord::new(
                MemoryId::new("b"),
                "x",
                Scope::User,
                creator,
                Origin::Inferred,
                9_999,
            );
            other.updated_at = 9_999; // much newer
            let (winner, why) = prefer(&user_said, &other);
            assert_eq!(winner.id, user_said.id, "{creator:?} overrode the user");
            assert_eq!(why, PrecedenceReason::MoreTrustedCreator);
        }
    }

    #[test]
    fn newer_does_not_beat_pinned() {
        let mut pinned = rec("a", "x", Scope::User);
        pinned.pinned = true;
        pinned.updated_at = 1;
        let mut newer = rec("b", "x", Scope::User);
        newer.updated_at = 10_000;
        assert_eq!(prefer(&pinned, &newer).0.id, pinned.id);
    }

    /// The mutation test the precedence rules exist to satisfy: the answer must
    /// not depend on the order records are compared or stored in.
    #[test]
    fn precedence_is_independent_of_iteration_order() {
        let mut records = vec![
            rec("a", "x", Scope::User),
            rec("b", "x", Scope::Project),
            rec("c", "x", Scope::Session),
        ];
        records[0].pinned = true;
        records[1].updated_at = 50_000;

        let winner_of = |set: &[MemoryRecord]| -> MemoryId {
            set.iter()
                .skip(1)
                .fold(&set[0], |best, next| prefer(best, next).0)
                .id
                .clone()
        };

        let forward = winner_of(&records);
        records.reverse();
        let reversed = winner_of(&records);
        records.swap(0, 2);
        let swapped = winner_of(&records);

        assert_eq!(forward, reversed);
        assert_eq!(forward, swapped);
        assert_eq!(forward, MemoryId::new("c"), "session memory should win");
    }

    /// `prefer` must be symmetric, or a fold over a set could produce different
    /// answers for different orderings even with the rules above.
    #[test]
    fn prefer_is_symmetric_for_every_pair() {
        let mut a = rec("a", "x", Scope::Project);
        let mut b = rec("b", "x", Scope::Project);
        for (pin_a, pin_b, ua, ub) in [
            (false, false, 1, 1),
            (true, false, 1, 9),
            (false, true, 9, 1),
            (false, false, 5, 9),
        ] {
            a.pinned = pin_a;
            b.pinned = pin_b;
            a.updated_at = ua;
            b.updated_at = ub;
            assert_eq!(prefer(&a, &b).0.id, prefer(&b, &a).0.id, "asymmetric");
        }
    }

    #[test]
    fn detects_incompatible_instructions() {
        let a = rec("a", "Use npm for installs", Scope::Project);
        let mut b = rec("b", "Use yarn for installs", Scope::Project);
        b.project_id = a.project_id.clone();
        let conflicts = detect_conflicts(&[a, b]);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].subject, "package manager");
    }

    #[test]
    fn agreeing_records_are_not_conflicts() {
        let a = rec("a", "Use yarn", Scope::Project);
        let b = rec("b", "Use yarn for installs", Scope::Project);
        assert!(detect_conflicts(&[a, b]).is_empty());
    }

    /// A record that mentions both sides is describing them, not choosing one.
    #[test]
    fn a_record_naming_both_sides_is_not_in_conflict() {
        let a = rec("a", "We migrated from npm to yarn", Scope::Project);
        let b = rec("b", "Use yarn", Scope::Project);
        assert!(detect_conflicts(&[a, b]).is_empty());
    }

    #[test]
    fn whole_words_only() {
        let a = rec("a", "npmrc is checked in", Scope::Project);
        let b = rec("b", "Use yarn", Scope::Project);
        assert!(detect_conflicts(&[a, b]).is_empty());
    }

    #[test]
    fn duplicates_collapse_to_the_record_precedence_prefers() {
        let user = rec("a", "Use yarn", Scope::User);
        let mut project = rec("b", "Use yarn", Scope::Project);
        project.project_id = Some("p1".into());

        let kept = deduplicate(vec![user, project]);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].id, MemoryId::new("b"), "kept the broader record");
    }

    #[test]
    fn deduplication_is_order_independent() {
        let a = rec("a", "Use yarn", Scope::User);
        let b = rec("b", "Use yarn", Scope::Project);
        let forward = deduplicate(vec![a.clone(), b.clone()]);
        let reverse = deduplicate(vec![b, a]);
        assert_eq!(forward.len(), 1);
        assert_eq!(forward[0].id, reverse[0].id);
    }

    #[test]
    fn different_content_is_not_deduplicated() {
        let a = rec("a", "Use yarn", Scope::User);
        let b = rec("b", "Run tests before pushing", Scope::User);
        assert_eq!(deduplicate(vec![a, b]).len(), 2);
    }

    #[test]
    fn a_record_round_trips_through_json() {
        let mut m = rec("m1", "Use yarn", Scope::Project);
        m.project_id = Some("p1".into());
        m.provenance.session_id = Some("s1".into());
        m.expires_at = Some(5_000);
        m.supersedes = Some(MemoryId::new("m0"));
        let json = serde_json::to_string(&m).expect("serialise");
        let back: MemoryRecord = serde_json::from_str(&json).expect("deserialise");
        assert_eq!(m, back);
    }
}
