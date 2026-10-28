//! Which project folders the user has trusted to run their own code.
//!
//! A project folder can carry things that act for it: hooks that run shell
//! commands (`.jan/agent/hooks.toml`) and subagent definitions
//! (`.jan/agent/subagents/`). A repository the user only just cloned can ship
//! both, so they stay off until the user says the folder is theirs.
//!
//! Trust is a decision about a folder, made once. There is no expiry and no
//! content hash: a folder the user trusted stays trusted until they revoke it.
//! It covers the folder, everything under it, and the linked worktrees of a
//! repository, since a worktree is the same project checked out elsewhere.
//!
//! The list is a small file under the data folder, written atomically. The app
//! points this module at it once at startup ([`set_store`]); until then, which
//! is only so in unit tests and when the library is embedded without an app,
//! nothing is trusted (unit tests of this crate excepted). The restriction is
//! enforced where the project's code would be loaded, not here.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

const FILE_VERSION: u32 = 1;

static STORE: OnceLock<PathBuf> = OnceLock::new();

/// Point the process-wide trust list at `path` (a file; its folder is created
/// on the first write). Only the first call counts.
pub fn set_store(path: PathBuf) {
    let _ = STORE.set(path);
}

/// Whether the process-wide list has been set, i.e. whether trust is enforced.
pub fn enforced() -> bool {
    STORE.get().is_some()
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Doc {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    folders: Vec<String>,
}

fn read(path: &Path) -> Doc {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Doc>(&bytes).ok())
        .unwrap_or_default()
}

/// A folder as the list compares it: absolute, forward slashes, no trailing
/// slash, lower-cased on Windows where paths ignore case.
pub fn key(folder: &Path) -> String {
    fold_case(spelled(folder))
}

/// Lower-cased on Windows, where paths ignore case; as it is elsewhere.
fn fold_case(text: String) -> String {
    if cfg!(windows) { text.to_lowercase() } else { text }
}

/// A folder as the list stores and shows it: like [`key`], in its own case.
fn spelled(folder: &Path) -> String {
    let canonical = std::fs::canonicalize(folder).unwrap_or_else(|_| folder.to_path_buf());
    let mut text = canonical.to_string_lossy().replace('\\', "/");
    if let Some(rest) = text.strip_prefix("//?/") {
        text = rest.to_string();
    }
    while text.len() > 1 && text.ends_with('/') {
        text.pop();
    }
    text
}

/// The repository a linked worktree belongs to, or `folder` itself when it is
/// not one. Read from the worktree's `.git` pointer file, with no git process.
pub fn project_root(folder: &Path) -> PathBuf {
    let pointer = folder.join(".git");
    let Ok(text) = std::fs::read_to_string(&pointer) else {
        return folder.to_path_buf();
    };
    let Some(gitdir) = text.trim().strip_prefix("gitdir:") else {
        return folder.to_path_buf();
    };
    // Relative pointers (newer git) are relative to the folder, not the cwd.
    let gitdir = {
        let named = PathBuf::from(gitdir.trim());
        if named.is_absolute() { named } else { folder.join(named) }
    };
    // `<repo>/.git/worktrees/<name>`: the repository is three levels up, and
    // the middle one must really be called `worktrees`.
    let Some(worktrees) = gitdir.parent().filter(|p| p.file_name().is_some_and(|n| n == "worktrees")) else {
        return folder.to_path_buf();
    };
    let Some(common) = worktrees.parent().filter(|c| c.file_name().is_some_and(|n| n == ".git")) else {
        return folder.to_path_buf();
    };
    // The pointer is text the folder itself carries, so it proves nothing until
    // the repository it names points back: `<gitdir>/gitdir` must hold this
    // folder's own `.git`. Without that, an archive could name any trusted
    // folder as its repository and borrow its trust.
    let back = std::fs::read_to_string(gitdir.join("gitdir")).ok();
    let points_back = back.is_some_and(|b| key(Path::new(b.trim())) == key(&pointer));
    if !points_back {
        return folder.to_path_buf();
    }
    common.parent().map(Path::to_path_buf).unwrap_or_else(|| folder.to_path_buf())
}

/// Whether `folder`, or a folder above it, or the repository it is a worktree
/// of, is in the list at `store`.
pub fn is_trusted_in(store: &Path, folder: &Path) -> bool {
    let doc = read(store);
    if doc.folders.is_empty() {
        return false;
    }
    [folder.to_path_buf(), project_root(folder)].iter().any(|candidate| {
        let k = key(candidate);
        doc.folders.iter().any(|t| {
            let t = fold_case(t.clone());
            k == t || k.strip_prefix(t.as_str()).is_some_and(|rest| rest.starts_with('/'))
        })
    })
}

/// Add `folder` to the list at `store`. Trusting it twice changes nothing.
pub fn trust_in(store: &Path, folder: &Path) -> Result<(), String> {
    let mut doc = read(store);
    let k = key(folder);
    if !doc.folders.iter().any(|t| fold_case(t.clone()) == k) {
        doc.folders.push(spelled(folder));
        doc.folders.sort_by_key(|t| fold_case(t.clone()));
    }
    doc.version = FILE_VERSION;
    write(store, &doc)
}

/// Where the one-time migration leaves its marker: beside the list, in a file
/// of its own so an older build rewriting the list cannot erase it.
fn migrated_marker(store: &Path) -> PathBuf {
    store.with_file_name("trusted-folders.migrated")
}

/// The first-run migration: trust the folders the user was already using when
/// trust arrived, once, and never again.
///
/// Those folders have already run their hooks under the build before this one,
/// so leaving them untrusted would only switch off what was working. The caller
/// supplies them from the user's own history (their sessions and chats), not
/// from anything a repository can write into itself. Only folders that exist
/// and carry hooks or subagent definitions are recorded; a folder too broad to
/// trust is skipped. The marker is written even when nothing was trusted, so
/// a folder first opened after this point always asks -- but not when no
/// folders were offered at all: an empty list means the caller's history was
/// not loaded yet, and closing the migration then would switch off the hooks
/// of every folder the user already works in. Returns the folders trusted now.
pub fn grandfather_in(store: &Path, folders: impl IntoIterator<Item = PathBuf>) -> Vec<String> {
    let marker = migrated_marker(store);
    if marker.exists() {
        return Vec::new();
    }
    let folders: Vec<PathBuf> = folders.into_iter().collect();
    if folders.is_empty() {
        return Vec::new();
    }
    let mut trusted = Vec::new();
    for folder in folders {
        if folder.is_dir() && carries(&folder).any() && broad_folder(&folder).is_none() && trust_in(store, &folder).is_ok()
        {
            trusted.push(key(&folder));
        }
    }
    trusted.sort();
    trusted.dedup();
    if let Some(dir) = marker.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = crate::atomic_file::write_atomic(&marker, b"1");
    trusted
}

/// Whether the data folder already holds the user's history from an earlier
/// run: a saved chat thread, or a Cowork session in `settings.json`. Read at
/// startup, before this run can add any.
pub fn data_folder_has_history(data_folder: &Path) -> bool {
    let threads = std::fs::read_dir(data_folder.join("threads"))
        .map(|mut entries| entries.any(|e| e.is_ok()))
        .unwrap_or(false);
    if threads {
        return true;
    }
    let Ok(bytes) = std::fs::read(data_folder.join("settings.json")) else {
        return false;
    };
    let Ok(map) = serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(&bytes) else {
        // A damaged settings file proves nothing either way; keep the migration
        // open rather than switch off folders an older build already ran.
        return true;
    };
    let Some(serde_json::Value::String(sessions)) = map.get("code-sessions") else {
        return false;
    };
    // The store keeps one key per session: the index lists them in
    // `sessionIds`. An older build wrote them inline as `sessions`.
    serde_json::from_str::<serde_json::Value>(sessions)
        .ok()
        .map(|v| {
            ["/state/sessions", "/state/sessionIds"]
                .iter()
                .any(|p| v.pointer(p).and_then(|s| s.as_array()).is_some_and(|s| !s.is_empty()))
        })
        .unwrap_or(false)
}

/// Close the one-time migration at startup when this install has no history
/// from before (a fresh install): nothing ran before trust existed, so no
/// folder is grandfathered, including folders attached from now on. An install
/// with history keeps the migration open for the renderer to run it once.
/// Returns whether the migration was closed now.
pub fn close_migration_if_fresh_in(store: &Path, data_folder: &Path) -> bool {
    let marker = migrated_marker(store);
    if marker.exists() || data_folder_has_history(data_folder) {
        return false;
    }
    if let Some(dir) = marker.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    crate::atomic_file::write_atomic(&marker, b"fresh").is_ok()
}

/// [`close_migration_if_fresh_in`] on the process-wide list.
pub fn close_migration_if_fresh(data_folder: &Path) -> bool {
    match STORE.get() {
        Some(store) => close_migration_if_fresh_in(store, data_folder),
        None => false,
    }
}

/// [`grandfather_in`] on the process-wide list.
pub fn grandfather(folders: impl IntoIterator<Item = PathBuf>) -> Vec<String> {
    match STORE.get() {
        Some(store) => grandfather_in(store, folders),
        None => Vec::new(),
    }
}

/// Why `folder` is too broad to trust, `None` when it is not. Trust covers
/// everything under a folder, so a drive root or the user's home would trust
/// every clone below it.
pub fn broad_folder(folder: &Path) -> Option<&'static str> {
    let canonical = std::fs::canonicalize(folder).unwrap_or_else(|_| folder.to_path_buf());
    if canonical.parent().is_none() || canonical.components().count() <= 2 {
        return Some("a drive or filesystem root");
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from);
    if home.is_some_and(|h| key(&h) == key(&canonical)) {
        return Some("your home folder");
    }
    None
}

/// Remove `folder` from the list at `store`. Returns whether it was there.
pub fn revoke_in(store: &Path, folder: &Path) -> Result<bool, String> {
    let mut doc = read(store);
    let k = key(folder);
    let before = doc.folders.len();
    doc.folders.retain(|t| fold_case(t.clone()) != k);
    let removed = doc.folders.len() != before;
    if removed {
        doc.version = FILE_VERSION;
        write(store, &doc)?;
    }
    Ok(removed)
}

/// The folders in the list at `store`.
pub fn list_in(store: &Path) -> Vec<String> {
    read(store).folders
}

fn write(store: &Path, doc: &Doc) -> Result<(), String> {
    if let Some(dir) = store.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    }
    let bytes = serde_json::to_vec_pretty(doc).map_err(|e| e.to_string())?;
    crate::atomic_file::write_atomic(store, &bytes)
}

/// Whether this project may run the code it carries. When the list was never
/// set up in this process nothing is trusted (fail closed); only this crate's
/// own unit tests (and the app's, through `test-default-trusted`) default to
/// trusted.
pub fn is_trusted(folder: &Path) -> bool {
    match STORE.get() {
        Some(store) => is_trusted_in(store, folder),
        None => cfg!(any(test, feature = "test-default-trusted")),
    }
}

/// Trust `folder` in the process-wide list. Refuses a folder so broad that
/// trusting it would trust everything below it.
pub fn trust(folder: &Path) -> Result<(), String> {
    if let Some(why) = broad_folder(folder) {
        return Err(format!("{} is {why}: trust a project folder inside it instead", folder.display()));
    }
    match STORE.get() {
        Some(store) => trust_in(store, folder),
        None => Err("the trust list is not set up in this process".to_string()),
    }
}

/// Stop trusting `folder` in the process-wide list.
pub fn revoke(folder: &Path) -> Result<bool, String> {
    match STORE.get() {
        Some(store) => revoke_in(store, folder),
        None => Err("the trust list is not set up in this process".to_string()),
    }
}

/// The folders in the process-wide list.
pub fn list() -> Vec<String> {
    STORE.get().map(|s| list_in(s)).unwrap_or_default()
}

/// What a project carries that only a trusted folder may run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Carries {
    pub hooks: bool,
    pub subagents: bool,
}

impl Carries {
    pub fn any(self) -> bool {
        self.hooks || self.subagents
    }
}

/// Whether `folder` has hooks or project subagent definitions to run.
pub fn carries(folder: &Path) -> Carries {
    let agent = folder.join(".jan").join("agent");
    let non_empty = |dir: PathBuf| {
        std::fs::read_dir(dir)
            .map(|mut entries| entries.any(|e| e.is_ok()))
            .unwrap_or(false)
    };
    // The project's own definitions, and those of the plugins it carries.
    let plugin_agents = std::fs::read_dir(agent.join("plugins"))
        .map(|entries| {
            entries
                .flatten()
                .any(|plugin| non_empty(plugin.path().join("agents")))
        })
        .unwrap_or(false);
    let subagents = non_empty(agent.join("subagents")) || plugin_agents;
    Carries { hooks: agent.join("hooks.toml").is_file(), subagents }
}

/// Whether this is the first time `run` is told that `folder`'s hooks are off.
/// Used to say so once per run, not on every tool call.
pub fn first_notice(run: &str, folder: &Path) -> bool {
    use std::collections::HashSet;
    use std::sync::Mutex;
    static TOLD: Mutex<Option<HashSet<String>>> = Mutex::new(None);
    let mut told = TOLD.lock().unwrap_or_else(|e| e.into_inner());
    told.get_or_insert_with(HashSet::new)
        .insert(format!("{run}\u{1f}{}", key(folder)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn nothing_is_trusted_until_the_user_says_so() {
        let dir = temp();
        let store = dir.path().join("trust.json");
        let project = dir.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        assert!(!is_trusted_in(&store, &project));
        trust_in(&store, &project).unwrap();
        assert!(is_trusted_in(&store, &project));
    }

    #[test]
    fn trust_is_kept_for_good_and_covers_what_is_under_the_folder() {
        let dir = temp();
        let store = dir.path().join("trust.json");
        let project = dir.path().join("proj");
        let nested = project.join("packages").join("app");
        let sibling = dir.path().join("proj-other");
        for d in [&nested, &sibling] {
            std::fs::create_dir_all(d).unwrap();
        }
        trust_in(&store, &project).unwrap();
        trust_in(&store, &project).unwrap();
        assert_eq!(list_in(&store).len(), 1, "trusting twice is one entry");
        assert!(is_trusted_in(&store, &nested));
        // A name that merely starts the same is a different folder.
        assert!(!is_trusted_in(&store, &sibling));
        // A fresh read, as after a restart.
        assert!(is_trusted_in(&store, &project));
    }

    #[test]
    fn a_linked_worktree_is_trusted_with_its_repository() {
        let dir = temp();
        let store = dir.path().join("trust.json");
        let repo = dir.path().join("repo");
        let worktree = dir.path().join("elsewhere").join("wt");
        std::fs::create_dir_all(repo.join(".git").join("worktrees").join("wt")).unwrap();
        std::fs::create_dir_all(&worktree).unwrap();
        let gitdir = repo.join(".git").join("worktrees").join("wt");
        std::fs::write(worktree.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
        std::fs::write(gitdir.join("gitdir"), worktree.join(".git").display().to_string()).unwrap();
        assert!(!is_trusted_in(&store, &worktree));
        trust_in(&store, &repo).unwrap();
        assert!(is_trusted_in(&store, &worktree));
        assert_eq!(key(&project_root(&worktree)), key(&repo));
    }

    #[test]
    fn a_forged_git_pointer_does_not_borrow_a_trusted_repository() {
        let dir = temp();
        let store = dir.path().join("trust.json");
        let repo = dir.path().join("repo");
        let archive = dir.path().join("downloaded");
        let gitdir = repo.join(".git").join("worktrees").join("wt");
        std::fs::create_dir_all(&gitdir).unwrap();
        std::fs::create_dir_all(&archive).unwrap();
        trust_in(&store, &repo).unwrap();
        // Names the trusted repository, but the repository never heard of it:
        // `<gitdir>/gitdir` is missing.
        std::fs::write(archive.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
        assert!(!is_trusted_in(&store, &archive));
        // Or its record points somewhere else.
        std::fs::write(gitdir.join("gitdir"), dir.path().join("elsewhere").join(".git").display().to_string()).unwrap();
        assert!(!is_trusted_in(&store, &archive));
        // Only when the repository's record names this very folder.
        std::fs::write(gitdir.join("gitdir"), archive.join(".git").display().to_string()).unwrap();
        assert!(is_trusted_in(&store, &archive));
        // A pointer to a path that does not exist is nothing.
        std::fs::write(archive.join(".git"), "gitdir: C:/does/not/exist/.git/worktrees/x\n").unwrap();
        assert!(!is_trusted_in(&store, &archive));
    }

    #[test]
    fn the_first_notice_for_a_run_and_folder_is_given_once() {
        let dir = temp();
        assert!(first_notice("run-notice-1", dir.path()));
        assert!(!first_notice("run-notice-1", dir.path()));
        assert!(first_notice("run-notice-2", dir.path()));
    }

    fn with_hooks(dir: &Path, name: &str) -> PathBuf {
        let folder = dir.join(name);
        let agent = folder.join(".jan").join("agent");
        std::fs::create_dir_all(&agent).unwrap();
        std::fs::write(agent.join("hooks.toml"), "").unwrap();
        folder
    }

    #[test]
    fn the_first_run_trusts_folders_already_in_use_and_never_again() {
        let dir = temp();
        let store = dir.path().join("trust.json");
        let (a, b) = (with_hooks(dir.path(), "a"), with_hooks(dir.path(), "b"));
        let plain = dir.path().join("plain");
        let gone = dir.path().join("gone");
        std::fs::create_dir_all(&plain).unwrap();
        let done = grandfather_in(&store, vec![a.clone(), b.clone(), a.clone(), plain.clone(), gone]);
        assert_eq!(done.len(), 2, "only existing folders that carry something, once each: {done:?}");
        assert!(is_trusted_in(&store, &a));
        assert!(!is_trusted_in(&store, &plain), "nothing to run there, nothing to trust");
        // Whatever is offered later is not trusted: the marker is down.
        let later = with_hooks(dir.path(), "later");
        assert!(grandfather_in(&store, vec![later.clone()]).is_empty());
        assert!(!is_trusted_in(&store, &later));
        // And revoking everything does not bring the migration back.
        revoke_in(&store, &a).unwrap();
        revoke_in(&store, &b).unwrap();
        assert!(grandfather_in(&store, vec![a.clone()]).is_empty());
        assert!(!is_trusted_in(&store, &a));
    }

    #[test]
    fn a_first_run_with_nothing_to_trust_still_closes_the_migration() {
        let dir = temp();
        let store = dir.path().join("trust.json");
        let plain = dir.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert!(grandfather_in(&store, vec![plain]).is_empty());
        let later = with_hooks(dir.path(), "later");
        assert!(grandfather_in(&store, vec![later.clone()]).is_empty());
        assert!(!is_trusted_in(&store, &later));
    }

    #[test]
    fn an_empty_folder_list_does_not_burn_the_migration() {
        // The renderer's history was not loaded yet: nothing was offered.
        let dir = temp();
        let store = dir.path().join("trust.json");
        assert!(grandfather_in(&store, Vec::new()).is_empty());
        let a = with_hooks(dir.path(), "a");
        let done = grandfather_in(&store, vec![a.clone()]);
        assert_eq!(done.len(), 1, "the second call still migrates: {done:?}");
        assert!(is_trusted_in(&store, &a));
    }

    #[test]
    fn a_fresh_install_never_grandfathers_a_folder_attached_later() {
        // BUG-038: fresh data folder, first boot, no history.
        let dir = temp();
        let data = dir.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        let store = data.join("trusted-folders.json");
        assert!(close_migration_if_fresh_in(&store, &data));
        // The user attaches a repo carrying hooks but does not trust it; a
        // session now exists in the history.
        let repo = with_hooks(dir.path(), "repo");
        std::fs::create_dir_all(data.join("threads").join("t1")).unwrap();
        // Restart: the startup step and the renderer's migration run again.
        assert!(!close_migration_if_fresh_in(&store, &data));
        assert!(grandfather_in(&store, vec![repo.clone()]).is_empty());
        assert!(!is_trusted_in(&store, &repo));
    }

    #[test]
    fn a_legacy_install_still_migrates_once() {
        let dir = temp();
        let data = dir.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        let sessions = r#"{"state":{"sessions":[{"id":"s","folder":"x"}]},"version":0}"#;
        let settings = serde_json::json!({ "code-sessions": sessions });
        std::fs::write(data.join("settings.json"), settings.to_string()).unwrap();
        let store = data.join("trusted-folders.json");
        assert!(!close_migration_if_fresh_in(&store, &data), "history: the migration stays open");
        let repo = with_hooks(dir.path(), "repo");
        assert_eq!(grandfather_in(&store, vec![repo.clone()]).len(), 1);
        assert!(is_trusted_in(&store, &repo));
        let later = with_hooks(dir.path(), "later");
        assert!(grandfather_in(&store, vec![later.clone()]).is_empty());
        assert!(!is_trusted_in(&store, &later));
    }

    #[test]
    fn a_sharded_session_index_counts_as_history() {
        let dir = temp();
        let index = r#"{"state":{"sessionIds":["s1"],"currentId":"s1"},"version":5}"#;
        let settings = serde_json::json!({ "code-sessions": index });
        std::fs::write(dir.path().join("settings.json"), settings.to_string()).unwrap();
        assert!(data_folder_has_history(dir.path()));
        let empty = serde_json::json!({ "code-sessions": r#"{"state":{"sessionIds":[]},"version":5}"# });
        std::fs::write(dir.path().join("settings.json"), empty.to_string()).unwrap();
        assert!(!data_folder_has_history(dir.path()));
    }

    #[test]
    fn empty_sessions_or_no_settings_is_not_history() {
        let dir = temp();
        assert!(!data_folder_has_history(dir.path()));
        let settings = serde_json::json!({ "code-sessions": r#"{"state":{"sessions":[]}}"# });
        std::fs::write(dir.path().join("settings.json"), settings.to_string()).unwrap();
        assert!(!data_folder_has_history(dir.path()));
    }

    #[test]
    fn a_drive_root_or_home_is_too_broad_to_trust() {
        let root = if cfg!(windows) { Path::new("C:\\") } else { Path::new("/") };
        assert!(broad_folder(root).is_some());
        let dir = temp();
        assert!(broad_folder(&dir.path().join("proj")).is_none());
    }

    #[test]
    fn the_list_keeps_the_folder_in_its_own_case() {
        let dir = temp();
        let store = dir.path().join("trust.json");
        let project = dir.path().join("MyProject");
        std::fs::create_dir_all(&project).unwrap();
        trust_in(&store, &project).unwrap();
        let listed = list_in(&store);
        assert_eq!(listed.len(), 1);
        assert!(listed[0].ends_with("/MyProject"), "{listed:?}");
        assert!(is_trusted_in(&store, &project));
        // An entry an older build stored lower-cased still counts, and is
        // not added twice.
        if cfg!(windows) {
            std::fs::write(&store, format!(r#"{{"version":1,"folders":["{}"]}}"#, key(&project))).unwrap();
            assert!(is_trusted_in(&store, &project));
            trust_in(&store, &project).unwrap();
            assert_eq!(list_in(&store).len(), 1);
            assert!(revoke_in(&store, &project).unwrap());
        }
    }

    #[test]
    fn revoking_removes_only_that_folder() {
        let dir = temp();
        let store = dir.path().join("trust.json");
        let (a, b) = (dir.path().join("a"), dir.path().join("b"));
        for d in [&a, &b] {
            std::fs::create_dir_all(d).unwrap();
            trust_in(&store, d).unwrap();
        }
        assert!(revoke_in(&store, &a).unwrap());
        assert!(!revoke_in(&store, &a).unwrap());
        assert!(!is_trusted_in(&store, &a));
        assert!(is_trusted_in(&store, &b));
    }

    #[test]
    fn a_damaged_list_trusts_nothing() {
        let dir = temp();
        let store = dir.path().join("trust.json");
        let project = dir.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(&store, b"{ not json").unwrap();
        assert!(!is_trusted_in(&store, &project));
    }

    #[test]
    fn carries_reports_hooks_and_subagent_definitions() {
        let dir = temp();
        let project = dir.path().join("proj");
        let agent = project.join(".jan").join("agent");
        std::fs::create_dir_all(&agent).unwrap();
        assert!(!carries(&project).any());
        std::fs::write(agent.join("hooks.toml"), "").unwrap();
        assert_eq!(carries(&project), Carries { hooks: true, subagents: false });
        std::fs::create_dir_all(agent.join("subagents")).unwrap();
        assert!(!carries(&project).subagents, "an empty folder carries nothing");
        std::fs::write(agent.join("subagents").join("a.md"), "x").unwrap();
        assert!(carries(&project).subagents);
        // Agents shipped by a plugin the project carries count too.
        let other = dir.path().join("proj2");
        let plugin_agents = other.join(".jan").join("agent").join("plugins").join("p").join("agents");
        std::fs::create_dir_all(&plugin_agents).unwrap();
        assert!(!carries(&other).subagents);
        std::fs::write(plugin_agents.join("a.md"), "x").unwrap();
        assert!(carries(&other).subagents);
    }
}
