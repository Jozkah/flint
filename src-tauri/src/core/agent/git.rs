//! Git-backed workspace snapshots. The agent edits files in place in the
//! directory it works in; to make a run revertible we snapshot the state after
//! each turn and can restore it, Claude-Code style.
//!
//! That directory is the user's own checkout by default, and a dedicated
//! worktree when the session asked for one (`core::cli::worktree`), which the
//! snapshots follow: the worktree isolates the files, these snapshots make the
//! turns inside it revertible. The worktree primitives below are the git side
//! of that, kept here because this module owns every `git` invocation.
//!
//! Snapshots never scan the working tree. Each checkpoint stages only the exact
//! paths the caller reports as touched this turn (`edit`/`write` tool calls);
//! the base snapshot seeds from the current `HEAD` tree plus a `git diff
//! --name-only HEAD` (tracked files only -- no untracked-file walk). This keeps
//! cost bounded by what actually changed instead of the size of the repo, which
//! matters on large trees or ones with big non-ignored build/model directories.
//! A known trade-off: changes made by other means (a `bash` tool call, an
//! external editor) are not captured unless also reported via `changed`.
//!
//! Snapshots are kept OUT of the user's branch, HEAD, and index: we stage into a
//! throwaway index file (`GIT_INDEX_FILE`) and build commit objects with
//! `commit-tree`, reachable only from a hidden `refs/jan/agent/snapshots/<id>`
//! ref. The user's `git status`, current branch, and staged changes are never
//! touched. Shelling out keeps us free of a libgit2 dependency.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Run `git` with literal args (callers pass their own `-C`). Returns trimmed
/// stdout on success, trimmed stderr (or a generic message) on failure.
fn git(args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.args(crate::core::agent::vcs::HARDENED)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0");
    jan_utils::system::hide_console_window(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("failed to launch git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("git {} failed", args.first().copied().unwrap_or(""))
        } else {
            stderr
        })
    }
}

/// Run a repo-scoped `git` (`-C <repo>`), optionally against a throwaway index,
/// with a fixed agent identity so `commit-tree` never needs user config and
/// never triggers commit signing.
fn run(repo: &Path, index: Option<&Path>, args: &[&str]) -> Result<String, String> {
    exec(repo, index, args, None).map(|out| out.trim().to_string())
}

/// [`run`], with stdout returned exactly as written.
///
/// NUL-separated output (`-z`) must not be trimmed: a path that begins or ends
/// with a space is a legal file name, and trimming the whole output would
/// silently rename the first or last entry.
fn run_untrimmed(repo: &Path, index: Option<&Path>, args: &[&str]) -> Result<String, String> {
    exec(repo, index, args, None)
}

fn exec(
    repo: &Path,
    index: Option<&Path>,
    args: &[&str],
    stdin: Option<&[u8]>,
) -> Result<String, String> {
    use std::io::Write;
    use std::process::Stdio;

    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo).args(crate::core::agent::vcs::HARDENED).env("GIT_TERMINAL_PROMPT", "0");
    // Snapshot and restore must round-trip the working tree byte for byte.
    // `core.autocrlf` is on by default in Git for Windows, which converts on
    // the way into the index and back out again -- so a file snapshotted as
    // "one\n" was restored as "one\r\n", and Flint silently rewrote the line
    // endings of every file it put back. These are Flint's own private objects,
    // not the user's commits, so the conversion has nothing to gain here and a
    // fidelity guarantee to lose.
    cmd.arg("-c").arg("core.autocrlf=false");
    cmd.arg("-c").arg("core.eol=lf");
    cmd.args(args);
    // The same fidelity argument covers the repository's own `.gitattributes`:
    // `text`, `eol=crlf` or a filter there converts on the way in and out
    // regardless of `core.autocrlf`, so a CRLF file under `text=auto` came back
    // as LF. Reading attributes from the empty tree turns that off for Flint's
    // private objects. Git older than 2.40 ignores the variable and keeps the
    // previous behaviour.
    cmd.env("GIT_ATTR_SOURCE", EMPTY_TREE);
    cmd.env("GIT_AUTHOR_NAME", "Flint")
        .env("GIT_AUTHOR_EMAIL", "agent@jan.ai")
        .env("GIT_COMMITTER_NAME", "Flint")
        .env("GIT_COMMITTER_EMAIL", "agent@jan.ai");
    if let Some(idx) = index {
        cmd.env("GIT_INDEX_FILE", idx);
    }
    jan_utils::system::hide_console_window(&mut cmd);
    let out = match stdin {
        None => cmd.output(),
        Some(input) => cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .and_then(|mut child| {
                // Written from another thread so a child that fills its output
                // pipe before reading all of its input cannot deadlock us.
                let mut pipe = child.stdin.take();
                let input = input.to_vec();
                let writer = std::thread::spawn(move || {
                    if let Some(pipe) = pipe.as_mut() {
                        let _ = pipe.write_all(&input);
                    }
                });
                let out = child.wait_with_output();
                let _ = writer.join();
                out
            }),
    }
    .map_err(|e| format!("failed to launch git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("git {} failed", args.first().copied().unwrap_or(""))
        } else {
            stderr
        })
    }
}

/// A throwaway index for one-off git operations (restore, whole-tree
/// staging), so they never disturb the real index.
///
/// The file lives inside a freshly created private directory (mode 0700 on
/// Unix, with an unpredictable name made by exclusive creation), never
/// directly in the shared temp directory. A predictable name there -- it used
/// to be the pid plus a counter -- let another local user plant a symbolic
/// link at it ahead of time; git's lockfile code follows such a link and
/// renames the new index over its target, overwriting any file the user can
/// write. The directory and the index are removed when this is dropped.
struct TempIndex {
    _dir: tempfile::TempDir,
    path: PathBuf,
}

impl std::ops::Deref for TempIndex {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.path
    }
}

fn temp_index() -> Result<TempIndex, String> {
    let dir = tempfile::Builder::new()
        .prefix("jan-agent-idx-")
        .tempdir()
        .map_err(|e| format!("scratch index directory: {e}"))?;
    let path = dir.path().join("index");
    Ok(TempIndex { _dir: dir, path })
}

/// The shared parent of every thread's snapshot index directory, created
/// private to this user. Its path is fixed, so on a shared temp directory
/// another user could create it first (or plant a link there) and redirect
/// the index writes; a directory that is a link, belongs to someone else, or
/// is open to group or others is refused rather than written through.
fn private_snapshot_root(root: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt};
        match std::fs::DirBuilder::new().mode(0o700).create(root) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(format!("snapshot index directory: {e}")),
        }
        let meta = std::fs::symlink_metadata(root)
            .map_err(|e| format!("snapshot index directory: {e}"))?;
        // SAFETY: geteuid has no preconditions and cannot fail.
        let me = unsafe { libc::geteuid() };
        if !meta.file_type().is_dir() || meta.uid() != me || meta.mode() & 0o077 != 0 {
            return Err(format!(
                "refusing the snapshot index directory {}: it is not a private directory owned by this user",
                root.display()
            ));
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(root).map_err(|e| format!("snapshot index directory: {e}"))
    }
}

fn snapshot_root() -> PathBuf {
    std::env::temp_dir().join("jan-agent-snap-idx")
}

/// Where a thread's scratch indexes live: one directory per thread, one index
/// file per repository inside it.
///
/// The index is kept across calls rather than deleted after use. Reusing it
/// lets staging compare against its own prior stat cache instead of a fresh
/// empty one, so unchanged files are only stat'd (cheap) rather than re-hashed
/// and re-inserted like every other file touched this turn.
///
/// The repository has to be part of the key. With the index named only after
/// the thread, one file was shared by every repository that thread ever
/// touched, so a snapshot in a second project staged against the first
/// project's tree. Worse, the file outlives the process: an index left behind
/// by a crashed session -- or by a repository that has since been deleted --
/// refers to objects that no longer exist, and every later snapshot for that
/// thread failed with `fatal: <sha> is not a valid object` and stayed failing.
fn snapshot_index_dir(thread_id: &str) -> PathBuf {
    // The id reaches the filesystem, so keep it to something that can be a
    // directory name on every platform.
    let safe: String = thread_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    snapshot_root().join(safe)
}

/// A stable digest of the repository path, so the same repository maps to the
/// same index across processes. FNV-1a: `DefaultHasher` is explicitly not
/// guaranteed stable between runs, which is exactly what this needs to be.
fn repo_key(repo: &Path) -> String {
    let canonical = repo.canonicalize().unwrap_or_else(|_| repo.to_path_buf());
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in canonical.to_string_lossy().to_lowercase().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn snapshot_index(repo: &Path, thread_id: &str) -> PathBuf {
    snapshot_index_dir(thread_id).join(repo_key(repo))
}

/// Hidden ref that keeps a thread's snapshot chain reachable across GC. One ref
/// per thread; each snapshot parents the previous, so the whole chain is live.
pub(crate) fn snapshot_ref(thread_id: &str) -> String {
    format!("refs/jan/agent/snapshots/{thread_id}")
}

/// The repository top-level for `path`, or `None` when `path` is not inside a
/// git work tree (workspace-restore is unavailable then; the agent still edits
/// in place). Also `None` when `git` is not installed.
pub fn repo_root(path: &Path) -> Option<PathBuf> {
    let p = path.to_string_lossy();
    git(&["-C", &p, "rev-parse", "--show-toplevel"])
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// The current branch name for the repo containing `path`, or `None` when
/// `path` is not inside a git work tree, `git` is not installed, or `HEAD` is
/// detached (no symbolic branch). A detached `HEAD` yields the empty string
/// from `--abbrev-ref`, filtered out here.
pub(crate) fn current_branch(path: &Path) -> Option<String> {
    let p = path.to_string_lossy();
    git(&["-C", &p, "rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "HEAD")
}

/// The canonical empty tree object every git repo has, without needing a
/// commit to hash it from -- used as the base tree when `HEAD` is unborn.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// Stage a single relative path into `idx`: `add` if it still exists on disk,
/// `rm --cached` (ignoring paths not currently tracked) if it was deleted.
/// `force_add` is reserved for paths proven tracked by `git diff --name-only
/// HEAD`: a later .gitignore rule must not prevent the base snapshot from
/// preserving their dirty state. Never touches any other path, so cost is O(1)
/// per call, not O(repo size).
fn stage_path(repo: &Path, idx: &Path, rel: &Path, force_add: bool) -> Result<(), String> {
    let rel_str = rel.to_string_lossy();
    if repo.join(rel).exists() {
        if force_add {
            run(repo, Some(idx), &["add", "-f", "--", &rel_str])?;
        } else {
            run(repo, Some(idx), &["add", "--", &rel_str])?;
        }
    } else {
        run(
            repo,
            Some(idx),
            &["rm", "--cached", "--ignore-unmatch", "--", &rel_str],
        )?;
    }
    Ok(())
}

/// Snapshot the current state as a commit object, without touching the user's
/// branch/HEAD/index, and without ever scanning the whole working tree.
/// `parent` chains onto the previous snapshot; `None` for the base. `changed`
/// lists paths (relative to `repo`) touched since the previous snapshot in
/// this thread's chain -- only these are staged. Returns the snapshot sha.
///
/// `thread_id` keys a persistent throwaway index reused across a thread's
/// whole snapshot chain, seeded once (base) from `HEAD`'s tree (or the empty
/// tree for an unborn `HEAD`) plus any already-dirty tracked files (via `git
/// diff --name-only HEAD`, which compares only tracked paths -- no untracked
/// scan). Every later checkpoint reuses that same index and stages only
/// `changed`.
pub(crate) fn snapshot(
    repo: &Path,
    parent: Option<&str>,
    msg: &str,
    thread_id: &str,
    changed: &[PathBuf],
) -> Result<String, String> {
    crate::core::agent::vcs::refuse_filter_programs(repo)?;
    let idx = snapshot_index(repo, thread_id);
    private_snapshot_root(&snapshot_root())?;
    if let Some(parent_dir) = idx.parent() {
        std::fs::create_dir_all(parent_dir)
            .map_err(|e| format!("snapshot index directory: {e}"))?;
    }

    // Build the index from the repository's own state.
    let seed = |idx: &Path| -> Result<(), String> {
        let base_tree = run(repo, None, &["rev-parse", "--verify", "-q", "HEAD^{tree}"])
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| EMPTY_TREE.to_string());
        run(repo, Some(idx), &["read-tree", &base_tree])?;
        if let Ok(dirty) = run(repo, None, &["diff", "--name-only", "HEAD"]) {
            for rel in dirty.lines().filter(|l| !l.is_empty()) {
                stage_path(repo, idx, Path::new(rel), true)?;
            }
        }
        Ok(())
    };

    let stage_all = |idx: &Path| -> Result<String, String> {
        for rel in changed {
            stage_path(repo, idx, rel, false)?;
        }
        run(repo, Some(idx), &["write-tree"])
    };

    if !idx.exists() {
        seed(&idx)?;
    }

    // An index carried over from a previous session can name objects this
    // repository does not have -- the repository was recreated, or the index
    // was written against a different one. That is recoverable: the index is a
    // cache, so throw it away and rebuild rather than leaving the thread
    // permanently unable to snapshot.
    let tree = match stage_all(&idx) {
        Ok(tree) => tree,
        Err(err) => {
            let _ = std::fs::remove_file(&idx);
            seed(&idx).map_err(|second| {
                format!("snapshot index was unusable ({err}); rebuilding it also failed: {second}")
            })?;
            stage_all(&idx)?
        }
    };
    let mut args = vec!["commit-tree", &tree];
    if let Some(p) = parent {
        args.push("-p");
        args.push(p);
    }
    args.push("-m");
    args.push(msg);
    run(repo, None, &args)
}

/// Drop a thread's persistent snapshot index (e.g. once the thread is done or
/// after a workspace restore invalidates it). Safe to call even if it was
/// never created.
pub(crate) fn cleanup_snapshot_index(thread_id: &str) {
    // Every repository this thread touched, not just one: the caller deleting a
    // thread has no repository in hand and should not leave indexes behind.
    let _ = std::fs::remove_dir_all(snapshot_index_dir(thread_id));
}

/// Point the thread's snapshot ref at `sha` (create or update).
pub(crate) fn update_ref(repo: &Path, thread_id: &str, sha: &str) -> Result<(), String> {
    run(repo, None, &["update-ref", &snapshot_ref(thread_id), sha]).map(|_| ())
}

/// A unified diff from `from` to `to`, both snapshot commits.
///
/// Used to show what a rewind *would* do in a tree Flint does not own, where the
/// answer has to be reviewable rather than applied. `--no-index` is not wanted
/// here: these are real commit objects, and diffing them is what makes the
/// patch exact rather than reconstructed from the working tree.
pub(crate) fn diff_between(repo: &Path, from: &str, to: &str) -> Result<String, String> {
    run(repo, None, &["diff", "--no-ext-diff", "--no-textconv", from, to])
}

/// The change that would take the working tree as it stands back to `commit`,
/// as a unified diff. Untracked (not ignored) files count as part of the tree,
/// so a file a restore would delete shows up as a deletion. Nothing on disk,
/// and not the user's index, is touched: the tree is staged into a scratch
/// index seeded from `commit`.
pub(crate) fn diff_worktree_to(repo: &Path, commit: &str) -> Result<String, String> {
    let idx = temp_index()?;
    let result = (|| {
        stage_worktree(repo, &idx, commit)?;
        let tree = run(repo, Some(&idx), &["write-tree"])?;
        run_untrimmed(repo, None, &["diff", &tree, commit])
    })();
    drop(idx);
    result
}

/// Stage the working tree exactly as it stands into a scratch index.
///
/// The index is seeded from `base` first so that paths outside `repo` (when
/// `repo` is a subdirectory of the repository) keep the content `base` gave
/// them; `add -A` then records every addition, modification and deletion
/// under `repo`, honouring `.gitignore`. The scratch index is the caller's to
/// remove. The user's own index is never touched: everything goes through
/// `GIT_INDEX_FILE`.
///
/// R22: `add -A` runs every clean filter the repository's config names, so
/// the refusal gate runs here, in the one helper every whole-tree staging
/// path shares, rather than being left to each caller to remember.
fn stage_worktree(repo: &Path, idx: &Path, base: &str) -> Result<(), String> {
    crate::core::agent::vcs::refuse_filter_programs(repo)?;
    run(repo, Some(idx), &["read-tree", base])?;
    run(repo, Some(idx), &["add", "-A", "--", "."])?;
    Ok(())
}

/// Snapshot the whole working tree as it stands, as a commit object.
///
/// Unlike [`snapshot`], this scans the tree rather than staging a list of
/// paths, so it cannot miss an edit nobody reported — a file changed in an
/// editor, by a build, or by a shell command. That costs a full scan, which is
/// why it is used only where Flint owns the tree and completeness is what makes
/// a rewind safe to offer. Branch, HEAD and the real index are untouched.
pub(crate) fn snapshot_worktree(
    repo: &Path,
    parent: Option<&str>,
    msg: &str,
) -> Result<String, String> {
    let idx = temp_index()?;
    let result = (|| {
        let base = match parent {
            Some(p) => p.to_string(),
            None => run(repo, None, &["rev-parse", "--verify", "-q", "HEAD^{tree}"])
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| EMPTY_TREE.to_string()),
        };
        stage_worktree(repo, &idx, &base)?;
        let tree = run(repo, Some(&idx), &["write-tree"])?;
        let mut args: Vec<&str> = vec!["commit-tree", &tree];
        if let Some(p) = parent {
            args.push("-p");
            args.push(p);
        }
        args.push("-m");
        args.push(msg);
        run(repo, None, &args)
    })();
    drop(idx);
    result
}

/// Mode git records for a gitlink: a nested repository or submodule, stored as
/// a pointer to a commit rather than as files.
const GITLINK_MODE: &str = "160000";

/// One entry of `git diff --raw -z --no-renames`.
#[derive(Debug, Clone, PartialEq)]
struct RawChange {
    old_mode: String,
    new_mode: String,
    /// `A`, `D`, `M` or `T`. Renames and copies are never reported because
    /// every caller passes `--no-renames`.
    status: char,
    path: String,
}

impl RawChange {
    /// A nested repository or submodule on either side. Its files are not in
    /// the snapshot — only the commit it pointed at — so it can be neither put
    /// back nor safely removed, and every restore leaves it alone.
    fn is_gitlink(&self) -> bool {
        self.old_mode == GITLINK_MODE || self.new_mode == GITLINK_MODE
    }
}

/// Parse `git diff --raw -z --no-renames` output: a `:<old> <new> <sha> <sha>
/// <status>` header token followed by one path token, each NUL-terminated.
fn parse_raw_z(out: &str) -> Vec<RawChange> {
    let mut changes = Vec::new();
    let mut tokens = out.split('\0');
    while let Some(header) = tokens.next() {
        let Some(header) = header.strip_prefix(':') else {
            continue;
        };
        let Some(path) = tokens.next() else { break };
        let fields: Vec<&str> = header.split(' ').collect();
        if fields.len() < 5 || path.is_empty() {
            continue;
        }
        changes.push(RawChange {
            old_mode: fields[0].to_string(),
            new_mode: fields[1].to_string(),
            status: fields[4].chars().next().unwrap_or('M'),
            path: path.to_string(),
        });
    }
    changes
}

/// How snapshot `to` differs from snapshot `from`.
// Only the TUI's restore, built with the `cli` feature, compares two snapshots.
#[cfg_attr(not(feature = "cli"), allow(dead_code))]
fn tree_changes(repo: &Path, from: &str, to: &str) -> Result<Vec<RawChange>, String> {
    let out = run_untrimmed(
        repo,
        None,
        &["diff", "--raw", "-z", "--no-renames", "--no-abbrev", from, to],
    )?;
    Ok(parse_raw_z(&out))
}

/// How the working tree differs from snapshot `commit`, staged into `idx`.
///
/// `A` is on disk but not in `commit`, `D` is in `commit` but missing on disk,
/// `M`/`T` differ in content or type. Ignored files never appear.
fn worktree_changes(repo: &Path, idx: &Path, commit: &str) -> Result<Vec<RawChange>, String> {
    stage_worktree(repo, idx, commit)?;
    let out = run_untrimmed(
        repo,
        Some(idx),
        &[
            "diff",
            "--cached",
            "--raw",
            "-z",
            "--no-renames",
            "--no-abbrev",
            commit,
        ],
    )?;
    Ok(parse_raw_z(&out))
}

/// Paths whose content in the working tree differs from snapshot `commit`.
///
/// Added, modified and deleted paths alike, relative to the repository root,
/// ignored files and nested repositories excluded. Nothing is written except
/// loose objects for the scratch staging, which garbage collection reclaims.
pub(crate) fn changed_since(repo: &Path, commit: &str) -> Result<Vec<String>, String> {
    let idx = temp_index()?;
    let result = worktree_changes(repo, &idx, commit).map(|changes| {
        changes
            .into_iter()
            .filter(|c| !c.is_gitlink())
            .map(|c| c.path)
            .collect()
    });
    drop(idx);
    result
}

/// What removing one path did.
#[derive(Debug, PartialEq)]
enum Removal {
    Removed,
    /// Nothing to remove inside the tree: already gone, a real directory, or
    /// reachable only through a symbolic link or a file.
    NotThere,
}

/// Remove `rel` under `repo` without ever following a symbolic link.
///
/// Every ancestor is checked with `symlink_metadata` first. A path that can
/// only be reached through a link leads somewhere this tree does not own, so it
/// is treated as not there rather than deleted. A symbolic link that is itself
/// the path is removed as a link; its target is never touched. Directories left
/// empty are pruned, up to but never including `repo`.
fn remove_within(repo: &Path, rel: &str) -> Result<Removal, String> {
    safe_rel(rel).map_err(|_| format!("refusing an unsafe path: {rel}"))?;
    let components: Vec<_> = Path::new(rel).components().collect();
    let mut current = repo.to_path_buf();
    for (i, component) in components.iter().enumerate() {
        current.push(component);
        let meta = match std::fs::symlink_metadata(&current) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Removal::NotThere),
            Err(e) => return Err(e.to_string()),
        };
        let is_link = meta.file_type().is_symlink();
        if i + 1 < components.len() {
            if is_link || !meta.is_dir() {
                return Ok(Removal::NotThere);
            }
            continue;
        }
        if meta.is_dir() && !is_link {
            return Ok(Removal::NotThere);
        }
        remove_entry(&current, &meta)?;
    }
    prune_empty_parents(repo, rel);
    Ok(Removal::Removed)
}

fn remove_entry(path: &Path, meta: &std::fs::Metadata) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        // A symbolic link to a directory is a directory entry on Windows.
        Err(_) if meta.file_type().is_symlink() && std::fs::remove_dir(path).is_ok() => Ok(()),
        // Git for Windows clears the read-only attribute before unlinking, and
        // so does this: the file's content is held by a snapshot either way.
        #[cfg(windows)]
        Err(e)
            if e.kind() == std::io::ErrorKind::PermissionDenied
                && meta.permissions().readonly() =>
        {
            let mut perms = meta.permissions();
            #[allow(clippy::permissions_set_readonly_false)]
            perms.set_readonly(false);
            std::fs::set_permissions(path, perms).map_err(|_| e.to_string())?;
            std::fs::remove_file(path).map_err(|e| e.to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}

fn prune_empty_parents(repo: &Path, rel: &str) {
    let mut parent = Path::new(rel).parent();
    while let Some(dir) = parent {
        if dir.as_os_str().is_empty() {
            break;
        }
        // Only succeeds on an empty directory, which is exactly the condition.
        if std::fs::remove_dir(repo.join(dir)).is_err() {
            break;
        }
        parent = dir.parent();
    }
}

/// Why a managed restore did not finish.
#[derive(Debug, PartialEq)]
pub(crate) enum RestoreError {
    /// Refused before anything on disk was changed.
    Refused(String),
    /// Something was changed and something failed; the tree may be anywhere
    /// between where it was and the target.
    Incomplete(String),
}

/// What a managed restore changed.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct RestoreOutcome {
    pub written: Vec<String>,
    pub removed: Vec<String>,
}

/// Make a Flint-owned working tree match snapshot `target` exactly.
///
/// Scope is the working tree under `repo` as `git add -A` sees it: tracked and
/// untracked files alike, ignored files excluded. Only paths that differ are
/// touched — a file already matching `target` is not rewritten, which keeps a
/// failure small and lets a rollback skip whatever the failed attempt never
/// reached.
///
/// - Paths in `target` that are missing or different on disk are written from
///   the snapshot with `checkout-index`, which replaces a symbolic link on the
///   way to a path with a real directory instead of writing through it.
/// - Paths on disk that `target` does not have are removed, without following
///   symbolic links (see [`remove_within`]).
/// - Nested repositories and submodules are skipped entirely.
///
/// Refuses, before writing anything, when a file must replace a directory that
/// holds ignored files: `checkout-index -f` would delete that directory with
/// everything in it, and ignored files are held by no snapshot.
pub(crate) fn restore_worktree(
    repo: &Path,
    target: &str,
) -> Result<RestoreOutcome, RestoreError> {
    // R22: `checkout-index -f` runs every smudge filter the repository names.
    crate::core::agent::vcs::refuse_filter_programs(repo).map_err(RestoreError::Refused)?;
    let current_idx = temp_index().map_err(RestoreError::Refused)?;
    let target_idx = temp_index().map_err(RestoreError::Refused)?;
    let result = (|| {
        let changes =
            worktree_changes(repo, &current_idx, target).map_err(RestoreError::Refused)?;
        let mut write = Vec::new();
        let mut remove = Vec::new();
        for change in changes.into_iter().filter(|c| !c.is_gitlink()) {
            if safe_rel(&change.path).is_err() {
                return Err(RestoreError::Refused(format!(
                    "the snapshot names a path outside the tree: {}",
                    change.path
                )));
            }
            if change.status == 'A' {
                remove.push(change.path);
            } else {
                write.push(change.path);
            }
        }

        for path in &write {
            let on_disk = std::fs::symlink_metadata(repo.join(path));
            if !matches!(&on_disk, Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink()) {
                continue;
            }
            let ignored = run_untrimmed(
                repo,
                Some(&current_idx),
                &[
                    "ls-files",
                    "-z",
                    "--others",
                    "--ignored",
                    "--exclude-standard",
                    "--",
                    path,
                ],
            )
            .map_err(RestoreError::Refused)?;
            let ignored: Vec<&str> = ignored.split('\0').filter(|p| !p.is_empty()).collect();
            if !ignored.is_empty() {
                return Err(RestoreError::Refused(format!(
                    "{path} must become a file again, but it is a directory holding ignored \
                     files no checkpoint keeps ({}); move them out of the way first",
                    ignored.join(", ")
                )));
            }
        }

        run(repo, Some(&target_idx), &["read-tree", target]).map_err(RestoreError::Refused)?;

        let mut outcome = RestoreOutcome::default();
        let mut failures = Vec::new();
        for path in remove {
            match remove_within(repo, &path) {
                Ok(Removal::Removed) => outcome.removed.push(path),
                Ok(Removal::NotThere) => {}
                Err(e) => failures.push(format!("could not remove {path}: {e}")),
            }
        }
        if !write.is_empty() {
            let mut input = Vec::new();
            for path in &write {
                input.extend_from_slice(path.as_bytes());
                input.push(0);
            }
            match exec(
                repo,
                Some(&target_idx),
                &["checkout-index", "-f", "-z", "--stdin"],
                Some(&input),
            ) {
                Ok(_) => outcome.written = write,
                Err(e) => failures.push(format!("could not write every file: {}", e.trim())),
            }
        }
        if failures.is_empty() {
            Ok(outcome)
        } else {
            Err(RestoreError::Incomplete(failures.join("; ")))
        }
    })();
    drop((current_idx, target_idx));
    result
}

/// Drop a thread's snapshot ref, letting the chain be collected.
///
/// Idempotent: a ref that is already gone is success, because the caller's
/// intent — that nothing keeps this chain alive — is already satisfied.
pub(crate) fn drop_ref(repo: &Path, thread_id: &str) -> Result<(), String> {
    let name = snapshot_ref(thread_id);
    match run(repo, None, &["update-ref", "-d", &name]) {
        Ok(_) => Ok(()),
        // `update-ref -d` on a missing ref is not a failure worth surfacing.
        Err(_) => Ok(()),
    }
}

/// Restore the working tree to snapshot `target`, discarding changes made after
/// it. `latest` (the newest snapshot) is used only to find files added since
/// `target` so they can be removed. Files matching `.gitignore` are untouched.
///
/// This is the TUI's restore, over snapshots of reported paths only; a managed
/// Cowork tree uses [`restore_worktree`]. A file that could not be removed is
/// reported rather than skipped: it used to be dropped silently, and a name
/// with a space or a non-ASCII character was never removed at all, because it
/// was read back from git's quoted output.
#[cfg_attr(not(feature = "cli"), allow(dead_code))]
pub(crate) fn restore(repo: &Path, target: &str, latest: &str) -> Result<(), String> {
    crate::core::agent::vcs::refuse_filter_programs(repo)?;
    let idx = temp_index()?;
    let result = (|| {
        run(repo, Some(&idx), &["read-tree", target])?;
        run(repo, Some(&idx), &["checkout-index", "-a", "-f"])?;
        if target != latest {
            let mut failures = Vec::new();
            for added in tree_changes(repo, target, latest)?
                .into_iter()
                .filter(|c| c.status == 'A' && !c.is_gitlink())
            {
                if let Err(e) = remove_within(repo, &added.path) {
                    failures.push(format!("{}: {e}", added.path));
                }
            }
            if !failures.is_empty() {
                return Err(format!(
                    "the files were restored, but some added after the checkpoint could not \
                     be removed: {}",
                    failures.join("; ")
                ));
            }
        }
        Ok(())
    })();
    drop(idx);
    result
}

// ---------------------------------------------------------------------------
// Read-only working-tree inspection (Cowork "Changes" review panel).
//
// Everything below is strictly read-only: `status`, `diff`, `rev-parse`,
// `ls-files` and reading files off disk. Nothing here stages, unstages,
// commits, resets, checks out, or otherwise mutates the user's repository or
// index. Machine-readable git output (`--porcelain=v2 -z`, `--numstat -z`) is
// parsed rather than the localizable human-readable form. All git file
// arguments are passed after `--` so a path can never be read as a flag.
// ---------------------------------------------------------------------------

/// Which set of changes to report and diff against.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DiffScope {
    /// Unstaged changes (working tree vs. index), plus untracked files.
    Working,
    /// Staged changes only (index vs. `HEAD`).
    Staged,
    /// Everything not yet committed (working tree vs. `HEAD`), plus untracked.
    All,
}

impl DiffScope {
    /// Parse the wire value sent by the UI; unknown values fall back to the
    /// safe default of the plain working tree.
    pub fn parse(s: &str) -> Self {
        match s {
            "staged" => Self::Staged,
            "all" => Self::All,
            _ => Self::Working,
        }
    }
}

/// One changed file, as shown in a review row. `path` is always repo-relative
/// and, for renames/copies, is the new path; `orig_path` carries the old one.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitFileEntry {
    pub path: String,
    pub orig_path: Option<String>,
    /// One of: modified, added, deleted, renamed, copied, type_changed,
    /// untracked, unmerged.
    pub status: String,
    /// Has a staged component (index differs from `HEAD`).
    pub staged: bool,
    /// Has an unstaged component (working tree differs from index), or is
    /// untracked.
    pub unstaged: bool,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
}

/// The whole working-tree snapshot for one scope.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: Option<String>,
    pub repo_root: String,
    pub files: Vec<GitFileEntry>,
    pub additions: u32,
    pub deletions: u32,
}

/// The unified diff for a single file, loaded lazily when a row is expanded.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiff {
    /// A standard unified diff, or a short placeholder for binary files.
    pub diff: String,
    pub binary: bool,
    /// True when the diff exceeded the size cap and was cut short.
    pub truncated: bool,
}

/// True when `HEAD` resolves to a commit (i.e. the repo is not unborn).
fn head_born(root: &str) -> bool {
    git(&["-C", root, "rev-parse", "--verify", "-q", "HEAD"])
        .map(|s| !s.is_empty())
        .unwrap_or(false)
}

/// Parse `git diff --numstat -z` into `path -> (additions, deletions, binary)`,
/// keyed by the new path for renames/copies. Binary files report `-`/`-` and
/// are recorded with zero counts and `binary = true`.
fn parse_numstat(raw: &str) -> std::collections::HashMap<String, (u32, u32, bool)> {
    let mut map = std::collections::HashMap::new();
    let tokens: Vec<&str> = raw.split('\0').filter(|t| !t.is_empty()).collect();
    let mut i = 0;
    while i < tokens.len() {
        let field = tokens[i];
        // `add \t del \t path`; for -z renames the path is empty and the two
        // following NUL-separated tokens are the old and new paths.
        let mut parts = field.splitn(3, '\t');
        let add = parts.next().unwrap_or("");
        let del = parts.next().unwrap_or("");
        let inline_path = parts.next().unwrap_or("");
        let binary = add == "-" || del == "-";
        let additions = add.parse::<u32>().unwrap_or(0);
        let deletions = del.parse::<u32>().unwrap_or(0);
        let path = if inline_path.is_empty() {
            // Rename/copy: consume `<old>` and `<new>`; key on `<new>`.
            let new_path = tokens.get(i + 2).copied().unwrap_or("");
            i += 3;
            new_path.to_string()
        } else {
            i += 1;
            inline_path.to_string()
        };
        if !path.is_empty() {
            map.insert(path, (additions, deletions, binary));
        }
    }
    map
}

/// Map a porcelain-v2 status code character to a UI status string.
fn status_word(code: char) -> &'static str {
    match code {
        'M' => "modified",
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'T' => "type_changed",
        'U' => "unmerged",
        _ => "modified",
    }
}

/// A single parsed porcelain-v2 record we care about for review.
struct StatusRecord {
    path: String,
    orig_path: Option<String>,
    /// Index (staged) status char, `.` when unmodified.
    x: char,
    /// Worktree (unstaged) status char, `.` when unmodified.
    y: char,
    untracked: bool,
}

/// Parse `git status --porcelain=v2 --branch -z` into the branch name and the
/// changed-file records. Rename/copy ("2") records span two NUL tokens (new
/// path then old path); untracked ("?") and unmerged ("u") records are handled
/// too. Ignored ("!") records are skipped.
fn parse_status_v2(raw: &str) -> (Option<String>, Vec<StatusRecord>) {
    let mut branch = None;
    let mut records = Vec::new();
    let tokens: Vec<&str> = raw.split('\0').filter(|t| !t.is_empty()).collect();
    let mut i = 0;
    while i < tokens.len() {
        let tok = tokens[i];
        if let Some(rest) = tok.strip_prefix("# branch.head ") {
            branch = Some(rest.trim().to_string()).filter(|s| !s.is_empty() && s != "(detached)");
            i += 1;
        } else if tok.starts_with("# ") {
            i += 1;
        } else if let Some(rest) = tok.strip_prefix("1 ") {
            // Ordinary change: `<XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`.
            let mut f = rest.splitn(8, ' ');
            let xy = f.next().unwrap_or("..");
            let path = f.nth(6).unwrap_or("").to_string();
            let (x, y) = xy_chars(xy);
            if !path.is_empty() {
                records.push(StatusRecord {
                    path,
                    orig_path: None,
                    x,
                    y,
                    untracked: false,
                });
            }
            i += 1;
        } else if let Some(rest) = tok.strip_prefix("2 ") {
            // Rename/copy: same leading fields plus `<score> <newPath>`; the
            // old path is the next NUL token.
            let mut f = rest.splitn(9, ' ');
            let xy = f.next().unwrap_or("..");
            let new_path = f.nth(7).unwrap_or("").to_string();
            let orig = tokens.get(i + 1).copied().unwrap_or("").to_string();
            let (x, y) = xy_chars(xy);
            if !new_path.is_empty() {
                records.push(StatusRecord {
                    path: new_path,
                    orig_path: if orig.is_empty() { None } else { Some(orig) },
                    x,
                    y,
                    untracked: false,
                });
            }
            i += 2;
        } else if let Some(rest) = tok.strip_prefix("? ") {
            records.push(StatusRecord {
                path: rest.to_string(),
                orig_path: None,
                x: '.',
                y: 'A',
                untracked: true,
            });
            i += 1;
        } else if let Some(rest) = tok.strip_prefix("u ") {
            // Unmerged: `<xy> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`.
            let path = rest.rsplit(' ').next().unwrap_or("").to_string();
            if !path.is_empty() {
                records.push(StatusRecord {
                    path,
                    orig_path: None,
                    x: 'U',
                    y: 'U',
                    untracked: false,
                });
            }
            i += 1;
        } else {
            i += 1;
        }
    }
    (branch, records)
}

/// Split a two-char `XY` field into its index and worktree status chars.
fn xy_chars(xy: &str) -> (char, char) {
    let mut it = xy.chars();
    let x = it.next().unwrap_or('.');
    let y = it.next().unwrap_or('.');
    (x, y)
}

/// Cap for a file read when counting/synthesizing an untracked-file diff, so a
/// stray multi-GB file can never be slurped into memory.
const MAX_INLINE_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Whether a byte slice looks binary (contains a NUL in its leading window).
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|&b| b == 0)
}

/// A symlink's target as a display string, or `None` when `abs` is not a
/// symlink. Read without following, so an untracked symlink is shown by its
/// target text (git's own representation, mode 120000) rather than by
/// dereferencing to whatever it points at — a symlink to a file outside the
/// repository must never have that file's contents surfaced in the diff.
fn symlink_target(abs: &Path) -> Option<String> {
    let meta = std::fs::symlink_metadata(abs).ok()?;
    if !meta.file_type().is_symlink() {
        return None;
    }
    Some(std::fs::read_link(abs).ok()?.to_string_lossy().to_string())
}

/// Count additions in a freshly-added (untracked) file. A symlink counts as its
/// single target line, never the pointed-at file. Returns `None` when the path
/// cannot be stat'd; binary and oversized regular files report zero additions.
fn untracked_counts(root: &str, rel: &str) -> Option<(u32, bool)> {
    let abs = Path::new(root).join(rel);
    let meta = std::fs::symlink_metadata(&abs).ok()?;
    if meta.file_type().is_symlink() {
        // One line: the link target. Never dereferenced.
        return Some((1, false));
    }
    if !meta.is_file() {
        // Untracked directories/fifos/etc: nothing textual to count.
        return Some((0, false));
    }
    if meta.len() > MAX_INLINE_FILE_BYTES {
        return Some((0, false));
    }
    let bytes = std::fs::read(&abs).ok()?;
    if looks_binary(&bytes) {
        return Some((0, true));
    }
    let text = String::from_utf8_lossy(&bytes);
    let lines = if text.is_empty() {
        0
    } else {
        text.split('\n').count() - usize::from(text.ends_with('\n'))
    };
    Some((lines as u32, false))
}

/// Load the working-tree status for `project` under `scope`. Errors when
/// `project` is not inside a git work tree (or git is unavailable).
pub fn status(project: &Path, scope: DiffScope) -> Result<GitStatus, String> {
    let root = repo_root(project).ok_or_else(|| "not a git repository".to_string())?;
    crate::core::agent::vcs::refuse_program_config(&root).map_err(|e| e.message)?;
    let root_s = root.to_string_lossy().to_string();

    let raw = git(&[
        "-C",
        &root_s,
        "status",
        "--porcelain=v2",
        "--branch",
        "--untracked-files=all",
        "--renames",
        "-z",
    ])?;
    let (branch, records) = parse_status_v2(&raw);

    // Counts come from numstat for the same scope. `HEAD`-relative scopes fall
    // back to `--cached` on an unborn repo, where there is no `HEAD` to diff.
    let numstat_args: Vec<&str> = match scope {
        DiffScope::Staged => vec!["-C", &root_s, "diff", "--no-ext-diff", "--no-textconv", "--cached", "--numstat", "-z", "-M"],
        DiffScope::Working => vec!["-C", &root_s, "diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "-M"],
        DiffScope::All => {
            if head_born(&root_s) {
                vec!["-C", &root_s, "diff", "--no-ext-diff", "--no-textconv", "HEAD", "--numstat", "-z", "-M"]
            } else {
                vec!["-C", &root_s, "diff", "--no-ext-diff", "--no-textconv", "--cached", "--numstat", "-z", "-M"]
            }
        }
    };
    let counts = parse_numstat(&git(&numstat_args).unwrap_or_default());

    let mut files = Vec::new();
    let mut total_add = 0u32;
    let mut total_del = 0u32;
    for rec in records {
        let staged = rec.x != '.';
        let unstaged = rec.y != '.' || rec.untracked;
        // Scope filter: which side of the change this scope cares about.
        let include = match scope {
            DiffScope::Staged => staged,
            DiffScope::Working => unstaged,
            DiffScope::All => staged || unstaged,
        };
        if !include {
            continue;
        }
        // Pick the status char that matches what this scope shows.
        let code = match scope {
            DiffScope::Staged => rec.x,
            DiffScope::Working => rec.y,
            DiffScope::All => {
                if rec.x != '.' {
                    rec.x
                } else {
                    rec.y
                }
            }
        };
        let (additions, deletions, binary) = if rec.untracked {
            match untracked_counts(&root_s, &rec.path) {
                Some((add, bin)) => (add, 0, bin),
                None => (0, 0, false),
            }
        } else {
            counts.get(&rec.path).copied().unwrap_or((0, 0, false))
        };
        total_add = total_add.saturating_add(additions);
        total_del = total_del.saturating_add(deletions);
        files.push(GitFileEntry {
            path: rec.path,
            orig_path: rec.orig_path,
            status: if rec.untracked {
                "untracked".to_string()
            } else {
                status_word(code).to_string()
            },
            staged,
            unstaged,
            additions,
            deletions,
            binary,
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(GitStatus {
        branch,
        repo_root: root_s,
        files,
        additions: total_add,
        deletions: total_del,
    })
}

/// Reject a path that could escape the repository when joined to its root.
/// Status output is already repo-relative and safe, but the value round-trips
/// through the UI, so it is re-validated here.
fn safe_rel(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if p.is_absolute()
        || path.is_empty()
        || p.components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("invalid path".to_string());
    }
    Ok(())
}

/// Build a synthetic "new file" unified diff for an untracked text file, so it
/// renders like any other addition. Binary/oversized files get a placeholder.
fn untracked_diff(root: &str, rel: &str, max_bytes: usize) -> GitFileDiff {
    let abs = Path::new(root).join(rel);
    // A symlink is shown by its target text, never by dereferencing it — a link
    // pointing outside the repo must not surface that file's contents here.
    if let Some(target) = symlink_target(&abs) {
        let out = format!(
            "diff --git a/{rel} b/{rel}\nnew file mode 120000\n--- /dev/null\n+++ b/{rel}\n@@ -0,0 +1 @@\n+{target}\n\\ No newline at end of file\n"
        );
        return cap_diff(out, max_bytes, false);
    }
    let meta = std::fs::metadata(&abs).ok();
    if meta.as_ref().map(|m| m.len()).unwrap_or(0) > MAX_INLINE_FILE_BYTES {
        return GitFileDiff {
            diff: format!("diff --git a/{rel} b/{rel}\n(new file too large to display)"),
            binary: false,
            truncated: true,
        };
    }
    let Ok(bytes) = std::fs::read(&abs) else {
        return GitFileDiff {
            diff: String::new(),
            binary: false,
            truncated: false,
        };
    };
    if looks_binary(&bytes) {
        return GitFileDiff {
            diff: format!("diff --git a/{rel} b/{rel}\nBinary file (untracked) differs"),
            binary: true,
            truncated: false,
        };
    }
    let text = String::from_utf8_lossy(&bytes);
    let raw_lines: Vec<&str> = if text.is_empty() {
        Vec::new()
    } else {
        // Drop the trailing empty element from a final newline.
        let mut v: Vec<&str> = text.split('\n').collect();
        if text.ends_with('\n') {
            v.pop();
        }
        v
    };
    let count = raw_lines.len();
    let mut out = String::new();
    out.push_str(&format!("diff --git a/{rel} b/{rel}\n"));
    out.push_str("new file mode 100644\n");
    out.push_str("--- /dev/null\n");
    out.push_str(&format!("+++ b/{rel}\n"));
    out.push_str(&format!("@@ -0,0 +1,{count} @@\n"));
    for line in raw_lines {
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    if !text.ends_with('\n') && !text.is_empty() {
        out.push_str("\\ No newline at end of file\n");
    }
    cap_diff(out, max_bytes, true)
}

/// Truncate `diff` to `max_bytes` on a line boundary, flagging when cut.
fn cap_diff(diff: String, max_bytes: usize, binary: bool) -> GitFileDiff {
    if diff.len() <= max_bytes {
        return GitFileDiff {
            diff,
            binary,
            truncated: false,
        };
    }
    let cut = diff[..max_bytes]
        .rfind('\n')
        .map(|n| n + 1)
        .unwrap_or(max_bytes);
    let mut head = diff[..cut].to_string();
    head.push_str("\n… diff truncated (too large to display in full) …\n");
    GitFileDiff {
        diff: head,
        binary,
        truncated: true,
    }
}

/// The unified diff for a single file under `scope`, loaded on demand. Untracked
/// files (present in Working/All scopes) are synthesized as new-file diffs since
/// plain `git diff` never shows them.
pub fn file_diff(
    project: &Path,
    path: &str,
    scope: DiffScope,
    max_bytes: usize,
) -> Result<GitFileDiff, String> {
    safe_rel(path)?;
    let root = repo_root(project).ok_or_else(|| "not a git repository".to_string())?;
    crate::core::agent::vcs::refuse_program_config(&root).map_err(|e| e.message)?;
    let root_s = root.to_string_lossy().to_string();

    let args: Vec<&str> = match scope {
        DiffScope::Staged => vec![
            "-C",
            &root_s,
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--cached",
            "-M",
            "--no-color",
            "--",
            path,
        ],
        DiffScope::Working => vec!["-C", &root_s, "diff", "--no-ext-diff", "--no-textconv", "-M", "--no-color", "--", path],
        DiffScope::All => {
            if head_born(&root_s) {
                vec![
                    "-C",
                    &root_s,
                    "diff",
                    "--no-ext-diff",
                    "--no-textconv",
                    "HEAD",
                    "-M",
                    "--no-color",
                    "--",
                    path,
                ]
            } else {
                vec![
                    "-C",
                    &root_s,
                    "diff",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--cached",
                    "-M",
                    "--no-color",
                    "--",
                    path,
                ]
            }
        }
    };
    let diff = git(&args)?;

    // Empty diff on a scope that includes untracked files means the file is not
    // known to git yet: synthesize its addition.
    if diff.trim().is_empty() && scope != DiffScope::Staged {
        let tracked = git(&["-C", &root_s, "ls-files", "--error-unmatch", "--", path])
            .map(|s| !s.is_empty())
            .unwrap_or(false);
        // `symlink_metadata` (not `exists`) so a broken symlink still counts as
        // present and is rendered by its target rather than dereferenced.
        let present = Path::new(&root_s).join(path).symlink_metadata().is_ok();
        if !tracked && present {
            return Ok(untracked_diff(&root_s, path, max_bytes));
        }
    }

    let binary = diff.contains("Binary files ") || diff.contains("GIT binary patch");
    Ok(cap_diff(diff, max_bytes, binary))
}

/// Run a read-only `git -C <dir>` and return stdout exactly as written.
fn git_read_raw(dir: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(dir)
        .args(crate::core::agent::vcs::HARDENED)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0");
    jan_utils::system::hide_console_window(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("failed to launch git: {e}"))?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// A file as committed at HEAD, for the Code panel's change gutter. `path` is
/// relative to `project` (which may sit below the repository root). `None`
/// when the file is not in HEAD, the folder is not a repository, or the
/// committed bytes are binary or too large to diff in the editor.
pub fn head_file(project: &Path, path: &str) -> Result<Option<String>, String> {
    safe_rel(path)?;
    let Some(root) = repo_root(project) else {
        return Ok(None);
    };
    crate::core::agent::vcs::refuse_program_config(&root).map_err(|e| e.message)?;
    let spec = format!("HEAD:./{}", path.replace('\\', "/"));
    let Ok(bytes) = git_read_raw(project, &["show", "--no-textconv", &spec]) else {
        return Ok(None);
    };
    if bytes.len() as u64 > MAX_INLINE_FILE_BYTES || looks_binary(&bytes) {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

/// `git blame --porcelain` for one file, raw; parsed in the web app.
pub fn blame(project: &Path, path: &str) -> Result<Option<String>, String> {
    safe_rel(path)?;
    let Some(root) = repo_root(project) else {
        return Ok(None);
    };
    crate::core::agent::vcs::refuse_program_config(&root).map_err(|e| e.message)?;
    match git_read_raw(project, &["blame", "--porcelain", "--", path]) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        // Untracked or outside the repository: nothing to blame.
        Err(_) => Ok(None),
    }
}

/// The GitHub web URL of `origin`, when it is on GitHub.
pub fn github_web_url(project: &Path) -> Option<String> {
    let raw = git_read_raw(project, &["remote", "get-url", "origin"]).ok()?;
    parse_github_remote(String::from_utf8_lossy(&raw).trim())
}

/// `git@github.com:o/r.git` or `https://github.com/o/r(.git)` to
/// `https://github.com/o/r`; anything else is not GitHub.
pub fn parse_github_remote(remote: &str) -> Option<String> {
    let rest = remote
        .strip_prefix("git@github.com:")
        .or_else(|| remote.strip_prefix("https://github.com/"))
        .or_else(|| remote.strip_prefix("ssh://git@github.com/"))?;
    let rest = rest.trim_end_matches('/').trim_end_matches(".git");
    let mut parts = rest.split('/');
    let (owner, repo) = (parts.next()?, parts.next()?);
    let ok = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    (ok(owner) && ok(repo) && parts.next().is_none())
        .then(|| format!("https://github.com/{owner}/{repo}"))
}

/// The pull request a commit belongs to, through `gh`, when it is installed
/// and signed in. `None` for anything else: a missing `gh` is not an error.
pub fn pr_for_commit(project: &Path, sha: &str) -> Option<(u64, String)> {
    if sha.len() < 7 || sha.len() > 40 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let mut cmd = Command::new("gh");
    cmd.current_dir(project)
        .args(["pr", "list", "--search", sha, "--state", "all", "--json", "number,url", "--limit", "1"])
        .env("GH_PROMPT_DISABLED", "1");
    jan_utils::system::hide_console_window(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let list: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let first = list.as_array()?.first()?;
    let url = first.get("url")?.as_str()?;
    if !url.starts_with("https://github.com/") {
        return None;
    }
    Some((first.get("number")?.as_u64()?, url.to_string()))
}

/// Pure-parser tests for the review-panel plumbing. These need neither git nor
/// the `cli` feature, so they always run.
#[cfg(test)]
mod review_tests {
    use super::*;

    #[test]
    fn only_a_github_origin_gets_a_web_url() {
        for remote in [
            "git@github.com:Jozkah/flint.git",
            "https://github.com/Jozkah/flint",
            "https://github.com/Jozkah/flint.git/",
            "ssh://git@github.com/Jozkah/flint.git",
        ] {
            assert_eq!(
                parse_github_remote(remote).as_deref(),
                Some("https://github.com/Jozkah/flint"),
                "{remote}"
            );
        }
        for remote in [
            "https://gitlab.com/a/b",
            "https://github.com/a",
            "https://github.com/a/b/c",
            "https://github.com/a/b\"onclick",
        ] {
            assert_eq!(parse_github_remote(remote), None, "{remote}");
        }
    }

    #[test]
    fn numstat_parses_normal_and_binary() {
        // `10\t2\tsrc/a.rs\0-\t-\tlogo.png\0`
        let raw = "10\t2\tsrc/a.rs\0-\t-\tlogo.png\0";
        let map = parse_numstat(raw);
        assert_eq!(map.get("src/a.rs"), Some(&(10, 2, false)));
        assert_eq!(map.get("logo.png"), Some(&(0, 0, true)));
    }

    #[test]
    fn numstat_keys_rename_on_new_path() {
        // Rename in -z form: `add\tdel\t` then `<old>` then `<new>`.
        let raw = "3\t1\t\0old/name.rs\0new/name.rs\0";
        let map = parse_numstat(raw);
        assert_eq!(map.get("new/name.rs"), Some(&(3, 1, false)));
        assert!(!map.contains_key("old/name.rs"));
    }

    #[test]
    fn status_v2_reads_branch_and_ordinary_change() {
        let raw = "# branch.oid abc123\0# branch.head feature/x\x001 .M N... 100644 100644 100644 aaa bbb src/a.rs\0";
        let (branch, records) = parse_status_v2(raw);
        assert_eq!(branch.as_deref(), Some("feature/x"));
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].path, "src/a.rs");
        assert_eq!(records[0].x, '.');
        assert_eq!(records[0].y, 'M');
        assert!(!records[0].untracked);
    }

    #[test]
    fn status_v2_reads_rename_with_orig_path() {
        // A "2" record: XY, sub, three modes, two hashes, score, new path; the
        // old path is the following NUL token.
        let raw = "2 R. N... 100644 100644 100644 aaa bbb R100 new.rs\0old.rs\0";
        let (_branch, records) = parse_status_v2(raw);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].path, "new.rs");
        assert_eq!(records[0].orig_path.as_deref(), Some("old.rs"));
        assert_eq!(records[0].x, 'R');
    }

    #[test]
    fn status_v2_reads_untracked() {
        let raw = "? notes.txt\0";
        let (_branch, records) = parse_status_v2(raw);
        assert_eq!(records.len(), 1);
        assert!(records[0].untracked);
        assert_eq!(records[0].path, "notes.txt");
    }

    #[test]
    fn detached_head_reports_no_branch() {
        let raw = "# branch.head (detached)\0";
        let (branch, _records) = parse_status_v2(raw);
        assert!(branch.is_none());
    }

    #[test]
    fn safe_rel_rejects_traversal_and_absolute() {
        assert!(safe_rel("src/a.rs").is_ok());
        assert!(safe_rel("../etc/passwd").is_err());
        assert!(safe_rel("a/../../b").is_err());
        assert!(safe_rel("").is_err());
        #[cfg(unix)]
        assert!(safe_rel("/etc/passwd").is_err());
    }

    #[test]
    fn cap_diff_truncates_on_line_boundary() {
        let big = "line one\nline two\nline three\n".to_string();
        let out = cap_diff(big, 10, false);
        assert!(out.truncated);
        assert!(out.diff.starts_with("line one\n"));
        assert!(out.diff.contains("truncated"));
    }

    #[test]
    fn cap_diff_keeps_small_diffs_intact() {
        let small = "one\ntwo\n".to_string();
        let out = cap_diff(small.clone(), 1000, false);
        assert!(!out.truncated);
        assert_eq!(out.diff, small);
    }

    #[test]
    fn scope_parse_defaults_to_working() {
        assert_eq!(DiffScope::parse("staged"), DiffScope::Staged);
        assert_eq!(DiffScope::parse("all"), DiffScope::All);
        assert_eq!(DiffScope::parse("working"), DiffScope::Working);
        assert_eq!(DiffScope::parse("nonsense"), DiffScope::Working);
    }

    // An untracked symlink must be shown by its target text, never by
    // dereferencing to the pointed-at file — otherwise a link to a file outside
    // the attached repo would surface that file's contents in the panel.
    #[cfg(unix)]
    #[test]
    fn untracked_symlink_is_not_dereferenced() {
        use std::os::unix::fs::symlink;
        let dir = std::env::temp_dir().join(format!(
            "jan_symlink_review_{}_{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let secret = dir.join("secret.txt");
        std::fs::write(&secret, "TOP SECRET CONTENTS\n").unwrap();
        symlink(&secret, dir.join("link")).unwrap();
        let root = dir.to_string_lossy().to_string();

        let d = untracked_diff(&root, "link", 512 * 1024);
        assert!(!d.binary);
        assert!(d.diff.contains("mode 120000"), "rendered as a symlink");
        assert!(d.diff.contains("secret.txt"), "shows the target path");
        assert!(
            !d.diff.contains("TOP SECRET"),
            "must not dereference the symlink target"
        );

        assert_eq!(untracked_counts(&root, "link"), Some((1, false)));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
}

/// `HEAD`'s commit sha, or `None` on an unborn branch (or no git).
#[cfg(feature = "cli")]
pub(crate) fn head_sha(repo: &Path) -> Option<String> {
    run(repo, None, &["rev-parse", "HEAD"])
        .ok()
        .filter(|s| !s.is_empty())
}

/// Create a worktree at `path`, checking out a new branch `branch` starting at
/// `base` (any commit-ish). The parent directory is created first: `git
/// worktree add` requires the path's parent to exist but refuses the path
/// itself to.
#[cfg(feature = "cli")]
pub(crate) fn worktree_add(
    repo: &Path,
    path: &Path,
    branch: &str,
    base: &str,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    run(
        repo,
        None,
        &[
            "worktree",
            "add",
            "-b",
            branch,
            &path.to_string_lossy(),
            base,
        ],
    )
    .map(|_| ())
}

/// The worktree checkouts registered with `repo`, main worktree included.
///
/// Parsed from `--porcelain`, whose `worktree <path>` lines are the stable
/// machine-readable form; the human listing pads the path with the sha and
/// branch, which a path containing spaces makes ambiguous.
#[cfg(feature = "cli")]
pub(crate) fn worktree_paths(repo: &Path) -> Vec<PathBuf> {
    run(repo, None, &["worktree", "list", "--porcelain"])
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.strip_prefix("worktree "))
        .map(PathBuf::from)
        .collect()
}

/// Whether `path` is a checkout `repo` still knows about. Compared after
/// canonicalization, because git reports the resolved path and the caller's
/// copy came from a config file or a thread record.
#[cfg(feature = "cli")]
pub(crate) fn worktree_registered(repo: &Path, path: &Path) -> bool {
    let Ok(want) = path.canonicalize() else {
        return false;
    };
    worktree_paths(repo)
        .iter()
        .filter_map(|p| p.canonicalize().ok())
        .any(|p| p == want)
}

/// Forget worktree registrations whose directory the user has deleted. Without
/// this, `worktree add` refuses a path that a stale registration still claims.
#[cfg(feature = "cli")]
pub(crate) fn worktree_prune(repo: &Path) {
    let _ = run(repo, None, &["worktree", "prune"]);
}

/// Paths changed in a worktree relative to its own `HEAD`, staged, unstaged and
/// untracked alike (`status --porcelain`, whose status letters are stripped).
/// This is the "what has the agent done in there" summary, not a diff.
///
/// The status field is split off at its first space rather than by a fixed
/// width: `run` trims the output, so the leading space of an unstaged-only
/// line (` M a.txt`) is gone by the time this sees it and a fixed offset would
/// eat the first character of that one path.
#[cfg(feature = "cli")]
pub(crate) fn changed_paths(worktree: &Path) -> Vec<String> {
    run(worktree, None, &["status", "--porcelain"])
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.trim_start().split_once(' '))
        // A rename reads `R old -> new`; the new name is the path on disk, and
        // the old one no longer exists, so staging it would be a delete.
        .map(|(_, path)| match path.trim().split_once(" -> ") {
            Some((_, to)) => to.to_string(),
            None => path.trim().to_string(),
        })
        .filter(|s| !s.is_empty())
        .collect()
}

#[cfg(all(test, feature = "cli"))]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU32;
    use std::sync::atomic::Ordering;

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// Init a throwaway repo with one commit, or `None` if git is unavailable so
    /// the suite skips instead of failing on a box without git.
    fn init_repo() -> Option<PathBuf> {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!("jan_snap_test_{}_{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).ok()?;
        let r = root.to_string_lossy().to_string();
        git(&["-C", &r, "init", "-q"]).ok()?;
        std::fs::write(root.join(".gitignore"), "ignored/\n").ok()?;
        std::fs::write(root.join("a.txt"), "one\n").ok()?;
        run(&root, None, &["add", "-A"]).ok()?;
        // --no-gpg-sign: this is a throwaway test repo, so signing (which
        // needs the developer's own key/passphrase and would hang or fail on
        // a box without one configured) is irrelevant and must be off.
        run(
            &root,
            None,
            &["commit", "-q", "-m", "init", "--no-gpg-sign"],
        )
        .ok()?;
        repo_root(&root)
    }

    /// Two repositories, one thread id. Before the index was keyed by
    /// repository as well, the second snapshot staged against the first
    /// repository's tree.
    #[test]
    fn each_repository_gets_its_own_snapshot_index() {
        let Some(a) = init_repo() else { return };
        let Some(b) = init_repo() else { return };
        let thread_id = "shared-thread-id";
        cleanup_snapshot_index(thread_id);

        assert_ne!(
            snapshot_index(&a, thread_id),
            snapshot_index(&b, thread_id),
            "one index file served two repositories"
        );

        snapshot(&a, None, "a", thread_id, &[]).expect("snapshot a");
        snapshot(&b, None, "b", thread_id, &[]).expect("snapshot b");
        assert!(snapshot_index(&a, thread_id).exists());
        assert!(snapshot_index(&b, thread_id).exists());
        cleanup_snapshot_index(thread_id);
    }

    /// An index left behind by a previous session names objects this repository
    /// does not have. That must be recoverable: it is a cache, not a record.
    /// Before this the failure was permanent -- every later snapshot for the
    /// thread returned `fatal: <sha> is not a valid object`.
    #[test]
    fn a_poisoned_snapshot_index_is_rebuilt_rather_than_fatal() {
        let Some(root) = init_repo() else { return };
        let thread_id = "poisoned-thread";
        cleanup_snapshot_index(thread_id);

        snapshot(&root, None, "base", thread_id, &[]).expect("base snapshot");
        let idx = snapshot_index(&root, thread_id);
        assert!(idx.exists());

        // Replace it with an index from a different repository, whose objects
        // this one has never seen.
        let Some(other) = init_repo() else { return };
        let other_thread = "poisoned-thread-source";
        cleanup_snapshot_index(other_thread);
        std::fs::write(other.join("a.txt"), "different").unwrap();
        snapshot(&other, None, "other", other_thread, &[PathBuf::from("a.txt")])
            .expect("other snapshot");
        std::fs::copy(snapshot_index(&other, other_thread), &idx).unwrap();

        std::fs::write(root.join("a.txt"), "changed").unwrap();
        let sha = snapshot(&root, None, "after", thread_id, &[PathBuf::from("a.txt")])
            .expect("a stale index must not be fatal");
        assert!(!sha.is_empty());

        cleanup_snapshot_index(thread_id);
        cleanup_snapshot_index(other_thread);
    }

    /// `cleanup_snapshot_index` has no repository in hand, so it must clear the
    /// thread's indexes for every repository it touched.
    #[test]
    fn cleanup_clears_every_repository_for_the_thread() {
        let Some(a) = init_repo() else { return };
        let Some(b) = init_repo() else { return };
        let thread_id = "cleanup-thread";
        cleanup_snapshot_index(thread_id);

        snapshot(&a, None, "a", thread_id, &[]).expect("snapshot a");
        snapshot(&b, None, "b", thread_id, &[]).expect("snapshot b");

        cleanup_snapshot_index(thread_id);
        assert!(!snapshot_index(&a, thread_id).exists());
        assert!(!snapshot_index(&b, thread_id).exists());
    }

    /// R22: a checkpoint runs no filter program the repository's own config
    /// names, and a repository using git-lfs's own filter commands keeps
    /// checkpoints.
    #[test]
    fn a_checkpoint_runs_no_filter_program_the_repository_names() {
        let Some(root) = init_repo() else { return };
        let marker = root.join("filter-ran.txt");
        let marker_sh = marker.to_string_lossy().replace('\\', "/");
        std::fs::write(root.join(".gitattributes"), "*.txt filter=evil\n").unwrap();
        run(&root, None, &["config", "--local", "filter.evil.clean", &format!("sh -c 'echo ran > \"{marker_sh}\"; cat'")]).unwrap();
        run(&root, None, &["config", "--local", "filter.evil.smudge", &format!("sh -c 'echo ran > \"{marker_sh}\"; cat'")]).unwrap();
        std::fs::write(root.join("a.txt"), "changed\n").unwrap();
        let taken = snapshot(&root, None, "base", "r22-thread", &[PathBuf::from("a.txt")]);
        assert!(!marker.exists(), "a checkpoint ran the repository's filter program");
        assert!(taken.is_err(), "a repository naming a filter program was snapshotted: {taken:?}");
        assert!(taken.unwrap_err().contains("filter.evil"), "the refusal does not name the setting");
        cleanup_snapshot_index("r22-thread");

        // git-lfs's own filter commands are not refused.
        run(&root, None, &["config", "--local", "--unset", "filter.evil.clean"]).unwrap();
        run(&root, None, &["config", "--local", "--unset", "filter.evil.smudge"]).unwrap();
        std::fs::write(root.join(".gitattributes"), "*.bin filter=lfs\n").unwrap();
        run(&root, None, &["config", "--local", "filter.lfs.clean", "git-lfs clean -- %f"]).unwrap();
        run(&root, None, &["config", "--local", "filter.lfs.smudge", "git-lfs smudge -- %f"]).unwrap();
        run(&root, None, &["config", "--local", "filter.lfs.process", "git-lfs filter-process"]).unwrap();
        assert!(snapshot(&root, None, "base", "r22-lfs", &[PathBuf::from("a.txt")]).is_ok(), "a git-lfs repository lost its checkpoints");
        cleanup_snapshot_index("r22-lfs");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// R22 for managed worktrees: whole-tree checkpoint capture and restore
    /// refuse a repository whose config names a filter program, even when the
    /// attribute reaching it comes from `.git/info/attributes`, which the
    /// empty `GIT_ATTR_SOURCE` does not neutralize.
    #[test]
    fn a_managed_checkpoint_runs_no_filter_program_the_repository_names() {
        let Some(root) = init_repo() else { return };
        let base = snapshot_worktree(&root, None, "base").expect("clean repo snapshots");
        let marker = root.join("filter-ran.txt");
        let marker_sh = marker.to_string_lossy().replace('\\', "/");
        let info = root.join(".git").join("info");
        std::fs::create_dir_all(&info).unwrap();
        std::fs::write(info.join("attributes"), "*.txt filter=evil\n").unwrap();
        let cmd = format!("sh -c 'echo ran > \"{marker_sh}\"; cat'");
        run(&root, None, &["config", "--local", "filter.evil.clean", &cmd]).unwrap();
        run(&root, None, &["config", "--local", "filter.evil.smudge", &cmd]).unwrap();
        std::fs::write(root.join("a.txt"), "changed\n").unwrap();

        let taken = snapshot_worktree(&root, Some(&base), "turn");
        assert!(taken.as_ref().is_err_and(|e| e.contains("filter.evil")), "snapshot_worktree: {taken:?}");
        assert!(changed_since(&root, &base).is_err(), "changed_since staged through the filter");
        let restored = restore_worktree(&root, &base);
        assert!(matches!(restored, Err(RestoreError::Refused(ref e)) if e.contains("filter.evil")), "restore_worktree was not refused");
        assert!(!marker.exists(), "a managed checkpoint ran the repository's filter program");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A scratch index lives in its own fresh private directory, never at a
    /// guessable path in the shared temp directory, and is gone once dropped.
    #[test]
    fn a_scratch_index_is_private_and_unpredictable() {
        let a = temp_index().expect("scratch index");
        let b = temp_index().expect("scratch index");
        let dir = a.parent().unwrap().to_path_buf();
        assert_ne!(dir, b.parent().unwrap(), "two scratch indexes shared a directory");
        assert_ne!(dir, std::env::temp_dir(), "the index sits directly in the shared temp directory");
        assert!(!a.exists(), "the index file is left for git to create inside the private directory");
        let name = dir.file_name().unwrap().to_string_lossy().to_string();
        assert!(!name.contains(&std::process::id().to_string()), "the name is derived from the pid: {name}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700, "the scratch directory is not private");
        }
        drop(a);
        assert!(!dir.exists(), "the scratch directory outlived its index");
    }

    /// The fixed-path snapshot root is refused when it is not a private
    /// directory of this user -- here, a symbolic link planted ahead of time.
    #[cfg(unix)]
    #[test]
    fn a_planted_snapshot_root_is_refused() {
        let base = tempfile::tempdir().unwrap();
        let target = base.path().join("elsewhere");
        std::fs::create_dir(&target).unwrap();
        let root = base.path().join("jan-agent-snap-idx");
        std::os::unix::fs::symlink(&target, &root).unwrap();
        assert!(private_snapshot_root(&root).is_err(), "a symlinked root was accepted");
        let open = base.path().join("open");
        std::fs::create_dir(&open).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(private_snapshot_root(&open).is_err(), "a world-writable root was accepted");
        let fresh = base.path().join("fresh");
        private_snapshot_root(&fresh).expect("a fresh root is created private");
    }

    #[test]
    fn a_worktree_is_added_registered_and_reports_its_changes() {
        let Some(root) = init_repo() else { return };
        let wt = root.parent().unwrap().join(format!(
            "{}-wt",
            root.file_name().unwrap().to_string_lossy()
        ));
        let _ = std::fs::remove_dir_all(&wt);

        let head = head_sha(&root).expect("a repo with one commit has a HEAD");
        worktree_add(&root, &wt, "jan/agent/test1", &head).expect("worktree add");

        assert!(wt.join("a.txt").is_file(), "the tree was checked out");
        assert!(worktree_registered(&root, &wt));
        assert!(
            worktree_paths(&root).len() >= 2,
            "the main checkout and the new one"
        );
        assert_eq!(
            current_branch(&wt).as_deref(),
            Some("jan/agent/test1"),
            "the worktree is on its own branch"
        );
        // The main checkout is untouched by work done in the worktree.
        assert!(changed_paths(&wt).is_empty());
        std::fs::write(wt.join("a.txt"), "edited\n").unwrap();
        std::fs::write(wt.join("new.txt"), "added\n").unwrap();
        let mut changed = changed_paths(&wt);
        changed.sort();
        assert_eq!(changed, vec!["a.txt".to_string(), "new.txt".to_string()]);
        assert!(
            changed_paths(&root).is_empty(),
            "the user's checkout is clean"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "one\n"
        );

        // A worktree the user deleted is forgotten, so its path is reusable.
        std::fs::remove_dir_all(&wt).unwrap();
        worktree_prune(&root);
        assert!(!worktree_registered(&root, &wt));
    }

    /// A worktree can start from any commit, which is how a fork of a session
    /// picks up where that conversation left off instead of at `HEAD`.
    #[test]
    fn a_worktree_can_branch_from_a_snapshot_commit() {
        let Some(root) = init_repo() else { return };
        std::fs::write(root.join("a.txt"), "two\n").unwrap();
        let snap =
            snapshot(&root, None, "turn 1", "t1", &[PathBuf::from("a.txt")]).expect("snapshot");
        std::fs::write(root.join("a.txt"), "three\n").unwrap();

        let wt = root.parent().unwrap().join(format!(
            "{}-snapwt",
            root.file_name().unwrap().to_string_lossy()
        ));
        let _ = std::fs::remove_dir_all(&wt);
        worktree_add(&root, &wt, "jan/agent/test2", &snap).expect("worktree add at a snapshot");
        assert_eq!(
            std::fs::read_to_string(wt.join("a.txt")).unwrap(),
            "two\n",
            "the branch starts from the snapshot, not HEAD and not the live tree"
        );
        let _ = std::fs::remove_dir_all(&wt);
    }

    #[test]
    fn snapshot_restore_roundtrip() {
        let Some(root) = init_repo() else { return };

        let thread_id = "test-thread";
        let base = snapshot(&root, None, "base", thread_id, &[]).expect("base snapshot");

        // Mutate: edit a file, add a new one, and drop something into an ignored dir.
        std::fs::write(root.join("a.txt"), "two\n").unwrap();
        std::fs::write(root.join("b.txt"), "new\n").unwrap();
        std::fs::create_dir_all(root.join("ignored")).unwrap();
        std::fs::write(root.join("ignored/keep.txt"), "keep\n").unwrap();

        let changed = [PathBuf::from("a.txt"), PathBuf::from("b.txt")];
        let turn =
            snapshot(&root, Some(&base), "turn 1", thread_id, &changed).expect("turn snapshot");
        assert_ne!(turn, base);

        // Restore to base: a.txt reverts, b.txt (added) is removed, ignored file stays.
        restore(&root, &base, &turn).expect("restore");
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "one\n"
        );
        assert!(!root.join("b.txt").exists(), "added file must be removed");
        assert!(
            root.join("ignored/keep.txt").exists(),
            "gitignored file must be left alone"
        );
        cleanup_snapshot_index(thread_id);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn snapshot_is_invisible_to_user_state() {
        let Some(root) = init_repo() else { return };
        let thread_id = "test-thread-2";
        std::fs::write(root.join("a.txt"), "dirty\n").unwrap();
        let _ = snapshot(&root, None, "s", thread_id, &[]).expect("snapshot");
        // The user's index/branch are untouched: HEAD still the init commit and the
        // working change is still unstaged.
        let staged = run(&root, None, &["diff", "--cached", "--name-only"]).unwrap();
        assert!(staged.is_empty(), "snapshot must not stage anything");
        cleanup_snapshot_index(thread_id);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn base_snapshot_picks_up_preexisting_dirty_tracked_file() {
        let Some(root) = init_repo() else { return };
        let thread_id = "test-thread-dirty-base";

        // Dirty *before* the agent starts -- no tool call reported it, so the
        // base must still capture it via the tracked-only diff, not `changed`.
        std::fs::write(root.join("a.txt"), "dirty-at-start\n").unwrap();
        let base = snapshot(&root, None, "base", thread_id, &[]).expect("base snapshot");

        let head_tree = run(&root, None, &["rev-parse", "HEAD^{tree}"]).unwrap();
        let base_tree = run(&root, None, &["rev-parse", &format!("{base}^{{tree}}")]).unwrap();
        assert_ne!(
            base_tree, head_tree,
            "base tree must include the pre-existing dirty edit"
        );

        cleanup_snapshot_index(thread_id);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn base_snapshot_includes_dirty_tracked_file_that_became_ignored() {
        let Some(root) = init_repo() else { return };
        let thread_id = "test-thread-dirty-now-ignored";
        cleanup_snapshot_index(thread_id);

        // Generated files can be committed before their directory is added to
        // .gitignore. Git rejects a normal `add` for a dirty file under that
        // newly ignored directory, even though the file is already tracked.
        let generated = root.join("generated");
        std::fs::create_dir_all(&generated).unwrap();
        std::fs::write(generated.join("a.txt"), "committed\n").unwrap();
        run(&root, None, &["add", "-f", "--", "generated/a.txt"]).unwrap();
        run(
            &root,
            None,
            &["commit", "-q", "-m", "generated", "--no-gpg-sign"],
        )
        .unwrap();
        std::fs::write(root.join(".gitignore"), "ignored/\ngenerated/\n").unwrap();
        std::fs::write(generated.join("a.txt"), "dirty-and-now-ignored\n").unwrap();
        let base = snapshot(&root, None, "base", thread_id, &[]).expect("base snapshot");

        let base_contents =
            run(&root, None, &["show", &format!("{base}:generated/a.txt")]).unwrap();
        assert_eq!(base_contents, "dirty-and-now-ignored");

        cleanup_snapshot_index(thread_id);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn checkpoint_only_stages_reported_paths() {
        let Some(root) = init_repo() else { return };
        let thread_id = "test-thread-3";

        let base = snapshot(&root, None, "base", thread_id, &[]).expect("base snapshot");
        let idx = snapshot_index(&root, thread_id);
        assert!(idx.exists(), "base snapshot should persist its index");

        // Two files change on disk, but only one is reported as touched; the
        // checkpoint must reflect just that one.
        std::fs::write(root.join("a.txt"), "two\n").unwrap();
        std::fs::write(root.join("untouched.txt"), "not reported\n").unwrap();
        let changed = [PathBuf::from("a.txt")];
        let turn =
            snapshot(&root, Some(&base), "turn 1", thread_id, &changed).expect("turn snapshot");
        assert_ne!(turn, base);

        let listed = run(&root, None, &["ls-tree", "-r", "--name-only", &turn]).unwrap();
        assert!(listed.lines().any(|l| l == "a.txt"));
        assert!(
            !listed.lines().any(|l| l == "untouched.txt"),
            "unreported path must not be staged even though it changed on disk"
        );

        cleanup_snapshot_index(thread_id);
        assert!(!idx.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn repo_root_is_none_outside_git() {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("jan_nogit_{}_{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        if repo_root(&std::env::temp_dir()).is_none() {
            assert!(repo_root(&dir).is_none());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `current_branch` re-reads `HEAD` live rather than caching it, so a
    /// checkout made after the first call (e.g. by another process while the
    /// TUI is open) is picked up on the next call.
    #[test]
    fn current_branch_reflects_a_checkout_made_after_the_first_read() {
        let Some(root) = init_repo() else { return };
        let r = root.to_string_lossy().to_string();

        let first = current_branch(&root);
        assert!(first.is_some(), "a fresh init_repo commit has a branch");

        git(&["-C", &r, "checkout", "-q", "-b", "feature/other"]).expect("checkout");
        let second = current_branch(&root);
        assert_eq!(second.as_deref(), Some("feature/other"));
        assert_ne!(
            first, second,
            "the branch must change after an external checkout"
        );

        let _ = std::fs::remove_dir_all(&root);
    }
}

/// A repository's own config can name programs git runs while it reads:
/// `diff.external`, a `diff.<driver>.textconv`, or a `filter.<driver>.clean`
/// selected by `.gitattributes`. The review panel reads status and diffs of
/// whatever project is open, so none of those reads may run such a program.
#[cfg(test)]
mod program_config_tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn sh(repo: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .expect("git runs in these tests");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// A repository with a committed file, a staged change and an unstaged
    /// change to it, whose own config sets `key` to a command that leaves a
    /// marker file behind. Returns the repository and the marker path.
    fn planted(key: &str, tail: &str) -> (PathBuf, PathBuf) {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let base = std::env::temp_dir().join(format!("jan_gitcfg_{}_{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let marker = base.join("marker");
        sh(&repo, &["init", "-q", "-b", "main"]);
        sh(&repo, &["config", "user.email", "t@example.invalid"]);
        sh(&repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join(".gitattributes"), "*.txt diff=evil filter=evil\n").unwrap();
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        sh(&repo, &["add", "-A"]);
        sh(&repo, &["commit", "-qm", "first"]);
        std::fs::write(repo.join("a.txt"), "two\n").unwrap();
        sh(&repo, &["add", "a.txt"]);
        std::fs::write(repo.join("a.txt"), "three\n").unwrap();
        let m = marker.to_string_lossy().replace('\\', "/");
        sh(&repo, &["config", key, &format!(": > '{m}'; {tail}")]);
        (base, marker)
    }

    fn cases() -> [(&'static str, &'static str); 3] {
        [
            ("diff.external", "true"),
            ("diff.evil.textconv", "cat"),
            ("filter.evil.clean", "cat"),
        ]
    }

    #[test]
    fn status_runs_no_program_the_repository_names() {
        for (key, tail) in cases() {
            for scope in [DiffScope::Staged, DiffScope::Working, DiffScope::All] {
                let (base, marker) = planted(key, tail);
                let result = status(&base.join("repo"), scope);
                assert!(!marker.exists(), "status {scope:?} ran `{key}`");
                assert!(result.is_err(), "status {scope:?} must refuse a repo setting `{key}`");
                let _ = std::fs::remove_dir_all(&base);
            }
        }
    }

    #[test]
    fn file_diff_runs_no_program_the_repository_names() {
        for (key, tail) in cases() {
            for scope in [DiffScope::Staged, DiffScope::Working, DiffScope::All] {
                let (base, marker) = planted(key, tail);
                let result = file_diff(&base.join("repo"), "a.txt", scope, 1 << 20);
                assert!(!marker.exists(), "file_diff {scope:?} ran `{key}`");
                assert!(result.is_err(), "file_diff {scope:?} must refuse a repo setting `{key}`");
                let _ = std::fs::remove_dir_all(&base);
            }
        }
    }

    /// With `extensions.worktreeConfig` on, git also reads
    /// `.git/config.worktree`, which `git config --local` never lists. A
    /// filter planted there must be refused like one in `.git/config`.
    #[test]
    fn a_filter_in_worktree_config_is_refused_too() {
        let (base, marker) = planted("core.autocrlf", "false");
        let repo = base.join("repo");
        sh(&repo, &["config", "--unset", "core.autocrlf"]);
        sh(&repo, &["config", "extensions.worktreeConfig", "true"]);
        let m = marker.to_string_lossy().replace('\\', "/");
        sh(&repo, &["config", "--worktree", "filter.evil.clean", &format!(": > '{m}'; cat")]);
        for scope in [DiffScope::Staged, DiffScope::Working, DiffScope::All] {
            assert!(status(&repo, scope).is_err(), "status {scope:?} must refuse");
            assert!(file_diff(&repo, "a.txt", scope, 1 << 20).is_err(), "file_diff {scope:?} must refuse");
        }
        assert!(crate::core::agent::vcs::staged(&repo).is_err());
        assert!(crate::core::agent::vcs::divergence(&repo).is_err());
        assert!(!marker.exists(), "a read ran the worktree-config filter");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_ordinary_repository_still_reads() {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let repo = std::env::temp_dir().join(format!("jan_gitcfg_plain_{}_{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&repo);
        std::fs::create_dir_all(&repo).unwrap();
        sh(&repo, &["init", "-q", "-b", "main"]);
        sh(&repo, &["config", "user.email", "t@example.invalid"]);
        sh(&repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        sh(&repo, &["add", "-A"]);
        sh(&repo, &["commit", "-qm", "first"]);
        std::fs::write(repo.join("a.txt"), "two\n").unwrap();
        let st = status(&repo, DiffScope::All).expect("status reads");
        assert_eq!(st.files.len(), 1);
        let d = file_diff(&repo, "a.txt", DiffScope::Working, 1 << 20).expect("diff reads");
        assert!(d.diff.contains("+two"));
        let _ = std::fs::remove_dir_all(&repo);
    }
}
