//! Creating a memory, and refusing to create the wrong one.
//!
//! Everything a user or an agent asks to remember comes through here. The
//! renderer never writes a record: it asks for a [`Proposal`] to be reviewed,
//! shows what comes back, and then asks for the reviewed version to be saved.
//! That ordering is the point -- a renderer that could write straight to the
//! store would be able to create a trusted memory without any of the checks
//! below, and "trusted" is the whole difference between a memory and a note.
//!
//! Two refusals are absolute and apply whether the user asked or an agent
//! proposed: content that carries a credential, and content saved into a scope
//! it does not belong to. The first is refused because a memory is injected
//! into every future prompt, so a secret stored here is a secret leaked
//! repeatedly and silently. The second is refused because project-specific
//! knowledge quietly promoted to "across chats" is how one project's
//! conventions start being applied to another.

use super::record::{
    content_hash, detect_conflicts, normalise, Conflict, Creator, MemoryId, MemoryRecord, Origin,
    Scope, Status,
};
use super::store;
use crate::secrets;

/// Why a proposed memory cannot be saved as asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// Nothing to remember.
    Empty,
    /// The content held a credential. Never stored, not even redacted, when the
    /// secret *is* the content.
    ContainsSecret,
    /// The scope needs an id the caller did not supply.
    MissingScopeIdentity(Scope),
    /// Longer than a memory should ever be. A memory is a fact, not a document.
    TooLong { limit: usize },
}

impl Refusal {
    pub fn message(&self) -> String {
        match self {
            Refusal::Empty => "there is nothing to remember".to_string(),
            Refusal::ContainsSecret => {
                "this looks like a credential, and a memory is added to every future prompt"
                    .to_string()
            }
            Refusal::MissingScopeIdentity(scope) => format!(
                "a {} memory needs to know which {} it belongs to",
                match scope {
                    Scope::Session => "chat",
                    Scope::Project => "project",
                    Scope::User => "user",
                },
                match scope {
                    Scope::Session => "chat",
                    Scope::Project => "project",
                    Scope::User => "user",
                }
            ),
            Refusal::TooLong { limit } => {
                format!("a memory should be a fact, not a document (over {limit} characters)")
            }
        }
    }
}

/// A memory should be a fact worth re-reading in every future prompt. Past this
/// it is a document, and documents belong in a note or a file.
const MAX_CONTENT_CHARS: usize = 2_000;

/// What the user is asked to confirm before anything is stored.
///
/// Carries everything the review surface needs, so the UI never has to compute
/// a judgement of its own that could disagree with the backend's.
#[derive(Debug, Clone, PartialEq)]
pub struct Proposal {
    /// The record that would be saved, after normalisation and redaction.
    pub record: MemoryRecord,
    /// Existing records with identical content, which this would duplicate.
    pub duplicates: Vec<MemoryId>,
    /// Existing records this would contradict.
    pub conflicts: Vec<Conflict>,
    /// True when the redactor changed the content on the way in.
    pub redacted: bool,
}

/// Build a reviewable proposal, or say why not.
///
/// Does not write. Nothing reaches the store until [`commit`] is called with a
/// proposal the user has seen.
#[allow(clippy::too_many_arguments)]
pub fn propose(
    id: MemoryId,
    content: &str,
    scope: Scope,
    project_id: Option<&str>,
    session_id: Option<&str>,
    creator: Creator,
    origin: Origin,
    now: i64,
    existing: &[MemoryRecord],
) -> Result<Proposal, Refusal> {
    let content = normalise(content);
    if content.is_empty() {
        return Err(Refusal::Empty);
    }
    if content.chars().count() > MAX_CONTENT_CHARS {
        return Err(Refusal::TooLong {
            limit: MAX_CONTENT_CHARS,
        });
    }

    // Refused, not redacted. Redaction is right for tool output that happens to
    // contain a key; here the credential is what the caller asked to remember,
    // and storing a redacted husk of it would leave a memory that says nothing
    // while implying something was kept.
    if !secrets::scan_text(&content).is_empty() {
        return Err(Refusal::ContainsSecret);
    }

    // A scope without its identity would apply to nothing or, worse, to
    // everything. Refused here rather than stored and silently ignored.
    match scope {
        Scope::Project if project_id.is_none() => {
            return Err(Refusal::MissingScopeIdentity(scope))
        }
        Scope::Session if session_id.is_none() => {
            return Err(Refusal::MissingScopeIdentity(scope))
        }
        _ => {}
    }

    // Belt and braces: the redactor runs over the content that will be stored,
    // so anything the scanner classifies differently from `scan_text` still
    // cannot reach the store verbatim.
    let redacted_text = secrets::redact_secrets(&content);
    let redacted = redacted_text != content;

    let mut record = MemoryRecord::new(id, &redacted_text, scope, creator, origin, now);
    record.project_id = match scope {
        Scope::Project => project_id.map(str::to_string),
        _ => None,
    };
    record.session_id = match scope {
        Scope::Session => session_id.map(str::to_string),
        _ => None,
    };
    record.redacted = redacted;

    let hash = content_hash(&redacted_text);
    let duplicates = existing
        .iter()
        .filter(|r| r.content_hash == hash && matches!(r.status, Status::Active))
        .map(|r| r.id.clone())
        .collect();

    // Conflicts are looked for against the records this one would sit beside.
    let mut together: Vec<MemoryRecord> = existing
        .iter()
        .filter(|r| matches!(r.status, Status::Active))
        .cloned()
        .collect();
    together.push(record.clone());
    let conflicts = detect_conflicts(&together)
        .into_iter()
        .filter(|c| c.left == record.id || c.right == record.id)
        .collect();

    Ok(Proposal {
        record,
        duplicates,
        conflicts,
        redacted,
    })
}

/// Persist a reviewed proposal.
///
/// Takes the proposal rather than raw fields, so what is stored is what was
/// shown. A caller cannot review one thing and commit another without building
/// a second proposal, which would be checked again.
pub fn commit(store_root: &std::path::Path, proposal: &Proposal) -> Result<MemoryId, String> {
    store::upsert(store_root, &proposal.record)?;
    Ok(proposal.record.id.clone())
}

/// Forget a memory, keeping it recoverable for a short while.
///
/// Marks it deleted rather than removing the line, so it leaves retrieval
/// immediately and undo can restore the same record -- the same id, the same
/// provenance -- instead of creating an unrelated duplicate that has lost its
/// history.
pub fn forget(
    store_root: &std::path::Path,
    scope: Scope,
    id: &MemoryId,
    now: i64,
) -> Result<bool, String> {
    let mut records = store::load(store_root, scope).records;
    let Some(record) = records.iter_mut().find(|r| &r.id == id) else {
        return Ok(false);
    };
    record.status = Status::Deleted;
    record.updated_at = now;
    store::save(store_root, scope, &records)?;
    Ok(true)
}

/// Restore a forgotten memory.
pub fn restore(
    store_root: &std::path::Path,
    scope: Scope,
    id: &MemoryId,
    now: i64,
) -> Result<bool, String> {
    let mut records = store::load(store_root, scope).records;
    let Some(record) = records.iter_mut().find(|r| &r.id == id) else {
        return Ok(false);
    };
    if !matches!(record.status, Status::Deleted) {
        return Ok(false);
    }
    record.status = Status::Active;
    record.updated_at = now;
    store::save(store_root, scope, &records)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn unique_root() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("jan_memcreate_{}_{}", std::process::id(), n))
    }

    fn propose_user(content: &str, existing: &[MemoryRecord]) -> Result<Proposal, Refusal> {
        propose(
            MemoryId::new("m1"),
            content,
            Scope::User,
            None,
            None,
            Creator::User,
            Origin::Explicit,
            1_000,
            existing,
        )
    }

    #[test]
    fn an_ordinary_fact_is_proposed_cleanly() {
        let p = propose_user("The user prefers yarn", &[]).unwrap();
        assert_eq!(p.record.content, "The user prefers yarn");
        assert!(p.duplicates.is_empty());
        assert!(p.conflicts.is_empty());
        assert!(!p.redacted);
    }

    #[test]
    fn nothing_to_remember_is_refused() {
        assert_eq!(propose_user("   \n  ", &[]), Err(Refusal::Empty));
    }

    #[test]
    fn an_over_long_memory_is_refused() {
        let long = "x".repeat(MAX_CONTENT_CHARS + 1);
        assert!(matches!(
            propose_user(&long, &[]),
            Err(Refusal::TooLong { .. })
        ));
    }

    /// The refusal that matters most: a memory is replayed into every future
    /// prompt, so a credential here leaks repeatedly and silently.
    #[test]
    fn a_credential_is_refused_outright() {
        for secret in [
            // Deliberately not AWS's published example key: that literally
            // contains "EXAMPLE", which the scanner treats as a placeholder --
            // correctly, since flagging placeholders trains people to ignore
            // the warning that matters.
            "export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYzsRtQq41",
            "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789",
            "-----BEGIN RSA PRIVATE KEY-----",
            "DATABASE_PASSWORD=hunter2hunter2",
            "postgres://admin:s3cr3tpassword@db.internal:5432/app",
        ] {
            assert_eq!(
                propose_user(secret, &[]),
                Err(Refusal::ContainsSecret),
                "stored a credential: {secret}"
            );
        }
    }

    /// A scope with no identity would apply nowhere or everywhere. Neither is
    /// acceptable, so it is refused rather than quietly stored.
    #[test]
    fn a_scope_without_its_identity_is_refused() {
        let project = propose(
            MemoryId::new("m1"),
            "x",
            Scope::Project,
            None,
            None,
            Creator::User,
            Origin::Explicit,
            1_000,
            &[],
        );
        assert_eq!(project, Err(Refusal::MissingScopeIdentity(Scope::Project)));

        let session = propose(
            MemoryId::new("m1"),
            "x",
            Scope::Session,
            None,
            None,
            Creator::User,
            Origin::Explicit,
            1_000,
            &[],
        );
        assert_eq!(session, Err(Refusal::MissingScopeIdentity(Scope::Session)));
    }

    /// Project-specific knowledge must not become user-global by accident: the
    /// project id is dropped when the scope is not a project one, so a
    /// mis-addressed save cannot smuggle it across.
    #[test]
    fn a_user_memory_carries_no_project_or_session_identity() {
        let p = propose(
            MemoryId::new("m1"),
            "a global preference",
            Scope::User,
            Some("p1"),
            Some("s1"),
            Creator::User,
            Origin::Explicit,
            1_000,
            &[],
        )
        .unwrap();
        assert_eq!(p.record.project_id, None);
        assert_eq!(p.record.session_id, None);
    }

    #[test]
    fn duplicates_are_reported_before_saving() {
        let existing = MemoryRecord::new(
            MemoryId::new("old"),
            "The user prefers yarn",
            Scope::User,
            Creator::User,
            Origin::Explicit,
            500,
        );
        let p = propose_user("The user prefers yarn", std::slice::from_ref(&existing)).unwrap();
        assert_eq!(p.duplicates, vec![MemoryId::new("old")]);
    }

    #[test]
    fn conflicts_are_reported_before_saving() {
        let existing = MemoryRecord::new(
            MemoryId::new("old"),
            "Use npm for installs",
            Scope::User,
            Creator::User,
            Origin::Explicit,
            500,
        );
        let p = propose_user("Use yarn for installs", std::slice::from_ref(&existing)).unwrap();
        assert_eq!(p.conflicts.len(), 1);
        assert_eq!(p.conflicts[0].subject, "package manager");
    }

    /// A deleted record is not something a new memory duplicates or fights.
    #[test]
    fn forgotten_records_are_not_reported_as_duplicates() {
        let mut existing = MemoryRecord::new(
            MemoryId::new("old"),
            "The user prefers yarn",
            Scope::User,
            Creator::User,
            Origin::Explicit,
            500,
        );
        existing.status = Status::Deleted;
        let p = propose_user("The user prefers yarn", std::slice::from_ref(&existing)).unwrap();
        assert!(p.duplicates.is_empty());
    }

    #[test]
    fn committing_stores_exactly_what_was_reviewed() {
        let root = unique_root();
        let p = propose_user("Prefer concise answers", &[]).unwrap();
        let id = commit(&root, &p).unwrap();

        let stored = store::load(&root, Scope::User).records;
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].id, id);
        assert_eq!(stored[0].content, p.record.content);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Forgetting leaves retrieval immediately but keeps the record, so undo
    /// restores the same memory rather than an unrelated copy of its text.
    #[test]
    fn forgetting_is_undoable_and_keeps_the_same_identity() {
        let root = unique_root();
        let p = propose_user("Prefer concise answers", &[]).unwrap();
        let id = commit(&root, &p).unwrap();

        assert!(forget(&root, Scope::User, &id, 2_000).unwrap());
        let after = store::load(&root, Scope::User).records;
        assert_eq!(after.len(), 1, "the record must survive for undo");
        assert!(!after[0].is_usable(2_000), "a forgotten memory is still in use");

        assert!(restore(&root, Scope::User, &id, 3_000).unwrap());
        let restored = store::load(&root, Scope::User).records;
        assert_eq!(restored[0].id, id, "undo created a different memory");
        assert!(restored[0].is_usable(3_000));
        assert_eq!(
            restored[0].created_at, p.record.created_at,
            "undo lost the original provenance"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn forgetting_something_that_is_not_there_is_not_an_error() {
        let root = unique_root();
        assert!(!forget(&root, Scope::User, &MemoryId::new("nope"), 1).unwrap());
        assert!(!restore(&root, Scope::User, &MemoryId::new("nope"), 1).unwrap());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn restoring_a_record_that_was_never_forgotten_changes_nothing() {
        let root = unique_root();
        let p = propose_user("x", &[]).unwrap();
        let id = commit(&root, &p).unwrap();
        assert!(!restore(&root, Scope::User, &id, 2_000).unwrap());
        let _ = std::fs::remove_dir_all(&root);
    }
}
