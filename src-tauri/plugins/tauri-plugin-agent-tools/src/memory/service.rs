//! The one entry point the renderer reaches memory through.
//!
//! Commands are thin wrappers over this. Nothing in the UI opens a JSONL file,
//! and nothing in the UI decides what it is allowed to see: every operation
//! takes an [`Access`] describing which session and project the *backend*
//! resolved, and refuses anything outside it.
//!
//! Two rules shape the whole module.
//!
//! **Listing fails closed.** Asking for memories without naming a scope you are
//! entitled to returns nothing, not everything. A renderer bug that forgets to
//! pass the session must not become a window onto every conversation the user
//! has ever had.
//!
//! **What leaves is a DTO, never a record.** [`MemoryView`] is built for
//! display: it carries the content that was already redacted on the way in, and
//! it cannot carry anything the record does not. Returning the record itself
//! would mean every future field is exposed to the renderer by default, which
//! is the wrong direction for a type that holds whatever the user typed.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::record::{MemoryId, MemoryRecord, Scope, Status};
use super::store;

/// What the caller is entitled to see, resolved by the backend.
///
/// Not supplied by the renderer as a claim to be trusted: the commands build
/// this from canonical state, and the renderer's own idea of the session is
/// only ever a request that has to match.
#[derive(Debug, Clone, Default)]
pub struct Access {
    pub session_id: Option<String>,
    pub project_id: Option<String>,
    /// The project's own store, when a project is open.
    pub project_store: Option<PathBuf>,
    /// The permanent store holding user and session records.
    pub permanent_store: Option<PathBuf>,
    /// Why the named project folder was not usable for memory, when it was
    /// refused (a link, the data folder, a path that does not resolve).
    pub project_refused: Option<String>,
}

impl Access {
    /// Where records of this scope live, or `None` when the caller has no
    /// standing to see that scope at all.
    pub(crate) fn store_for(&self, scope: Scope) -> Option<&Path> {
        match scope {
            Scope::Project => self.project_store.as_deref(),
            Scope::User | Scope::Session => self.permanent_store.as_deref(),
        }
    }

    /// Whether a record is within what this caller may see.
    ///
    /// The same containment the prompt path applies, enforced again here
    /// because a management surface is a second way to read memory and must not
    /// be a weaker one.
    pub(crate) fn may_see(&self, record: &MemoryRecord) -> bool {
        match record.scope {
            Scope::User => true,
            Scope::Project => match (&record.project_id, &self.project_id) {
                (Some(mine), Some(theirs)) => mine == theirs,
                _ => false,
            },
            Scope::Session => match (&record.session_id, &self.session_id) {
                (Some(mine), Some(theirs)) => mine == theirs,
                _ => false,
            },
        }
    }
}

/// Why an operation was refused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "detail")]
pub enum Denied {
    /// The caller has no standing in that scope here.
    ScopeUnavailable(String),
    /// The record exists but belongs to another session or project.
    OutOfScope,
    /// No record with that id in that scope.
    NotFound,
    /// The record changed since the caller last saw it.
    Stale,
    Storage(String),
}

impl Denied {
    pub fn message(&self) -> String {
        match self {
            Denied::ScopeUnavailable(scope) => {
                format!("no {scope} is open, so {scope} memories are not available here")
            }
            Denied::OutOfScope => "that memory belongs to another chat or project".to_string(),
            Denied::NotFound => "that memory no longer exists".to_string(),
            Denied::Stale => {
                "that memory changed while you were looking at it; reload and try again".to_string()
            }
            Denied::Storage(e) => e.clone(),
        }
    }
}

pub(super) fn scope_word(scope: Scope) -> &'static str {
    match scope {
        Scope::Session => "chat",
        Scope::Project => "project",
        Scope::User => "user",
    }
}

/// A memory as the UI sees it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryView {
    pub id: String,
    pub content: String,
    pub scope: String,
    pub creator: String,
    pub origin: String,
    pub status: String,
    pub pinned: bool,
    pub redacted: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_used_at: Option<i64>,
    pub use_count: u32,
    pub expires_at: Option<i64>,
    pub category: Option<String>,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    /// Source session, when the record knows one and the caller may see it.
    pub source_session_id: Option<String>,
    pub source_message_id: Option<String>,
    pub source_deleted: bool,
    pub supersedes: Option<String>,
    /// A short preview for a dense list, so the renderer never has to truncate
    /// content itself and accidentally cut a redaction marker in half.
    pub preview: String,
    /// `None` when the record predates versions: shown as unknown.
    pub version: Option<u32>,
    pub content_hash: String,
    /// "user-authored", "agent-authored", "imported", "extracted" or "system".
    pub source_type: String,
    pub source_run_id: Option<String>,
    pub source_project_id: Option<String>,
    pub history: Vec<super::record::Revision>,
    /// The most recent dispatches that carried it, newest last.
    pub uses: Vec<super::record::MemoryUse>,
    /// Set for an imported memory: the export it came in and its origin there.
    pub imported_from: Option<super::record::ImportedFrom>,
}

fn preview_of(content: &str) -> String {
    const MAX: usize = 140;
    let first = content.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    if first.chars().count() <= MAX {
        return first.to_string();
    }
    let mut out: String = first.chars().take(MAX).collect();
    out.push('…');
    out
}

impl MemoryView {
    pub(crate) fn from_record(record: &MemoryRecord) -> Self {
        Self {
            id: record.id.to_string(),
            content: record.content.clone(),
            scope: scope_word(record.scope).to_string(),
            creator: format!("{:?}", record.creator).to_lowercase(),
            origin: format!("{:?}", record.origin).to_lowercase(),
            status: match &record.status {
                Status::Active => "active".to_string(),
                Status::Superseded { .. } => "superseded".to_string(),
                Status::Conflicted { .. } => "conflicted".to_string(),
                Status::Expired => "expired".to_string(),
                Status::Deleted => "deleted".to_string(),
                // The card keys off this, and off `pendingReason` below, to
                // show the proposal as a question rather than a memory.
                Status::Proposed { .. } => "proposed".to_string(),
            },
            pinned: record.pinned,
            redacted: record.redacted,
            created_at: record.created_at,
            updated_at: record.updated_at,
            last_used_at: record.last_used_at,
            use_count: record.use_count,
            expires_at: record.expires_at,
            category: record.category.clone(),
            project_id: record.project_id.clone(),
            session_id: record.session_id.clone(),
            source_session_id: record.provenance.session_id.clone(),
            source_message_id: record.provenance.message_id.clone(),
            source_deleted: record.provenance.source_deleted,
            supersedes: record.supersedes.as_ref().map(MemoryId::to_string),
            preview: preview_of(&record.content),
            version: record.version,
            content_hash: record.content_hash.clone(),
            source_type: record.source_type().to_string(),
            source_run_id: record.provenance.run_id.clone(),
            source_project_id: record.provenance.source_project_id.clone(),
            history: record.history.clone(),
            uses: record.provenance.uses.clone(),
            imported_from: record.provenance.imported_from.clone(),
        }
    }
}

/// One page of memories.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub items: Vec<MemoryView>,
    /// Total matching before paging, so the UI can say "12 of 340".
    pub total: usize,
    pub offset: usize,
}

/// How much of a store a single call may return.
///
/// A store can grow without limit, and handing all of it to the renderer at
/// once is how a settings page becomes unusable on the machine that needs it
/// most. Callers page; they do not get an unbounded list by asking nicely.
const MAX_PAGE: usize = 200;

/// List one scope, newest first.
///
/// Fails closed: a scope the caller has no standing in is a refusal, not an
/// empty list, so a renderer that forgets to pass the session is told rather
/// than quietly shown nothing (or, worse, everything).
pub fn list(
    access: &Access,
    scope: Scope,
    query: Option<&str>,
    offset: usize,
    limit: usize,
) -> Result<Page, Denied> {
    if scope == Scope::Project {
        if let Some(why) = &access.project_refused {
            return Err(Denied::ScopeUnavailable(format!("project: {why}")));
        }
    }
    let store_root = access
        .store_for(scope)
        .ok_or_else(|| Denied::ScopeUnavailable(scope_word(scope).to_string()))?;

    // A scoped listing needs the identity that scope is keyed by. Without it
    // there is nothing legitimate to return.
    match scope {
        Scope::Project if access.project_id.is_none() => {
            return Err(Denied::ScopeUnavailable("project".into()))
        }
        Scope::Session if access.session_id.is_none() => {
            return Err(Denied::ScopeUnavailable("chat".into()))
        }
        _ => {}
    }

    let needle = query
        .map(|q| q.trim().to_lowercase())
        .filter(|q| !q.is_empty());
    let mut matching: Vec<MemoryRecord> = store::load(store_root, scope)
        .records
        .into_iter()
        .filter(|r| access.may_see(r))
        // A proposal is a question, not a memory. It has its own list and its
        // own card; showing it here would put something nobody has agreed to
        // among the things Jan says it remembers.
        .filter(|r| !matches!(r.status, super::record::Status::Proposed { .. }))
        // A forgotten memory is a tombstone with no text left. Listing it
        // among "what Jan remembers" would contradict the forget; undo is the
        // toast's job, holding the text the tombstone no longer has.
        .filter(|r| !matches!(r.status, super::record::Status::Deleted))
        .filter(|r| match &needle {
            Some(q) => r.content.to_lowercase().contains(q),
            None => true,
        })
        .collect();

    matching.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));

    let total = matching.len();
    let limit = limit.clamp(1, MAX_PAGE);
    let items = matching
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|r| MemoryView::from_record(&r))
        .collect();
    Ok(Page {
        items,
        total,
        offset,
    })
}

/// One memory, if the caller may see it.
pub fn get(access: &Access, scope: Scope, id: &MemoryId) -> Result<MemoryView, Denied> {
    let record = find(access, scope, id)?;
    Ok(MemoryView::from_record(&record))
}

fn find(access: &Access, scope: Scope, id: &MemoryId) -> Result<MemoryRecord, Denied> {
    let store_root = access
        .store_for(scope)
        .ok_or_else(|| Denied::ScopeUnavailable(scope_word(scope).to_string()))?;
    let record = store::load(store_root, scope)
        .records
        .into_iter()
        .find(|r| &r.id == id)
        .ok_or(Denied::NotFound)?;
    // Found, but not yours. Reported as out of scope rather than not found,
    // because the caller asked about a scope they do have standing in.
    if !access.may_see(&record) {
        return Err(Denied::OutOfScope);
    }
    Ok(record)
}

/// Replace a memory's content, keeping its identity and provenance.
///
/// `expected_hash` is the content the caller was looking at. A mismatch means
/// the record changed underneath them -- another window, another chat -- and
/// the edit is refused rather than silently overwriting the newer value.
pub fn edit(
    access: &Access,
    scope: Scope,
    id: &MemoryId,
    content: &str,
    expected_hash: Option<&str>,
    now: i64,
) -> Result<MemoryView, Denied> {
    let mut record = find(access, scope, id)?;
    if let Some(expected) = expected_hash {
        if record.content_hash != expected {
            return Err(Denied::Stale);
        }
    }

    let normalised = super::record::normalise(content);
    if normalised.is_empty() {
        return Err(Denied::Storage("a memory cannot be empty".into()));
    }
    // Re-checked on the way through: an edit is a fresh chance to introduce a
    // credential, and the guard at creation would not see it.
    if !crate::secrets::scan_text(&normalised).is_empty() {
        return Err(Denied::Storage(
            "that looks like a credential, and a memory is added to every future prompt".into(),
        ));
    }

    if normalised == record.content {
        return Ok(MemoryView::from_record(&record));
    }
    record.revise(normalised, now);
    record.last_confirmed_at = Some(now);

    let store_root = access.store_for(scope).expect("checked in find");
    store::upsert(store_root, &record).map_err(Denied::Storage)?;
    Ok(MemoryView::from_record(&record))
}

/// Pin or unpin, which ranks a memory within its own scope and nowhere else.
pub fn set_pinned(
    access: &Access,
    scope: Scope,
    id: &MemoryId,
    pinned: bool,
    now: i64,
) -> Result<MemoryView, Denied> {
    let mut record = find(access, scope, id)?;
    record.pinned = pinned;
    record.updated_at = now;
    let store_root = access.store_for(scope).expect("checked in find");
    store::upsert(store_root, &record).map_err(Denied::Storage)?;
    Ok(MemoryView::from_record(&record))
}

/// Set or clear an expiry.
pub fn set_expiration(
    access: &Access,
    scope: Scope,
    id: &MemoryId,
    expires_at: Option<i64>,
    now: i64,
) -> Result<MemoryView, Denied> {
    let mut record = find(access, scope, id)?;
    record.expires_at = expires_at;
    record.updated_at = now;
    let store_root = access.store_for(scope).expect("checked in find");
    store::upsert(store_root, &record).map_err(Denied::Storage)?;
    Ok(MemoryView::from_record(&record))
}

/// Move a memory to another scope.
///
/// Re-scoped rather than copied: the record keeps its id and provenance, and
/// gains or loses exactly the identity the new scope is keyed by. Promoting to
/// user scope drops the project and session ids, so project-specific knowledge
/// cannot arrive in "across chats" still carrying the project it came from.
pub fn move_scope(
    access: &Access,
    from: Scope,
    id: &MemoryId,
    to: Scope,
    now: i64,
) -> Result<MemoryView, Denied> {
    if from == to {
        return get(access, from, id);
    }
    let mut record = find(access, from, id)?;

    let target_store = access
        .store_for(to)
        .ok_or_else(|| Denied::ScopeUnavailable(scope_word(to).to_string()))?
        .to_path_buf();

    record.scope = to;
    record.project_id = match to {
        Scope::Project => Some(
            access
                .project_id
                .clone()
                .ok_or_else(|| Denied::ScopeUnavailable("project".into()))?,
        ),
        _ => None,
    };
    record.session_id = match to {
        Scope::Session => Some(
            access
                .session_id
                .clone()
                .ok_or_else(|| Denied::ScopeUnavailable("chat".into()))?,
        ),
        _ => None,
    };
    record.updated_at = now;

    // Written to the destination before it leaves the source, so a failure
    // between the two duplicates a memory rather than losing one.
    store::upsert(&target_store, &record).map_err(Denied::Storage)?;
    let source_store = access.store_for(from).expect("checked in find");
    store::remove(source_store, from, id).map_err(Denied::Storage)?;
    Ok(MemoryView::from_record(&record))
}

/// How much is stored, for the settings page.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageSummary {
    pub session_count: usize,
    pub project_count: usize,
    pub user_count: usize,
    pub deleted_count: usize,
    pub conflicted_count: usize,
    pub bytes: u64,
    /// Stores that could not be read in full, in words for the UI.
    pub issues: Vec<String>,
}

pub fn storage_summary(access: &Access) -> StorageSummary {
    let mut out = StorageSummary::default();
    for scope in [Scope::Session, Scope::Project, Scope::User] {
        let Some(root) = access.store_for(scope) else {
            continue;
        };
        let loaded = store::load(root, scope);
        if let Some(issue) = loaded.issue(scope) {
            out.issues.push(issue);
        }
        let visible: Vec<&MemoryRecord> = loaded
            .records
            .iter()
            .filter(|r| access.may_see(r))
            .collect();
        let count = visible
            .iter()
            .filter(|r| matches!(r.status, Status::Active))
            .count();
        match scope {
            Scope::Session => out.session_count = count,
            Scope::Project => out.project_count = count,
            Scope::User => out.user_count = count,
        }
        out.deleted_count += visible
            .iter()
            .filter(|r| matches!(r.status, Status::Deleted))
            .count();
        out.conflicted_count += visible
            .iter()
            .filter(|r| matches!(r.status, Status::Conflicted { .. }))
            .count();
        if let Ok(meta) = std::fs::metadata(store::records_path(root, scope)) {
            out.bytes += meta.len();
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::record::{Creator, Origin};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn roots() -> (PathBuf, PathBuf) {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let base = std::env::temp_dir().join(format!("jan_memsvc_{}_{}", std::process::id(), n));
        (base.join("project"), base.join("permanent"))
    }

    fn access() -> (Access, PathBuf, PathBuf) {
        let (project, permanent) = roots();
        (
            Access {
                session_id: Some("s1".into()),
                project_id: Some("p1".into()),
                project_store: Some(project.clone()),
                permanent_store: Some(permanent.clone()),
                project_refused: None,
            },
            project,
            permanent,
        )
    }

    fn save(
        root: &Path,
        id: &str,
        content: &str,
        scope: Scope,
        project: Option<&str>,
        session: Option<&str>,
    ) {
        let mut r = MemoryRecord::new(
            MemoryId::new(id),
            content,
            scope,
            Creator::User,
            Origin::Explicit,
            1_000,
        );
        r.project_id = project.map(str::to_string);
        r.session_id = session.map(str::to_string);
        store::upsert(root, &r).unwrap();
    }

    /// The rule that keeps a renderer bug from becoming a data leak.
    #[test]
    fn listing_a_scope_with_no_standing_is_refused_not_emptied() {
        let bare = Access::default();
        assert_eq!(
            list(&bare, Scope::User, None, 0, 50),
            Err(Denied::ScopeUnavailable("user".into()))
        );

        // A permanent store but no session: session memories are not listable.
        let (_, permanent) = roots();
        let no_session = Access {
            permanent_store: Some(permanent),
            ..Access::default()
        };
        assert_eq!(
            list(&no_session, Scope::Session, None, 0, 50),
            Err(Denied::ScopeUnavailable("chat".into()))
        );
    }

    #[test]
    fn listing_never_returns_another_sessions_memory() {
        let (access, _, permanent) = access();
        save(&permanent, "mine", "mine", Scope::Session, None, Some("s1"));
        save(
            &permanent,
            "theirs",
            "theirs",
            Scope::Session,
            None,
            Some("s2"),
        );

        let page = list(&access, Scope::Session, None, 0, 50).unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].id, "mine");
        let _ = std::fs::remove_dir_all(permanent.parent().unwrap());
    }

    #[test]
    fn listing_never_returns_another_projects_memory() {
        let (access, project, _) = access();
        save(&project, "mine", "mine", Scope::Project, Some("p1"), None);
        save(
            &project,
            "theirs",
            "theirs",
            Scope::Project,
            Some("p2"),
            None,
        );

        let page = list(&access, Scope::Project, None, 0, 50).unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].id, "mine");
        let _ = std::fs::remove_dir_all(project.parent().unwrap());
    }

    #[test]
    fn reading_another_scopes_record_is_refused() {
        let (access, _, permanent) = access();
        save(&permanent, "theirs", "x", Scope::Session, None, Some("s2"));
        assert_eq!(
            get(&access, Scope::Session, &MemoryId::new("theirs")),
            Err(Denied::OutOfScope)
        );
        let _ = std::fs::remove_dir_all(permanent.parent().unwrap());
    }

    #[test]
    fn search_and_paging_bound_what_is_returned() {
        let (access, _, permanent) = access();
        for i in 0..10 {
            save(
                &permanent,
                &format!("m{i}"),
                &format!("fact number {i}"),
                Scope::User,
                None,
                None,
            );
        }
        save(
            &permanent,
            "other",
            "something else",
            Scope::User,
            None,
            None,
        );

        let all = list(&access, Scope::User, None, 0, 50).unwrap();
        assert_eq!(all.total, 11);

        let searched = list(&access, Scope::User, Some("fact number"), 0, 50).unwrap();
        assert_eq!(searched.total, 10);

        let paged = list(&access, Scope::User, None, 0, 4).unwrap();
        assert_eq!(paged.items.len(), 4);
        assert_eq!(paged.total, 11, "total counts everything, not the page");

        // An unbounded request is clamped rather than honoured.
        let huge = list(&access, Scope::User, None, 0, 100_000).unwrap();
        assert!(huge.items.len() <= MAX_PAGE);
        let _ = std::fs::remove_dir_all(permanent.parent().unwrap());
    }

    #[test]
    fn editing_refuses_a_stale_hash() {
        let (access, _, permanent) = access();
        save(&permanent, "m", "original", Scope::User, None, None);
        let view = get(&access, Scope::User, &MemoryId::new("m")).unwrap();

        // Someone else edits first.
        edit(
            &access,
            Scope::User,
            &MemoryId::new("m"),
            "newer",
            None,
            2_000,
        )
        .unwrap();

        let stale = super::super::record::content_hash(&view.content);
        assert_eq!(
            edit(
                &access,
                Scope::User,
                &MemoryId::new("m"),
                "mine",
                Some(&stale),
                3_000
            ),
            Err(Denied::Stale)
        );
        let _ = std::fs::remove_dir_all(permanent.parent().unwrap());
    }

    /// An edit is a fresh chance to introduce a credential.
    #[test]
    fn editing_in_a_credential_is_refused() {
        let (access, _, permanent) = access();
        save(&permanent, "m", "harmless", Scope::User, None, None);
        let result = edit(
            &access,
            Scope::User,
            &MemoryId::new("m"),
            "API_KEY=abcd1234efgh5678",
            None,
            2_000,
        );
        assert!(matches!(result, Err(Denied::Storage(_))));
        let _ = std::fs::remove_dir_all(permanent.parent().unwrap());
    }

    /// Promotion must not carry the project along, or project knowledge becomes
    /// global while still claiming a project.
    #[test]
    fn promoting_to_user_scope_drops_the_project_identity() {
        let (access, project, permanent) = access();
        save(
            &project,
            "m",
            "a project fact",
            Scope::Project,
            Some("p1"),
            None,
        );

        let moved = move_scope(
            &access,
            Scope::Project,
            &MemoryId::new("m"),
            Scope::User,
            2_000,
        )
        .unwrap();
        assert_eq!(moved.scope, "user");
        assert_eq!(moved.project_id, None);
        assert_eq!(moved.session_id, None);

        // Gone from the project store, present in the permanent one.
        assert!(list(&access, Scope::Project, None, 0, 50)
            .unwrap()
            .items
            .is_empty());
        assert_eq!(list(&access, Scope::User, None, 0, 50).unwrap().total, 1);
        let _ = std::fs::remove_dir_all(permanent.parent().unwrap());
    }

    #[test]
    fn narrowing_to_a_chat_attaches_that_chat() {
        let (access, _, permanent) = access();
        save(&permanent, "m", "a fact", Scope::User, None, None);
        let moved = move_scope(
            &access,
            Scope::User,
            &MemoryId::new("m"),
            Scope::Session,
            2_000,
        )
        .unwrap();
        assert_eq!(moved.scope, "chat");
        assert_eq!(moved.session_id.as_deref(), Some("s1"));
        let _ = std::fs::remove_dir_all(permanent.parent().unwrap());
    }

    #[test]
    fn moving_keeps_the_identity_and_provenance() {
        let (access, project, permanent) = access();
        save(&project, "m", "a fact", Scope::Project, Some("p1"), None);
        let before = get(&access, Scope::Project, &MemoryId::new("m")).unwrap();
        let after = move_scope(
            &access,
            Scope::Project,
            &MemoryId::new("m"),
            Scope::User,
            2_000,
        )
        .unwrap();
        assert_eq!(after.id, before.id);
        assert_eq!(after.created_at, before.created_at);
        let _ = std::fs::remove_dir_all(permanent.parent().unwrap());
    }

    #[test]
    fn pin_and_expiry_round_trip() {
        let (access, _, permanent) = access();
        save(&permanent, "m", "a fact", Scope::User, None, None);
        let id = MemoryId::new("m");

        assert!(
            set_pinned(&access, Scope::User, &id, true, 2_000)
                .unwrap()
                .pinned
        );
        assert!(
            !set_pinned(&access, Scope::User, &id, false, 2_000)
                .unwrap()
                .pinned
        );
        assert_eq!(
            set_expiration(&access, Scope::User, &id, Some(9_999), 2_000)
                .unwrap()
                .expires_at,
            Some(9_999)
        );
        assert_eq!(
            set_expiration(&access, Scope::User, &id, None, 2_000)
                .unwrap()
                .expires_at,
            None
        );
        let _ = std::fs::remove_dir_all(permanent.parent().unwrap());
    }

    #[test]
    fn the_preview_never_splits_a_long_line_without_saying_so() {
        let long = "x".repeat(400);
        let preview = preview_of(&long);
        assert!(preview.chars().count() <= 141);
        assert!(preview.ends_with('…'));
    }

    #[test]
    fn storage_summary_counts_only_what_the_caller_may_see() {
        let (access, project, permanent) = access();
        save(&permanent, "u", "user", Scope::User, None, None);
        save(
            &permanent,
            "mine",
            "session",
            Scope::Session,
            None,
            Some("s1"),
        );
        save(
            &permanent,
            "theirs",
            "session",
            Scope::Session,
            None,
            Some("s2"),
        );
        save(&project, "p", "project", Scope::Project, Some("p1"), None);

        let summary = storage_summary(&access);
        assert_eq!(summary.user_count, 1);
        assert_eq!(
            summary.session_count, 1,
            "another chat's memory was counted"
        );
        assert_eq!(summary.project_count, 1);
        assert!(summary.bytes > 0);
        let _ = std::fs::remove_dir_all(permanent.parent().unwrap());
    }
}
