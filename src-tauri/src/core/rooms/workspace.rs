//! Isolated workspaces for compare-room participants.
//!
//! When two or more participants of a compare room may edit, each works in its
//! own checkout so they cannot overwrite each other or the user's folder: a
//! detached git worktree of the folder's repository, or (when the folder is not
//! a git repository) a scratch copy made into a fresh private repository. Both
//! live only under `<rooms>/<roomId>/workspaces/<participantId>`; nothing here
//! creates a checkout anywhere else, and every path read back from the
//! workspace record is checked to sit inside that directory before use.
//!
//! The user's folder is touched in exactly one place, `apply`, which only the
//! user's own "Apply to my folder" action calls after previewing the patch.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use super::store::{validate_id, RoomError, RoomErrorCode};

const WORKSPACES_DIR: &str = "workspaces";
/// A non-git folder larger than this is not copied: isolation is reported
/// unavailable and the participant falls back to reading.
const COPY_MAX_FILES: usize = 5_000;
const COPY_MAX_BYTES: u64 = 200 * 1024 * 1024;
/// Directories never copied into a scratch workspace.
const COPY_SKIP: &[&str] = &[".git", "node_modules", "target", ".next", "dist", "build"];
/// Per-file excerpt kept for the transcript card, and how many files get one.
const EXCERPT_CHARS: usize = 4_000;
const EXCERPT_FILES: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceKind {
    Worktree,
    Copy,
}

/// What `ensure` hands back: where the participant works.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    /// The folder the participant's tools resolve against.
    pub path: String,
    pub kind: WorkspaceKind,
}

/// The record kept beside each workspace, read back for diff/reset/apply/remove.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRecord {
    kind: WorkspaceKind,
    /// The checkout root (worktree or copy) inside the room's workspaces dir.
    root: String,
    /// The folder the participant works in (root, or a subfolder of it).
    path: String,
    /// The user's folder the workspace was made from.
    source: String,
    /// Where an applied patch lands: the repository root, or the source folder.
    apply_root: String,
    /// The repository a worktree is registered with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    repo: Option<String>,
    /// The workspace's tree when the current turn started (`mark_turn`), so a
    /// turn's card can show that turn's change alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    turn_base: Option<String>,
}

/// What a change listing is measured against.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeScope {
    /// Since the last `mark_turn` (everything, when no turn was marked).
    Turn,
    /// Since the workspace was made.
    All,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChanges {
    pub files: Vec<FileChange>,
}

fn err(message: impl Into<String>) -> RoomError {
    RoomError::new(RoomErrorCode::Io, message)
}

/// Beyond the shared hardening: no transport may run (no `ext::` or other
/// remote helper), no pager, no external diff, no alternate-refs program, and
/// no submodule recursion.
const HARDENED_EXTRA: &[&str] = &[
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.quotepath=false",
    "-c",
    "protocol.allow=never",
    "-c",
    "core.pager=cat",
    "-c",
    "diff.external=",
    "-c",
    "core.alternateRefsCommand=",
    "-c",
    "submodule.recurse=false",
];

/// Drop every `GIT_*` variable named in `keys` from `cmd`'s environment.
fn scrub_git_env(cmd: &mut Command, keys: impl Iterator<Item = std::ffi::OsString>) {
    for key in keys {
        if key.to_string_lossy().to_ascii_uppercase().starts_with("GIT_") {
            cmd.env_remove(&key);
        }
    }
}

/// Flags for every `git diff`: no external diff driver, no textconv program.
const DIFF_SAFE: &[&str] = &["--no-ext-diff", "--no-textconv"];

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    git_input(dir, args, None)
}

fn git_input(dir: &Path, args: &[&str], stdin: Option<&[u8]>) -> Result<String, String> {
    use std::io::Write;
    use std::process::Stdio;
    let mut cmd = Command::new("git");
    // Nothing from the app's own environment steers git: GIT_DIR,
    // GIT_WORK_TREE, GIT_CONFIG_*, GIT_EXTERNAL_DIFF and the rest are dropped.
    scrub_git_env(&mut cmd, std::env::vars_os().map(|(k, _)| k));
    cmd.arg("-C")
        .arg(dir)
        .args(crate::core::agent::vcs::HARDENED)
        .args(HARDENED_EXTRA)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_AUTHOR_NAME", "Flint")
        .env("GIT_AUTHOR_EMAIL", "agent@jan.ai")
        .env("GIT_COMMITTER_NAME", "Flint")
        .env("GIT_COMMITTER_EMAIL", "agent@jan.ai")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    jan_utils::system::hide_console_window(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to launch git: {e}"))?;
    if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
        pipe.write_all(input).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
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

/// `<rooms>/<roomId>/workspaces`, for a room that exists.
fn workspaces_dir(rooms_root: &Path, room_id: &str) -> Result<PathBuf, RoomError> {
    validate_id(room_id)?;
    let room = rooms_root.join(room_id);
    if !room.is_dir() {
        return Err(RoomError::new(
            RoomErrorCode::NotFound,
            format!("room {room_id} not found"),
        ));
    }
    Ok(room.join(WORKSPACES_DIR))
}

/// Whether `path` is inside `dir` once both are resolved.
fn inside(dir: &Path, path: &Path) -> bool {
    match (dir.canonicalize(), path.canonicalize()) {
        (Ok(d), Ok(p)) => p.starts_with(&d) && p != d,
        _ => false,
    }
}

fn read_record(dir: &Path, participant_id: &str) -> Result<WorkspaceRecord, RoomError> {
    validate_id(participant_id)?;
    let raw = fs::read_to_string(dir.join(format!("{participant_id}.json"))).map_err(|_| {
        RoomError::new(
            RoomErrorCode::NotFound,
            format!("no workspace for participant {participant_id}"),
        )
    })?;
    let record: WorkspaceRecord =
        serde_json::from_str(&raw).map_err(|e| err(format!("workspace record: {e}")))?;
    // A record names paths; never act on one that points outside this room.
    if !inside(dir, Path::new(&record.root)) || !inside(dir, Path::new(&record.path)) {
        return Err(err("workspace record points outside the room"));
    }
    Ok(record)
}

fn write_record(
    dir: &Path,
    participant_id: &str,
    record: &WorkspaceRecord,
) -> Result<(), RoomError> {
    let json = serde_json::to_string_pretty(record).map_err(|e| err(e.to_string()))?;
    fs::write(dir.join(format!("{participant_id}.json")), json).map_err(|e| err(e.to_string()))
}

/// The workspace root, once git agrees it is the checkout it works on and its
/// config names no filter/diff/merge program. A participant can write inside
/// its copy (a scratch copy's `.git/config` included); `core.worktree`
/// pointed elsewhere, or a clean filter, must not turn the next stage, reset
/// or clean into a write or a program run outside it.
fn checked_root(record: &WorkspaceRecord) -> Result<PathBuf, RoomError> {
    let root = PathBuf::from(&record.root);
    crate::core::agent::vcs::refuse_filter_programs(&root).map_err(err)?;
    let top = git(&root, &["rev-parse", "--show-toplevel"]).map_err(err)?;
    let same = match (Path::new(top.trim()).canonicalize(), root.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    if !same {
        return Err(err("the workspace's git checkout points somewhere else"));
    }
    Ok(root)
}

/// Copy `from` into `to`, refusing past the size caps. Links are skipped.
fn copy_tree(from: &Path, to: &Path, files: &mut usize, bytes: &mut u64) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        let name = entry.file_name();
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            if COPY_SKIP.iter().any(|s| name == *s) {
                continue;
            }
            copy_tree(&entry.path(), &to.join(&name), files, bytes)?;
        } else if meta.is_file() {
            *files += 1;
            *bytes += meta.len();
            if *files > COPY_MAX_FILES || *bytes > COPY_MAX_BYTES {
                return Err("the folder is too large to copy for an isolated workspace".into());
            }
            fs::copy(entry.path(), to.join(&name)).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Bring the user's uncommitted state into a fresh worktree of `top`: tracked
/// changes (staged or not) as a patch, untracked files that are not ignored as
/// copies. When anything came over it is committed in the detached worktree,
/// so the workspace's base is what the user sees and the participant's diff,
/// reset and apply are all measured from there.
fn seed_from_working_tree(top: &Path, root: &Path) -> Result<(), String> {
    let mut diff_args = vec!["diff", "--binary"];
    diff_args.extend_from_slice(DIFF_SAFE);
    diff_args.push("HEAD");
    let diff = git(top, &diff_args)?;
    let mut seeded = false;
    if !diff.trim().is_empty() {
        git_input(
            root,
            &["apply", "--whitespace=nowarn", "-"],
            Some(diff.as_bytes()),
        )?;
        seeded = true;
    }
    let untracked = git(top, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    let (mut files, mut bytes) = (0usize, 0u64);
    for rel in untracked.split('\0').filter(|r| !r.is_empty()) {
        let rel_path = Path::new(rel);
        if rel_path.is_absolute()
            || rel_path
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            continue;
        }
        let from = top.join(rel_path);
        let Ok(meta) = fs::symlink_metadata(&from) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        files += 1;
        bytes += meta.len();
        if files > COPY_MAX_FILES || bytes > COPY_MAX_BYTES {
            return Err("too many untracked files to copy".into());
        }
        let to = root.join(rel_path);
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(&from, &to).map_err(|e| e.to_string())?;
        seeded = true;
    }
    if seeded {
        git(root, &["add", "-A"])?;
        git(
            root,
            &["commit", "-q", "--allow-empty", "-m", "workspace base"],
        )?;
    }
    Ok(())
}

/// The participant's workspace, made on first use. `trusted` is the folder's
/// trust status, checked by the caller: an untrusted folder gets none.
pub fn ensure(
    rooms_root: &Path,
    room_id: &str,
    participant_id: &str,
    folder: &Path,
    trusted: bool,
) -> Result<WorkspaceInfo, RoomError> {
    let dir = workspaces_dir(rooms_root, room_id)?;
    validate_id(participant_id)?;
    if !trusted {
        return Err(err("the folder is not trusted"));
    }
    if !folder.is_absolute() || !folder.is_dir() {
        return Err(err("the room's folder is not available"));
    }
    if let Ok(record) = read_record(&dir, participant_id) {
        if Path::new(&record.path).is_dir() {
            return Ok(WorkspaceInfo {
                path: record.path,
                kind: record.kind,
            });
        }
    }
    fs::create_dir_all(&dir).map_err(|e| err(e.to_string()))?;
    let root = dir.join(participant_id);
    if root.exists() {
        fs::remove_dir_all(&root).map_err(|e| err(e.to_string()))?;
    }

    let toplevel = git(folder, &["rev-parse", "--show-toplevel"])
        .ok()
        .map(|s| PathBuf::from(s.trim()))
        .filter(|p| p.is_dir());
    let head_born = toplevel
        .as_ref()
        .map(|t| git(t, &["rev-parse", "--verify", "HEAD"]).is_ok())
        .unwrap_or(false);

    let record = match toplevel.filter(|_| head_born) {
        Some(top) => {
            crate::core::agent::vcs::refuse_filter_programs(&top).map_err(err)?;
            let _ = git(&top, &["worktree", "prune"]);
            git(
                &top,
                &[
                    "worktree",
                    "add",
                    "--detach",
                    &root.to_string_lossy(),
                    "HEAD",
                ],
            )
            .map_err(|e| err(format!("git worktree: {e}")))?;
            if let Err(e) = seed_from_working_tree(&top, &root) {
                let _ = git(
                    &top,
                    &["worktree", "remove", "--force", &root.to_string_lossy()],
                );
                let _ = fs::remove_dir_all(&root);
                return Err(err(format!("copy your uncommitted changes: {e}")));
            }
            let canon_top = top.canonicalize().unwrap_or(top.clone());
            let canon_folder = folder.canonicalize().unwrap_or(folder.to_path_buf());
            let rel = canon_folder
                .strip_prefix(&canon_top)
                .map(Path::to_path_buf)
                .unwrap_or_default();
            let path = root.join(rel);
            WorkspaceRecord {
                kind: WorkspaceKind::Worktree,
                root: root.to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
                source: folder.to_string_lossy().into_owned(),
                apply_root: top.to_string_lossy().into_owned(),
                repo: Some(top.to_string_lossy().into_owned()),
                turn_base: None,
            }
        }
        None => {
            let (mut files, mut bytes) = (0usize, 0u64);
            if let Err(e) = copy_tree(folder, &root, &mut files, &mut bytes) {
                let _ = fs::remove_dir_all(&root);
                return Err(err(e));
            }
            let base = (|| -> Result<(), String> {
                git(&root, &["init", "-q"])?;
                git(&root, &["add", "-A"])?;
                git(
                    &root,
                    &["commit", "-q", "--allow-empty", "-m", "workspace base"],
                )?;
                Ok(())
            })();
            if let Err(e) = base {
                let _ = fs::remove_dir_all(&root);
                return Err(err(format!("scratch copy: {e}")));
            }
            WorkspaceRecord {
                kind: WorkspaceKind::Copy,
                root: root.to_string_lossy().into_owned(),
                path: root.to_string_lossy().into_owned(),
                source: folder.to_string_lossy().into_owned(),
                apply_root: folder.to_string_lossy().into_owned(),
                repo: None,
                turn_base: None,
            }
        }
    };
    write_record(&dir, participant_id, &record)?;
    Ok(WorkspaceInfo {
        path: record.path,
        kind: record.kind,
    })
}

/// Stage everything in the workspace (its own index) so new files count.
fn stage(root: &Path) -> Result<(), RoomError> {
    git(root, &["add", "-A"]).map(|_| ()).map_err(err)
}

/// What the participant changed against the workspace's base, with excerpts.
pub fn changes(
    rooms_root: &Path,
    room_id: &str,
    participant_id: &str,
    scope: ChangeScope,
) -> Result<WorkspaceChanges, RoomError> {
    let dir = workspaces_dir(rooms_root, room_id)?;
    let record = read_record(&dir, participant_id)?;
    let root = checked_root(&record)?;
    stage(&root)?;
    let base = match (scope, record.turn_base.as_deref()) {
        (ChangeScope::Turn, Some(tree)) if is_object_id(tree) => tree.to_string(),
        _ => "HEAD".to_string(),
    };
    let mut numstat_args = vec!["diff", "--cached", "--numstat"];
    numstat_args.extend_from_slice(DIFF_SAFE);
    numstat_args.push(&base);
    let numstat = git(&root, &numstat_args).map_err(err)?;
    let mut files = Vec::new();
    for line in numstat.lines() {
        let mut parts = line.splitn(3, '\t');
        let (Some(a), Some(d), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let binary = a == "-" || d == "-";
        files.push(FileChange {
            path: path.to_string(),
            additions: a.parse().unwrap_or(0),
            deletions: d.parse().unwrap_or(0),
            binary,
            excerpt: None,
        });
    }
    for f in files.iter_mut().take(EXCERPT_FILES).filter(|f| !f.binary) {
        let mut args = vec!["diff", "--cached"];
        args.extend_from_slice(DIFF_SAFE);
        args.extend_from_slice(&[&base, "--", &f.path]);
        if let Ok(diff) = git(&root, &args) {
            let mut text: String = diff.chars().take(EXCERPT_CHARS).collect();
            if diff.chars().count() > EXCERPT_CHARS {
                text.push_str("\n… (truncated)");
            }
            f.excerpt = Some(text);
        }
    }
    Ok(WorkspaceChanges { files })
}

fn is_object_id(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Remember the workspace as it is now as the current turn's starting point.
pub fn mark_turn(rooms_root: &Path, room_id: &str, participant_id: &str) -> Result<(), RoomError> {
    let dir = workspaces_dir(rooms_root, room_id)?;
    let mut record = read_record(&dir, participant_id)?;
    let root = checked_root(&record)?;
    stage(&root)?;
    let tree = git(&root, &["write-tree"]).map_err(err)?;
    let tree = tree.trim();
    if !is_object_id(tree) {
        return Err(err("git write-tree gave no tree"));
    }
    record.turn_base = Some(tree.to_string());
    write_record(&dir, participant_id, &record)
}

/// The whole change as one patch, for the preview before applying.
pub fn patch(rooms_root: &Path, room_id: &str, participant_id: &str) -> Result<String, RoomError> {
    let dir = workspaces_dir(rooms_root, room_id)?;
    let record = read_record(&dir, participant_id)?;
    let root = checked_root(&record)?;
    stage(&root)?;
    git(
        &root,
        &["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "HEAD"],
    )
    .map_err(err)
}

/// Throw away everything the participant changed in its workspace.
pub fn reset(rooms_root: &Path, room_id: &str, participant_id: &str) -> Result<(), RoomError> {
    let dir = workspaces_dir(rooms_root, room_id)?;
    let record = read_record(&dir, participant_id)?;
    let root = checked_root(&record)?;
    git(&root, &["reset", "-q", "--hard", "HEAD"]).map_err(err)?;
    git(&root, &["clean", "-q", "-fd"]).map_err(err)?;
    Ok(())
}

/// Apply the participant's patch to the user's folder. Only the user's own
/// "Apply to my folder" action calls this, after previewing `patch`. The patch
/// is checked first, so a conflict changes nothing.
pub fn apply(rooms_root: &Path, room_id: &str, participant_id: &str) -> Result<u32, RoomError> {
    let dir = workspaces_dir(rooms_root, room_id)?;
    let record = read_record(&dir, participant_id)?;
    let root = checked_root(&record)?;
    stage(&root)?;
    let diff = git(
        &root,
        &["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "HEAD"],
    )
    .map_err(err)?;
    if diff.trim().is_empty() {
        return Ok(0);
    }
    let target = PathBuf::from(&record.apply_root);
    if !target.is_dir() {
        return Err(err("your folder is no longer there"));
    }
    git_input(
        &target,
        &["apply", "--check", "--whitespace=nowarn", "-"],
        Some(diff.as_bytes()),
    )
    .map_err(|e| err(format!("the change does not apply cleanly: {e}")))?;
    git_input(
        &target,
        &["apply", "--whitespace=nowarn", "-"],
        Some(diff.as_bytes()),
    )
    .map_err(|e| err(format!("apply: {e}")))?;
    let count = diff
        .lines()
        .filter(|l| l.starts_with("diff --git "))
        .count();
    Ok(count as u32)
}

/// Remove every workspace of a room: unregister worktrees, then delete the
/// directory. Missing workspaces are not an error.
pub fn remove_all(rooms_root: &Path, room_id: &str) -> Result<(), RoomError> {
    validate_id(room_id)?;
    let dir = rooms_root.join(room_id).join(WORKSPACES_DIR);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(pid) = name.strip_suffix(".json") else {
            continue;
        };
        if let Ok(record) = read_record(&dir, pid) {
            if let (WorkspaceKind::Worktree, Some(repo)) = (record.kind, record.repo.as_ref()) {
                let _ = git(
                    Path::new(repo),
                    &["worktree", "remove", "--force", &record.root],
                );
                let _ = git(Path::new(repo), &["worktree", "prune"]);
            }
        }
    }
    match fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(err(format!("remove workspaces: {e}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(dir: &Path, args: &[&str]) {
        git(dir, args).unwrap_or_else(|e| panic!("git {args:?}: {e}"));
    }

    fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let rooms = tmp.path().join("rooms");
        fs::create_dir_all(rooms.join("room1")).unwrap();
        let folder = tmp.path().join("project");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("a.txt"), "one\n").unwrap();
        (tmp, rooms, folder)
    }

    #[test]
    fn untrusted_folder_gets_no_workspace() {
        let (_t, rooms, folder) = setup();
        assert!(ensure(&rooms, "room1", "p1", &folder, false).is_err());
        assert!(!rooms.join("room1").join(WORKSPACES_DIR).exists());
    }

    #[test]
    fn scratch_copy_isolates_and_reports_changes() {
        let (_t, rooms, folder) = setup();
        let a = ensure(&rooms, "room1", "p1", &folder, true).unwrap();
        let b = ensure(&rooms, "room1", "p2", &folder, true).unwrap();
        assert_eq!(a.kind, WorkspaceKind::Copy);
        assert_ne!(a.path, b.path);
        assert!(Path::new(&a.path).starts_with(rooms.join("room1").join(WORKSPACES_DIR)));
        fs::write(Path::new(&a.path).join("a.txt"), "one\ntwo\n").unwrap();
        fs::write(Path::new(&a.path).join("new.txt"), "x\n").unwrap();
        // The other participant and the user's folder are untouched.
        assert_eq!(
            fs::read_to_string(Path::new(&b.path).join("a.txt")).unwrap(),
            "one\n"
        );
        assert_eq!(fs::read_to_string(folder.join("a.txt")).unwrap(), "one\n");
        let c = changes(&rooms, "room1", "p1", ChangeScope::All).unwrap();
        assert_eq!(c.files.len(), 2);
        let f = c.files.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!((f.additions, f.deletions), (1, 0));
        assert!(f.excerpt.as_deref().unwrap().contains("+two"));
        assert!(changes(&rooms, "room1", "p2", ChangeScope::All)
            .unwrap()
            .files
            .is_empty());
    }

    #[test]
    fn reset_discards_and_apply_writes_only_on_request() {
        let (_t, rooms, folder) = setup();
        let a = ensure(&rooms, "room1", "p1", &folder, true).unwrap();
        fs::write(Path::new(&a.path).join("a.txt"), "changed\n").unwrap();
        assert!(patch(&rooms, "room1", "p1").unwrap().contains("+changed"));
        assert_eq!(fs::read_to_string(folder.join("a.txt")).unwrap(), "one\n");
        assert_eq!(apply(&rooms, "room1", "p1").unwrap(), 1);
        assert_eq!(
            fs::read_to_string(folder.join("a.txt")).unwrap(),
            "changed\n"
        );
        fs::write(Path::new(&a.path).join("b.txt"), "b\n").unwrap();
        reset(&rooms, "room1", "p1").unwrap();
        // Reset returns to the workspace base, not to the applied folder.
        assert_eq!(
            fs::read_to_string(Path::new(&a.path).join("a.txt")).unwrap(),
            "one\n"
        );
        assert!(!Path::new(&a.path).join("b.txt").exists());
    }

    #[test]
    fn git_folder_gets_a_detached_worktree_inside_the_room_and_is_removed() {
        let (_t, rooms, folder) = setup();
        sh(&folder, &["init", "-q"]);
        sh(&folder, &["add", "-A"]);
        sh(&folder, &["commit", "-q", "-m", "base"]);
        let a = ensure(&rooms, "room1", "p1", &folder, true).unwrap();
        assert_eq!(a.kind, WorkspaceKind::Worktree);
        assert!(Path::new(&a.path).join("a.txt").is_file());
        let listed = git(&folder, &["worktree", "list", "--porcelain"]).unwrap();
        assert!(
            listed
                .lines()
                .filter(|l| l.starts_with("worktree "))
                .count()
                == 2
        );
        remove_all(&rooms, "room1").unwrap();
        assert!(!rooms.join("room1").join(WORKSPACES_DIR).exists());
        let listed = git(&folder, &["worktree", "list", "--porcelain"]).unwrap();
        assert_eq!(
            listed
                .lines()
                .filter(|l| l.starts_with("worktree "))
                .count(),
            1
        );
    }

    #[test]
    fn record_pointing_outside_the_room_is_refused() {
        let (_t, rooms, folder) = setup();
        ensure(&rooms, "room1", "p1", &folder, true).unwrap();
        let rec = rooms.join("room1").join(WORKSPACES_DIR).join("p1.json");
        let mut r: WorkspaceRecord =
            serde_json::from_str(&fs::read_to_string(&rec).unwrap()).unwrap();
        r.root = folder.to_string_lossy().into_owned();
        fs::write(&rec, serde_json::to_string(&r).unwrap()).unwrap();
        assert!(reset(&rooms, "room1", "p1").is_err());
        assert_eq!(fs::read_to_string(folder.join("a.txt")).unwrap(), "one\n");
    }

    fn git_project(folder: &Path) {
        sh(folder, &["init", "-q"]);
        fs::write(folder.join(".gitignore"), "ignored.txt\n").unwrap();
        sh(folder, &["add", "-A"]);
        sh(folder, &["commit", "-q", "-m", "base"]);
    }

    #[test]
    fn worktree_starts_from_the_users_uncommitted_state() {
        let (_t, rooms, folder) = setup();
        git_project(&folder);
        // Dirty: a modified tracked file, a staged new file, an untracked
        // file, an ignored file.
        fs::write(folder.join("a.txt"), "one\nlocal\n").unwrap();
        fs::write(folder.join("staged.txt"), "s\n").unwrap();
        sh(&folder, &["add", "staged.txt"]);
        fs::create_dir_all(folder.join("sub")).unwrap();
        fs::write(folder.join("sub").join("new.txt"), "n\n").unwrap();
        fs::write(folder.join("ignored.txt"), "i\n").unwrap();
        let a = ensure(&rooms, "room1", "p1", &folder, true).unwrap();
        let ws = Path::new(&a.path);
        assert_eq!(fs::read_to_string(ws.join("a.txt")).unwrap(), "one\nlocal\n");
        assert_eq!(fs::read_to_string(ws.join("staged.txt")).unwrap(), "s\n");
        assert_eq!(fs::read_to_string(ws.join("sub").join("new.txt")).unwrap(), "n\n");
        assert!(!ws.join("ignored.txt").exists());
        // The seed is the base: nothing counts as the participant's change.
        assert!(changes(&rooms, "room1", "p1", ChangeScope::All)
            .unwrap()
            .files
            .is_empty());
        // The user's folder and branch are untouched.
        assert_eq!(fs::read_to_string(folder.join("a.txt")).unwrap(), "one\nlocal\n");
        assert!(!git(&folder, &["status", "--porcelain"]).unwrap().is_empty());
        // A participant edit applies onto the user's dirty folder.
        fs::write(ws.join("a.txt"), "one\nlocal\nmore\n").unwrap();
        assert_eq!(apply(&rooms, "room1", "p1").unwrap(), 1);
        assert_eq!(
            fs::read_to_string(folder.join("a.txt")).unwrap(),
            "one\nlocal\nmore\n"
        );
        remove_all(&rooms, "room1").unwrap();
    }

    #[test]
    fn turn_scope_shows_only_that_turns_change() {
        let (_t, rooms, folder) = setup();
        let a = ensure(&rooms, "room1", "p1", &folder, true).unwrap();
        let ws = Path::new(&a.path);
        mark_turn(&rooms, "room1", "p1").unwrap();
        fs::write(ws.join("first.txt"), "1\n").unwrap();
        let t1 = changes(&rooms, "room1", "p1", ChangeScope::Turn).unwrap();
        assert_eq!(t1.files.len(), 1);
        mark_turn(&rooms, "room1", "p1").unwrap();
        fs::write(ws.join("second.txt"), "2\n").unwrap();
        let t2 = changes(&rooms, "room1", "p1", ChangeScope::Turn).unwrap();
        assert_eq!(
            t2.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            vec!["second.txt"]
        );
        let all = changes(&rooms, "room1", "p1", ChangeScope::All).unwrap();
        assert_eq!(all.files.len(), 2);
        // The record round-trips the marker; older records without it load.
        let rec = rooms.join("room1").join(WORKSPACES_DIR).join("p1.json");
        let raw = fs::read_to_string(&rec).unwrap();
        assert!(raw.contains("turnBase"));
        let mut v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        v.as_object_mut().unwrap().remove("turnBase");
        fs::write(&rec, v.to_string()).unwrap();
        // Without a marker the turn view falls back to the whole change.
        assert_eq!(
            changes(&rooms, "room1", "p1", ChangeScope::Turn)
                .unwrap()
                .files
                .len(),
            2
        );
    }

    #[test]
    fn git_environment_variables_are_dropped() {
        let mut cmd = Command::new("git");
        scrub_git_env(
            &mut cmd,
            ["GIT_DIR", "git_work_tree", "GIT_EXTERNAL_DIFF", "PATH"]
                .into_iter()
                .map(std::ffi::OsString::from),
        );
        let removed: Vec<String> = cmd
            .get_envs()
            .filter(|(_, v)| v.is_none())
            .map(|(k, _)| k.to_string_lossy().to_ascii_uppercase())
            .collect();
        assert!(removed.contains(&"GIT_DIR".to_string()));
        assert!(removed.contains(&"GIT_WORK_TREE".to_string()));
        assert!(removed.contains(&"GIT_EXTERNAL_DIFF".to_string()));
        assert!(!removed.contains(&"PATH".to_string()));
    }

    #[test]
    fn workspace_config_naming_a_program_or_another_worktree_is_refused() {
        let (_t, rooms, folder) = setup();
        let a = ensure(&rooms, "room1", "p1", &folder, true).unwrap();
        let ws = PathBuf::from(&a.path);
        // A participant writes a clean filter into its copy's own config.
        let marker = folder.join("ran.txt");
        let cfg = ws.join(".git").join("config");
        let original = fs::read_to_string(&cfg).unwrap();
        fs::write(
            &cfg,
            format!(
                "{original}[filter \"x\"]\n\tclean = sh -c 'echo ran > {}'\n",
                marker.to_string_lossy().replace('\\', "/")
            ),
        )
        .unwrap();
        fs::write(ws.join(".gitattributes"), "* filter=x\n").unwrap();
        assert!(changes(&rooms, "room1", "p1", ChangeScope::All).is_err());
        assert!(reset(&rooms, "room1", "p1").is_err());
        assert!(!marker.exists());
        // core.worktree pointed at the user's folder: reset/clean refused.
        fs::write(
            &cfg,
            format!(
                "{original}[core]\n\tworktree = {}\n",
                folder.to_string_lossy().replace('\\', "/")
            ),
        )
        .unwrap();
        fs::write(folder.join("keep.txt"), "mine\n").unwrap();
        assert!(reset(&rooms, "room1", "p1").is_err());
        assert!(folder.join("keep.txt").exists());
        assert_eq!(fs::read_to_string(folder.join("a.txt")).unwrap(), "one\n");
    }

    #[test]
    fn bad_ids_are_refused() {
        let (_t, rooms, folder) = setup();
        assert!(ensure(&rooms, "room1", "../x", &folder, true).is_err());
        assert!(ensure(&rooms, "../room1", "p1", &folder, true).is_err());
    }
}
