//! `flint cli worktree list | merge | discard`: the lifecycle the desktop's
//! worktree bar offers, for the checkouts `--worktree` sessions create under
//! `~/.jan/worktrees/<repo>/<id>`.
//!
//! Nothing here runs unless asked, and nothing loses work quietly: `discard`
//! names what a checkout holds and refuses to remove it until that is dealt
//! with (or `--force`), and `merge` only fast-forwards the checked-out base
//! when that checkout is clean.

use std::path::{Path, PathBuf};

use serde_json::json;

use super::worktree::{branch_for, repo_slug, worktrees_root};
use crate::core::agent::git;

fn run_git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = crate::core::agent::git_exec::GitCmd::new()
        .dir(dir)
        .args(args)
        .run()
        .map_err(|e| e.with_prefix("could not run git: "))?;
    if out.success {
        Ok(out.stdout_lossy().trim().to_string())
    } else {
        let err = out.stderr_lossy().trim().to_string();
        let err = if err.is_empty() { out.stdout_lossy().trim().to_string() } else { err };
        Err(format!("git {}: {err}", args.join(" ")))
    }
}

struct Checkout {
    id: String,
    path: PathBuf,
    branch: String,
}

fn repo_of(project: &str) -> Result<PathBuf, String> {
    git::repo_root(Path::new(project)).ok_or_else(|| "not a git repository".to_string())
}

fn checkouts(repo: &Path) -> Result<Vec<Checkout>, String> {
    // Compared resolved: git reports a path through a junction, a symlink or a
    // different letter case than the one the root was built from.
    let resolved = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let root = resolved(&worktrees_root()?.join(repo_slug(repo)));
    let mut out = Vec::new();
    for path in git::worktree_paths(repo) {
        if !path.is_dir() {
            continue;
        }
        let ours = path.parent().map(|p| resolved(p) == root).unwrap_or(false);
        // A sub-agent's checkout lives under the data folder, on a
        // `jan/cowork/` branch: listed too, so it can be seen and discarded.
        let head = run_git(&path, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
        let child = head.trim().starts_with(crate::core::agent::worktree::BRANCH_PREFIX);
        if ours || child {
            let id = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
            let mut branch = head;
            // A detached checkout reports "HEAD", which from the main repo
            // names the wrong commit: use the checkout's own commit instead,
            // so its unmerged work is still seen before a discard.
            if branch.trim().is_empty() || branch.trim() == "HEAD" {
                branch = run_git(&path, &["rev-parse", "HEAD"]).unwrap_or_default();
            }
            let branch = branch.trim().to_string();
            out.push(Checkout { id, path, branch });
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

fn find(repo: &Path, id: &str) -> Result<Checkout, String> {
    if id.is_empty() || id.contains(['/', '\\']) || id.contains("..") {
        return Err(format!("'{id}' is not a worktree id"));
    }
    checkouts(repo)?
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| format!("no worktree '{id}' for this repository (see `worktree list`)"))
}

fn base_branch(repo: &Path, target: Option<&str>) -> Result<String, String> {
    target
        .map(str::to_string)
        .or_else(|| git::current_branch(repo))
        .ok_or_else(|| "the repository is on a detached HEAD; pass --into BRANCH".to_string())
}

fn unmerged(repo: &Path, base: &str, branch: &str) -> Result<Vec<String>, String> {
    if branch.is_empty() {
        return Err("could not read the checkout's commit".to_string());
    }
    run_git(repo, &["log", "--format=%h %s", &format!("{base}..{branch}")])
        .map(|s| s.lines().map(str::to_string).collect())
}

fn pending(c: &Checkout) -> Result<Vec<String>, String> {
    run_git(&c.path, &["status", "--porcelain"])
        .map(|s| s.lines().map(|l| l.trim().to_string()).collect())
}

/// What `status --porcelain` in `dir` says blocks a merge, split in two:
/// changes to tracked files, which a merge would leave behind or clobber, and
/// untracked files, which it neither takes nor touches. Flint's own session
/// records under `.jan/` are neither: they are bookkeeping, not work. Files
/// the repository ignores never appear here at all.
fn merge_blockers(dir: &Path) -> Result<(Vec<String>, Vec<String>), String> {
    let status = run_git(dir, &["status", "--porcelain", "--untracked-files=all"])?;
    Ok(split_status(&status))
}

fn split_status(status: &str) -> (Vec<String>, Vec<String>) {
    let mut changed = Vec::new();
    let mut untracked = Vec::new();
    for line in status.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let path = line.get(3..).unwrap_or("").trim().trim_matches('"');
        if let Some(rest) = line.strip_prefix("?? ") {
            let rest = rest.trim().trim_matches('"');
            if rest == ".jan" || rest.starts_with(".jan/") {
                continue;
            }
            untracked.push(rest.to_string());
        } else {
            changed.push(path.to_string());
        }
    }
    (changed, untracked)
}

/// Counts for a listing, where an unreadable one shows as "?" rather than 0.
fn count<T>(r: &Result<Vec<T>, String>) -> String {
    r.as_ref().map(|v| v.len().to_string()).unwrap_or_else(|_| "?".to_string())
}

/// `worktree list [--project P] [--json]`
pub fn list(project: &str, json_out: bool) -> Result<(), String> {
    let repo = repo_of(project)?;
    git::worktree_prune(&repo);
    let base = base_branch(&repo, None).unwrap_or_else(|_| "HEAD".to_string());
    let rows = checkouts(&repo)?;
    if json_out {
        let v: Vec<_> = rows
            .iter()
            .map(|c| {
                json!({
                    "id": c.id,
                    "path": c.path,
                    "branch": c.branch,
                    "pending": pending(c).map_err(|e| e.to_string()).map_or_else(|e| json!({ "error": e }), |v| json!(v)),
                    "unmerged": unmerged(&repo, &base, &c.branch).map_err(|e| e.to_string()).map_or_else(|e| json!({ "error": e }), |v| json!(v)),
                })
            })
            .collect();
        println!("{}", serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?);
        return Ok(());
    }
    if rows.is_empty() {
        println!("No worktrees for this repository.");
    }
    for c in &rows {
        println!(
            "{}  {}  {} uncommitted, {} unmerged  {}",
            c.id,
            c.branch,
            count(&pending(c)),
            count(&unmerged(&repo, &base, &c.branch)),
            c.path.display()
        );
    }
    Ok(())
}

/// `worktree discard <id> [--force]`
pub fn discard(project: &str, id: &str, force: bool) -> Result<(), String> {
    let repo = repo_of(project)?;
    let c = find(&repo, id)?;
    let base = base_branch(&repo, None).unwrap_or_else(|_| "HEAD".to_string());
    if !force {
        // If either check cannot be made, say so: "could not look" is not "clean".
        let dirty = pending(&c).map_err(|e| format!("could not check worktree {id} for uncommitted work ({e}); pass --force to discard it anyway"))?;
        let ahead = unmerged(&repo, &base, &c.branch).map_err(|e| format!("could not check worktree {id} for unmerged commits ({e}); pass --force to discard it anyway"))?;
        if !dirty.is_empty() || !ahead.is_empty() {
            let mut why = format!("worktree {id} holds work that would be lost:");
            for d in dirty.iter().take(10) {
                why.push_str(&format!("\n  uncommitted: {d}"));
            }
            for a in ahead.iter().take(10) {
                why.push_str(&format!("\n  not in {base}: {a}"));
            }
            why.push_str("\nMerge it (`worktree merge`), or pass --force to discard it anyway.");
            return Err(why);
        }
    }
    let path = c.path.to_string_lossy().to_string();
    let mut remove = vec!["worktree", "remove"];
    if force {
        remove.push("--force");
    }
    remove.push(&path);
    run_git(&repo, &remove)?;
    // Only the branch Flint made for it; a branch with another name is left.
    if c.branch == branch_for(&c.id) || c.branch.starts_with(crate::core::agent::worktree::BRANCH_PREFIX) {
        let _ = run_git(&repo, &["branch", if force { "-D" } else { "-d" }, &c.branch]);
    }
    println!("{}", json!({ "discarded": true, "id": id }));
    Ok(())
}

/// `worktree merge <id> [--into BRANCH] [--message M]`
pub fn merge(project: &str, id: &str, into: Option<&str>, message: Option<&str>) -> Result<(), String> {
    let repo = repo_of(project)?;
    let c = find(&repo, id)?;
    let target = base_branch(&repo, into)?;
    if target.starts_with('-') || target == c.branch {
        return Err(format!("cannot merge {} into {target}", c.branch));
    }
    // Uncommitted changes to tracked files block: the merge takes commits
    // only, so they would be left behind. Untracked files do not block (a
    // merge neither takes nor touches them) but are named, so nothing the
    // agent wrote and never committed goes unnoticed.
    let (dirty, untracked) = merge_blockers(&c.path)?;
    if !dirty.is_empty() {
        return Err(format!(
            "worktree {id} has uncommitted changes ({}): commit them in {} first",
            dirty.join(", "),
            c.path.display()
        ));
    }
    if !untracked.is_empty() {
        eprintln!(
            "note: worktree {id} has untracked files that are not committed and will not be merged: {}",
            untracked.iter().take(20).cloned().collect::<Vec<_>>().join(", ")
        );
    }
    // The merge happens in the repository's own checkout, so that checkout has
    // to be on the target and clean; anything else would move work around.
    let Some(on) = git::current_branch(&repo).filter(|b| !b.is_empty()) else {
        return Err(format!(
            "the repository is on a detached HEAD, not '{target}': check out '{target}' first"
        ));
    };
    if on != target {
        return Err(format!(
            "the repository is on '{on}', not '{target}': check out '{target}' first, or pass --into {on}"
        ));
    }
    // Untracked files and Flint's own `.jan/` records do not block: git
    // refuses by itself if the merge would overwrite an untracked file.
    let (repo_dirty, _) = merge_blockers(&repo)?;
    if !repo_dirty.is_empty() {
        return Err(format!(
            "the repository has uncommitted changes ({}); commit or stash them before merging",
            repo_dirty.join(", ")
        ));
    }
    let ahead = unmerged(&repo, &target, &c.branch)?;
    if ahead.is_empty() {
        println!("{}", json!({ "merged": false, "reason": "nothing to merge" }));
        return Ok(());
    }
    let msg = message.map(str::to_string).unwrap_or_else(|| format!("Merge {} (Flint worktree {})", c.branch, c.id));
    match run_git(&repo, &["merge", "--no-ff", "-m", &msg, &c.branch]) {
        Ok(_) => {
            let mut out = json!({ "merged": true, "commits": ahead.len(), "into": target });
            if !untracked.is_empty() {
                out["untracked_left_behind"] = json!(untracked);
            }
            println!("{out}");
            Ok(())
        }
        Err(e) => {
            // Only a merge that actually started has anything to abort.
            let in_progress = repo.join(".git").join("MERGE_HEAD").exists()
                || run_git(&repo, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_ok();
            if in_progress {
                let _ = run_git(&repo, &["merge", "--abort"]);
                Err(format!("the merge conflicted and was aborted; nothing changed. {e}"))
            } else {
                Err(format!("git could not merge ({e}); nothing changed"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git_ok(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "T")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "T")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .output()
            .expect("git");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// Flint's own session records and untracked build output do not block a
    /// merge; a changed tracked file does.
    #[test]
    fn merge_blockers_skip_flint_records_and_split_untracked() {
        let status = "?? .jan/\n?? .jan/agent/session.json\n?? __pycache__/m.cpython-311.pyc\n M src/a.py\nA  src/b.py\n";
        let (changed, untracked) = split_status(status);
        assert_eq!(changed, ["src/a.py", "src/b.py"]);
        assert_eq!(untracked, ["__pycache__/m.cpython-311.pyc"]);
        assert_eq!(split_status("?? .jan/x\n"), (vec![], vec![]));
    }

    /// A sub-agent's checkout (outside the session folder, on a
    /// `jan/cowork/` branch) is listed and can be discarded with its branch.
    #[test]
    fn a_sub_agent_checkout_is_listed_and_discardable() {
        let _g = crate::core::server::provider_secrets::TEST_ENV_LOCK.lock();
        let home = tempfile::tempdir().unwrap();
        let prev = std::env::var_os("JAN_HOME");
        std::env::set_var("JAN_HOME", home.path());
        let repo_dir = tempfile::tempdir().unwrap();
        let repo = repo_dir.path();
        git_ok(repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "one").unwrap();
        git_ok(repo, &["add", "."]);
        git_ok(repo, &["commit", "-q", "-m", "first"]);
        let elsewhere = tempfile::tempdir().unwrap();
        let path = elsewhere.path().join("child-1");
        let root = git::repo_root(repo).unwrap();
        git::worktree_add(&root, &path, "jan/cowork/child-1", "HEAD").unwrap();

        let found = checkouts(&root).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].branch, "jan/cowork/child-1");
        let project = repo.to_string_lossy().to_string();
        discard(&project, "child-1", false).unwrap();
        assert!(!path.exists());
        let branches = Command::new("git").arg("-C").arg(repo).args(["branch", "--list", "jan/cowork/*"]).output().unwrap();
        assert!(String::from_utf8_lossy(&branches.stdout).trim().is_empty());
        match prev {
            Some(p) => std::env::set_var("JAN_HOME", p),
            None => std::env::remove_var("JAN_HOME"),
        }
    }

    #[test]
    fn list_merge_and_guarded_discard() {
        let _g = crate::core::server::provider_secrets::TEST_ENV_LOCK.lock();
        let home = tempfile::tempdir().unwrap();
        let prev = std::env::var_os("JAN_HOME");
        std::env::set_var("JAN_HOME", home.path());
        let repo_dir = tempfile::tempdir().unwrap();
        let repo = repo_dir.path();
        git_ok(repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "one").unwrap();
        git_ok(repo, &["add", "."]);
        git_ok(repo, &["commit", "-q", "-m", "first"]);

        // Place a checkout where `--worktree` sessions put theirs.
        let root = worktrees_root().unwrap();
        assert!(root.starts_with(home.path()), "the test must never touch the real home");
        let slug_dir = root.join(repo_slug(&git::repo_root(repo).unwrap()));
        let path = slug_dir.join("abcd1234");
        let branch = branch_for("abcd1234");
        git::worktree_add(&git::repo_root(repo).unwrap(), &path, &branch, "HEAD").unwrap();

        let project = repo.to_string_lossy().to_string();
        list(&project, true).unwrap();
        assert_eq!(checkouts(&git::repo_root(repo).unwrap()).unwrap().len(), 1);

        // Uncommitted work blocks discard and merge.
        std::fs::write(path.join("b.txt"), "two").unwrap();
        assert!(discard(&project, "abcd1234", false).unwrap_err().contains("would be lost"));
        std::fs::write(path.join("a.txt"), "changed").unwrap();
        assert!(merge(&project, "abcd1234", None, None).unwrap_err().contains("uncommitted"));

        git_ok(&path, &["add", "."]);
        git_ok(&path, &["commit", "-q", "-m", "second"]);
        // Neither Flint's session record in the repository nor untracked
        // build output in the checkout blocks the merge.
        std::fs::create_dir_all(repo.join(".jan").join("agent")).unwrap();
        std::fs::write(repo.join(".jan").join("agent").join("session.json"), "{}").unwrap();
        std::fs::create_dir_all(path.join("__pycache__")).unwrap();
        std::fs::write(path.join("__pycache__").join("b.pyc"), "x").unwrap();
        // Committed but unmerged still blocks discard.
        assert!(discard(&project, "abcd1234", false).unwrap_err().contains("not in main"));

        // A detached repository checkout is named as such, not as ''.
        git_ok(repo, &["checkout", "-q", "--detach"]);
        let err = merge(&project, "abcd1234", Some("main"), None).unwrap_err();
        assert!(err.contains("detached HEAD") && !err.contains("''"), "{err}");
        git_ok(repo, &["checkout", "-q", "main"]);
        merge(&project, "abcd1234", None, None).unwrap();
        assert!(repo.join("b.txt").exists());
        // The untracked file left behind still guards a discard.
        assert!(discard(&project, "abcd1234", false).unwrap_err().contains("would be lost"));
        std::fs::remove_dir_all(path.join("__pycache__")).unwrap();
        discard(&project, "abcd1234", false).unwrap();
        assert!(!path.exists());
        assert!(find(&git::repo_root(repo).unwrap(), "../x").is_err());
        let _ = std::fs::remove_dir_all(&slug_dir);
        match prev {
            Some(p) => std::env::set_var("JAN_HOME", p),
            None => std::env::remove_var("JAN_HOME"),
        }
    }
}
