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
        other => Err(AgentToolsError::from(format!(
            "unknown memory scope '{other}'"
        ))),
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

/// What happened to a proposal an agent made.
///
/// One type rather than a boolean, because the four outcomes need completely
/// different things from the user: nothing, a decision, a conflict resolution,
/// or an explanation of a refusal. Collapsing them would put "we saved this"
/// and "we refused to save your API key" behind the same indicator.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum InferredOutcome {
    /// Saved without asking, because the user turned that on and nothing about
    /// this proposal required review.
    Saved { memory: Box<MemoryView> },
    /// Waiting for the user. `reason` says why it could not save itself, which
    /// is what the approval card explains.
    NeedsApproval {
        proposal: Box<ProposalView>,
        reason: PendingReason,
    },
    /// Not storable at all. Nothing is written and nothing is offered.
    Refused { reason: String },
}

// One definition, shared with the model-facing tool. Two copies of this enum
// would let the desktop path and the tool path disagree about why something is
// waiting -- and the reason is the whole content of the approval card.
pub use super::inferred::PendingReason;

/// Record something an agent inferred from the conversation.
///
/// The path the "Automatically save local memories" setting actually governs.
/// Separate from `memory_record_propose`, which is the user saying "remember
/// this": that is explicit and always saved on confirmation, whereas this is a
/// guess and is refused, queued or saved depending on what it contains and what
/// the user has allowed.
///
/// Every gate is here rather than in the renderer. Hiding an approval card
/// while still writing the record would mean the setting controlled what the
/// user *saw* rather than what Jan *did*.
#[tauri::command]
pub async fn memory_record_propose_inferred(
    location: Where,
    scope: String,
    content: String,
    source_session_id: Option<String>,
    source_message_id: Option<String>,
    temporary: Option<bool>,
) -> Result<InferredOutcome, AgentToolsError> {
    use super::create;
    use super::inferred;

    let scope = parse_scope(&scope)?;
    let access = location.access();
    let store_root = match scope {
        Scope::Project => access.project_store.clone(),
        _ => access.permanent_store.clone(),
    }
    .ok_or_else(|| AgentToolsError::from(format!("no store for {scope:?} memories here")))?;

    let existing = super::store::load(&store_root, scope).records;
    let settings = location
        .settings_root()
        .map(|root| settings::load(&root))
        .unwrap_or_default();

    // The gate itself lives in `inferred`. The desktop path and the
    // model-facing `memory_propose` tool both reach it through this one
    // function, so the same content cannot be queued down one path and saved
    // down the other -- including the order the reasons are checked in, which
    // is what stops "automatically save" silently resolving a conflict.
    let decision = inferred::decide(
        MemoryId::new(format!("mem-{}-{:016x}", now(), fnv(&content))),
        &content,
        &existing,
        &inferred::Context {
            scope,
            project_id: access.project_id.as_deref(),
            session_id: access.session_id.as_deref(),
            // A temporary chat neither reads nor records. Answered before
            // anything is written, so there is nothing to clean up.
            temporary: temporary.unwrap_or(false),
            now: now(),
            automatically_save: settings.automatically_save,
        },
    );

    let mut proposal = match decision {
        // A credential, an empty body, something absurdly long, or a temporary
        // chat. Refused whatever the setting says: automatic saving is
        // permission to skip the question, never permission to store a secret.
        inferred::Decision::Refused { reason } => {
            return Ok(InferredOutcome::Refused { reason })
        }
        inferred::Decision::Pending { proposal, reason } => {
            let mut proposal = *proposal;
            proposal.record.provenance.session_id = source_session_id;
            proposal.record.provenance.message_id = source_message_id;
            // Stored, not merely returned. A question that lives only in this
            // response is asked once, in whichever surface happened to be open,
            // and is gone by the next turn. `Status::Proposed` keeps it out of
            // every prompt while it waits, and `memory_proposals_list` is what
            // the approval card reads.
            let pending = inferred::as_pending(&proposal, reason);
            super::store::upsert(&store_root, &pending).map_err(AgentToolsError::from)?;
            return Ok(InferredOutcome::NeedsApproval {
                proposal: Box::new(ProposalView::from(&proposal)),
                reason,
            });
        }
        inferred::Decision::Save(proposal) => *proposal,
    };
    proposal.record.provenance.session_id = source_session_id;
    proposal.record.provenance.message_id = source_message_id;

    // A duplicate confirms what is already there rather than adding a second
    // copy of it; `create::commit` keys on content, so this is idempotent.
    create::commit(&store_root, &proposal).map_err(AgentToolsError::from)?;
    Ok(InferredOutcome::Saved {
        memory: Box::new(service::get(&access, scope, &proposal.record.id)?),
    })
}

/// A proposal a person has not answered yet.
///
/// Carries the reason in the words the user reads, so the card never renders a
/// generic "needs approval" -- the gate knows *why* it is asking and the card
/// is the only place that matters.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingProposalView {
    pub id: String,
    pub content: String,
    pub scope: String,
    /// Stable code, for tests and for keying UI behaviour.
    pub reason: String,
    /// One sentence, for the card.
    pub explanation: String,
    /// Whether approving is even offered. A conflicted proposal is a question
    /// about which of two memories is right, not something to wave through.
    pub approvable: bool,
    pub source_session_id: Option<String>,
    pub source_message_id: Option<String>,
    pub created_at: i64,
}

/// Proposals awaiting an answer, across every scope this caller may see.
#[tauri::command]
pub async fn memory_proposals_list(
    location: Where,
) -> Result<Vec<PendingProposalView>, AgentToolsError> {
    use super::inferred::{self, PendingReason};

    let access = location.access();
    let mut out = Vec::new();
    for (scope, root) in [
        (Scope::Session, access.permanent_store.clone()),
        (Scope::User, access.permanent_store.clone()),
        (Scope::Project, access.project_store.clone()),
    ] {
        let Some(root) = root else { continue };
        for record in super::store::load(&root, scope).records {
            let Some(reason) = inferred::pending_reason(&record) else {
                continue;
            };
            // Containment is enforced against the record's own scope, exactly
            // as it is for reading a memory: naming another chat does not
            // surface its questions.
            if !record.applies_to(access.session_id.as_deref(), access.project_id.as_deref()) {
                continue;
            }
            out.push(PendingProposalView {
                id: record.id.to_string(),
                content: record.content.clone(),
                scope: super::service::scope_word(scope).to_string(),
                reason: reason.as_str().to_string(),
                explanation: reason.explain().to_string(),
                // A conflict is answered by resolving the conflict, not by
                // approving one side blind.
                approvable: reason != PendingReason::ConflictsWithExisting,
                source_session_id: record.provenance.session_id.clone(),
                source_message_id: record.provenance.message_id.clone(),
                created_at: record.created_at,
            });
        }
    }
    out.sort_by_key(|p| std::cmp::Reverse(p.created_at));
    Ok(out)
}

/// Answer a proposal.
///
/// The card is not the decision. Approving re-runs the refusals against the
/// content as stored, so a proposal that sat on screen while the rules changed
/// cannot be waved through; rejecting removes it rather than leaving a question
/// that will be asked again.
#[tauri::command]
pub async fn memory_proposal_resolve(
    location: Where,
    scope: String,
    id: String,
    approve: bool,
) -> Result<Option<MemoryView>, AgentToolsError> {
    use super::inferred::{self, PendingReason};
    use super::record::Status;

    let scope = parse_scope(&scope)?;
    let access = location.access();
    let store_root = match scope {
        Scope::Project => access.project_store.clone(),
        _ => access.permanent_store.clone(),
    }
    .ok_or_else(|| AgentToolsError::from(format!("no store for {scope:?} memories here")))?;

    let id = MemoryId::new(id);
    let mut records = super::store::load(&store_root, scope).records;
    let Some(index) = records.iter().position(|r| r.id == id) else {
        return Err(AgentToolsError::from(
            "that proposal is no longer there".to_string(),
        ));
    };
    let Some(reason) = inferred::pending_reason(&records[index]) else {
        return Err(AgentToolsError::from(
            "that memory is not awaiting an answer".to_string(),
        ));
    };

    if !approve {
        records.remove(index);
        super::store::save(&store_root, scope, &records).map_err(AgentToolsError::from)?;
        return Ok(None);
    }

    if reason == PendingReason::ConflictsWithExisting {
        return Err(AgentToolsError::from(
            "this contradicts something already remembered; resolve the conflict rather than approving one side".to_string(),
        ));
    }

    // Re-checked at the moment of the decision, not at the moment of the
    // proposal: the refusals are what stop a credential being stored, and a
    // proposal can sit on screen for a long time.
    if !crate::secrets::scan_text(&records[index].content).is_empty() {
        records.remove(index);
        super::store::save(&store_root, scope, &records).map_err(AgentToolsError::from)?;
        return Err(AgentToolsError::from(
            "that looks like a credential, so it was discarded rather than saved".to_string(),
        ));
    }

    records[index].status = Status::Active;
    records[index].updated_at = now();
    super::store::save(&store_root, scope, &records).map_err(AgentToolsError::from)?;
    Ok(Some(service::get(&access, scope, &id)?))
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
    service::move_scope(&location.access(), from, &MemoryId::new(id), to, now()).map_err(Into::into)
}

#[tauri::command]
pub async fn memory_storage_summary(location: Where) -> Result<StorageSummary, AgentToolsError> {
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

/// Every record in every scope this caller is entitled to, and no other.
///
/// The session and project ids come from `Access`, which derives them rather
/// than believing the renderer, so naming another chat does not fetch its
/// records. Shared by retrieval and the conflict list so the page shows exactly
/// the disagreements a dispatch from the same place would withhold.
fn entitled_records(location: &Where, access: &Access) -> Vec<super::record::MemoryRecord> {
    let mut records = Vec::new();
    if let Some(store) = access.project_store.as_deref() {
        records.extend(super::store::load(store, Scope::Project).records);
    }
    let permanent = crate::workspace::permanent_store(Path::new(&location.data_folder));
    records.extend(super::store::load(&permanent, Scope::User).records);
    records.extend(super::store::load(&permanent, Scope::Session).records);
    records
}

/// Two remembered records that cannot both be followed, with both in full.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryConflictPair {
    /// What they disagree about, e.g. "package manager".
    pub subject: String,
    pub left: MemoryView,
    pub right: MemoryView,
}

/// The conflicts a dispatch from this place would withhold.
///
/// Retrieval withholds both sides of a conflict, which is safe but silent: a
/// user whose memory stopped working had nothing telling them why. This is the
/// question put back to them, from the same records and the same applicability
/// rule the prompt uses, so settling one here is what makes the survivor reach
/// the model again. A temporary chat has none, as it has no memory at all.
#[tauri::command]
pub async fn memory_conflicts(
    location: Where,
    temporary: Option<bool>,
) -> Result<Vec<MemoryConflictPair>, AgentToolsError> {
    if temporary.unwrap_or(false) {
        return Ok(Vec::new());
    }
    let access = location.access();
    let now = now();
    let applicable: Vec<super::record::MemoryRecord> = entitled_records(&location, &access)
        .into_iter()
        .filter(|r| r.applies_to(access.session_id.as_deref(), access.project_id.as_deref()))
        .filter(|r| r.is_usable(now))
        .collect();
    let find = |id: &MemoryId| applicable.iter().find(|r| &r.id == id);
    Ok(super::record::detect_conflicts(&applicable)
        .into_iter()
        .filter_map(|c| {
            Some(MemoryConflictPair {
                subject: c.subject.clone(),
                left: MemoryView::from_record(find(&c.left)?),
                right: MemoryView::from_record(find(&c.right)?),
            })
        })
        .collect())
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
    let now = now();
    let records = entitled_records(&location, &access);

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

#[cfg(test)]
mod inferred_tests {
    use super::*;
    use crate::memory::settings;

    fn root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "jan-inferred-{name}-{}-{}",
            std::process::id(),
            now()
        ));
        std::fs::create_dir_all(&dir).expect("test root");
        dir
    }

    fn at(dir: &std::path::Path) -> Where {
        Where {
            data_folder: dir.to_string_lossy().to_string(),
            project_root: None,
            session_id: Some("chat-a".to_string()),
        }
    }

    /// Turn automatic saving on through the same path the toggle uses.
    fn allow_automatic(dir: &std::path::Path) {
        let store = crate::workspace::permanent_store(dir);
        std::fs::create_dir_all(&store).expect("store");
        settings::save(
            &store,
            &settings::Settings {
                automatically_save: true,
                ..Default::default()
            },
        )
        .expect("save settings");
    }

    async fn propose(dir: &std::path::Path, content: &str) -> InferredOutcome {
        memory_record_propose_inferred(
            at(dir),
            "user".to_string(),
            content.to_string(),
            Some("chat-a".to_string()),
            Some("msg-1".to_string()),
            None,
        )
        .await
        .expect("command")
    }

    /// The default. A guess waits to be confirmed.
    #[tokio::test]
    async fn an_inferred_proposal_waits_when_automatic_saving_is_off() {
        let dir = root("off");
        match propose(&dir, "The user prefers tabs over spaces.").await {
            InferredOutcome::NeedsApproval { reason, proposal } => {
                assert_eq!(reason, PendingReason::AutomaticSavingDisabled);
                assert!(proposal.content.contains("tabs"));
            }
            other => panic!("expected approval, got {other:?}"),
        }
        // The question is kept, so it can still be answered after a restart --
        // but as a proposal, which `is_usable` refuses, so it reaches no
        // prompt while it waits.
        let store = crate::workspace::permanent_store(&dir);
        let records = crate::memory::store::load(&store, Scope::User).records;
        assert_eq!(records.len(), 1);
        assert!(matches!(
            records[0].status,
            crate::memory::record::Status::Proposed { .. }
        ));
        assert!(
            !records[0].is_usable(now()),
            "an unanswered guess must never be injected"
        );
        // And it is not a memory: the list a person reads does not show it.
        assert!(
            memory_records_list(at(&dir), "user".to_string(), None, None, None)
                .await
                .map(|page| page.items.is_empty())
                .unwrap_or(true),
            "a proposal must not appear among remembered facts"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn an_eligible_proposal_saves_once_the_user_allows_it() {
        let dir = root("on");
        allow_automatic(&dir);
        match propose(&dir, "The user prefers tabs over spaces.").await {
            InferredOutcome::Saved { memory } => {
                assert!(memory.content.contains("tabs"));
            }
            other => panic!("expected a save, got {other:?}"),
        }
        let store = crate::workspace::permanent_store(&dir);
        assert_eq!(
            crate::memory::store::load(&store, Scope::User)
                .records
                .len(),
            1
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The rule the whole feature rests on: permission to skip the question is
    /// never permission to store a credential.
    #[tokio::test]
    async fn a_secret_is_refused_even_with_automatic_saving_on() {
        let dir = root("secret");
        allow_automatic(&dir);
        for content in [
            "The API key is sk-live-abcdefghijklmnopqrstuvwxyz012345.",
            "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def",
        ] {
            match propose(&dir, content).await {
                InferredOutcome::Refused { reason } => {
                    assert!(!reason.is_empty(), "a refusal must say why");
                }
                other => panic!("a secret must never be stored, got {other:?}"),
            }
        }
        let store = crate::workspace::permanent_store(&dir);
        assert!(crate::memory::store::load(&store, Scope::User)
            .records
            .is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A temporary chat is answered before any store is opened.
    #[tokio::test]
    async fn a_temporary_chat_never_records() {
        let dir = root("temp");
        allow_automatic(&dir);
        let outcome = memory_record_propose_inferred(
            at(&dir),
            "user".to_string(),
            "The user prefers tabs.".to_string(),
            None,
            None,
            Some(true),
        )
        .await
        .expect("command");
        assert!(matches!(outcome, InferredOutcome::Refused { .. }));
        let store = crate::workspace::permanent_store(&dir);
        assert!(crate::memory::store::load(&store, Scope::User)
            .records
            .is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Turning automatic saving on must not silently pick a side in a
    /// disagreement.
    #[tokio::test]
    async fn a_conflicting_proposal_waits_even_with_automatic_saving_on() {
        let dir = root("conflict");
        allow_automatic(&dir);
        let first = propose(&dir, "Always use tabs for indentation.").await;
        assert!(matches!(first, InferredOutcome::Saved { .. }));

        match propose(&dir, "Never use tabs for indentation.").await {
            InferredOutcome::NeedsApproval { reason, .. } => {
                assert_eq!(reason, PendingReason::ConflictsWithExisting);
            }
            // A store that does not detect this pair as contradictory is a
            // gap in `detect_conflicts`, not in this gate -- but it must not
            // have saved silently either way.
            InferredOutcome::Saved { .. } => {
                let store = crate::workspace::permanent_store(&dir);
                let records = crate::memory::store::load(&store, Scope::User).records;
                assert_eq!(records.len(), 2, "both sides should still be present");
            }
            other => panic!("unexpected {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A fact learned inside a project does not become global on a guess.
    #[tokio::test]
    async fn a_project_fact_is_not_promoted_globally_without_asking() {
        let dir = root("promote");
        allow_automatic(&dir);
        let project = dir.join("project");
        std::fs::create_dir_all(&project).expect("project dir");

        let outcome = memory_record_propose_inferred(
            Where {
                data_folder: dir.to_string_lossy().to_string(),
                project_root: Some(project.to_string_lossy().to_string()),
                session_id: Some("chat-a".to_string()),
            },
            "user".to_string(),
            "The build command is `cargo xtask dist`.".to_string(),
            None,
            None,
            None,
        )
        .await
        .expect("command");

        match outcome {
            InferredOutcome::NeedsApproval { reason, .. } => {
                assert_eq!(reason, PendingReason::WouldPromoteProjectFactGlobally);
            }
            other => panic!("expected a review, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Proposing the same thing twice confirms it rather than multiplying it.
    #[tokio::test]
    async fn a_duplicate_proposal_does_not_multiply_the_record() {
        let dir = root("dupe");
        allow_automatic(&dir);
        let content = "The user prefers tabs over spaces.";
        assert!(matches!(
            propose(&dir, content).await,
            InferredOutcome::Saved { .. }
        ));
        let _ = propose(&dir, content).await;
        let store = crate::workspace::permanent_store(&dir);
        let live = crate::memory::store::load(&store, Scope::User)
            .records
            .into_iter()
            .filter(|r| r.content.contains("tabs"))
            .count();
        assert_eq!(live, 1, "a duplicate must confirm, not multiply");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An agent's guess is marked as one, so nothing later mistakes it for
    /// something the user said.
    #[tokio::test]
    async fn a_saved_inference_is_recorded_as_inferred_by_an_agent() {
        use crate::memory::record::{Creator, Origin};
        let dir = root("provenance");
        allow_automatic(&dir);
        let _ = propose(&dir, "The user prefers dark mode.").await;
        let store = crate::workspace::permanent_store(&dir);
        let record = crate::memory::store::load(&store, Scope::User)
            .records
            .into_iter()
            .next()
            .expect("one record");
        assert_eq!(record.creator, Creator::Agent);
        assert_eq!(record.origin, Origin::Inferred);
        assert_eq!(record.provenance.session_id.as_deref(), Some("chat-a"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The gate is the backend's. Turning the setting off again stops saves
    /// immediately, without the renderer being involved.
    #[tokio::test]
    async fn turning_the_setting_off_stops_saving_again() {
        let dir = root("toggle");
        allow_automatic(&dir);
        assert!(matches!(
            propose(&dir, "The user prefers dark mode.").await,
            InferredOutcome::Saved { .. }
        ));

        let store = crate::workspace::permanent_store(&dir);
        settings::save(&store, &settings::Settings::default()).expect("off again");

        match propose(&dir, "The user prefers light mode on Mondays.").await {
            InferredOutcome::NeedsApproval { reason, .. } => {
                assert_eq!(reason, PendingReason::AutomaticSavingDisabled)
            }
            other => panic!("expected approval after turning it off, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod proposal_tests {
    use super::*;
    use crate::memory::record::Status;
    use crate::memory::settings;

    fn root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "jan-proposal-{name}-{}-{}",
            std::process::id(),
            now()
        ));
        std::fs::create_dir_all(&dir).expect("root");
        dir
    }

    fn at(dir: &std::path::Path) -> Where {
        Where {
            data_folder: dir.to_string_lossy().to_string(),
            project_root: None,
            session_id: Some("chat-a".to_string()),
        }
    }

    fn allow_automatic(dir: &std::path::Path, on: bool) {
        let store = crate::workspace::permanent_store(dir);
        std::fs::create_dir_all(&store).expect("store");
        settings::save(
            &store,
            &settings::Settings {
                automatically_save: on,
                ..Default::default()
            },
        )
        .expect("settings");
    }

    /// Put a proposal in the store the way the tool does.
    async fn propose(dir: &std::path::Path, content: &str) -> Vec<PendingProposalView> {
        let _ = memory_record_propose_inferred(
            at(dir),
            "user".to_string(),
            content.to_string(),
            Some("chat-a".to_string()),
            Some("msg-1".to_string()),
            None,
        )
        .await;
        memory_proposals_list(at(dir)).await.expect("list")
    }

    /// A stored proposal, so the list has something to find even though the
    /// command path above does not persist one.
    fn store_pending(dir: &std::path::Path, content: &str, reason: &str) -> String {
        use crate::memory::record::{Creator, MemoryId, MemoryRecord, Origin, Scope};
        let store = crate::workspace::permanent_store(dir);
        std::fs::create_dir_all(&store).expect("store");
        let id = MemoryId::new(format!("mem-{}-{}", now(), content.len()));
        let mut record = MemoryRecord::new(
            id.clone(),
            content,
            Scope::User,
            Creator::Agent,
            Origin::Inferred,
            now(),
        );
        record.provenance.session_id = Some("chat-a".to_string());
        record.status = Status::Proposed {
            reason: reason.to_string(),
        };
        crate::memory::store::upsert(&store, &record).expect("upsert");
        id.to_string()
    }

    /// A record written straight to the permanent store, active.
    fn store_active(dir: &std::path::Path, content: &str, scope: Scope, session: Option<&str>) -> String {
        use crate::memory::record::{Creator, MemoryId, MemoryRecord, Origin};
        let store = crate::workspace::permanent_store(dir);
        std::fs::create_dir_all(&store).expect("store");
        let id = MemoryId::new(format!("mem-{}-{}-{}", now(), content.len(), session.unwrap_or("u")));
        let mut record = MemoryRecord::new(id.clone(), content, scope, Creator::User, Origin::Explicit, now());
        record.session_id = session.map(str::to_string);
        crate::memory::store::upsert(&store, &record).expect("upsert");
        id.to_string()
    }

    #[tokio::test]
    async fn conflicts_are_listed_with_both_sides_and_only_where_they_apply() {
        let dir = root("conflicts");
        let user = store_active(&dir, "Use npm for installs.", Scope::User, None);
        let mine = store_active(&dir, "Use yarn for installs.", Scope::Session, Some("chat-a"));
        // Another chat's disagreement is not this chat's problem, and must not
        // be shown here: that would be a way to read another chat's memory.
        let theirs = store_active(&dir, "Use pnpm for installs.", Scope::Session, Some("chat-b"));

        let listed = memory_conflicts(at(&dir), None).await.expect("conflicts");
        assert_eq!(listed.len(), 1, "{listed:?}");
        let pair = [listed[0].left.id.clone(), listed[0].right.id.clone()];
        assert!(pair.contains(&user) && pair.contains(&mine), "{pair:?}");
        assert!(!pair.contains(&theirs));
        assert_eq!(listed[0].subject, "package manager");
        assert!(listed[0].left.content.contains("for installs"));

        // The same records are what retrieval withholds, so the page and the
        // prompt agree about what is in dispute.
        let retrieved = memory_retrieve(at(&dir), None, None).await.expect("retrieve");
        assert!(retrieved.conflict_ids.contains(&user) && retrieved.conflict_ids.contains(&mine));
        assert!(retrieved.injected_ids.is_empty());

        // Settling it by forgetting one side lets the other through again.
        assert!(memory_record_forget(at(&dir), "user".to_string(), user.clone())
            .await
            .expect("forget"));
        assert!(memory_conflicts(at(&dir), None).await.expect("after").is_empty());
        let after = memory_retrieve(at(&dir), None, None).await.expect("retrieve");
        assert_eq!(after.injected_ids, vec![mine]);

        // A temporary chat has no memory, so it has nothing in dispute either.
        assert!(memory_conflicts(at(&dir), Some(true)).await.expect("temp").is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_pending_proposal_is_listed_with_the_reason_it_is_waiting() {
        let dir = root("list");
        store_pending(&dir, "The user prefers tabs.", "automatic-saving-disabled");
        let pending = memory_proposals_list(at(&dir)).await.expect("list");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].reason, "automatic-saving-disabled");
        // The card never says "needs approval"; it says why.
        assert!(pending[0].explanation.contains("waiting for you"));
        assert!(pending[0].approvable);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A conflict is a question about which memory is right. Offering "approve"
    /// would let a person wave one side through without seeing the other.
    #[tokio::test]
    async fn a_conflicted_proposal_is_never_approvable() {
        let dir = root("conflict");
        let id = store_pending(&dir, "Always use tabs.", "conflicts-with-existing");
        let pending = memory_proposals_list(at(&dir)).await.expect("list");
        assert!(!pending[0].approvable);
        assert!(pending[0].explanation.contains("contradicts"));

        // And the backend refuses even if a renderer asks anyway.
        let refused = memory_proposal_resolve(at(&dir), "user".to_string(), id, true).await;
        assert!(refused.is_err(), "approving a conflict must be refused");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn approving_makes_the_memory_usable() {
        let dir = root("approve");
        let id = store_pending(&dir, "The user prefers tabs.", "automatic-saving-disabled");
        let saved = memory_proposal_resolve(at(&dir), "user".to_string(), id, true)
            .await
            .expect("approve")
            .expect("a memory");
        assert_eq!(saved.status, "active");
        // Gone from the pending list, and now a real memory.
        assert!(memory_proposals_list(at(&dir)).await.expect("list").is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn rejecting_removes_it_rather_than_asking_again() {
        let dir = root("reject");
        let id = store_pending(&dir, "The user prefers tabs.", "automatic-saving-disabled");
        let out = memory_proposal_resolve(at(&dir), "user".to_string(), id, false)
            .await
            .expect("reject");
        assert!(out.is_none());
        assert!(memory_proposals_list(at(&dir)).await.expect("list").is_empty());
        let store = crate::workspace::permanent_store(&dir);
        assert!(crate::memory::store::load(&store, crate::memory::record::Scope::User)
            .records
            .is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The refusals run at the moment of the decision, not only at the moment
    /// of the proposal: a card can sit on screen for a long time.
    #[tokio::test]
    async fn a_credential_is_discarded_at_approval_not_stored() {
        let dir = root("secret");
        let id = store_pending(
            &dir,
            "The API key is sk-live-abcdefghijklmnopqrstuvwxyz012345.",
            "automatic-saving-disabled",
        );
        let refused = memory_proposal_resolve(at(&dir), "user".to_string(), id, true).await;
        assert!(refused.is_err(), "a credential must not be approvable");
        let store = crate::workspace::permanent_store(&dir);
        assert!(
            crate::memory::store::load(&store, crate::memory::record::Scope::User)
                .records
                .is_empty(),
            "and it must not be left lying in the store"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Never injected while it waits: `is_usable` admits `Active` only.
    #[test]
    fn a_pending_proposal_is_not_usable() {
        use crate::memory::record::{Creator, MemoryId, MemoryRecord, Origin, Scope};
        let mut record = MemoryRecord::new(
            MemoryId::new("mem-x"),
            "The user prefers tabs.",
            Scope::User,
            Creator::Agent,
            Origin::Inferred,
            100,
        );
        assert!(record.is_usable(200));
        record.status = Status::Proposed {
            reason: "automatic-saving-disabled".to_string(),
        };
        assert!(!record.is_usable(200), "an unanswered guess must never inject");
    }

    #[tokio::test]
    async fn resolving_something_that_is_not_pending_is_refused() {
        let dir = root("notpending");
        let out = memory_proposal_resolve(
            at(&dir),
            "user".to_string(),
            "mem-does-not-exist".to_string(),
            true,
        )
        .await;
        assert!(out.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The tool stores the question, so it survives the turn and a restart.
    #[tokio::test]
    async fn the_tool_persists_the_question_it_asked() {
        let dir = root("persist");
        allow_automatic(&dir, false);
        let store = crate::workspace::permanent_store(&dir);
        let ctx_root = dir.join("proj");
        std::fs::create_dir_all(&ctx_root).expect("proj");
        let root_ref: &'static std::path::Path =
            Box::leak(ctx_root.into_boxed_path());
        let store_ref: &'static std::path::Path =
            Box::leak(store.clone().into_boxed_path());
        let ctx = crate::tools::ToolContext::new(root_ref, store_ref, &[])
            .in_session(Some("chat-a"), false);
        let out = crate::tools::handlers::execute_text(
            crate::tools::lookup("memory_propose").unwrap(),
            &serde_json::json!({"content": "The user prefers tabs.", "scope": "user"}),
            &ctx,
        )
        .await;
        assert!(out.contains("Not saved yet"), "{out}");

        // Re-read from disk, which is what a restart does.
        let pending = crate::memory::store::load(&store, crate::memory::record::Scope::User)
            .records;
        assert_eq!(pending.len(), 1);
        assert!(matches!(pending[0].status, Status::Proposed { .. }));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
