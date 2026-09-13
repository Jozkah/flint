//! What happens to a memory an agent proposes, decided in one place.
//!
//! Two surfaces reach this: the Tauri command the renderer calls, and the
//! `memory_propose` tool the model calls. They must not disagree, so neither
//! owns the rules -- both call [`decide`], which is the only thing that reads
//! the "Automatically save local memories" setting.
//!
//! This module is deliberately free of `tauri`. The tool handler is compiled
//! for the headless CLI too, and a gate that existed only on the desktop would
//! mean the CLI agent could save whatever it liked.
//!
//! The order of the gates is the whole design:
//!
//! 1. **Refusals** -- a credential, an empty body, something absurdly long.
//!    Checked first and unconditionally: automatic saving is permission to skip
//!    the question, never permission to store a secret.
//! 2. **Conflicts** -- it contradicts something already remembered. Both sides
//!    stay withheld until a person says which is right, so this can never
//!    resolve itself by being switched on.
//! 3. **Project → global promotion** -- a fact learned inside a project does
//!    not become global on a guess. Widening what a memory applies to is a
//!    decision.
//! 4. **The setting** -- last, so turning it on cannot reach past any of the
//!    above.

use std::path::Path;

use serde::Serialize;

use super::create::{self, Proposal};
use super::record::{Conflict, Creator, MemoryId, Origin, Scope};
use super::{settings, store};

/// Why an inferred proposal is waiting rather than saved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PendingReason {
    /// Automatic saving is off. The ordinary case, and the default.
    AutomaticSavingDisabled,
    /// It contradicts something already remembered.
    ConflictsWithExisting,
    /// It would put a fact learned inside a project into the global scope.
    WouldPromoteProjectFactGlobally,
}

impl PendingReason {
    /// One sentence for the approval card. Says what happened and what the
    /// person is being asked to decide, rather than "needs approval".
    pub fn explain(self) -> &'static str {
        match self {
            PendingReason::AutomaticSavingDisabled => {
                "Automatic saving is off, so this is waiting for you."
            }
            PendingReason::ConflictsWithExisting => {
                "This contradicts something already remembered. Both are being \
                 withheld until you say which is right."
            }
            PendingReason::WouldPromoteProjectFactGlobally => {
                "This was learned in a project and would apply everywhere. \
                 Widening it is your decision, not a guess."
            }
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            PendingReason::AutomaticSavingDisabled => "automatic-saving-disabled",
            PendingReason::ConflictsWithExisting => "conflicts-with-existing",
            PendingReason::WouldPromoteProjectFactGlobally => "would-promote-project-fact-globally",
        }
    }
}

/// What should happen to one proposal.
///
/// Three outcomes rather than a boolean, because they need completely different
/// things from the user: nothing, a decision, or an explanation.
#[derive(Clone)]
pub enum Decision {
    /// Eligible. The caller commits it.
    Save(Box<Proposal>),
    /// Waiting for a person, with the reason to show them.
    Pending {
        proposal: Box<Proposal>,
        reason: PendingReason,
    },
    /// Not storable at all. Nothing is written and nothing is offered.
    Refused { reason: String },
}

/// Everything the decision depends on, so it can be made without a store.
pub struct Context<'a> {
    pub scope: Scope,
    pub project_id: Option<&'a str>,
    pub session_id: Option<&'a str>,
    /// A temporary chat neither reads nor records.
    pub temporary: bool,
    pub now: i64,
    /// Whether the user turned automatic saving on.
    pub automatically_save: bool,
}

/// Decide what to do with content an agent inferred.
///
/// `existing` is the scope's current records, used for conflict and duplicate
/// detection. Nothing here writes.
pub fn decide(
    id: MemoryId,
    content: &str,
    existing: &[super::record::MemoryRecord],
    ctx: &Context<'_>,
) -> Decision {
    if ctx.temporary {
        return Decision::Refused {
            reason: "This is a temporary chat, so nothing from it is remembered.".to_string(),
        };
    }

    let proposal = match create::propose(
        id,
        content,
        ctx.scope,
        ctx.project_id,
        ctx.session_id,
        // An agent's guess, marked as one. `Creator::Agent` is what stops it
        // overriding something the user saved; `Origin::Inferred` is what the
        // UI reads to label it.
        Creator::Agent,
        Origin::Inferred,
        ctx.now,
        existing,
    ) {
        Ok(proposal) => proposal,
        Err(refusal) => {
            return Decision::Refused {
                reason: refusal.message(),
            }
        }
    };

    let reason = if !proposal.conflicts.is_empty() {
        Some(PendingReason::ConflictsWithExisting)
    } else if ctx.scope == Scope::User && ctx.project_id.is_some() {
        Some(PendingReason::WouldPromoteProjectFactGlobally)
    } else if !ctx.automatically_save {
        Some(PendingReason::AutomaticSavingDisabled)
    } else {
        None
    };

    match reason {
        Some(reason) => Decision::Pending {
            proposal: Box::new(proposal),
            reason,
        },
        None => Decision::Save(Box::new(proposal)),
    }
}

/// The record to store for a proposal awaiting an answer.
///
/// Persisting the question is what makes it survivable: the user is asked once
/// and can answer later, after a restart, from Settings rather than only from
/// the conversation that produced it. `Status::Proposed` keeps it out of every
/// prompt in the meantime, because `is_usable` admits only `Active`.
pub fn as_pending(proposal: &Proposal, reason: PendingReason) -> super::record::MemoryRecord {
    let mut record = proposal.record.clone();
    record.status = super::record::Status::Proposed {
        reason: reason.as_str().to_string(),
    };
    record
}

/// The reason a stored proposal is waiting, recovered from its status.
pub fn pending_reason(record: &super::record::MemoryRecord) -> Option<PendingReason> {
    let super::record::Status::Proposed { reason } = &record.status else {
        return None;
    };
    Some(match reason.as_str() {
        "conflicts-with-existing" => PendingReason::ConflictsWithExisting,
        "would-promote-project-fact-globally" => {
            PendingReason::WouldPromoteProjectFactGlobally
        }
        _ => PendingReason::AutomaticSavingDisabled,
    })
}

/// Read the setting from a store root, defaulting to off.
pub fn automatic_saving_enabled(settings_root: &Path) -> bool {
    settings::load(settings_root).automatically_save
}

/// The records a decision must be made against.
pub fn existing_records(store_root: &Path, scope: Scope) -> Vec<super::record::MemoryRecord> {
    store::load(store_root, scope).records
}

/// Conflicts, as ids, for a caller that reports them.
pub fn conflict_ids(conflicts: &[Conflict]) -> Vec<String> {
    conflicts
        .iter()
        .flat_map(|c| [c.left.as_str().to_string(), c.right.as_str().to_string()])
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(automatically_save: bool) -> Context<'static> {
        Context {
            scope: Scope::User,
            project_id: None,
            session_id: Some("chat-a"),
            temporary: false,
            now: 1_700_000_000,
            automatically_save,
        }
    }

    fn id() -> MemoryId {
        MemoryId::new("mem-test")
    }

    #[test]
    fn the_default_is_to_ask() {
        match decide(id(), "The user prefers tabs.", &[], &ctx(false)) {
            Decision::Pending { reason, .. } => {
                assert_eq!(reason, PendingReason::AutomaticSavingDisabled)
            }
            other => panic!("expected pending, got {other:?}"),
        }
    }

    #[test]
    fn an_eligible_proposal_saves_once_allowed() {
        assert!(matches!(
            decide(id(), "The user prefers tabs.", &[], &ctx(true)),
            Decision::Save(_)
        ));
    }

    /// The rule the feature rests on.
    #[test]
    fn a_credential_is_refused_however_the_setting_is_set() {
        for allowed in [false, true] {
            match decide(
                id(),
                "The API key is sk-live-abcdefghijklmnopqrstuvwxyz012345.",
                &[],
                &ctx(allowed),
            ) {
                Decision::Refused { reason } => assert!(!reason.is_empty()),
                other => panic!("a secret must never be storable, got {other:?}"),
            }
        }
    }

    #[test]
    fn a_temporary_chat_is_answered_before_anything_is_read() {
        let mut c = ctx(true);
        c.temporary = true;
        assert!(matches!(
            decide(id(), "The user prefers tabs.", &[], &c),
            Decision::Refused { .. }
        ));
    }

    /// Turning the setting on must not reach past the earlier gates.
    #[test]
    fn a_project_fact_is_not_promoted_globally_even_when_allowed() {
        let mut c = ctx(true);
        c.project_id = Some("proj-1");
        match decide(id(), "The build command is `cargo dist`.", &[], &c) {
            Decision::Pending { reason, .. } => {
                assert_eq!(reason, PendingReason::WouldPromoteProjectFactGlobally)
            }
            other => panic!("expected pending, got {other:?}"),
        }
    }

    /// A project-scoped fact in a project is fine -- it is not being widened.
    #[test]
    fn a_project_scoped_fact_saves_inside_its_project() {
        let mut c = ctx(true);
        c.project_id = Some("proj-1");
        c.scope = Scope::Project;
        assert!(matches!(
            decide(id(), "The build command is `cargo dist`.", &[], &c),
            Decision::Save(_)
        ));
    }

    #[test]
    fn every_pending_reason_explains_itself_without_saying_needs_approval() {
        for reason in [
            PendingReason::AutomaticSavingDisabled,
            PendingReason::ConflictsWithExisting,
            PendingReason::WouldPromoteProjectFactGlobally,
        ] {
            let text = reason.explain();
            assert!(text.len() > 20, "{text}");
            assert!(!text.to_lowercase().contains("needs approval"), "{text}");
            assert!(!reason.as_str().is_empty());
        }
    }
}

impl std::fmt::Debug for Decision {
    /// Never prints the proposed content: a `Decision` is logged in
    /// diagnostics, and the thing being proposed may be the reason it was
    /// refused.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Decision::Save(_) => write!(f, "Save(<content>)"),
            Decision::Pending { reason, .. } => {
                write!(f, "Pending({})", reason.as_str())
            }
            Decision::Refused { reason } => write!(f, "Refused({reason})"),
        }
    }
}
