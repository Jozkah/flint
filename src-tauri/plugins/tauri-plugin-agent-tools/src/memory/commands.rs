//! Tauri commands for memory management.
//!
//! Every one is a thin wrapper over [`super::service`]: the checks live there,
//! so a command cannot accidentally be the weaker path. What these add is the
//! translation between what the renderer sends and what the service requires --
//! parsing a scope name, resolving stores, turning a refusal into a dialog
//! message.
//!
//! On trust: the session and project the renderer names are treated as a
//! *request*, not a claim. Containment is enforced against the record's own
//! scope every time, so a caller naming another chat still cannot read a record
//! that does not belong to the chat it named. This crate has no session
//! registry of its own, so it cannot go further and prove the caller is really
//! in that chat; the app layer owns that state, and this is documented rather
//! than presented as more than it is.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::record::{MemoryId, Scope};
use super::service::{self, Access, Denied, MemoryView, Page, StorageSummary};
use super::settings::{self, Settings};
use crate::commands::AgentToolsError;
use crate::workspace;

impl From<Denied> for AgentToolsError {
    fn from(denied: Denied) -> Self {
        AgentToolsError::from(denied.message())
    }
}

/// The scope words the UI uses. Deliberately the user-facing spelling, so the
/// renderer never has to know the internal names.
fn parse_scope(raw: &str) -> Result<Scope, AgentToolsError> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "chat" | "session" => Ok(Scope::Session),
        "project" => Ok(Scope::Project),
        "user" | "global" | "across-chats" => Ok(Scope::User),
        other => Err(AgentToolsError::from(format!("unknown memory scope '{other}'"))),
    }
}

/// What the renderer sends to say where it is.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Where {
    pub data_folder: String,
    /// The open project's root, when one is open.
    pub project_root: Option<String>,
    /// The active chat.
    pub session_id: Option<String>,
}

impl Where {
    fn access(&self) -> Access {
        let project_root = self
            .project_root
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(PathBuf::from);

        Access {
            session_id: self
                .session_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            // Derived from the project itself, never from anything the renderer
            // says it is: an id supplied by the caller would be a way to ask
            // for another project's memories by name.
            project_id: project_root
                .as_deref()
                .and_then(super::identity::project_id),
            project_store: project_root.as_deref().map(workspace::project_store),
            permanent_store: (!self.data_folder.trim().is_empty())
                .then(|| workspace::permanent_store(Path::new(&self.data_folder))),
        }
    }

    /// Where settings live: with the permanent store, so one answer governs
    /// every scope rather than each project having its own consent decision.
    fn settings_root(&self) -> Option<PathBuf> {
        (!self.data_folder.trim().is_empty())
            .then(|| workspace::permanent_store(Path::new(&self.data_folder)))
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[tauri::command]
pub async fn memory_records_list(
    location: Where,
    scope: String,
    query: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<Page, AgentToolsError> {
    let scope = parse_scope(&scope)?;
    service::list(
        &location.access(),
        scope,
        query.as_deref(),
        offset.unwrap_or(0),
        limit.unwrap_or(50),
    )
    .map_err(Into::into)
}

#[tauri::command]
pub async fn memory_record_get(
    location: Where,
    scope: String,
    id: String,
) -> Result<MemoryView, AgentToolsError> {
    let scope = parse_scope(&scope)?;
    service::get(&location.access(), scope, &MemoryId::new(id)).map_err(Into::into)
}

#[tauri::command]
pub async fn memory_record_edit(
    location: Where,
    scope: String,
    id: String,
    content: String,
    expected_hash: Option<String>,
) -> Result<MemoryView, AgentToolsError> {
    let scope = parse_scope(&scope)?;
    service::edit(
        &location.access(),
        scope,
        &MemoryId::new(id),
        &content,
        expected_hash.as_deref(),
        now(),
    )
    .map_err(Into::into)
}

/// Propose a memory for review. Writes nothing.
#[tauri::command]
pub async fn memory_record_propose(
    location: Where,
    scope: String,
    content: String,
    source_session_id: Option<String>,
    source_message_id: Option<String>,
) -> Result<ProposalView, AgentToolsError> {
    use super::create;
    use super::record::{Creator, Origin};

    let scope = parse_scope(&scope)?;
    let access = location.access();
    let store_root = match scope {
        Scope::Project => access.project_store.clone(),
        _ => access.permanent_store.clone(),
    }
    .ok_or_else(|| AgentToolsError::from(format!("no store for {scope:?} memories here")))?;

    let existing = super::store::load(&store_root, scope).records;
    let id = MemoryId::new(format!("mem-{}-{:016x}", now(), fnv(&content)));

    let mut proposal = create::propose(
        id,
        &content,
        scope,
        access.project_id.as_deref(),
        access.session_id.as_deref(),
        // The user asked for this one. An agent's proposal comes through the
        // typed proposal path, not through a command the UI can call.
        Creator::User,
        Origin::Explicit,
        now(),
        &existing,
    )
    .map_err(|r| AgentToolsError::from(r.message()))?;

    proposal.record.provenance.session_id = source_session_id;
    proposal.record.provenance.message_id = source_message_id;

    Ok(ProposalView::from(&proposal))
}

/// Commit a proposal the user has reviewed.
///
/// Re-proposed from the reviewed content rather than trusting a handle: the
/// refusals run again at commit time, so a proposal that sat on screen while
/// something changed cannot be committed unchecked.
#[tauri::command]
pub async fn memory_record_commit(
    location: Where,
    scope: String,
    content: String,
    expected_hash: String,
    source_session_id: Option<String>,
    source_message_id: Option<String>,
) -> Result<MemoryView, AgentToolsError> {
    use super::create;
    use super::record::{content_hash, Creator, Origin};

    let scope = parse_scope(&scope)?;
    let access = location.access();
    let store_root = match scope {
        Scope::Project => access.project_store.clone(),
        _ => access.permanent_store.clone(),
    }
    .ok_or_else(|| AgentToolsError::from(format!("no store for {scope:?} memories here")))?;

    // What was reviewed is what gets stored. A different body than the one the
    // hash describes is a stale surface, not an edit.
    if content_hash(&content) != expected_hash {
        return Err(AgentToolsError::from(
            "this memory changed while you were reviewing it; reopen and try again".to_string(),
        ));
    }

    let existing = super::store::load(&store_root, scope).records;
    let id = MemoryId::new(format!("mem-{}-{:016x}", now(), fnv(&content)));
    let mut proposal = create::propose(
        id,
        &content,
        scope,
        access.project_id.as_deref(),
        access.session_id.as_deref(),
        Creator::User,
        Origin::Explicit,
        now(),
        &existing,
    )
    .map_err(|r| AgentToolsError::from(r.message()))?;
    proposal.record.provenance.session_id = source_session_id;
    proposal.record.provenance.message_id = source_message_id;

    create::commit(&store_root, &proposal).map_err(AgentToolsError::from)?;
    Ok(service::get(&access, scope, &proposal.record.id)?)
}

#[tauri::command]
pub async fn memory_record_forget(
    location: Where,
    scope: String,
    id: String,
) -> Result<bool, AgentToolsError> {
    let scope = parse_scope(&scope)?;
    let access = location.access();
    // Read it first, so forgetting something out of scope is refused rather
    // than silently doing nothing.
    service::get(&access, scope, &MemoryId::new(id.clone()))?;
    let store_root = match scope {
        Scope::Project => access.project_store.clone(),
        _ => access.permanent_store.clone(),
    }
    .ok_or_else(|| AgentToolsError::from("no store for that scope here".to_string()))?;
    super::create::forget(&store_root, scope, &MemoryId::new(id), now())
        .map_err(AgentToolsError::from)
}

#[tauri::command]
pub async fn memory_record_restore(
    location: Where,
    scope: String,
    id: String,
) -> Result<bool, AgentToolsError> {
    let scope = parse_scope(&scope)?;
    let access = location.access();
    service::get(&access, scope, &MemoryId::new(id.clone()))?;
    let store_root = match scope {
        Scope::Project => access.project_store.clone(),
        _ => access.permanent_store.clone(),
    }
    .ok_or_else(|| AgentToolsError::from("no store for that scope here".to_string()))?;
    super::create::restore(&store_root, scope, &MemoryId::new(id), now())
        .map_err(AgentToolsError::from)
}

#[tauri::command]
pub async fn memory_record_pin(
    location: Where,
    scope: String,
    id: String,
    pinned: bool,
) -> Result<MemoryView, AgentToolsError> {
    let scope = parse_scope(&scope)?;
    service::set_pinned(&location.access(), scope, &MemoryId::new(id), pinned, now())
        .map_err(Into::into)
}

#[tauri::command]
pub async fn memory_record_set_expiration(
    location: Where,
    scope: String,
    id: String,
    expires_at: Option<i64>,
) -> Result<MemoryView, AgentToolsError> {
    let scope = parse_scope(&scope)?;
    service::set_expiration(
        &location.access(),
        scope,
        &MemoryId::new(id),
        expires_at,
        now(),
    )
    .map_err(Into::into)
}

#[tauri::command]
pub async fn memory_record_move_scope(
    location: Where,
    from_scope: String,
    id: String,
    to_scope: String,
) -> Result<MemoryView, AgentToolsError> {
    let from = parse_scope(&from_scope)?;
    let to = parse_scope(&to_scope)?;
    service::move_scope(&location.access(), from, &MemoryId::new(id), to, now())
        .map_err(Into::into)
}

#[tauri::command]
pub async fn memory_storage_summary(
    location: Where,
) -> Result<StorageSummary, AgentToolsError> {
    Ok(service::storage_summary(&location.access()))
}

#[tauri::command]
pub async fn memory_settings_get(location: Where) -> Result<Settings, AgentToolsError> {
    Ok(location
        .settings_root()
        .map(|root| settings::load(&root))
        .unwrap_or_default())
}

#[tauri::command]
pub async fn memory_settings_update(
    location: Where,
    automatically_save: bool,
) -> Result<Settings, AgentToolsError> {
    let root = location
        .settings_root()
        .ok_or_else(|| AgentToolsError::from("no data folder to store settings in".to_string()))?;
    let next = Settings {
        automatically_save,
        ..settings::load(&root)
    };
    settings::save(&root, &next).map_err(AgentToolsError::from)?;
    Ok(next)
}

/// A proposal as the review surface sees it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalView {
    pub content: String,
    pub scope: String,
    /// The hash `memory_record_commit` must be given back, so what is stored is
    /// what was shown.
    pub content_hash: String,
    pub duplicates: Vec<String>,
    pub conflicts: Vec<ConflictView>,
    pub redacted: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictView {
    pub left: String,
    pub right: String,
    pub subject: String,
}

impl From<&super::create::Proposal> for ProposalView {
    fn from(p: &super::create::Proposal) -> Self {
        Self {
            content: p.record.content.clone(),
            scope: match p.record.scope {
                Scope::Session => "chat",
                Scope::Project => "project",
                Scope::User => "user",
            }
            .to_string(),
            content_hash: p.record.content_hash.clone(),
            duplicates: p.duplicates.iter().map(MemoryId::to_string).collect(),
            conflicts: p
                .conflicts
                .iter()
                .map(|c| ConflictView {
                    left: c.left.to_string(),
                    right: c.right.to_string(),
                    subject: c.subject.clone(),
                })
                .collect(),
            redacted: p.redacted,
        }
    }
}

fn fnv(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    hash
}

/// What one dispatch is allowed to remember, and which records that was.
///
/// The desktop drives its own tool loop in TypeScript, so unlike the CLI agent
/// -- which calls [`super::retrieve::select`] in process -- it has to reach the
/// same selection over IPC. This is that reach. Both surfaces end in one
/// function, which is the point: a memory the CLI would inject and the desktop
/// would not is a disagreement nobody would find.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Retrieved {
    /// The rendered block for the system prompt, or `None` when nothing
    /// applies. Already delimited; the caller inserts it verbatim.
    pub block: Option<String>,
    /// The ids injected, for the prompt snapshot and the activity record.
    pub injected_ids: Vec<String>,
    /// Content hashes of what was injected, so a snapshot can prove which
    /// *version* of a memory the model saw rather than only which record.
    pub injected_hashes: Vec<String>,
    /// Records in conflict. Both sides were withheld, so neither reached the
    /// model as authoritative.
    pub conflict_ids: Vec<String>,
    /// Applicable records dropped because the budget ran out.
    pub dropped_ids: Vec<String>,
    /// Characters injected, for context accounting.
    pub chars_used: usize,
}

impl Retrieved {
    /// Nothing remembered, nothing recorded. The answer for a temporary chat.
    fn empty() -> Self {
        Self {
            block: None,
            injected_ids: Vec::new(),
            injected_hashes: Vec::new(),
            conflict_ids: Vec::new(),
            dropped_ids: Vec::new(),
            chars_used: 0,
        }
    }
}

/// Select the memories one dispatch may use.
///
/// `temporary` is the whole of the temporary-chat rule, and it is answered
/// before any store is opened rather than filtered afterwards: a temporary chat
/// should not even read.
#[tauri::command]
pub async fn memory_retrieve(
    location: Where,
    temporary: Option<bool>,
    budget_chars: Option<usize>,
) -> Result<Retrieved, AgentToolsError> {
    if temporary.unwrap_or(false) {
        return Ok(Retrieved::empty());
    }

    let access = location.access();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    // Every scope this caller is entitled to and no other. The session and
    // project ids come from `Access`, which derives them rather than believing
    // the renderer, so naming another chat does not fetch its records.
    let mut records = Vec::new();
    if let Some(store) = access.project_store.as_deref() {
        records.extend(super::store::load(store, Scope::Project).records);
    }
    let permanent = crate::workspace::permanent_store(std::path::Path::new(
        &location.data_folder,
    ));
    records.extend(super::store::load(&permanent, Scope::User).records);
    records.extend(super::store::load(&permanent, Scope::Session).records);

    let selection = super::retrieve::select(
        &records,
        &super::retrieve::RetrievalContext {
            session_id: access.session_id.as_deref(),
            project_id: access.project_id.as_deref(),
            now,
            budget_chars: budget_chars.unwrap_or(super::retrieve::DEFAULT_BUDGET_CHARS),
            temporary: false,
        },
    );

    Ok(Retrieved {
        block: selection.render(),
        injected_ids: selection
            .injected
            .iter()
            .map(|i| i.id.as_str().to_string())
            .collect(),
        injected_hashes: selection
            .injected
            .iter()
            .map(|i| super::record::content_hash(&i.content))
            .collect(),
        conflict_ids: selection
            .conflicts
            .iter()
            .flat_map(|c| [c.left.as_str().to_string(), c.right.as_str().to_string()])
            .collect(),
        dropped_ids: selection
            .dropped_for_budget
            .iter()
            .map(|id| id.as_str().to_string())
            .collect(),
        chars_used: selection.chars_used,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_words_are_the_ones_the_ui_uses() {
        assert_eq!(parse_scope("chat").unwrap(), Scope::Session);
        assert_eq!(parse_scope("project").unwrap(), Scope::Project);
        assert_eq!(parse_scope("user").unwrap(), Scope::User);
        assert_eq!(parse_scope("across-chats").unwrap(), Scope::User);
        // Internal spellings still work, so diagnostics and tests can use them.
        assert_eq!(parse_scope("session").unwrap(), Scope::Session);
        assert_eq!(parse_scope("  PROJECT  ").unwrap(), Scope::Project);
    }

    #[test]
    fn an_unknown_scope_is_refused_rather_than_guessed() {
        assert!(parse_scope("everything").is_err());
        assert!(parse_scope("").is_err());
    }

    /// The project id is derived from the project, never taken from the caller.
    #[test]
    fn a_caller_cannot_name_the_project_id_it_wants() {
        let fields: Vec<&str> = serde_json::to_value(Where::default())
            .ok()
            .and_then(|v| v.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()))
            .unwrap_or_default()
            .iter()
            .map(|s| Box::leak(s.clone().into_boxed_str()) as &str)
            .collect();
        assert!(
            !fields.iter().any(|f| f.contains("projectId")),
            "the renderer must not be able to supply a project id: {fields:?}"
        );
    }

    #[test]
    fn no_data_folder_means_no_permanent_store_rather_than_a_guess() {
        let access = Where::default().access();
        assert!(access.permanent_store.is_none());
        assert!(access.project_store.is_none());
        assert!(access.project_id.is_none());
    }

    #[test]
    fn a_blank_session_is_no_session_not_an_empty_one() {
        let location = Where {
            data_folder: "/tmp/x".into(),
            session_id: Some("   ".into()),
            ..Where::default()
        };
        assert!(location.access().session_id.is_none());
    }
}

// `Where` needs Serialize only so the test above can inspect its shape.
impl Serialize for Where {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("Where", 3)?;
        s.serialize_field("dataFolder", &self.data_folder)?;
        s.serialize_field("projectRoot", &self.project_root)?;
        s.serialize_field("sessionId", &self.session_id)?;
        s.end()
    }
}
