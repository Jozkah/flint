//! Should a new session start in its own worktree?

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::{head, path_key};
use crate::session_mailbox::{Mailbox, SessionStatus};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IsolationInput {
    /// The folder is a git repository.
    pub is_git: bool,
    /// The session was forked from another.
    pub is_fork: bool,
    /// Live sessions already in this folder on the shared tree (not isolated,
    /// not this session).
    pub live_sharing: usize,
    /// The session is already in a worktree or copy.
    pub already_isolated: bool,
    /// The user explicitly chose to work in the shared tree.
    pub user_chose_shared: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IsolationReason {
    /// A fork of a session that is live in the same folder.
    Fork,
    /// A second (or later) session in a folder that has a live one.
    SecondSession,
    NotGit,
    Alone,
    AlreadyIsolated,
    UserChoseShared,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IsolationDecision {
    pub isolate: bool,
    pub reason: IsolationReason,
}

/// The default placement. Pure: callers gather the facts.
pub fn default_isolation(input: &IsolationInput) -> IsolationDecision {
    let (isolate, reason) = if input.already_isolated {
        (false, IsolationReason::AlreadyIsolated)
    } else if !input.is_git {
        (false, IsolationReason::NotGit)
    } else if input.user_chose_shared {
        (false, IsolationReason::UserChoseShared)
    } else if input.live_sharing == 0 {
        (false, IsolationReason::Alone)
    } else if input.is_fork {
        (true, IsolationReason::Fork)
    } else {
        (true, IsolationReason::SecondSession)
    };
    IsolationDecision { isolate, reason }
}

/// Gather the facts for `folder` from the registry and decide. `session_id`
/// is the session being placed (never counted as another); `None` for one
/// not registered yet.
pub fn decide_for_folder(
    mailbox: &Mailbox,
    folder: &str,
    session_id: Option<&str>,
    is_fork: bool,
    user_chose_shared: bool,
) -> IsolationDecision {
    let key = path_key::folder_key(Path::new(folder));
    let live_sharing = mailbox
        .live_in_folder(&key)
        .iter()
        .filter(|r| !r.shared.isolated && Some(r.id.as_str()) != session_id)
        // A second session isolates only beside one that is working now: every
        // session in the app's list stays registered (idle) in its folder, so
        // counting idle ones isolated every new session in a repo that had any
        // earlier thread. A fork still isolates beside its idle parent, which
        // is likely to be picked up again.
        .filter(|r| is_fork || r.status == SessionStatus::Running)
        .count();
    let already_isolated = session_id
        .and_then(|id| mailbox.session(id))
        .is_some_and(|r| r.shared.isolated);
    default_isolation(&IsolationInput {
        is_git: head::is_git_repo(Path::new(folder)),
        is_fork,
        live_sharing,
        already_isolated,
        user_chose_shared,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_registry_decides_a_second_session_in_a_repo() {
        let data = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(repo.path().join(".git")).unwrap();
        std::fs::write(repo.path().join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        let folder = repo.path().to_str().unwrap();
        let m = Mailbox::open(data.path());
        // Empty folder: the first session stays on the shared tree.
        assert!(!decide_for_folder(&m, folder, Some("a"), false, false).isolate);
        m.register_shared("a", "A", Some(folder), None, None, Some(false)).unwrap();
        // An idle session (a finished thread still in the list) is not someone
        // working: a newcomer stays on the shared tree. A fork still isolates.
        assert!(!decide_for_folder(&m, folder, Some("b"), false, false).isolate);
        let fork = decide_for_folder(&m, folder, None, true, false);
        assert_eq!(fork.reason, IsolationReason::Fork);
        m.set_status("a", true, Some("run-1")).unwrap();
        // It is not "another" to itself, but it is to a newcomer.
        assert!(!decide_for_folder(&m, folder, Some("a"), false, false).isolate);
        assert!(decide_for_folder(&m, folder, Some("b"), false, false).isolate);
        // An isolated session does not count as someone on the shared tree.
        m.register_shared("a", "A", Some(folder), None, None, Some(true)).unwrap();
        assert!(!decide_for_folder(&m, folder, Some("b"), false, false).isolate);
        // The user's choice of the shared tree stands.
        m.register_shared("a", "A", Some(folder), None, None, Some(false)).unwrap();
        assert!(!decide_for_folder(&m, folder, Some("b"), false, true).isolate);
    }

    fn base() -> IsolationInput {
        IsolationInput {
            is_git: true,
            is_fork: false,
            live_sharing: 0,
            already_isolated: false,
            user_chose_shared: false,
        }
    }

    #[test]
    fn alone_in_a_repo_stays_on_the_shared_tree() {
        let d = default_isolation(&base());
        assert!(!d.isolate);
        assert_eq!(d.reason, IsolationReason::Alone);
    }

    #[test]
    fn a_second_session_in_a_repo_is_isolated() {
        let d = default_isolation(&IsolationInput { live_sharing: 1, ..base() });
        assert!(d.isolate);
        assert_eq!(d.reason, IsolationReason::SecondSession);
    }

    #[test]
    fn a_fork_beside_its_parent_is_isolated() {
        let d = default_isolation(&IsolationInput { live_sharing: 1, is_fork: true, ..base() });
        assert!(d.isolate);
        assert_eq!(d.reason, IsolationReason::Fork);
    }

    #[test]
    fn a_fork_in_an_empty_folder_is_not() {
        assert!(!default_isolation(&IsolationInput { is_fork: true, ..base() }).isolate);
    }

    #[test]
    fn a_plain_folder_never_is() {
        let d = default_isolation(&IsolationInput { is_git: false, live_sharing: 3, ..base() });
        assert!(!d.isolate);
        assert_eq!(d.reason, IsolationReason::NotGit);
    }

    #[test]
    fn the_users_choice_of_the_shared_tree_wins() {
        let d = default_isolation(&IsolationInput {
            live_sharing: 2,
            is_fork: true,
            user_chose_shared: true,
            ..base()
        });
        assert!(!d.isolate);
        assert_eq!(d.reason, IsolationReason::UserChoseShared);
    }

    #[test]
    fn already_isolated_is_left_alone() {
        let d = default_isolation(&IsolationInput {
            live_sharing: 2,
            already_isolated: true,
            ..base()
        });
        assert!(!d.isolate);
        assert_eq!(d.reason, IsolationReason::AlreadyIsolated);
    }

    #[test]
    fn many_sessions_still_isolate() {
        assert!(default_isolation(&IsolationInput { live_sharing: 9, ..base() }).isolate);
    }
}
