//! Turning a run's worktree into a proposal. AH-146/147/148/109.
//!
//! A run in isolated mode edits a Jan-owned worktree, never the user's
//! checkout. What it changed there only reaches the user's files through a
//! proposal: the changes are read here, stored as an immutable record by
//! `tauri_plugin_agent_tools::proposal`, shown, and applied only as approved.
//!
//! The destination is always the worktree's recorded source, taken from the
//! stored proposal at apply time -- never a path the renderer supplies with the
//! approval.

use std::path::Path;
use std::process::Command;

use tauri_plugin_agent_tools::proposal::FileInput;

use crate::core::agent::worktree::WorktreeRecord;

/// Jan's own state and Git's are never part of a proposal, at any depth: a
/// nested `.git` is another repository's hooks and config. Short names such as
/// `GIT~1` count, since Windows opens `.git` by them.
fn is_jan_state(path: &str) -> bool {
    path.split('/')
        .any(tauri_plugin_agent_tools::proposal::is_reserved_name)
}

/// Why a worktree's changes could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChangesError {
    /// A changed path passes through a symlink, junction or other reparse
    /// point, so what it names is not inside the worktree.
    LinkEscape(String),
    Other(String),
}

impl std::fmt::Display for ChangesError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ChangesError::LinkEscape(p) => write!(
                f,
                "{p} in the worktree is a link, or sits under one, so it could name a file outside the worktree; nothing was proposed"
            ),
            ChangesError::Other(e) => f.write_str(e),
        }
    }
}

impl From<String> for ChangesError {
    fn from(e: String) -> Self {
        ChangesError::Other(e)
    }
}

fn git_bytes(repo: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(crate::core::agent::vcs::HARDENED)
        .args(["-c", "diff.external="])
        .env("GIT_TERMINAL_PROMPT", "0")
        // Paths are read as bytes and split on NUL; never quoted or escaped.
        .args(["-c", "core.quotepath=off"])
        .args(args)
        .output()
        .map_err(|e| format!("failed to launch git: {e}"))?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("git {} failed", args.first().copied().unwrap_or(""))
        } else {
            stderr
        })
    }
}

fn nul_paths(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .map(|p| String::from_utf8_lossy(p).replace('\\', "/"))
        .collect()
}

/// Whether `path` exists in `commit`. Distinguishes "added" from "git failed".
fn exists_at(repo: &Path, commit: &str, path: &str) -> Result<bool, String> {
    let listed = git_bytes(repo, &["ls-tree", "-z", "--name-only", commit, "--", path])?;
    Ok(!nul_paths(&listed).is_empty())
}

/// Everything the worktree changed relative to the commit it was created from:
/// commits made on its branch, uncommitted edits and untracked files alike.
/// The base of each file is read from that commit, the proposal from disk.
///
/// Every changed path is read without following links. A symlink or junction
/// the worktree gained -- made by a shell the run started, or by anything else
/// with access to the directory -- would otherwise have the proposal carry the
/// content of whatever it points at, from anywhere on the machine, into the
/// user's checkout. Such a path refuses the whole proposal and is named.
pub fn changes_in_worktree(record: &WorktreeRecord) -> Result<Vec<FileInput>, ChangesError> {
    let wt = Path::new(&record.path);
    let base = record.base_sha.as_str();
    if base.is_empty() || !base.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ChangesError::Other(
            "the worktree has no base commit to compare against".into(),
        ));
    }
    let wt_canonical = wt
        .canonicalize()
        .map_err(|e| ChangesError::Other(format!("could not resolve the worktree: {e}")))?;

    let mut paths = nul_paths(&git_bytes(
        wt,
        &["diff", "--name-only", "-z", "--no-renames", base, "--"],
    )?);
    paths.extend(nul_paths(&git_bytes(
        wt,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )?));
    paths.sort();
    paths.dedup();

    let mut inputs = Vec::with_capacity(paths.len());
    for path in paths.into_iter().filter(|p| !is_jan_state(p)) {
        if tauri_plugin_agent_tools::proposal::passes_through_link(wt, &path) {
            return Err(ChangesError::LinkEscape(path));
        }
        let base_bytes = if exists_at(wt, base, &path)? {
            Some(git_bytes(wt, &["cat-file", "blob", &format!("{base}:{path}")])?)
        } else {
            None
        };
        let on_disk = wt.join(&path);
        // Belt and braces for what the walk cannot see, such as a parent
        // directory swapped between the walk and this read.
        if let Ok(resolved) = on_disk.canonicalize() {
            if !resolved.starts_with(&wt_canonical) {
                return Err(ChangesError::LinkEscape(path));
            }
        }
        let proposed = match std::fs::read(&on_disk) {
            Ok(b) => Some(b),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                return Err(ChangesError::Other(format!(
                    "could not read {path} in the worktree: {e}"
                )))
            }
        };
        inputs.push(FileInput {
            path,
            base: base_bytes,
            proposed,
        });
    }
    Ok(inputs)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::core::agent::worktree;

    fn git(repo: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.invalid")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.invalid")
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
    }

    fn repo(name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "jan-proposals-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let src = root.join("src");
        std::fs::create_dir_all(&src).unwrap();
        git(&src, &["init", "-q", "-b", "main"]);
        std::fs::write(src.join("keep.txt"), "one\ntwo\n").unwrap();
        std::fs::write(src.join("gone.txt"), "bye\n").unwrap();
        git(&src, &["add", "."]);
        git(&src, &["commit", "-q", "-m", "base"]);
        (src, root.join("worktrees"))
    }

    /// Edits, deletions, new files and commits on the worktree's branch are all
    /// in the proposal; Jan's own state is not; and the user's checkout is not
    /// touched by reading any of it.
    #[test]
    fn a_worktree_becomes_the_files_it_changed() {
        let (src, roots) = repo("changes");
        let record = worktree::ensure(&src, &roots, "sess-1").unwrap();
        let wt = Path::new(&record.path);
        std::fs::write(wt.join("keep.txt"), "one\nTWO\n").unwrap();
        std::fs::remove_file(wt.join("gone.txt")).unwrap();
        std::fs::write(wt.join("new.txt"), "hello\n").unwrap();
        std::fs::create_dir_all(wt.join(".jan")).unwrap();
        std::fs::write(wt.join(".jan").join("state"), "x").unwrap();
        std::fs::write(wt.join("committed.txt"), "c\n").unwrap();
        git(wt, &["add", "committed.txt"]);
        git(wt, &["commit", "-q", "-m", "on the branch"]);

        let inputs = changes_in_worktree(&record).unwrap();
        let by: std::collections::BTreeMap<_, _> =
            inputs.iter().map(|i| (i.path.as_str(), i)).collect();
        assert_eq!(
            by.keys().copied().collect::<Vec<_>>(),
            vec!["committed.txt", "gone.txt", "keep.txt", "new.txt"]
        );
        assert_eq!(by["keep.txt"].base.as_deref(), Some(&b"one\ntwo\n"[..]));
        assert_eq!(by["keep.txt"].proposed.as_deref(), Some(&b"one\nTWO\n"[..]));
        assert!(by["gone.txt"].proposed.is_none());
        assert!(by["new.txt"].base.is_none());
        assert!(by["committed.txt"].base.is_none());
        assert_eq!(
            std::fs::read_to_string(src.join("keep.txt")).unwrap(),
            "one\ntwo\n"
        );
    }

    #[test]
    fn an_untouched_worktree_proposes_nothing() {
        let (src, roots) = repo("empty");
        let record = worktree::ensure(&src, &roots, "sess-2").unwrap();
        assert!(changes_in_worktree(&record).unwrap().is_empty());
    }

    /// Make `link` point at the directory `target`: a junction on Windows,
    /// which needs no privilege, and a symlink elsewhere.
    pub(crate) fn link_dir(link: &Path, target: &Path) {
        #[cfg(windows)]
        {
            let ok = Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            assert!(ok, "could not make a junction at {}", link.display());
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    /// A link the worktree gained, pointing outside it, never carries what it
    /// points at into a proposal -- whether it links a directory or a file.
    #[test]
    fn a_link_out_of_the_worktree_refuses_the_proposal() {
        let (src, roots) = repo("escape");
        let record = worktree::ensure(&src, &roots, "sess-esc").unwrap();
        let wt = Path::new(&record.path);
        let outside = src.parent().unwrap().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "not yours\n").unwrap();
        std::fs::write(wt.join("fine.txt"), "fine\n").unwrap();
        link_dir(&wt.join("escape"), &outside);

        match changes_in_worktree(&record) {
            Err(ChangesError::LinkEscape(path)) => assert!(path.starts_with("escape"), "{path}"),
            // Git may decline to list a link's target at all, in which case
            // nothing outside was offered either -- but then the listing must
            // not contain the secret.
            Ok(inputs) => {
                for input in &inputs {
                    assert!(
                        input.proposed.as_deref() != Some(&b"not yours\n"[..]),
                        "the proposal carried a file from outside the worktree"
                    );
                }
                panic!("the link at escape/ was not refused: {:?}", inputs.iter().map(|i| &i.path).collect::<Vec<_>>());
            }
            Err(other) => panic!("unexpected error: {other}"),
        }
    }

    /// A link that points somewhere inside the worktree is refused too. The
    /// walk refuses any link rather than judging where it points: a target
    /// inside today can be swapped for one outside between the check and
    /// the read.
    #[test]
    fn a_link_that_stays_inside_the_worktree_is_still_refused() {
        let (src, roots) = repo("inner-link");
        let record = worktree::ensure(&src, &roots, "sess-inner").unwrap();
        let wt = Path::new(&record.path);
        std::fs::create_dir_all(wt.join("real")).unwrap();
        std::fs::write(wt.join("real").join("x.txt"), "x\n").unwrap();
        link_dir(&wt.join("alias"), &wt.join("real"));
        match changes_in_worktree(&record) {
            Err(ChangesError::LinkEscape(path)) => assert!(path.starts_with("alias"), "{path}"),
            other => panic!("an inner link was not refused: {:?}", other.map(|i| i.len())),
        }
    }

    #[test]
    fn a_nested_git_directory_is_never_proposed() {
        assert!(is_jan_state("vendor/lib/.git/config"));
        assert!(is_jan_state(".GIT./hooks/pre-commit"));
        // Windows' short name for `.git`, and the number after it varies.
        assert!(is_jan_state("GIT~1/hooks/pre-commit"));
        assert!(is_jan_state("vendor/git~2/config"));
        assert!(!is_jan_state("src/.gitignore"));
        assert!(!is_jan_state("docs/git~notes.md"));
    }
}
