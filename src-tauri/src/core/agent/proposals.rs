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

/// Jan's own state is never part of a proposal.
fn is_jan_state(path: &str) -> bool {
    let first = path.split('/').next().unwrap_or("");
    first.eq_ignore_ascii_case(".jan") || first.eq_ignore_ascii_case(".git")
}

fn git_bytes(repo: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
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
pub fn changes_in_worktree(record: &WorktreeRecord) -> Result<Vec<FileInput>, String> {
    let wt = Path::new(&record.path);
    let base = record.base_sha.as_str();
    if base.is_empty() || !base.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("the worktree has no base commit to compare against".into());
    }

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
        let base_bytes = if exists_at(wt, base, &path)? {
            Some(git_bytes(wt, &["cat-file", "blob", &format!("{base}:{path}")])?)
        } else {
            None
        };
        let proposed = match std::fs::read(wt.join(&path)) {
            Ok(b) => Some(b),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(format!("could not read {path} in the worktree: {e}")),
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
mod tests {
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
}
