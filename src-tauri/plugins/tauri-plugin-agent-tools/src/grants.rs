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

#[cfg(any(feature = "tauri", test))]
use std::collections::HashMap;
#[cfg(any(feature = "tauri", test))]
use std::path::{Path, PathBuf};
#[cfg(any(feature = "tauri", test))]
use std::sync::{Mutex, OnceLock};

#[cfg(any(feature = "tauri", test))]
use crate::tools::jail;

/// One authorization: a folder, the session it was granted to, and nothing else.
#[derive(Debug, Clone)]
#[cfg(any(feature = "tauri", test))]
struct Grant {
    session_id: String,
    /// Canonical, as the backend resolved it — never as the caller spelled it.
    root: PathBuf,
    /// The session's additional attached folders, validated like `root` and
    /// canonical. Always after `root` in what [`resolve_all`] returns, so the
    /// primary stays the first write root (the one a managed worktree run's
    /// shell starts in).
    extra_roots: Vec<PathBuf>,
    /// The session workspace the grant was issued against. Its sandbox
    /// container holds the folder ACEs on AppContainer, so withdrawing the
    /// grant withdraws them through it ([`withdraw_folder_aces`]).
    workspace: PathBuf,
}

#[cfg(any(feature = "tauri", test))]
fn registry() -> &'static Mutex<HashMap<String, Grant>> {
    static GRANTS: OnceLock<Mutex<HashMap<String, Grant>>> = OnceLock::new();
    GRANTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Can this platform confine both the file tools and the shell to a repository?
///
/// Asked of the sandbox backend rather than declared here, so a platform that
/// cannot hold the line is never offered the option. See
/// [`jail::supports_write_roots`].
#[cfg(any(feature = "tauri", test))]
pub fn capability() -> bool {
    jail::supports_write_roots(jail::backend())
}

/// Can this platform confine a run to a worktree Jan owns?
///
/// True wherever [`capability`] is, and also on Windows, where AppContainer
/// can grant a Jan-owned directory the same way it grants the thread
/// workspace. This is what Managed worktree mode asks.
#[cfg(any(feature = "tauri", test))]
pub fn worktree_capability() -> bool {
    jail::supports_owned_write_roots(jail::backend())
}

/// Whether `root` is a managed worktree: strictly inside Jan's worktree folder.
#[cfg(any(feature = "tauri", test))]
fn is_owned_worktree(root: &Path, data_folder: &Path) -> bool {
    let Ok(owned) = crate::workspace::worktrees_dir(data_folder).canonicalize() else {
        return false;
    };
    root.starts_with(&owned) && root != owned
}

/// A new opaque id.
///
/// Process-local and never shown to a model, so this needs to be unique rather
/// than unguessable. The clock and a counter give that without a dependency.
#[cfg(any(feature = "tauri", test))]
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
///
/// On top of the read-root validation, a folder is refused when the sandbox
/// must never be granted it (a drive root, the profile, Windows, Program
/// Files: [`crate::tools::appcontainer::grant_refusal`]) or when it lies
/// inside Flint's data folder without being one of its managed worktrees.
#[cfg(any(feature = "tauri", test))]
#[cfg_attr(not(test), allow(dead_code))]
pub fn authorize(
    session_id: &str,
    folder: &str,
    workspace: &Path,
    data_folder: &Path,
) -> Result<String, String> {
    authorize_with_extras(session_id, folder, &[], workspace, data_folder)
}

/// [`authorize`], also covering the session's additional attached folders.
///
/// Each extra folder is validated exactly like the primary, and one that fails
/// validation fails the whole grant: a run must never be told a folder is
/// writable when it is not. Extras are attached directly, never through a
/// managed worktree, so on a platform that can only confine a run to Jan's own
/// worktrees a user folder among them cannot be written. There they are left
/// out of the grant rather than refused -- the primary's worktree stays
/// writable and the extras stay readable, which is exactly what the primary
/// folder itself gets on that platform.
#[cfg(any(feature = "tauri", test))]
pub fn authorize_with_extras(
    session_id: &str,
    folder: &str,
    extras: &[String],
    workspace: &Path,
    data_folder: &Path,
) -> Result<String, String> {
    if !capability() && !worktree_capability() {
        return Err(format!(
            "this platform cannot confine a shell to a project folder ({}), \
             so editing a folder directly is not available",
            jail::backend().as_str()
        ));
    }
    if session_id.is_empty() {
        return Err("a grant needs the session it belongs to".to_string());
    }
    let root = grantable(Path::new(folder), workspace, data_folder)?;
    // Where only Jan's own worktrees can be confined, the user's folder cannot
    // be authorized at all: decided on the canonical path, after validation,
    // so no spelling of a user folder passes for a worktree.
    if !capability() && !is_owned_worktree(&root, data_folder) {
        return Err(format!(
            "this platform can only confine a run to a Jan-managed worktree ({}), \
             so editing {} directly is not available; choose Managed worktree instead",
            jail::backend().as_str(),
            root.display()
        ));
    }

    let mut extra_roots: Vec<PathBuf> = Vec::new();
    for extra in extras {
        let extra = grantable(Path::new(extra), workspace, data_folder)?;
        if !capability() && !is_owned_worktree(&extra, data_folder) {
            continue;
        }
        if extra != root && !extra_roots.contains(&extra) {
            extra_roots.push(extra);
        }
    }

    let id = new_id();
    let mut grants = registry().lock().map_err(|_| "grant registry poisoned")?;
    let replaced: Vec<PathBuf> = grants
        .values()
        .filter(|grant| grant.session_id == session_id)
        .map(|grant| grant.workspace.clone())
        .collect();
    grants.retain(|_, grant| grant.session_id != session_id);
    // The replaced grant's folders may not be in this one (a folder removed
    // from the session): their ACEs go now, not at the next command.
    withdraw_folder_aces(&replaced);
    grants.insert(
        id.clone(),
        Grant {
            session_id: session_id.to_string(),
            root,
            extra_roots,
            workspace: workspace.to_path_buf(),
        },
    );
    Ok(id)
}

/// Withdraw one grant. Idempotent: revoking what is already gone is success.
#[cfg(any(feature = "tauri", test))]
pub fn revoke(grant_id: &str) -> bool {
    let removed = registry()
        .lock()
        .ok()
        .and_then(|mut grants| grants.remove(grant_id));
    match removed {
        Some(grant) => {
            withdraw_folder_aces(&[grant.workspace]);
            true
        }
        None => false,
    }
}

/// Does a live grant issued against `workspace` cover `folder`?
///
/// What a confined MCP server started in that session workspace needs before
/// it may be given a folder to write on AppContainer: the server shares the
/// session's container, so its ACE lives exactly as long as the grant does.
#[cfg(any(feature = "tauri", test))]
pub fn workspace_holds_grant(workspace: &Path, folder: &Path) -> bool {
    let Ok(folder) = folder.canonicalize() else {
        return false;
    };
    let workspace = workspace.canonicalize().unwrap_or_else(|_| workspace.to_path_buf());
    let Ok(grants) = registry().lock() else {
        return false;
    };
    grants.values().any(|grant| {
        grant.workspace.canonicalize().unwrap_or_else(|_| grant.workspace.clone()) == workspace
            && (grant.root == folder || grant.extra_roots.contains(&folder))
    })
}

/// Validate one folder a grant would cover. See [`authorize`].
#[cfg(any(feature = "tauri", test))]
fn grantable(folder: &Path, workspace: &Path, data_folder: &Path) -> Result<PathBuf, String> {
    let root = crate::workspace::validate_read_root(folder, workspace, Some(data_folder))?;
    if let Some(why) = crate::tools::appcontainer::grant_refusal(&root) {
        return Err(format!("{why}, so Flint cannot be allowed to edit it"));
    }
    if let Ok(data) = data_folder.canonicalize() {
        if root.starts_with(&data) && !is_owned_worktree(&root, data_folder) {
            return Err(format!(
                "{} is inside Flint's data folder and cannot be edited",
                root.display()
            ));
        }
    }
    Ok(root)
}

/// Withdraw the folder ACEs the sandbox containers of these workspaces hold.
/// A no-op off Windows, where confinement is per command and holds nothing
/// between them.
#[cfg(any(feature = "tauri", test))]
fn withdraw_folder_aces(workspaces: &[PathBuf]) {
    for workspace in workspaces {
        crate::tools::appcontainer::revoke_roots(workspace);
    }
}

/// How a child destination's owner id is spelled.
///
/// A team can give a child its own isolated checkout, and that checkout needs
/// its own grant: one write root per child, not one shared between them. The
/// registry keys authority by session id, so a child is given a *derived*
/// session id rather than the parent's — which is what makes
/// [`resolve`] refuse a child's grant id when the parent presents it, and the
/// parent's when a child does.
///
/// The separator stays out of the alphabet generated session ids use, and the
/// whole id stays within what [`crate::workspace::thread_segment`] accepts, so
/// a derived id is a legal workspace name as well as a legal grant owner.
const CHILD_SEP: &str = "--child-";

/// The owner id for one isolated child of `parent`.
///
/// Deterministic, so the same child asked for twice is the same destination
/// rather than a second one beside it.
///
/// Currently exercised only by the grant-isolation tests below, which use it to
/// build the child ids they assert [`resolve`] refuses across owners. It is the
/// canonical derivation for that id, so it stays here rather than being inlined
/// into the tests; the narrow allow covers only non-test builds.
#[cfg_attr(not(test), allow(dead_code))]
pub fn child_session_id(parent: &str, child: &str) -> String {
    let safe: String = child
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .take(48)
        .collect();
    format!("{parent}{CHILD_SEP}{safe}")
}

/// Whether `id` is a child destination of `parent`.
#[cfg(any(feature = "tauri", test))]
pub fn is_child_of(id: &str, parent: &str) -> bool {
    id.starts_with(parent) && id[parent.len()..].starts_with(CHILD_SEP)
}

/// Withdraw everything a session holds — detaching, switching, deleting.
///
/// Children go with the parent. A grant issued to an isolated child outliving
/// the session that dispatched it would be authority nobody can see and nobody
/// asked to keep: the user detached the folder, and every root that was reached
/// through that decision goes away with it.
#[cfg(any(feature = "tauri", test))]
pub fn revoke_session(session_id: &str) -> usize {
    let Ok(mut grants) = registry().lock() else {
        return 0;
    };
    let before = grants.len();
    let mut released = Vec::new();
    grants.retain(|_, grant| {
        let keep = grant.session_id != session_id && !is_child_of(&grant.session_id, session_id);
        if !keep {
            released.push(grant.workspace.clone());
        }
        keep
    });
    withdraw_folder_aces(&released);
    before - grants.len()
}

/// The root this grant authorizes, if it is live and belongs to `session_id`.
///
/// The session check is not decoration. An id that leaked, or was held across a
/// session switch, must not authorize a write in a session it was never given
/// to — so the answer is `None` and the run writes to its sandbox as if it had
/// never been authorized at all.
#[cfg(any(feature = "tauri", test))]
#[cfg_attr(not(test), allow(dead_code))]
pub fn resolve(grant_id: &str, session_id: &str) -> Option<PathBuf> {
    let grants = registry().lock().ok()?;
    let grant = grants.get(grant_id)?;
    (grant.session_id == session_id).then(|| grant.root.clone())
}

/// Every root this grant authorizes -- the primary first, then the session's
/// additional attached folders -- or nothing when the grant is not live and
/// ours. Same session check as [`resolve`].
#[cfg(any(feature = "tauri", test))]
pub fn resolve_all(grant_id: &str, session_id: &str) -> Vec<PathBuf> {
    let Ok(grants) = registry().lock() else {
        return Vec::new();
    };
    match grants.get(grant_id) {
        Some(grant) if grant.session_id == session_id => std::iter::once(grant.root.clone())
            .chain(grant.extra_roots.iter().cloned())
            .collect(),
        _ => Vec::new(),
    }
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
    fn extra_folders_resolve_after_the_primary() {
        require_capability!();
        let (ws, data, repo, session) = fixture();
        let other = ws.parent().unwrap().join("second-repo");
        std::fs::create_dir_all(&other).unwrap();
        let extras = [
            other.to_string_lossy().into_owned(),
            // The primary again, and a duplicate: neither is listed twice.
            repo.to_string_lossy().into_owned(),
            other.to_string_lossy().into_owned(),
        ];
        let id = authorize_with_extras(&session, &repo.to_string_lossy(), &extras, &ws, &data)
            .unwrap();

        assert_eq!(
            resolve_all(&id, &session),
            vec![repo.canonicalize().unwrap(), other.canonicalize().unwrap()]
        );
        assert_eq!(resolve(&id, &session), Some(repo.canonicalize().unwrap()));
        assert!(resolve_all(&id, "another-session").is_empty());

        revoke(&id);
        assert!(resolve_all(&id, &session).is_empty());
        let _ = std::fs::remove_dir_all(ws.parent().unwrap());
    }

    #[test]
    fn an_invalid_extra_folder_fails_the_whole_grant() {
        let (ws, data, repo, session) = fixture();
        let gone = ws.parent().unwrap().join("not-there");
        let err = authorize_with_extras(
            &session,
            &repo.to_string_lossy(),
            &[data.to_string_lossy().into_owned(), gone.to_string_lossy().into_owned()],
            &ws,
            &data,
        );
        assert!(err.is_err());
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
    fn two_isolated_children_hold_separate_roots() {
        require_capability!();
        let (ws, data, repo, session) = fixture();
        let other = repo.parent().unwrap().join("note-py");
        std::fs::create_dir_all(&other).unwrap();

        let a = child_session_id(&session, "parser");
        let b = child_session_id(&session, "docs");
        let first = authorize(&a, &repo.to_string_lossy(), &ws, &data).unwrap();
        let second = authorize(&b, &other.to_string_lossy(), &ws, &data).unwrap();

        // Authorizing the second must not have replaced the first: children of
        // one session are separate owners, or a team of three would end with
        // one live grant and two children writing nothing they were promised.
        assert_eq!(resolve(&first, &a), Some(repo.canonicalize().unwrap()));
        assert_eq!(resolve(&second, &b), Some(other.canonicalize().unwrap()));
        // And neither child can use the other's, or the parent's session.
        assert_eq!(resolve(&first, &b), None);
        assert_eq!(resolve(&first, &session), None);

        assert_eq!(revoke_session(&session), 2, "children go with the parent");
        let _ = std::fs::remove_dir_all(ws.parent().unwrap());
    }

    #[test]
    fn a_child_id_is_recognised_only_under_its_own_parent() {
        let a = child_session_id("session-1", "parser");
        assert!(is_child_of(&a, "session-1"));
        assert!(!is_child_of(&a, "session-2"));
        // A parent whose id is a prefix of another must not collect its grants.
        assert!(!is_child_of(
            &child_session_id("session-10", "x"),
            "session-1"
        ));
        assert!(!is_child_of("session-1", "session-1"));
        // Whatever a task calls itself, the id stays a legal workspace name.
        let odd = child_session_id("session-1", "../../etc/passwd");
        assert!(crate::workspace::thread_segment(&odd).is_ok(), "{odd}");
    }

    /// Windows: AppContainer grants the user's own folder under "Edit this
    /// folder" and a managed worktree alike, extras included; a folder inside
    /// Flint's data folder that is not a worktree stays refused.
    #[cfg(windows)]
    #[test]
    fn on_windows_user_folders_and_worktrees_can_be_authorized() {
        if jail::backend() != jail::Backend::AppContainer {
            eprintln!("skipping: AppContainer is not available here");
            return;
        }
        let (ws, data, repo, session) = fixture();
        let owned = crate::workspace::worktrees_dir(&data).join("key").join("session-1");
        std::fs::create_dir_all(&owned).unwrap();

        assert!(capability(), "direct editing is available on Windows");
        assert!(worktree_capability());
        let id = authorize(&session, &owned.to_string_lossy(), &ws, &data)
            .expect("a Jan-owned worktree is authorized");
        assert_eq!(resolve(&id, &session), Some(owned.canonicalize().unwrap()));

        // Extras are attached directly beside the worktree, in the grant.
        let with_extra = authorize_with_extras(
            &session,
            &owned.to_string_lossy(),
            &[repo.to_string_lossy().into_owned()],
            &ws,
            &data,
        )
        .expect("the worktree is still authorized");
        assert_eq!(
            resolve_all(&with_extra, &session),
            vec![owned.canonicalize().unwrap(), repo.canonicalize().unwrap()]
        );

        let id = authorize(&session, &repo.to_string_lossy(), &ws, &data)
            .expect("the user's own folder is authorized");
        assert_eq!(resolve(&id, &session), Some(repo.canonicalize().unwrap()));
        // The worktree folder itself, and a spelling that climbs out of it,
        // are inside the data folder and not a worktree.
        let root = crate::workspace::worktrees_dir(&data);
        assert!(authorize(&session, &root.to_string_lossy(), &ws, &data).is_err());
        let climb = owned.join("..").join("..").join("..");
        assert!(authorize(&session, &climb.to_string_lossy(), &ws, &data).is_err());

        revoke_session(&session);
        let _ = std::fs::remove_dir_all(ws.parent().unwrap());
    }

    /// The profile, a folder holding it, and a drive root are never granted.
    #[cfg(windows)]
    #[test]
    fn the_profile_and_drive_roots_cannot_be_authorized() {
        let (ws, data, _repo, session) = fixture();
        let profile = std::env::var("USERPROFILE").expect("USERPROFILE");
        for folder in [profile.clone(), "C:\\".to_string()] {
            assert!(
                authorize(&session, &folder, &ws, &data).is_err(),
                "{folder} must be refused"
            );
        }
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

    /// A confined MCP server in a session workspace may edit a folder only
    /// while that session's grant covers it; on AppContainer it is refused
    /// otherwise, and refused again once the grant is revoked.
    #[test]
    fn an_mcp_server_edits_a_folder_only_under_a_live_grant() {
        use crate::tools::mcp_confine::{confined_command, ConfineError, McpAuthority};
        require_capability!();
        let (ws, data, repo, session) = fixture();
        let authority = McpAuthority::EditFolder {
            workspace: ws.clone(),
            repository: repo.canonicalize().unwrap(),
            read_roots: vec![],
        };
        let build = || confined_command(Path::new("node"), &[], None, &authority, None);
        let appcontainer = jail::backend() == jail::Backend::AppContainer;

        assert!(!workspace_holds_grant(&ws, &repo));
        if appcontainer {
            assert_eq!(build().err(), Some(ConfineError::NoGrant));
        }
        let id = authorize(&session, &repo.to_string_lossy(), &ws, &data).unwrap();
        assert!(workspace_holds_grant(&ws, &repo));
        assert!(!workspace_holds_grant(&data, &repo), "another workspace holds nothing");
        assert_ne!(build().err(), Some(ConfineError::NoGrant));

        revoke(&id);
        assert!(!workspace_holds_grant(&ws, &repo));
        if appcontainer {
            assert_eq!(build().err(), Some(ConfineError::NoGrant));
        }
        let _ = std::fs::remove_dir_all(ws.parent().unwrap());
    }
}
