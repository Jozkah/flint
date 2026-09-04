//! Who may write where, and for how long.
//!
//! The write boundary itself lives in the tool gate and the shell policy. This
//! is the thing that decides whether a run gets to hand them a root at all.
//!
//! Two properties shape the design.
//!
//! The renderer never passes a path at tool time. It authorizes once, naming
//! the folder the user confirmed, and afterwards carries an opaque id. So a
//! path arriving with a tool call cannot become authority no matter where it
//! came from, and the only way to widen a root is to ask the user again.
//!
//! Nothing here is persisted. A grant lives in this process and dies with it,
//! which is what makes "restarting Jan does not silently restore write access
//! to your repository" true by construction rather than by remembering to
//! clear something.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use crate::tools::jail;

/// One authorization: a folder, the session it was granted to, and nothing else.
#[derive(Debug, Clone)]
struct Grant {
    session_id: String,
    /// Canonical, as the backend resolved it — never as the caller spelled it.
    root: PathBuf,
}

fn registry() -> &'static Mutex<HashMap<String, Grant>> {
    static GRANTS: OnceLock<Mutex<HashMap<String, Grant>>> = OnceLock::new();
    GRANTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Can this platform confine both the file tools and the shell to a repository?
///
/// Asked of the sandbox backend rather than declared here, so a platform that
/// cannot hold the line is never offered the option. See
/// [`jail::supports_write_roots`].
pub fn capability() -> bool {
    jail::supports_write_roots(jail::backend())
}

/// A new opaque id.
///
/// Process-local and never shown to a model, so this needs to be unique rather
/// than unguessable. The clock and a counter give that without a dependency.
fn new_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("grant-{}-{n}-{nanos}", std::process::id())
}

/// Authorize `folder` for `session_id`, returning the id the run will carry.
///
/// Validated exactly as an attached read root is — canonicalized, refused at
/// the filesystem root, refused when it overlaps the session workspace or the
/// Jan data folder — so authorizing a repository can never authorize Jan's own
/// settings, keys, memories or skill storage.
///
/// Reauthorizing a session replaces its previous grant under the same lock, so
/// there is no moment when a session holds two, and no way for the old one to
/// outlive the new.
///
/// Nothing is published if any step fails: the registry is only touched after
/// validation has succeeded.
pub fn authorize(
    session_id: &str,
    folder: &str,
    workspace: &Path,
    data_folder: &Path,
) -> Result<String, String> {
    if !capability() {
        return Err(format!(
            "this platform cannot confine a shell to a project folder ({}), \
             so editing a folder directly is not available",
            jail::backend().as_str()
        ));
    }
    if session_id.is_empty() {
        return Err("a grant needs the session it belongs to".to_string());
    }
    let root =
        crate::workspace::validate_read_root(Path::new(folder), workspace, Some(data_folder))?;

    let id = new_id();
    let mut grants = registry().lock().map_err(|_| "grant registry poisoned")?;
    grants.retain(|_, grant| grant.session_id != session_id);
    grants.insert(
        id.clone(),
        Grant {
            session_id: session_id.to_string(),
            root,
        },
    );
    Ok(id)
}

/// Withdraw one grant. Idempotent: revoking what is already gone is success.
pub fn revoke(grant_id: &str) -> bool {
    registry()
        .lock()
        .map(|mut grants| grants.remove(grant_id).is_some())
        .unwrap_or(false)
}

/// Withdraw everything a session holds — detaching, switching, deleting.
pub fn revoke_session(session_id: &str) -> usize {
    let Ok(mut grants) = registry().lock() else {
        return 0;
    };
    let before = grants.len();
    grants.retain(|_, grant| grant.session_id != session_id);
    before - grants.len()
}

/// The root this grant authorizes, if it is live and belongs to `session_id`.
///
/// The session check is not decoration. An id that leaked, or was held across a
/// session switch, must not authorize a write in a session it was never given
/// to — so the answer is `None` and the run writes to its sandbox as if it had
/// never been authorized at all.
pub fn resolve(grant_id: &str, session_id: &str) -> Option<PathBuf> {
    let grants = registry().lock().ok()?;
    let grant = grants.get(grant_id)?;
    (grant.session_id == session_id).then(|| grant.root.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);

    /// A workspace, a data folder, a repository — and the session id they
    /// belong to.
    ///
    /// The session is unique per test because the registry is process-wide and
    /// the tests run in parallel: sharing a name would let one test's
    /// `revoke_session` count another's grants.
    fn fixture() -> (PathBuf, PathBuf, PathBuf, String) {
        let n = N.fetch_add(1, Ordering::SeqCst);
        let base = std::env::temp_dir().join(format!("jan_grants_{}_{n}", std::process::id()));
        let workspace = base.join("workspace");
        let data = base.join("data");
        let repo = base.join("obs-forwarder");
        for dir in [&workspace, &data, &repo] {
            std::fs::create_dir_all(dir).expect("create dir");
        }
        (
            workspace,
            data,
            repo,
            format!("session-{}-{n}", std::process::id()),
        )
    }

    /// The registry only issues grants where the sandbox can hold them, so
    /// every test that expects an id has to say what it needs.
    macro_rules! require_capability {
        () => {
            if !capability() {
                eprintln!("skipping: no backend that can confine a repository");
                return;
            }
        };
    }

    #[test]
    fn a_grant_resolves_only_for_the_session_it_was_given_to() {
        require_capability!();
        let (ws, data, repo, session) = fixture();
        let id = authorize(&session, &repo.to_string_lossy(), &ws, &data).unwrap();

        assert_eq!(resolve(&id, &session), Some(repo.canonicalize().unwrap()));
        // The same id, in another session, authorizes nothing.
        assert_eq!(resolve(&id, "another-session"), None);

        revoke(&id);
        let _ = std::fs::remove_dir_all(ws.parent().unwrap());
    }

    #[test]
    fn revoking_is_idempotent_and_stops_resolution() {
        require_capability!();
        let (ws, data, repo, session) = fixture();
        let id = authorize(&session, &repo.to_string_lossy(), &ws, &data).unwrap();

        assert!(revoke(&id));
        assert!(
            !revoke(&id),
            "revoking twice is success, not a second removal"
        );
        assert_eq!(resolve(&id, &session), None);

        let _ = std::fs::remove_dir_all(ws.parent().unwrap());
    }

    // Reauthorizing must not leave the previous folder reachable.
    #[test]
    fn reauthorizing_a_session_invalidates_its_previous_grant() {
        require_capability!();
        let (ws, data, repo, session) = fixture();
        let other = repo.parent().unwrap().join("note-py");
        std::fs::create_dir_all(&other).unwrap();

        let first = authorize(&session, &repo.to_string_lossy(), &ws, &data).unwrap();
        let second = authorize(&session, &other.to_string_lossy(), &ws, &data).unwrap();

        assert_eq!(resolve(&first, &session), None);
        assert_eq!(
            resolve(&second, &session),
            Some(other.canonicalize().unwrap())
        );

        revoke(&second);
        let _ = std::fs::remove_dir_all(ws.parent().unwrap());
    }

    #[test]
    fn revoking_a_session_withdraws_everything_it_held() {
        require_capability!();
        let (ws, data, repo, session) = fixture();
        let id = authorize(&session, &repo.to_string_lossy(), &ws, &data).unwrap();

        assert_eq!(revoke_session(&session), 1);
        assert_eq!(resolve(&id, &session), None);
        assert_eq!(revoke_session(&session), 0);

        let _ = std::fs::remove_dir_all(ws.parent().unwrap());
    }

    #[test]
    fn an_unknown_grant_authorizes_nothing() {
        assert_eq!(resolve("grant-does-not-exist", "any-session"), None);
    }

    // The folder the user is editing must never be able to be Jan's own state.
    #[test]
    fn the_data_folder_cannot_be_authorized() {
        require_capability!();
        let (ws, data, _repo, session) = fixture();

        let err = authorize(&session, &data.to_string_lossy(), &ws, &data)
            .expect_err("the data folder must be refused");
        assert!(!err.is_empty());

        let _ = std::fs::remove_dir_all(ws.parent().unwrap());
    }

    #[test]
    fn the_session_workspace_cannot_be_authorized() {
        require_capability!();
        let (ws, data, _repo, session) = fixture();

        assert!(authorize(&session, &ws.to_string_lossy(), &ws, &data).is_err());

        let _ = std::fs::remove_dir_all(ws.parent().unwrap());
    }

    #[test]
    fn a_folder_that_does_not_exist_cannot_be_authorized() {
        require_capability!();
        let (ws, data, repo, session) = fixture();
        let gone = repo.join("nowhere");

        assert!(authorize(&session, &gone.to_string_lossy(), &ws, &data).is_err());

        let _ = std::fs::remove_dir_all(ws.parent().unwrap());
    }

    #[test]
    fn a_grant_needs_a_session() {
        require_capability!();
        let (ws, data, repo, _session) = fixture();

        assert!(authorize("", &repo.to_string_lossy(), &ws, &data).is_err());

        let _ = std::fs::remove_dir_all(ws.parent().unwrap());
    }
}
