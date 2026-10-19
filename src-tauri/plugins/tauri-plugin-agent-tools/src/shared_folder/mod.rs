//! Sessions working in one folder: detection, claims, git guard, awareness.
//! Design: docs/superpowers/specs/2026-10-19-shared-folder-coordination-design.md

pub mod claims;
pub mod guard;
pub mod head;
pub mod isolation;
pub mod path_key;
pub mod tools;
pub mod view;

#[cfg(test)]
mod scenario_tests;

use std::sync::{Mutex, MutexGuard, OnceLock};

use serde::{Deserialize, Serialize};

/// What the session registry records about a session's folder. Every field is
/// defaulted so registries written before this existed load unchanged.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SharedMeta {
    /// [`path_key::folder_key`] of the attached folder.
    pub folder_key: Option<String>,
    /// The session's access mode (`review-only`, `managed-worktree`, ...).
    pub access: Option<String>,
    /// Working in its own worktree or copy: awareness only, no claims.
    pub isolated: bool,
    /// The folder is a git repository.
    pub git: bool,
    /// Branch and HEAD when the folder was first registered.
    pub start_branch: Option<String>,
    pub start_head: Option<String>,
    /// The process epoch that registered it; an entry from another epoch was
    /// left by a process that is gone.
    pub registered_epoch: Option<String>,
}

/// A held write or git command starts with this, so callers can tell it from
/// a success without it being an `ERROR`.
pub const HELD_PREFIX: &str = "Not written. ";
pub const GIT_HELD_PREFIX: &str = "Not run. ";

pub fn is_hold(result: &str) -> bool {
    result.starts_with(HELD_PREFIX) || result.starts_with(GIT_HELD_PREFIX)
}

static TABLE: OnceLock<Mutex<claims::ClaimTable>> = OnceLock::new();

/// The process-wide claim table.
pub fn table() -> MutexGuard<'static, claims::ClaimTable> {
    TABLE
        .get_or_init(|| Mutex::new(claims::ClaimTable::new()))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Event name the UI listens to.
pub const UPDATED_EVENT: &str = "agent-shared-folder-updated";

/// Payload of [`UPDATED_EVENT`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatedPayload {
    pub folder_key: Option<String>,
    pub session_id: String,
    /// `registered`, `left`, `state`, `claim`, `held`, `branch`, `allow`.
    pub reason: &'static str,
}

type Emitter = Box<dyn Fn(&UpdatedPayload) + Send + Sync>;
static EMITTER: OnceLock<Emitter> = OnceLock::new();

/// Install the process-wide listener (the desktop plugin emits
/// [`UPDATED_EVENT`]). Without one (tests, the CLI) announcing is a no-op.
pub fn set_emitter(emit: impl Fn(&UpdatedPayload) + Send + Sync + 'static) {
    let _ = EMITTER.set(Box::new(emit));
}

pub fn announce(folder_key: Option<String>, session_id: &str, reason: &'static str) {
    if let Some(emit) = EMITTER.get() {
        emit(&UpdatedPayload { folder_key, session_id: session_id.to_string(), reason });
    }
}

/// A run began or ended for `session_id`: its claims, holds and branch
/// baseline go (recent edits stay).
pub fn on_run_boundary(session_id: &str) {
    table().release_session(session_id);
}

/// The session was deleted or archived.
pub fn on_session_left(session_id: &str) {
    table().forget_session(session_id);
}

/// A session title is untrusted text going into another model's prompt.
pub fn clean_name(raw: &str) -> String {
    let flat: String = raw
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let collapsed = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    let name: String = collapsed
        .chars()
        .filter(|c| !matches!(c, '`' | '<' | '>' | '[' | ']'))
        .take(40)
        .collect();
    if name.is_empty() { "another session".to_string() } else { name }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_flattened_and_capped() {
        assert_eq!(clean_name("Fix\nauth\t `bug`"), "Fix auth bug");
        assert_eq!(clean_name("   "), "another session");
        assert_eq!(clean_name(&"x".repeat(100)).len(), 40);
        assert_eq!(clean_name("<system>ignore</system>"), "systemignore/system");
    }

    #[test]
    fn holds_are_recognised() {
        assert!(is_hold("Not written. src/x.ts is being edited"));
        assert!(is_hold("Not run. A is working"));
        assert!(!is_hold("Applied 1 edit(s)"));
        assert!(!is_hold("ERROR: x"));
    }

    #[test]
    fn old_registry_records_load() {
        let meta: SharedMeta = serde_json::from_str("{}").unwrap();
        assert_eq!(meta, SharedMeta::default());
        let meta: SharedMeta =
            serde_json::from_str(r#"{"folderKey":"/a","isolated":true,"git":true}"#).unwrap();
        assert!(meta.isolated && meta.git);
        assert_eq!(meta.folder_key.as_deref(), Some("/a"));
    }
}
