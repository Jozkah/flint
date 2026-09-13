//! A project identity that survives being moved.
//!
//! The recall index keys projects by the project root's path text. That is
//! stable right up until the folder is renamed, moved, or reached by a
//! different spelling -- and on Windows a different spelling is the normal
//! case, because `C:\Src\Jan` and `c:\src\jan` are the same directory. When the
//! key changes the memories do not follow, so a project silently loses
//! everything it remembered; worse, two projects whose paths differ only in
//! case would be treated as one.
//!
//! So the identity is written down once, inside the project, and read back
//! afterwards. Moving the folder moves the file with it. Renaming it changes
//! nothing. Two projects are the same project when they carry the same id, and
//! a similarly named neighbour is a different project because it has its own.

use std::path::{Path, PathBuf};

use crate::workspace::project_store;

/// `<project>/.jan/agent/project-id`.
pub fn identity_path(project_root: &Path) -> PathBuf {
    project_store(project_root).join("project-id")
}

/// Read this project's stable id, creating one the first time.
///
/// Returns `None` only when no id could be established at all, which callers
/// must treat as "this project has no memories" rather than "use every
/// project's memories". Failing closed keeps an unidentifiable project from
/// matching records belonging to an identified one.
pub fn project_id(project_root: &Path) -> Option<String> {
    let path = identity_path(project_root);

    if let Some(existing) = read_written_id(project_root) {
        return Some(existing);
    }

    let id = derived_project_id(project_root);

    // Best effort. A read-only checkout still gets a usable id for this run;
    // it simply has to be derived again next time.
    if let Some(dir) = path.parent() {
        if std::fs::create_dir_all(dir).is_ok() {
            let _ = write_atomically(&path, &id);
        }
    }
    Some(id)
}

/// The same identity [`project_id`] resolves, without ever writing anything.
///
/// For callers that must not touch the user's folder -- cross-session
/// messaging groups sessions by project, and registering a session is not a
/// reason to create `.jan/agent/project-id` inside someone's checkout. An
/// existing id file still wins, so a project memory already identified keeps
/// the same identity here.
pub fn project_id_read_only(project_root: &Path) -> String {
    read_written_id(project_root).unwrap_or_else(|| derived_project_id(project_root))
}

/// The id written into the project, when there is a non-empty one.
fn read_written_id(project_root: &Path) -> Option<String> {
    let existing = std::fs::read_to_string(identity_path(project_root)).ok()?;
    let existing = existing.trim();
    (!existing.is_empty()).then(|| existing.to_string())
}

/// Derived from the canonical path rather than random, so a project whose id
/// file is lost gets the same id back instead of orphaning its memories.
/// Lower-cased first: on Windows the same directory is reachable by several
/// spellings, and two of them must not become two projects.
fn derived_project_id(project_root: &Path) -> String {
    let canonical = project_root
        .canonicalize()
        .unwrap_or_else(|_| project_root.to_path_buf());
    derive_id(&canonical)
}

/// A stable digest of the canonical path. FNV-1a: it needs to be identical
/// across processes and cheap, not cryptographic -- nothing is authenticated by
/// a project id.
fn derive_id(canonical: &Path) -> String {
    let text = canonical.to_string_lossy().to_lowercase();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    format!("proj-{hash:016x}")
}

/// Write through a temp file so a crash cannot leave a half-written id, which
/// would read back as a different project.
fn write_atomically(path: &Path, contents: &str) -> std::io::Result<()> {
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&temp, contents)?;
    match std::fs::rename(&temp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&temp);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn unique_project(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root =
            std::env::temp_dir().join(format!("jan_projid_{tag}_{}_{}", std::process::id(), n));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn the_same_project_keeps_the_same_id() {
        let root = unique_project("stable");
        let first = project_id(&root).unwrap();
        let second = project_id(&root).unwrap();
        assert_eq!(first, second);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_id_is_written_down_so_it_survives_a_move() {
        let root = unique_project("moved");
        let original = project_id(&root).unwrap();
        assert!(identity_path(&root).exists(), "id was not persisted");

        // Move the whole project, id file included.
        let moved = root.with_file_name(format!(
            "{}-moved",
            root.file_name().unwrap().to_string_lossy()
        ));
        std::fs::rename(&root, &moved).unwrap();

        assert_eq!(
            project_id(&moved).unwrap(),
            original,
            "a moved project lost its memories"
        );
        let _ = std::fs::remove_dir_all(&moved);
    }

    #[test]
    fn two_projects_are_never_the_same_project() {
        let a = unique_project("a");
        let b = unique_project("b");
        assert_ne!(project_id(&a).unwrap(), project_id(&b).unwrap());
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    /// A neighbour with a similar name is a different project. This is the
    /// case that a path-prefix comparison gets wrong.
    #[test]
    fn a_similarly_named_project_is_a_different_project() {
        let root = unique_project("proj");
        let sibling = root.with_file_name(format!(
            "{}-old",
            root.file_name().unwrap().to_string_lossy()
        ));
        std::fs::create_dir_all(&sibling).unwrap();

        assert_ne!(project_id(&root).unwrap(), project_id(&sibling).unwrap());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&sibling);
    }

    /// Windows reaches one directory by several spellings; they must not become
    /// several projects.
    #[test]
    fn path_casing_does_not_create_a_second_project() {
        let root = unique_project("Casing");
        let derived_upper = derive_id(Path::new(r"C:\Src\Jan"));
        let derived_lower = derive_id(Path::new(r"c:\src\jan"));
        assert_eq!(derived_upper, derived_lower);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Losing the id file must not orphan the project's memories: the derived
    /// id is the same one it had.
    #[test]
    fn a_lost_id_file_is_derived_back_to_the_same_id() {
        let root = unique_project("lost");
        let original = project_id(&root).unwrap();
        std::fs::remove_file(identity_path(&root)).unwrap();
        assert_eq!(project_id(&root).unwrap(), original);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// An id file someone edited by hand is taken at its word: it is the
    /// project's identity, and rewriting it would be the thing that orphans
    /// memories.
    #[test]
    fn a_written_id_wins_over_the_derived_one() {
        let root = unique_project("written");
        let path = identity_path(&root);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "proj-chosen-by-hand\n").unwrap();
        assert_eq!(project_id(&root).unwrap(), "proj-chosen-by-hand");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The read-only form agrees with the writing one and leaves the folder
    /// untouched.
    #[test]
    fn the_read_only_id_matches_and_writes_nothing() {
        let root = unique_project("readonly");
        let read_only = project_id_read_only(&root);
        assert!(!identity_path(&root).exists(), "read-only lookup wrote an id");
        assert_eq!(project_id(&root).unwrap(), read_only);

        let chosen = unique_project("readonly-chosen");
        let path = identity_path(&chosen);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "proj-by-hand\n").unwrap();
        assert_eq!(project_id_read_only(&chosen), "proj-by-hand");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&chosen);
    }

    #[test]
    fn an_empty_id_file_is_replaced_rather_than_trusted() {
        let root = unique_project("empty");
        let path = identity_path(&root);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "   \n").unwrap();
        let id = project_id(&root).unwrap();
        assert!(id.starts_with("proj-"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
