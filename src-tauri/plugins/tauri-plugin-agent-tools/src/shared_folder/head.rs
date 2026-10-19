//! A folder's git HEAD, read from `.git` without starting a process: cheap
//! enough to run at every tool boundary.

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHead {
    /// The checked-out branch; `None` for a detached HEAD.
    pub branch: Option<String>,
    /// The commit HEAD points at, when it could be resolved.
    pub sha: Option<String>,
}

impl GitHead {
    /// `feat/x`, or `abc1234` for a detached HEAD.
    pub fn label(&self) -> String {
        match (&self.branch, &self.sha) {
            (Some(b), _) => b.clone(),
            (None, Some(s)) => s.chars().take(7).collect(),
            _ => "unknown".to_string(),
        }
    }
}

/// The directory holding `.git` (a folder or a worktree's pointer file) at or
/// above `folder`.
pub fn repo_root(folder: &Path) -> Option<PathBuf> {
    let mut cursor = Some(folder);
    while let Some(dir) = cursor {
        if dir.join(".git").exists() {
            return Some(dir.to_path_buf());
        }
        cursor = dir.parent();
    }
    None
}

pub fn is_git_repo(folder: &Path) -> bool {
    repo_root(folder).is_some()
}

/// `(gitdir, commondir)` of the repo at `root`. A linked worktree's `.git` is
/// a file naming its own gitdir, whose `commondir` file points at the shared
/// one that holds the refs.
fn git_dirs(root: &Path) -> Option<(PathBuf, PathBuf)> {
    let dot = root.join(".git");
    if dot.is_dir() {
        return Some((dot.clone(), dot));
    }
    let text = std::fs::read_to_string(&dot).ok()?;
    let target = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
    let gitdir = {
        let p = PathBuf::from(target);
        if p.is_absolute() { p } else { root.join(p) }
    };
    let common = match std::fs::read_to_string(gitdir.join("commondir")) {
        Ok(rel) => {
            let p = PathBuf::from(rel.trim());
            if p.is_absolute() { p } else { gitdir.join(p) }
        }
        Err(_) => gitdir.clone(),
    };
    Some((gitdir, common))
}

fn resolve_ref(common: &Path, name: &str) -> Option<String> {
    if let Ok(text) = std::fs::read_to_string(common.join(name)) {
        let sha = text.trim();
        if sha.len() >= 7 && sha.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(sha.to_string());
        }
    }
    let packed = std::fs::read_to_string(common.join("packed-refs")).ok()?;
    packed.lines().find_map(|line| {
        let (sha, r) = line.split_once(' ')?;
        (r.trim() == name && !line.starts_with('#')).then(|| sha.to_string())
    })
}

/// Whether the repository containing `folder` has a local branch `name`.
pub fn branch_exists(folder: &Path, name: &str) -> bool {
    if name.is_empty() || name.contains("..") || name.starts_with('/') || name.contains([':', '\\']) {
        return false;
    }
    let Some((_, common)) = repo_root(folder).and_then(|r| git_dirs(&r)) else {
        return false;
    };
    let full = format!("refs/heads/{name}");
    common.join(&full).is_file()
        || std::fs::read_to_string(common.join("packed-refs"))
            .is_ok_and(|p| p.lines().any(|l| l.split_once(' ').is_some_and(|(_, r)| r.trim() == full)))
}

/// HEAD of the repository containing `folder`; `None` outside a repository.
pub fn read_head(folder: &Path) -> Option<GitHead> {
    let root = repo_root(folder)?;
    let (gitdir, common) = git_dirs(&root)?;
    let head = std::fs::read_to_string(gitdir.join("HEAD")).ok()?;
    let head = head.trim();
    match head.strip_prefix("ref:") {
        Some(target) => {
            let target = target.trim();
            let branch = target.strip_prefix("refs/heads/").map(str::to_string);
            Some(GitHead {
                branch,
                sha: resolve_ref(&common, target),
            })
        }
        None => Some(GitHead {
            branch: None,
            sha: Some(head.to_string()),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(head: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".git/refs/heads/feat")).unwrap();
        std::fs::write(dir.path().join(".git/HEAD"), head).unwrap();
        dir
    }

    #[test]
    fn branch_and_sha_from_a_loose_ref() {
        let dir = repo("ref: refs/heads/feat/x\n");
        std::fs::write(
            dir.path().join(".git/refs/heads/feat/x"),
            "0123456789abcdef0123456789abcdef01234567\n",
        )
        .unwrap();
        let head = read_head(dir.path()).unwrap();
        assert_eq!(head.branch.as_deref(), Some("feat/x"));
        assert_eq!(
            head.sha.as_deref(),
            Some("0123456789abcdef0123456789abcdef01234567")
        );
        assert_eq!(head.label(), "feat/x");
    }

    #[test]
    fn a_packed_ref_resolves() {
        let dir = repo("ref: refs/heads/main\n");
        std::fs::write(
            dir.path().join(".git/packed-refs"),
            "# pack-refs\nabcdefabcdefabcdefabcdefabcdefabcdefabcd refs/heads/main\n",
        )
        .unwrap();
        let head = read_head(dir.path()).unwrap();
        assert_eq!(head.branch.as_deref(), Some("main"));
        assert!(head.sha.unwrap().starts_with("abcdef"));
    }

    #[test]
    fn detached_head_has_no_branch() {
        let dir = repo("0123456789abcdef0123456789abcdef01234567\n");
        let head = read_head(dir.path()).unwrap();
        assert_eq!(head.branch, None);
        assert_eq!(head.label(), "0123456");
    }

    #[test]
    fn a_subfolder_finds_the_repo_and_a_plain_folder_has_none() {
        let dir = repo("ref: refs/heads/main\n");
        let sub = dir.path().join("a/b");
        std::fs::create_dir_all(&sub).unwrap();
        assert!(read_head(&sub).is_some());
        assert!(is_git_repo(&sub));
        let plain = tempfile::tempdir().unwrap();
        // A temp dir may sit inside a repo on a dev box; only assert when not.
        if repo_root(plain.path()).is_none() {
            assert!(read_head(plain.path()).is_none());
        }
    }

    #[test]
    fn a_linked_worktree_reads_its_own_head_and_the_shared_refs() {
        let main = repo("ref: refs/heads/main\n");
        let wt_git = main.path().join(".git/worktrees/w");
        std::fs::create_dir_all(&wt_git).unwrap();
        std::fs::write(wt_git.join("HEAD"), "ref: refs/heads/feat/w\n").unwrap();
        std::fs::write(wt_git.join("commondir"), "../..\n").unwrap();
        std::fs::write(
            main.path().join(".git/refs/heads/feat/w"),
            "1111111111111111111111111111111111111111\n",
        )
        .unwrap();
        let wt = tempfile::tempdir().unwrap();
        std::fs::write(
            wt.path().join(".git"),
            format!("gitdir: {}\n", wt_git.display()),
        )
        .unwrap();
        let head = read_head(wt.path()).unwrap();
        assert_eq!(head.branch.as_deref(), Some("feat/w"));
        assert_eq!(head.sha.as_deref(), Some("1111111111111111111111111111111111111111"));
    }
}
