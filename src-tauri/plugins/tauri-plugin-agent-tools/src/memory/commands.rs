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
    /// The Jan workspace project the chat belongs to, when it has no folder.
    ///
    /// Jan's sidebar projects are a renderer-owned grouping with no path on
    /// disk, so a folder identity cannot be derived for them. This names one.
    /// See [`JAN_PROJECT_PREFIX`] for what it becomes and why that is safe.
    pub jan_project_id: Option<String>,
}

/// Namespace for workspace-project identities.
///
/// A Jan project id becomes `jan-project:<id>`. Folder identities are
/// `proj-<hash>` (or whatever a project's id file says, which cannot contain
/// this prefix and still be read back by a folder -- see `identity`), so a
/// renderer naming a Jan project can never address a folder project's records,
/// and a folder can never be mistaken for a Jan project.
///
/// Trust boundary. The project list lives in the renderer's own storage and is
/// not reachable from Rust, so the backend cannot prove the id names a project
/// that exists. It does not need to: the only caller that can supply this field
/// is a renderer-invoked memory command, and the renderer is the user acting in
/// their own UI -- they can already open every project in Settings > Memory.
/// What must not supply it is the model. Model-facing tools reach memory
/// through `ToolContext`, which carries a project *root* and derives identity
/// from the folder; no tool schema or tool argument is ever parsed into a
/// `Where`, so nothing a model emits can choose a workspace project.
pub const JAN_PROJECT_PREFIX: &str = "jan-project:";

/// A workspace project id as the renderer sent it, if it is one.
///
/// Refused rather than escaped when it is blank, overlong or carries anything
/// beyond the characters Jan's own ids use: an id that needs escaping was not
/// produced by Jan, and an unusable id must mean "no project memory", never a
/// different project's.
fn workspace_project(raw: Option<&str>) -> Option<String> {
    let id = raw?.trim();
    let ok = !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    ok.then(|| format!("{JAN_PROJECT_PREFIX}{id}"))
}

impl Where {
    fn access(&self) -> Access {
        let project_root = self
            .project_root
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(PathBuf::from);
        let permanent_store = (!self.data_folder.trim().is_empty())
            .then(|| workspace::permanent_store(Path::new(&self.data_folder)));

        // A folder, when there is one, is the identity: a Jan project linked to
        // a Cowork workspace keeps the memories that folder already has. The
        // workspace-project identity applies only to a project with no folder.
        let (project_id, project_store) = match project_root.as_deref() {
            // Derived from the project itself, never from anything the
            // renderer says it is: an id supplied by the caller would be a way
            // to ask for another project's memories by name.
            Some(root) => (
                super::identity::project_id(root),
                Some(workspace::project_store(root)),
            ),
            // Namespaced, and kept in the data-folder store: there is no
            // project folder to hold it. Records from every workspace project
            // share that file and are told apart by `project_id`, which every
            // read path checks (`applies_to`, `may_see`).
            None => match workspace_project(self.jan_project_id.as_deref()) {
                Some(id) if permanent_store.is_some() => (Some(id), permanent_store.clone()),
                _ => (None, None),
            },
        };

        Access {
            session_id: self
                .session_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            project_id,
            project_store,
            permanent_store,
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
    automatically_save: Option<bool>,
    memory_enabled: Option<bool>,
) -> Result<Settings, AgentToolsError> {
    let root = location
        .settings_root()
        .ok_or_else(|| AgentToolsError::from("no data folder to store settings in".to_string()))?;
    // Each switch changes only itself: flipping one must not reset the other
    // to whatever a caller that did not mention it happened to default to.
    let current = settings::load(&root);
    let next = Settings {
        automatically_save: automatically_save.unwrap_or(current.automatically_save),
        memory_enabled: memory_enabled.unwrap_or(current.memory_enabled),
        ..current
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
    /// Usable records whose scope matched this chat, before conflicts,
    /// duplicates and the budget. "Retrieved" in the context panel: a record
    /// here was a candidate, and only `injected_ids` says it was chosen.
    pub candidate_ids: Vec<String>,
    /// The project identity this retrieval was scoped to, when there was one.
    /// Lets the panel say which project a request used after the chat moves.
    pub project_id: Option<String>,
    /// Memory is switched off in settings, so nothing was read.
    pub disabled: bool,
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
            candidate_ids: Vec::new(),
            project_id: None,
            disabled: false,
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

    // Switched off in settings: answered before any record is opened, and
    // said so, so the panel can tell "off" apart from "nothing applies".
    let enabled = location
        .settings_root()
        .map(|root| settings::load(&root).memory_enabled)
        .unwrap_or(true);
    if !enabled {
        return Ok(Retrieved {
            disabled: true,
            ..Retrieved::empty()
        });
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
    let permanent = crate::workspace::permanent_store(std::path::Path::new(&location.data_folder));
    records.extend(super::store::load(&permanent, Scope::User).records);
    records.extend(super::store::load(&permanent, Scope::Session).records);

    // The same two filters `select` starts with, so a candidate here is
    // exactly a record `select` considered.
    let candidate_ids: Vec<String> = records
        .iter()
        .filter(|r| r.applies_to(access.session_id.as_deref(), access.project_id.as_deref()))
        .filter(|r| r.is_usable(now))
        .map(|r| r.id.as_str().to_string())
        .collect();

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
        candidate_ids,
        project_id: access.project_id.clone(),
        disabled: false,
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

    /// The project id is derived, never taken from the caller verbatim. The
    /// only project name a caller may give is a workspace project, and that is
    /// namespaced so it cannot spell a folder project's identity.
    #[test]
    fn a_caller_cannot_name_the_project_id_it_wants() {
        let fields: Vec<String> = serde_json::to_value(Where::default())
            .ok()
            .and_then(|v| v.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()))
            .unwrap_or_default();
        assert!(
            !fields.iter().any(|f| f == "projectId"),
            "the renderer must not be able to supply a raw project id: {fields:?}"
        );

        // Naming a folder project's id as a workspace project reaches a
        // different, namespaced identity.
        let dir = std::env::temp_dir().join(format!("jan-where-ns-{}", std::process::id()));
        let access = Where {
            data_folder: dir.to_string_lossy().to_string(),
            jan_project_id: Some("proj-0123456789abcdef".into()),
            ..Where::default()
        }
        .access();
        assert_eq!(
            access.project_id.as_deref(),
            Some("jan-project:proj-0123456789abcdef")
        );
    }

    #[test]
    fn an_unusable_workspace_project_id_means_no_project_not_another_one() {
        for raw in ["", "   ", "../other", "a b", "jan-project:x", &"x".repeat(200)] {
            let access = Where {
                data_folder: "/tmp/x".into(),
                jan_project_id: Some(raw.to_string()),
                ..Where::default()
            }
            .access();
            assert!(access.project_id.is_none(), "{raw:?} was accepted");
            assert!(access.project_store.is_none(), "{raw:?} opened a store");
        }
    }

    /// A folder is the identity whenever there is one, so a Jan project linked
    /// to a Cowork workspace keeps the memories that folder already holds.
    #[test]
    fn a_folder_wins_over_a_workspace_project() {
        let root = std::env::temp_dir().join(format!("jan-where-folder-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let access = Where {
            data_folder: "/tmp/x".into(),
            project_root: Some(root.to_string_lossy().to_string()),
            jan_project_id: Some("p1".into()),
            ..Where::default()
        }
        .access();
        let id = access.project_id.expect("folder identity");
        assert!(!id.starts_with(JAN_PROJECT_PREFIX), "{id}");
        assert_eq!(access.project_store, Some(workspace::project_store(&root)));
        let _ = std::fs::remove_dir_all(&root);
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
        let mut s = serializer.serialize_struct("Where", 4)?;
        s.serialize_field("dataFolder", &self.data_folder)?;
        s.serialize_field("projectRoot", &self.project_root)?;
        s.serialize_field("sessionId", &self.session_id)?;
        s.serialize_field("janProjectId", &self.jan_project_id)?;
        s.end()
    }
}

#[cfg(test)]
mod workspace_project_tests {
    //! Project memory for Jan's sidebar projects, which have no folder.

    use super::*;
    use crate::memory::record::{Creator, MemoryId, MemoryRecord, Origin};

    fn root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "jan-wsproj-{name}-{}-{}",
            std::process::id(),
            now()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("root");
        dir
    }

    fn at(dir: &Path, project: Option<&str>, session: &str) -> Where {
        Where {
            data_folder: dir.to_string_lossy().to_string(),
            project_root: None,
            session_id: Some(session.to_string()),
            jan_project_id: project.map(str::to_string),
        }
    }

    /// Save an explicit project memory through the same commands the UI uses.
    async fn remember_in_project(dir: &Path, project: &str, content: &str) -> MemoryView {
        let location = at(dir, Some(project), "chat-in-project");
        let proposal = memory_record_propose(
            location.clone(),
            "project".into(),
            content.into(),
            None,
            None,
        )
        .await
        .expect("propose");
        memory_record_commit(
            location,
            "project".into(),
            content.into(),
            proposal.content_hash,
            None,
            None,
        )
        .await
        .expect("commit")
    }

    fn user_memory(dir: &Path, content: &str) {
        let store = workspace::permanent_store(dir);
        let record = MemoryRecord::new(
            MemoryId::new(format!("mem-user-{}", content.len())),
            content,
            Scope::User,
            Creator::User,
            Origin::Explicit,
            now(),
        );
        crate::memory::store::upsert(&store, &record).expect("user memory");
    }

    #[tokio::test]
    async fn a_project_memory_is_saved_under_the_namespaced_identity() {
        let dir = root("save");
        let saved = remember_in_project(&dir, "p-alpha", "Alpha deploys with make ship.").await;
        assert_eq!(saved.scope, "project");
        assert_eq!(saved.project_id.as_deref(), Some("jan-project:p-alpha"));
        // In the data-folder store: there is no project folder to put it in.
        let records =
            crate::memory::store::load(&workspace::permanent_store(&dir), Scope::Project).records;
        assert_eq!(records.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The isolation that matters: project A's memory never reaches a chat in
    /// project B, or a chat in no project.
    #[tokio::test]
    async fn project_memory_is_never_retrieved_for_another_project_or_none() {
        let dir = root("isolation");
        let a = remember_in_project(&dir, "p-alpha", "Alpha deploys with make ship.").await;
        let b = remember_in_project(&dir, "p-beta", "Beta deploys with cargo dist.").await;
        user_memory(&dir, "The user prefers metric units.");

        let in_a = memory_retrieve(at(&dir, Some("p-alpha"), "chat-1"), None, None)
            .await
            .unwrap();
        assert!(in_a.injected_ids.contains(&a.id));
        assert!(!in_a.injected_ids.contains(&b.id), "B leaked into A");
        assert!(!in_a.candidate_ids.contains(&b.id), "B was even a candidate in A");
        assert!(in_a.block.as_deref().unwrap_or("").contains("make ship"));
        assert!(!in_a.block.as_deref().unwrap_or("").contains("cargo dist"));
        assert_eq!(in_a.project_id.as_deref(), Some("jan-project:p-alpha"));

        let in_b = memory_retrieve(at(&dir, Some("p-beta"), "chat-2"), None, None)
            .await
            .unwrap();
        assert!(in_b.injected_ids.contains(&b.id));
        assert!(!in_b.injected_ids.contains(&a.id), "A leaked into B");

        let nowhere = memory_retrieve(at(&dir, None, "chat-3"), None, None)
            .await
            .unwrap();
        assert!(!nowhere.injected_ids.contains(&a.id));
        assert!(!nowhere.injected_ids.contains(&b.id));
        assert!(nowhere.candidate_ids.iter().all(|id| id != &a.id && id != &b.id));
        assert!(nowhere.project_id.is_none());
        // User memory still applies everywhere.
        assert!(nowhere.block.as_deref().unwrap_or("").contains("metric"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Moving a chat to another project changes what the next retrieval sees.
    #[tokio::test]
    async fn a_chat_that_moves_projects_sees_the_new_project_next_time() {
        let dir = root("move");
        let a = remember_in_project(&dir, "p-alpha", "Alpha uses tabs.").await;
        let b = remember_in_project(&dir, "p-beta", "Beta uses spaces.").await;
        let before = memory_retrieve(at(&dir, Some("p-alpha"), "chat-x"), None, None)
            .await
            .unwrap();
        let after = memory_retrieve(at(&dir, Some("p-beta"), "chat-x"), None, None)
            .await
            .unwrap();
        assert_eq!(before.injected_ids, vec![a.id.clone()]);
        assert_eq!(after.injected_ids, vec![b.id.clone()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Managing a project's memories from Settings sees only that project.
    #[tokio::test]
    async fn listing_a_project_shows_only_that_project() {
        let dir = root("list");
        remember_in_project(&dir, "p-alpha", "Alpha fact.").await;
        remember_in_project(&dir, "p-beta", "Beta fact.").await;
        let page = memory_records_list(at(&dir, Some("p-beta"), "s"), "project".into(), None, None, None)
            .await
            .unwrap();
        assert_eq!(page.items.len(), 1);
        assert!(page.items[0].content.contains("Beta"));
        // And no project at all is a refusal, not everything.
        assert!(
            memory_records_list(at(&dir, None, "s"), "project".into(), None, None, None)
                .await
                .is_err()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn disabled_memory_retrieves_nothing_and_says_so() {
        let dir = root("disabled");
        remember_in_project(&dir, "p-alpha", "Alpha deploys with make ship.").await;
        user_memory(&dir, "The user prefers metric units.");

        let settings = memory_settings_update(at(&dir, None, "s"), None, Some(false))
            .await
            .unwrap();
        assert!(!settings.memory_enabled);
        // Turning memory off did not touch the other switch.
        assert!(!settings.automatically_save);

        let out = memory_retrieve(at(&dir, Some("p-alpha"), "s"), None, None)
            .await
            .unwrap();
        assert!(out.disabled);
        assert!(out.block.is_none());
        assert!(out.injected_ids.is_empty());
        assert!(out.candidate_ids.is_empty());

        // Back on: the records were kept, and apply again.
        memory_settings_update(at(&dir, None, "s"), None, Some(true))
            .await
            .unwrap();
        let again = memory_retrieve(at(&dir, Some("p-alpha"), "s"), None, None)
            .await
            .unwrap();
        assert!(!again.disabled);
        assert_eq!(again.injected_ids.len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn each_switch_changes_only_itself() {
        let dir = root("switches");
        memory_settings_update(at(&dir, None, "s"), Some(true), None)
            .await
            .unwrap();
        let s = memory_settings_update(at(&dir, None, "s"), None, Some(false))
            .await
            .unwrap();
        assert!(s.automatically_save, "disabling memory reset automatic saving");
        let s = memory_settings_update(at(&dir, None, "s"), Some(false), None)
            .await
            .unwrap();
        assert!(!s.memory_enabled, "changing automatic saving re-enabled memory");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_older_settings_file_without_the_switch_keeps_memory_on() {
        let dir = root("legacy");
        let store = workspace::permanent_store(&dir);
        std::fs::create_dir_all(crate::memory::memory_dir(&store)).unwrap();
        std::fs::write(settings::settings_path(&store), r#"{"automaticallySave":true}"#).unwrap();
        let loaded = settings::load(&store);
        assert!(loaded.memory_enabled);
        assert!(loaded.automatically_save);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_temporary_chat_in_a_project_reads_nothing() {
        let dir = root("temporary");
        remember_in_project(&dir, "p-alpha", "Alpha deploys with make ship.").await;
        let out = memory_retrieve(at(&dir, Some("p-alpha"), "temporary-chat"), Some(true), None)
            .await
            .unwrap();
        assert!(out.injected_ids.is_empty());
        assert!(out.candidate_ids.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The model cannot choose a workspace project. Its memory tool takes a
    /// `ToolContext` built from a folder, and an argument naming a workspace
    /// project is not read -- the record lands under the folder's identity.
    #[tokio::test]
    async fn the_model_tool_path_cannot_supply_a_workspace_project() {
        let dir = root("tool");
        let store = workspace::permanent_store(&dir);
        std::fs::create_dir_all(&store).unwrap();
        settings::save(
            &store,
            &Settings {
                automatically_save: true,
                ..Settings::default()
            },
        )
        .unwrap();
        let project = dir.join("sandbox");
        std::fs::create_dir_all(&project).unwrap();
        let root_ref: &'static Path = Box::leak(project.clone().into_boxed_path());
        let store_ref: &'static Path = Box::leak(store.clone().into_boxed_path());

        // No model-facing schema offers such an argument.
        let schema =
            serde_json::to_string(&crate::tools::schema::builtin_tool_schemas()).unwrap_or_default();
        assert!(schema.contains("memory_propose"), "schema list is not the one advertised");
        assert!(!schema.contains("janProjectId"), "a tool advertises janProjectId");
        assert!(!schema.contains("jan_project"), "a tool advertises jan_project");

        let ctx = crate::tools::ToolContext::new(root_ref, store_ref, &[])
            .in_session(Some("chat-a"), false);
        let _ = crate::tools::handlers::execute_text(
            crate::tools::lookup("memory_propose").unwrap(),
            &serde_json::json!({
                "content": "The staging host is blue.",
                "scope": "project",
                "janProjectId": "p-alpha",
                "jan_project_id": "p-alpha",
                "project_id": "jan-project:p-alpha",
            }),
            &ctx,
        )
        .await;

        // Nothing was filed under the workspace project...
        let workspace_records =
            crate::memory::store::load(&store, Scope::Project).records;
        assert!(
            workspace_records
                .iter()
                .all(|r| r.project_id.as_deref() != Some("jan-project:p-alpha")),
            "a tool argument chose a workspace project"
        );
        let in_project = memory_retrieve(at(&dir, Some("p-alpha"), "chat-a"), None, None)
            .await
            .unwrap();
        assert!(!in_project
            .block
            .as_deref()
            .unwrap_or("")
            .contains("staging host"));
        let _ = std::fs::remove_dir_all(&dir);
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
            jan_project_id: None,
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
                jan_project_id: None,
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
            jan_project_id: None,
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
