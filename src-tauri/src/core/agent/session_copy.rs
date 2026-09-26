//! "Work on a copy": the managed-worktree idea for a folder that is not a Git
//! repository.
//!
//! A session copies the folder into a directory of its own under Flint's
//! worktrees folder (so the same grant code that confines a run to a managed
//! worktree confines it to the copy), works there, and then applies chosen
//! changes back. Several sessions can each work on their own copy of one folder
//! at the same time.
//!
//! What makes applying back safe is the manifest written at copy time: the
//! SHA-256 of every file that was copied. A file the session changed is a
//! *conflict* when the original has also changed since the copy (or appeared,
//! or vanished), and a conflict is applied only when the caller says so after
//! showing it. Nothing is written back without being asked for by path.

use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Directory names never copied: dependency caches, build output, virtual
/// environments and version-control metadata. Regenerable, usually large, and
/// not the session's to change.
pub const EXCLUDED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    ".venv",
    "venv",
    "dist",
    "build",
    ".git",
    ".hg",
    ".svn",
    "__pycache__",
    ".next",
    ".turbo",
    ".cache",
];

/// Where copies live, inside Flint's worktrees folder.
pub fn copies_dir(worktrees_root: &Path) -> PathBuf {
    worktrees_root.join("copies")
}

/// A session's copy of a folder.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CopyRecord {
    /// The copy the session works in.
    pub path: String,
    /// The folder it was copied from, and where changes are applied back.
    pub source_root: String,
    /// When the copy was made, milliseconds since the epoch.
    pub created_at: u64,
    /// How many files were copied.
    pub file_count: usize,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct Manifest {
    record: Option<CopyRecord>,
    /// Relative path (forward slashes) to the SHA-256 of the file as copied.
    files: BTreeMap<String, String>,
}

/// One file that differs between a copy and what it was copied from.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CopyChange {
    /// Relative path, forward slashes.
    pub path: String,
    /// `added`, `modified` or `deleted`, as the session left it.
    pub kind: &'static str,
    /// The original changed too since the copy was made.
    pub conflict: bool,
}

/// What applying back did.
#[derive(serde::Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutcome {
    pub applied: Vec<String>,
    /// Asked for, but in conflict and not forced: left untouched.
    pub skipped_conflicts: Vec<String>,
}

/// The two sides of one file, for a diff review. `None` for a side where the
/// file does not exist; binary or very large files are reported as such.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilePair {
    pub original: Option<String>,
    pub copy: Option<String>,
    pub binary: bool,
}

fn short_id(session_id: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in session_id.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}")[..10].to_string()
}

fn manifest_path(copy: &Path) -> PathBuf {
    let name = copy
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    copy.with_file_name(format!("{name}.manifest.json"))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension(format!(
        "{}flint-tmp",
        path.extension()
            .map(|e| format!("{}.", e.to_string_lossy()))
            .unwrap_or_default()
    ));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

fn hash_file(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    Some(format!("{:x}", Sha256::digest(&bytes)))
}

/// Every regular file under `root`, relative with forward slashes, skipping
/// [`EXCLUDED_DIRS`] and never following links.
fn walk(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !EXCLUDED_DIRS.contains(&name.as_str()) {
                    stack.push(path);
                }
            } else if kind.is_file() {
                if let Ok(rel) = path.strip_prefix(root) {
                    out.push(rel.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }
    out.sort();
    out
}

/// A relative path from IPC that stays inside its root.
fn checked_rel(rel: &str) -> Result<PathBuf, String> {
    let p = Path::new(rel);
    if rel.is_empty()
        || p.is_absolute()
        || p.components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err(format!("{rel} is not a path inside the folder"));
    }
    Ok(p.to_path_buf())
}

fn read_manifest(copy: &Path) -> Result<Manifest, String> {
    let text = std::fs::read_to_string(manifest_path(copy))
        .map_err(|_| format!("{} has no record of what was copied", copy.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("the copy's record is unreadable: {e}"))
}

fn write_manifest(copy: &Path, manifest: &Manifest) -> Result<(), String> {
    let text = serde_json::to_string(manifest).map_err(|e| e.to_string())?;
    write_atomic(&manifest_path(copy), text.as_bytes())
}

/// Copy `source` for `session_id`, or return the copy it already has.
pub fn create(
    source: &Path,
    worktrees_root: &Path,
    session_id: &str,
) -> Result<CopyRecord, String> {
    let source = source
        .canonicalize()
        .map_err(|e| format!("{} cannot be read: {e}", source.display()))?;
    if !source.is_dir() {
        return Err(format!("{} is not a folder", source.display()));
    }
    let root = copies_dir(worktrees_root);
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("could not create {}: {e}", root.display()))?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    if root.starts_with(&source) {
        return Err("Flint's data folder is inside this folder, so it cannot be copied".into());
    }
    let copy = root.join(short_id(session_id));
    if copy.exists() {
        let manifest = read_manifest(&copy)?;
        return manifest
            .record
            .filter(|r| Path::new(&r.source_root) == source)
            .ok_or_else(|| format!("{} is another folder's copy", copy.display()));
    }
    let staging = root.join(format!("{}.partial", short_id(session_id)));
    let _ = std::fs::remove_dir_all(&staging);
    let mut files = BTreeMap::new();
    for rel in walk(&source) {
        let from = source.join(&rel);
        let to = staging.join(&rel);
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::copy(&from, &to).map_err(|e| format!("could not copy {rel}: {e}"))?;
        if let Some(h) = hash_file(&to) {
            files.insert(rel, h);
        }
    }
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    std::fs::rename(&staging, &copy).map_err(|e| format!("could not finish the copy: {e}"))?;
    let record = CopyRecord {
        path: copy.to_string_lossy().to_string(),
        source_root: source.to_string_lossy().to_string(),
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        file_count: files.len(),
    };
    write_manifest(
        &copy,
        &Manifest {
            record: Some(record.clone()),
            files,
        },
    )?;
    Ok(record)
}

/// The copy's record, re-read from disk, when `path` is one of Flint's copies.
pub fn load(path: &Path, worktrees_root: &Path) -> Result<CopyRecord, String> {
    let root = copies_dir(worktrees_root)
        .canonicalize()
        .map_err(|_| "there are no copies".to_string())?;
    let copy = path
        .canonicalize()
        .map_err(|_| format!("{} does not exist", path.display()))?;
    if copy.parent() != Some(root.as_path()) {
        return Err(format!("{} is not a copy Flint made", path.display()));
    }
    read_manifest(&copy)?
        .record
        .ok_or_else(|| "the copy's record is incomplete".to_string())
}

/// What differs between the copy and the original, with conflicts marked.
pub fn changes(record: &CopyRecord) -> Result<Vec<CopyChange>, String> {
    let copy = Path::new(&record.path);
    let source = Path::new(&record.source_root);
    let manifest = read_manifest(copy)?;
    let mut paths: std::collections::BTreeSet<String> = walk(copy).into_iter().collect();
    paths.extend(manifest.files.keys().cloned());
    let mut out = Vec::new();
    for rel in paths {
        let copied = manifest.files.get(&rel);
        let now_copy = hash_file(&copy.join(&rel));
        if now_copy.as_ref() == copied {
            continue;
        }
        let kind = match (copied, &now_copy) {
            (None, Some(_)) => "added",
            (Some(_), None) => "deleted",
            _ => "modified",
        };
        let now_original = hash_file(&source.join(&rel));
        // The original moved away from what was copied -- unless it moved to
        // exactly what the session wants, which is no conflict at all.
        let conflict = now_original.as_ref() != copied && now_original != now_copy;
        out.push(CopyChange {
            path: rel,
            kind,
            conflict,
        });
    }
    Ok(out)
}

/// Both sides of one changed file.
pub fn file_pair(record: &CopyRecord, rel: &str) -> Result<FilePair, String> {
    let rel = checked_rel(rel)?;
    const LIMIT: u64 = 1_000_000;
    let read = |p: PathBuf| -> (Option<String>, bool) {
        match std::fs::metadata(&p) {
            Ok(m) if m.len() > LIMIT => (None, true),
            Ok(_) => match std::fs::read(&p) {
                Ok(bytes) => match String::from_utf8(bytes) {
                    Ok(text) => (Some(text), false),
                    Err(_) => (None, true),
                },
                Err(_) => (None, false),
            },
            Err(_) => (None, false),
        }
    };
    let (original, b1) = read(Path::new(&record.source_root).join(&rel));
    let (copy, b2) = read(Path::new(&record.path).join(&rel));
    Ok(FilePair {
        original,
        copy,
        binary: b1 || b2,
    })
}

/// Apply the chosen files from the copy to the original.
///
/// A file in conflict is skipped unless `force`. What was applied is recorded
/// as the new baseline, so applying again finds nothing left to do and a later
/// change in the original is again noticed.
pub fn apply(record: &CopyRecord, paths: &[String], force: bool) -> Result<ApplyOutcome, String> {
    let copy = Path::new(&record.path);
    let source = Path::new(&record.source_root);
    let current: BTreeMap<String, CopyChange> = changes(record)?
        .into_iter()
        .map(|c| (c.path.clone(), c))
        .collect();
    let mut manifest = read_manifest(copy)?;
    let mut outcome = ApplyOutcome::default();
    for rel in paths {
        let checked = checked_rel(rel)?;
        let Some(change) = current.get(rel) else {
            continue;
        };
        if change.conflict && !force {
            outcome.skipped_conflicts.push(rel.clone());
            continue;
        }
        let target = source.join(&checked);
        if change.kind == "deleted" {
            match std::fs::remove_file(&target) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("could not delete {rel}: {e}")),
            }
            manifest.files.remove(rel);
        } else {
            let bytes = std::fs::read(copy.join(&checked))
                .map_err(|e| format!("could not read {rel} from the copy: {e}"))?;
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            write_atomic(&target, &bytes).map_err(|e| format!("could not write {rel}: {e}"))?;
            manifest
                .files
                .insert(rel.clone(), format!("{:x}", Sha256::digest(&bytes)));
        }
        outcome.applied.push(rel.clone());
    }
    write_manifest(copy, &manifest)?;
    Ok(outcome)
}

/// Remove a copy. Refuses while it holds changes not applied back, unless
/// `force` (the caller has shown them).
pub fn discard(record: &CopyRecord, force: bool) -> Result<(), String> {
    let copy = Path::new(&record.path);
    if !force {
        let left = changes(record)?;
        if !left.is_empty() {
            return Err(format!(
                "the copy has {} change(s) not applied back: {}",
                left.len(),
                left.iter()
                    .map(|c| c.path.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
    }
    std::fs::remove_dir_all(copy).map_err(|e| format!("could not remove the copy: {e}"))?;
    let _ = std::fs::remove_file(manifest_path(copy));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct F {
        _dir: tempfile::TempDir,
        src: PathBuf,
        roots: PathBuf,
    }

    fn fixture() -> F {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("proj");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::create_dir_all(src.join("node_modules/x")).unwrap();
        std::fs::write(src.join("a.txt"), "a").unwrap();
        std::fs::write(src.join("sub/b.txt"), "b").unwrap();
        std::fs::write(src.join("node_modules/x/big.js"), "junk").unwrap();
        let roots = dir.path().join("data/wt");
        F {
            _dir: dir,
            src,
            roots,
        }
    }

    #[test]
    fn copies_the_folder_without_its_caches() {
        let f = fixture();
        let r = create(&f.src, &f.roots, "s1").unwrap();
        let copy = PathBuf::from(&r.path);
        assert!(copy.join("a.txt").exists() && copy.join("sub/b.txt").exists());
        assert!(!copy.join("node_modules").exists());
        assert_eq!(r.file_count, 2);
        assert!(changes(&r).unwrap().is_empty());
        // Idempotent, and another session gets its own copy.
        assert_eq!(create(&f.src, &f.roots, "s1").unwrap().path, r.path);
        assert_ne!(create(&f.src, &f.roots, "s2").unwrap().path, r.path);
        assert_eq!(load(&copy, &f.roots).unwrap(), r);
    }

    #[test]
    fn applies_chosen_changes_back_and_skips_conflicts_unless_forced() {
        let f = fixture();
        let r = create(&f.src, &f.roots, "s1").unwrap();
        let copy = PathBuf::from(&r.path);
        std::fs::write(copy.join("a.txt"), "session a").unwrap();
        std::fs::write(copy.join("sub/b.txt"), "session b").unwrap();
        std::fs::write(copy.join("new.txt"), "new").unwrap();
        // The user edits b.txt in the original meanwhile.
        std::fs::write(f.src.join("sub/b.txt"), "user b").unwrap();

        let found = changes(&r).unwrap();
        let by: BTreeMap<_, _> = found.iter().map(|c| (c.path.as_str(), c)).collect();
        assert_eq!(by["a.txt"].kind, "modified");
        assert!(!by["a.txt"].conflict);
        assert!(by["sub/b.txt"].conflict);
        assert_eq!(by["new.txt"].kind, "added");

        let all: Vec<String> = found.iter().map(|c| c.path.clone()).collect();
        let out = apply(&r, &all, false).unwrap();
        assert_eq!(out.skipped_conflicts, vec!["sub/b.txt".to_string()]);
        assert_eq!(
            std::fs::read_to_string(f.src.join("a.txt")).unwrap(),
            "session a"
        );
        assert_eq!(
            std::fs::read_to_string(f.src.join("new.txt")).unwrap(),
            "new"
        );
        assert_eq!(
            std::fs::read_to_string(f.src.join("sub/b.txt")).unwrap(),
            "user b"
        );

        // Only the conflict is left, and forcing it applies it.
        let left = changes(&r).unwrap();
        assert_eq!(left.len(), 1);
        assert!(discard(&r, false).is_err());
        apply(&r, &["sub/b.txt".to_string()], true).unwrap();
        assert_eq!(
            std::fs::read_to_string(f.src.join("sub/b.txt")).unwrap(),
            "session b"
        );
        assert!(changes(&r).unwrap().is_empty());
        discard(&r, false).unwrap();
        assert!(!copy.exists());
    }

    #[test]
    fn a_deletion_is_applied_back() {
        let f = fixture();
        let r = create(&f.src, &f.roots, "s1").unwrap();
        std::fs::remove_file(PathBuf::from(&r.path).join("a.txt")).unwrap();
        let out = apply(&r, &["a.txt".to_string()], false).unwrap();
        assert_eq!(out.applied, vec!["a.txt".to_string()]);
        assert!(!f.src.join("a.txt").exists());
    }

    #[test]
    fn refuses_paths_that_climb_out() {
        let f = fixture();
        let r = create(&f.src, &f.roots, "s1").unwrap();
        assert!(apply(&r, &["../x".to_string()], true).is_err());
        assert!(file_pair(&r, "../../etc/passwd").is_err());
        assert!(load(&f.src, &f.roots).is_err());
    }
}
