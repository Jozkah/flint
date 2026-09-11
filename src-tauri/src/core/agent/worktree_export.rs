//! An agent's worktree as a patch bundle someone can review elsewhere. AH-168.
//!
//! A bundle is a directory under `<data>/exports/`:
//!
//! * `changes.patch` -- every text change since the worktree's base commit,
//!   committed or not, as one unified diff `git apply` reads;
//! * `files/<path>` -- the new content of any file a text diff cannot carry;
//! * `manifest.json` -- where it came from (repository, branch, base, head),
//!   each file with its change, counts and review flags, and the SHA-256 of
//!   the patch and of each shipped file, so a reader can check nothing was
//!   altered on the way.
//!
//! The changes are read the way a proposal reads them
//! (`proposals::changes_in_worktree`): links out of the worktree refuse the
//! whole export, and Git's and Jan's own state are never included. Nothing in
//! the worktree or the user's checkout is written.
//!
//! The bundle is assembled under a `.partial` name and renamed into place
//! only once it is complete. A failure removes the partial directory, and a
//! partial directory left by a process that stopped part-way is swept by the
//! next export.

use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri_plugin_agent_tools::patch_export::unified_patch;
use tauri_plugin_agent_tools::proposal::{summarize, Change};
use tauri_plugin_agent_tools::review_flags::{flags_for, ReviewFlag};

use crate::core::agent::proposals::{changes_in_worktree, ChangesError};
use crate::core::agent::worktree::{self, WorktreeRecord, WorktreeState};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ExportErrorKind {
    /// The worktree is not under the folder Jan manages.
    NotManaged,
    /// The worktree is missing, corrupt, off its branch or its repository
    /// changed.
    NotReady,
    /// A changed path passes through a link.
    LinkEscape,
    NoChanges,
    Io,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportError {
    pub kind: ExportErrorKind,
    pub message: String,
}

impl ExportError {
    fn new(kind: ExportErrorKind, message: impl Into<String>) -> Self {
        ExportError {
            kind,
            message: message.into(),
        }
    }

    pub fn io_error(message: impl std::fmt::Display) -> Self {
        ExportError::new(ExportErrorKind::Io, message.to_string())
    }
}

fn io(e: impl std::fmt::Display) -> ExportError {
    ExportError::new(ExportErrorKind::Io, e.to_string())
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportedFile {
    pub path: String,
    pub change: Change,
    pub additions: usize,
    pub deletions: usize,
    /// Shipped whole under `files/` rather than in the patch.
    pub whole: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub flags: Vec<ReviewFlag>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema_version: u32,
    pub created_at: String,
    pub repository: String,
    pub branch: String,
    pub base_sha: String,
    pub head_sha: String,
    pub patch_sha256: String,
    pub files: Vec<ExportedFile>,
    /// How to apply it, for whoever receives it.
    pub apply_with: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub path: String,
    pub manifest: Manifest,
}

pub fn exports_dir(data_folder: &Path) -> PathBuf {
    data_folder.join("exports")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

fn head_of(record: &WorktreeRecord) -> String {
    std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&record.path)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// Remove bundles a stopped process left half-made.
fn sweep_partials(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        if e.file_name().to_string_lossy().ends_with(".partial") {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// Where a bundle's file goes, refusing any path that would leave it.
fn inside(root: &Path, rel: &str) -> Result<PathBuf, ExportError> {
    let mut out = root.to_path_buf();
    for part in rel.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.contains(':') || part.contains('\\') {
            return Err(ExportError::new(
                ExportErrorKind::Io,
                format!("{rel} cannot be written inside the bundle"),
            ));
        }
        out.push(part);
    }
    Ok(out)
}

/// Export a worktree. `step` runs after each piece is written; tests use it to
/// stop part-way.
pub fn export(
    data_folder: &Path,
    roots: &Path,
    record: &WorktreeRecord,
    step: &mut dyn FnMut(&str) -> Result<(), String>,
) -> Result<ExportReport, ExportError> {
    let managed = match (Path::new(&record.path).canonicalize(), roots.canonicalize()) {
        (Ok(p), Ok(r)) => p.starts_with(&r) && p != r,
        _ => false,
    };
    if !managed {
        return Err(ExportError::new(
            ExportErrorKind::NotManaged,
            format!("{} is not a worktree Jan manages", record.path),
        ));
    }
    let state = worktree::state(record);
    if state != WorktreeState::Ready {
        return Err(ExportError::new(
            ExportErrorKind::NotReady,
            format!("the worktree is {state:?}, not as it was recorded, so it is not exported"),
        ));
    }
    let inputs = changes_in_worktree(record).map_err(|e| match e {
        ChangesError::LinkEscape(_) => ExportError::new(ExportErrorKind::LinkEscape, e.to_string()),
        ChangesError::Other(m) => ExportError::new(ExportErrorKind::Io, m),
    })?;
    let summary = summarize(&inputs).map_err(|e| io(e.message()))?;
    if summary.is_empty() {
        return Err(ExportError::new(
            ExportErrorKind::NoChanges,
            "the worktree has no changes since its base commit",
        ));
    }
    let patch = unified_patch(&inputs);

    let dir = exports_dir(data_folder);
    std::fs::create_dir_all(&dir).map_err(io)?;
    sweep_partials(&dir);
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
    let tail = Path::new(&record.path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "worktree".into());
    let name = format!("{stamp}-{tail}");
    let partial = dir.join(format!("{name}.partial"));
    let done = dir.join(&name);

    let build = |step: &mut dyn FnMut(&str) -> Result<(), String>| -> Result<Manifest, ExportError> {
        std::fs::create_dir_all(&partial).map_err(io)?;
        std::fs::write(partial.join("changes.patch"), patch.patch.as_bytes()).map_err(io)?;
        step("changes.patch").map_err(io)?;
        let mut shipped = std::collections::BTreeMap::new();
        for whole in &patch.whole {
            if let Some(content) = &whole.content {
                let target = inside(&partial.join("files"), &whole.path)?;
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent).map_err(io)?;
                }
                std::fs::write(&target, content).map_err(io)?;
                shipped.insert(whole.path.clone(), sha256_hex(content));
                step(&whole.path).map_err(io)?;
            }
        }
        let files = summary
            .iter()
            .map(|s| {
                let input = inputs.iter().find(|i| i.path == s.path);
                ExportedFile {
                    path: s.path.clone(),
                    change: s.change,
                    additions: s.additions,
                    deletions: s.deletions,
                    whole: patch.whole.iter().any(|w| w.path == s.path),
                    sha256: shipped.get(&s.path).cloned(),
                    flags: input
                        .map(|i| flags_for(&i.path, i.base.as_deref(), i.proposed.as_deref()))
                        .unwrap_or_default(),
                }
            })
            .collect();
        let manifest = Manifest {
            schema_version: SCHEMA_VERSION,
            created_at: tauri_plugin_agent_tools::audit::now(),
            repository: record.source_root.clone(),
            branch: record.branch.clone(),
            base_sha: record.base_sha.clone(),
            head_sha: head_of(record),
            patch_sha256: sha256_hex(patch.patch.as_bytes()),
            files,
            apply_with: "git apply changes.patch, from a checkout at base_sha; copy files/ over it for anything listed as whole".into(),
        };
        let body = serde_json::to_vec_pretty(&manifest).map_err(io)?;
        std::fs::write(partial.join("manifest.json"), body).map_err(io)?;
        step("manifest.json").map_err(io)?;
        std::fs::rename(&partial, &done).map_err(io)?;
        Ok(manifest)
    };
    match build(step) {
        Ok(manifest) => Ok(ExportReport {
            path: done.to_string_lossy().to_string(),
            manifest,
        }),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&partial);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(["-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.autocrlf=false"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    struct Fixture {
        data: PathBuf,
        roots: PathBuf,
        src: PathBuf,
        record: WorktreeRecord,
    }

    fn fixture(tag: &str) -> Fixture {
        let root = std::env::temp_dir().join(format!(
            "jan-export-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let src = root.join("src");
        std::fs::create_dir_all(&src).unwrap();
        git(&src, &["init", "-q", "-b", "main"]);
        git(&src, &["config", "core.autocrlf", "false"]);
        std::fs::write(src.join("keep.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n").unwrap();
        std::fs::write(src.join("drop.txt"), "bye\n").unwrap();
        git(&src, &["add", "."]);
        git(&src, &["commit", "-q", "-m", "base"]);
        let data = root.join("data");
        let roots = root.join("worktrees");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&roots).unwrap();
        let src = src.canonicalize().unwrap();
        let record = worktree::ensure(&src, &roots, "export-session").unwrap();
        Fixture { data, roots, src, record }
    }

    fn change(f: &Fixture) {
        let wt = Path::new(&f.record.path);
        std::fs::write(wt.join("keep.txt"), "1\n2\nTHREE\n4\n5\n6\n7\nEIGHT\n").unwrap();
        std::fs::remove_file(wt.join("drop.txt")).unwrap();
        std::fs::create_dir_all(wt.join("sub")).unwrap();
        std::fs::write(wt.join("sub/new.txt"), "made here\n").unwrap();
        std::fs::write(wt.join("logo.bin"), [0u8, 1, 2, 3, 255]).unwrap();
        // One change committed on the worktree's branch, the rest not.
        git(wt, &["add", "sub/new.txt"]);
        git(wt, &["commit", "-q", "-m", "agent work"]);
    }

    /// The bundle is what the worktree changed: applied with `git apply` to a
    /// fresh checkout at the base, plus the files shipped whole, it reproduces
    /// the worktree exactly.
    #[test]
    fn a_bundle_applied_to_the_base_reproduces_the_worktree() {
        let f = fixture("roundtrip");
        change(&f);
        let report = export(&f.data, &f.roots, &f.record, &mut |_| Ok(())).unwrap();
        let bundle = Path::new(&report.path);
        assert!(bundle.join("changes.patch").exists() && bundle.join("manifest.json").exists());
        let m = &report.manifest;
        assert_eq!(m.base_sha, f.record.base_sha);
        assert_eq!(m.branch, f.record.branch);
        let paths: Vec<&str> = m.files.iter().map(|x| x.path.as_str()).collect();
        assert_eq!(paths, ["drop.txt", "keep.txt", "logo.bin", "sub/new.txt"]);
        let bin = m.files.iter().find(|x| x.path == "logo.bin").unwrap();
        assert!(bin.whole && bin.sha256.is_some());
        let patch = std::fs::read(bundle.join("changes.patch")).unwrap();
        assert_eq!(sha256_hex(&patch), m.patch_sha256);

        // Apply elsewhere.
        let clone = f.src.parent().unwrap().join("clone");
        // Git reads a `\\?\` path as a remote host name, so the plain form.
        let from = f.src.to_string_lossy().trim_start_matches(r"\\?\").to_string();
        git(f.src.parent().unwrap(), &["clone", "-q", &from, "clone"]);
        git(&clone, &["config", "core.autocrlf", "false"]);
        git(&clone, &["checkout", "-q", &m.base_sha]);
        git(&clone, &["apply", "--check", bundle.join("changes.patch").to_str().unwrap()]);
        git(&clone, &["apply", bundle.join("changes.patch").to_str().unwrap()]);
        std::fs::copy(bundle.join("files/logo.bin"), clone.join("logo.bin")).unwrap();
        let wt = Path::new(&f.record.path);
        for p in ["keep.txt", "sub/new.txt", "logo.bin"] {
            assert_eq!(std::fs::read(clone.join(p)).unwrap(), std::fs::read(wt.join(p)).unwrap(), "{p}");
        }
        assert!(!clone.join("drop.txt").exists());
        // Exporting wrote nothing to the worktree or the checkout.
        assert_eq!(git(wt, &["status", "--porcelain"]).lines().count(), 3);
        assert_eq!(git(&f.src, &["status", "--porcelain"]), "");
    }

    #[test]
    fn a_worktree_that_cannot_be_exported_is_a_typed_refusal() {
        let f = fixture("refusals");
        assert_eq!(
            export(&f.data, &f.roots, &f.record, &mut |_| Ok(())).unwrap_err().kind,
            ExportErrorKind::NoChanges
        );
        // The user's checkout is not a managed worktree.
        let mut theirs = f.record.clone();
        theirs.path = f.src.to_string_lossy().to_string();
        assert_eq!(
            export(&f.data, &f.roots, &theirs, &mut |_| Ok(())).unwrap_err().kind,
            ExportErrorKind::NotManaged
        );
        // Moved off its branch.
        git(Path::new(&f.record.path), &["checkout", "-q", "-b", "elsewhere"]);
        assert_eq!(
            export(&f.data, &f.roots, &f.record, &mut |_| Ok(())).unwrap_err().kind,
            ExportErrorKind::NotReady
        );
        assert!(!exports_dir(&f.data).exists() || std::fs::read_dir(exports_dir(&f.data)).unwrap().count() == 0);
    }

    #[cfg(windows)]
    #[test]
    fn a_link_out_of_the_worktree_refuses_the_export() {
        let f = fixture("link");
        let outside = f.src.parent().unwrap().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "not yours\n").unwrap();
        let ok = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(Path::new(&f.record.path).join("escape"))
            .arg(&outside)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "could not make a junction");
        let err = export(&f.data, &f.roots, &f.record, &mut |_| Ok(())).unwrap_err();
        assert_eq!(err.kind, ExportErrorKind::LinkEscape);
    }

    /// Stopped part-way, an export leaves nothing behind; and a partial bundle
    /// from a process that died is swept by the next export.
    #[test]
    fn an_export_stopped_part_way_leaves_no_bundle() {
        let f = fixture("stopped");
        change(&f);
        let err = export(&f.data, &f.roots, &f.record, &mut |piece| {
            if piece == "logo.bin" {
                Err("stopped".into())
            } else {
                Ok(())
            }
        })
        .unwrap_err();
        assert_eq!(err.kind, ExportErrorKind::Io);
        assert_eq!(std::fs::read_dir(exports_dir(&f.data)).unwrap().count(), 0, "a partial bundle was left");

        std::fs::create_dir_all(exports_dir(&f.data).join("20260101T000000Z-dead.partial")).unwrap();
        let report = export(&f.data, &f.roots, &f.record, &mut |_| Ok(())).unwrap();
        let left: Vec<String> = std::fs::read_dir(exports_dir(&f.data))
            .unwrap()
            .flatten()
            .map(|e| e.path().to_string_lossy().to_string())
            .collect();
        assert_eq!(left, vec![report.path]);
    }

    #[test]
    fn a_bundle_path_cannot_leave_the_bundle() {
        let root = Path::new("C:/bundle/files");
        for bad in ["../x", "a/../../x", "C:/x", "a\\b", ""] {
            assert!(inside(root, bad).is_err(), "{bad}");
        }
        assert!(inside(root, "a/b.bin").is_ok());
    }
}
