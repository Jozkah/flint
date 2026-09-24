//! Bringing an exported worktree bundle into a repository. AH-169.
//!
//! A bundle written by `worktree_export` (AH-168) may have travelled, so it is
//! read as hostile input:
//!
//! * **Copied, then read.** Every entry is copied into a private directory
//!   under `<data>/imports/` before anything is parsed, so what is checked is
//!   what is used. The bundle must contain exactly `manifest.json`,
//!   `changes.patch` and the `files/` the manifest declares -- nothing
//!   missing, nothing extra, no link, junction or reparse point anywhere in
//!   it. Counts, sizes, path lengths and time are bounded.
//! * **Every field checked.** The manifest is parsed strictly (unknown fields
//!   refused), every path is checked the way a proposal checks its own --
//!   `..`, absolute, drive, UNC, stream, device names, `.git`/`.jan` and
//!   their short names -- and paths that collide by case or Unicode
//!   normalization are refused. The patch and each shipped file must match
//!   their declared SHA-256.
//! * **Rebuilt against the destination.** The destination must be a Git
//!   repository that holds the bundle's base commit. Each file's base is read
//!   from that commit (read-only `git cat-file`/`git show`), the patch is
//!   applied to it in memory, and the result is stored as an ordinary
//!   proposal. Nothing is extracted into the repository, and no Git state --
//!   branch, index, stash, config, hooks -- is touched.
//! * **Applied through the proposal.** Review, hunk selection, flags that need
//!   acknowledging, three-way conflict detection, link and `.git` checks
//!   immediately before each write, and rollback are the proposal's. The
//!   approval is additionally bound to this import: its bundle and manifest
//!   hashes, and the destination's path and repository identity, all checked
//!   again at apply time.
//!
//! An import stopped part-way, failed or cancelled leaves nothing: the private
//! copy is removed on every path out, and a copy left by a process that died
//! is swept by the next import.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri_plugin_agent_tools::patch_export::{apply_file_patch, split_patch};
use tauri_plugin_agent_tools::proposal::{
    self, is_reserved_name, validate_path, Approval, ApplyReport, FileInput, ProposalRecord,
    ProposalScope, ProposalState,
};
use unicode_normalization::UnicodeNormalization;

use crate::core::agent::worktree;

pub const SCHEMA_VERSION: u32 = 1;
/// The bundle manifest versions this reader understands.
pub const BUNDLE_SCHEMA: u32 = 1;

/// Bounds on what an import will read.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_entries: usize,
    pub max_total_bytes: u64,
    pub max_file_bytes: u64,
    pub max_manifest_bytes: u64,
    pub max_path_chars: usize,
    pub max_depth: usize,
    pub deadline: Duration,
}

pub const LIMITS: Limits = Limits {
    max_entries: 2_000,
    max_total_bytes: 64 * 1024 * 1024,
    max_file_bytes: 16 * 1024 * 1024,
    max_manifest_bytes: 1024 * 1024,
    max_path_chars: 240,
    max_depth: 32,
    deadline: Duration::from_secs(120),
};

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ImportErrorKind {
    /// Not a bundle directory (an archive, a file, a link).
    UnsupportedContainer,
    /// A manifest version this reader does not know.
    UnsupportedVersion,
    /// A manifest field is missing, malformed or out of range.
    ManifestInvalid,
    /// An entry the manifest requires is not in the bundle.
    EntryMissing,
    /// The bundle holds something the manifest does not declare.
    EntryExtra,
    /// A link, junction or reparse point inside the bundle.
    EntryLink,
    /// Declared and actual hashes differ.
    HashMismatch,
    /// Over a count, size, depth, length or time bound.
    TooLarge,
    /// A path that could leave the project or name Git's or Flint's state.
    PathRefused,
    /// Two paths that name the same file on some file system.
    PathCollision,
    /// The patch is malformed, disagrees with the manifest, or does not fit
    /// its base.
    PatchInvalid,
    /// The destination is not a Git repository's top level.
    DestinationInvalid,
    /// The destination does not hold the bundle's base commit.
    BaseMissing,
    /// The destination moved, changed identity or lost the base since the
    /// import was reviewed.
    DestinationChanged,
    /// This bundle was already applied here, or its changes are already
    /// present.
    AlreadyApplied,
    /// The approval names something other than this import.
    ApprovalMismatch,
    /// No import by that id, or it is no longer pending.
    NotFound,
    Cancelled,
    Io,
    /// The proposal refused the apply; see `proposal`.
    Refused,
}

/// What this failure is, in the harness's own vocabulary (AH-009).
///
/// Written out case by case rather than defaulted: this enum says what went
/// wrong *here*, and the mapping is the place to decide what that means
/// everywhere else -- whether it may be retried, who it is for, what the
/// process exits with. A blanket "everything is internal" would be the same
/// as having no taxonomy at all.
impl From<&ImportError> for tauri_plugin_agent_tools::harness_error::HarnessError {
    fn from(error: &ImportError) -> Self {
        use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};
        let kind = match error.kind {
            ImportErrorKind::UnsupportedContainer | ImportErrorKind::UnsupportedVersion => {
                ErrorKind::Unsupported
            }
            // A bundle that is not what it says it is.
            ImportErrorKind::ManifestInvalid
            | ImportErrorKind::EntryMissing
            | ImportErrorKind::EntryExtra
            | ImportErrorKind::HashMismatch
            | ImportErrorKind::PatchInvalid => ErrorKind::MalformedState,
            // A bundle trying to write somewhere it may not: a refusal.
            ImportErrorKind::EntryLink
            | ImportErrorKind::PathRefused
            | ImportErrorKind::PathCollision
            | ImportErrorKind::DestinationInvalid => ErrorKind::PolicyViolation,
            ImportErrorKind::TooLarge => ErrorKind::InvalidInput,
            // The tree the bundle was made against is not the tree it is
            // being applied to: state, not input.
            ImportErrorKind::BaseMissing
            | ImportErrorKind::DestinationChanged
            | ImportErrorKind::AlreadyApplied => ErrorKind::MalformedState,
            // What was approved is not what arrived, and the user said no.
            ImportErrorKind::ApprovalMismatch => ErrorKind::PolicyViolation,
            ImportErrorKind::Refused => ErrorKind::ApprovalRefused,
            ImportErrorKind::NotFound => ErrorKind::NotFound,
            ImportErrorKind::Cancelled => ErrorKind::Cancelled,
            ImportErrorKind::Io => ErrorKind::Io,
        };
        HarnessError::new(kind, &error.message).at(Stage::Persistence)
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportError {
    pub kind: ImportErrorKind,
    pub message: String,
    /// The proposal's own refusal, when that is what stopped an apply.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflicts: Option<Vec<proposal::Conflict>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub unacknowledged: Vec<String>,
}

impl ImportError {
    pub fn new(kind: ImportErrorKind, message: impl Into<String>) -> Self {
        ImportError {
            kind,
            message: message.into(),
            conflicts: None,
            unacknowledged: Vec::new(),
        }
    }
}

fn io(e: impl std::fmt::Display) -> ImportError {
    ImportError::new(ImportErrorKind::Io, e.to_string())
}

// ---------------------------------------------------------------------------
// The manifest, as read
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManifestIn {
    schema_version: u32,
    created_at: String,
    repository: String,
    branch: String,
    base_sha: String,
    head_sha: String,
    patch_sha256: String,
    files: Vec<FileIn>,
    apply_with: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileIn {
    path: String,
    change: String,
    additions: u64,
    deletions: u64,
    whole: bool,
    #[serde(default)]
    sha256: Option<String>,
    #[serde(default)]
    flags: Vec<serde_json::Value>,
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.chars().all(|c| c.is_ascii_hexdigit())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

// ---------------------------------------------------------------------------
// The import record
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ImportState {
    Pending,
    Applied,
    PartiallyApplied,
    Rejected,
    Abandoned,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedFile {
    pub path: String,
    pub change: String,
    pub whole: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportRecord {
    pub schema_version: u32,
    pub id: String,
    pub bundle_schema: u32,
    /// Hash over every entry of the bundle, in a fixed order.
    pub bundle_sha256: String,
    pub manifest_sha256: String,
    pub patch_sha256: String,
    /// Where the bundle says it came from. Informational: it is another
    /// machine's path.
    pub origin_repository: String,
    pub branch: String,
    pub base_sha: String,
    pub head_sha: String,
    pub exported_at: String,
    /// The repository it is applied to, canonical.
    pub destination: String,
    /// That repository's root commit, when it has one.
    pub destination_first_commit: Option<String>,
    pub proposal_id: String,
    pub state: ImportState,
    pub created_at: String,
    #[serde(default)]
    pub ended_at: Option<String>,
    pub files: Vec<ImportedFile>,
}

/// What an import hands the review: the record and the proposal to show.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportView {
    #[serde(flatten)]
    pub record: ImportRecord,
    pub proposal: Option<ProposalRecord>,
}

/// An approval for an import: the proposal's own, plus what binds it here.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BundleApproval {
    pub import_id: String,
    pub bundle_sha256: String,
    pub manifest_sha256: String,
    pub destination: String,
    pub approval: Approval,
}

fn imports_dir(data_folder: &Path) -> PathBuf {
    data_folder.join("imports")
}

fn record_path(data_folder: &Path, id: &str) -> PathBuf {
    imports_dir(data_folder).join(format!("{id}.json"))
}

fn valid_id(id: &str) -> bool {
    id.starts_with("imp-") && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn new_id() -> String {
    use std::sync::atomic::AtomicU64;
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("imp-{nanos:x}-{}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed))
}

static RECORDS: Mutex<()> = Mutex::new(());

fn save(data_folder: &Path, record: &ImportRecord) -> Result<(), ImportError> {
    std::fs::create_dir_all(imports_dir(data_folder)).map_err(io)?;
    let path = record_path(data_folder, &record.id);
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&temp, serde_json::to_vec_pretty(record).map_err(io)?).map_err(io)?;
    std::fs::rename(&temp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        io(e)
    })
}

pub fn load(data_folder: &Path, id: &str) -> Result<ImportRecord, ImportError> {
    if !valid_id(id) {
        return Err(ImportError::new(ImportErrorKind::NotFound, "no import by that id"));
    }
    let text = std::fs::read_to_string(record_path(data_folder, id))
        .map_err(|_| ImportError::new(ImportErrorKind::NotFound, "no import by that id"))?;
    let record: ImportRecord = serde_json::from_str(&text)
        .map_err(|_| ImportError::new(ImportErrorKind::NotFound, "the import's record is unreadable"))?;
    if record.id != id {
        return Err(ImportError::new(ImportErrorKind::NotFound, "the import's record does not match its name"));
    }
    Ok(record)
}

/// Every import into `destination`, newest first, with its proposal.
pub fn list(data_folder: &Path, destination: &str) -> Vec<ImportView> {
    let Ok(dest) = canonical_dir(Path::new(destination)) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(imports_dir(data_folder)) else {
        return Vec::new();
    };
    let mut out: Vec<ImportView> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|t| serde_json::from_str::<ImportRecord>(&t).ok())
        .filter(|r| r.destination == dest)
        .map(|record| ImportView {
            proposal: proposal::load(data_folder, &record.proposal_id).ok(),
            record,
        })
        .collect();
    out.sort_by(|a, b| b.record.created_at.cmp(&a.record.created_at));
    out
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

fn cancels() -> &'static Mutex<BTreeMap<String, Arc<AtomicBool>>> {
    static MAP: std::sync::OnceLock<Mutex<BTreeMap<String, Arc<AtomicBool>>>> = std::sync::OnceLock::new();
    MAP.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// A token the renderer names an import by before it has an id.
pub fn valid_token(token: &str) -> bool {
    !token.is_empty() && token.len() <= 64 && token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

pub fn register(token: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    cancels().lock().unwrap_or_else(|p| p.into_inner()).insert(token.to_string(), flag.clone());
    flag
}

pub fn unregister(token: &str) {
    cancels().lock().unwrap_or_else(|p| p.into_inner()).remove(token);
}

/// Ask a running import to stop. False when there is none by that token.
pub fn cancel(token: &str) -> bool {
    match cancels().lock().unwrap_or_else(|p| p.into_inner()).get(token) {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    }
}

// ---------------------------------------------------------------------------
// Reading the bundle
// ---------------------------------------------------------------------------

fn is_link(meta: &std::fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

fn canonical_dir(path: &Path) -> Result<String, ()> {
    let c = path.canonicalize().map_err(|_| ())?;
    if !c.is_dir() {
        return Err(());
    }
    Ok(c.to_string_lossy().to_string())
}

struct Budget<'a> {
    started: Instant,
    limits: Limits,
    cancel: &'a AtomicBool,
}

impl Budget<'_> {
    fn check(&self) -> Result<(), ImportError> {
        if self.cancel.load(Ordering::SeqCst) {
            return Err(ImportError::new(ImportErrorKind::Cancelled, "the import was stopped; nothing was kept"));
        }
        if self.started.elapsed() > self.limits.deadline {
            return Err(ImportError::new(ImportErrorKind::TooLarge, "the import took longer than it is allowed to"));
        }
        Ok(())
    }
}

/// Every regular file under `root`, as relative `/` paths, refusing links and
/// anything past the bounds.
fn walk(root: &Path, budget: &Budget) -> Result<BTreeMap<String, u64>, ImportError> {
    let mut out = BTreeMap::new();
    let mut total = 0u64;
    let mut stack = vec![(root.to_path_buf(), String::new(), 0usize)];
    while let Some((dir, rel, depth)) = stack.pop() {
        budget.check()?;
        if depth > budget.limits.max_depth {
            return Err(ImportError::new(ImportErrorKind::TooLarge, "the bundle is nested too deeply"));
        }
        for entry in std::fs::read_dir(&dir).map_err(io)? {
            let entry = entry.map_err(io)?;
            let name = entry.file_name().to_string_lossy().to_string();
            let child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let meta = std::fs::symlink_metadata(entry.path()).map_err(io)?;
            if is_link(&meta) {
                return Err(ImportError::new(ImportErrorKind::EntryLink, format!("{child} in the bundle is a link")));
            }
            if child.chars().count() > budget.limits.max_path_chars {
                return Err(ImportError::new(ImportErrorKind::TooLarge, format!("a path in the bundle is too long: {child}")));
            }
            if meta.is_dir() {
                stack.push((entry.path(), child, depth + 1));
            } else if meta.is_file() {
                if out.len() >= budget.limits.max_entries {
                    return Err(ImportError::new(ImportErrorKind::TooLarge, "the bundle has too many entries"));
                }
                if meta.len() > budget.limits.max_file_bytes {
                    return Err(ImportError::new(ImportErrorKind::TooLarge, format!("{child} is larger than an import allows")));
                }
                total += meta.len();
                if total > budget.limits.max_total_bytes {
                    return Err(ImportError::new(ImportErrorKind::TooLarge, "the bundle is larger than an import allows"));
                }
                out.insert(child, meta.len());
            } else {
                return Err(ImportError::new(ImportErrorKind::EntryExtra, format!("{child} is not a regular file")));
            }
        }
    }
    Ok(out)
}

/// Two paths that one file system could read as the same file.
fn collision_key(path: &str) -> String {
    path.nfc().collect::<String>().to_lowercase()
}

fn check_path(raw: &str, limits: &Limits) -> Result<String, ImportError> {
    if raw.chars().count() > limits.max_path_chars {
        return Err(ImportError::new(ImportErrorKind::TooLarge, format!("{raw} is too long")));
    }
    let refused = || ImportError::new(ImportErrorKind::PathRefused, format!("{raw} is not a path the bundle may name"));
    if raw.contains('\\') || raw.contains('\0') {
        return Err(refused());
    }
    let normalized = validate_path(raw).map_err(|_| refused())?;
    if normalized != raw || raw.split('/').any(is_reserved_name) {
        return Err(refused());
    }
    // A name that differs only in its Unicode form is two names in Git and
    // one on some file systems.
    if raw.nfc().collect::<String>() != raw {
        return Err(refused());
    }
    Ok(normalized)
}

fn git_bytes(repo: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(repo)
        // Read-only commands, but still: no hooks, no pager, no prompts.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat");
    jan_utils::system::hide_console_window(&mut cmd);
    let out = cmd.output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(out.stdout)
}

/// Where an import is prepared, private to Flint.
fn workdir(data_folder: &Path, id: &str) -> PathBuf {
    imports_dir(data_folder).join(format!("{id}.partial"))
}

fn sweep_partials(data_folder: &Path) {
    if let Ok(entries) = std::fs::read_dir(imports_dir(data_folder)) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().ends_with(".partial") {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
}

/// Import a bundle for review. `step` runs after each piece; tests use it to
/// stop part-way.
pub fn import(
    data_folder: &Path,
    bundle: &Path,
    destination: &Path,
    cancel: &AtomicBool,
    limits: Limits,
    step: &mut dyn FnMut(&str) -> Result<(), String>,
) -> Result<ImportView, ImportError> {
    let budget = Budget { started: Instant::now(), limits, cancel };
    let container = std::fs::symlink_metadata(bundle)
        .map_err(|_| ImportError::new(ImportErrorKind::UnsupportedContainer, "there is no bundle at that path"))?;
    if is_link(&container) || !container.is_dir() {
        return Err(ImportError::new(
            ImportErrorKind::UnsupportedContainer,
            "a bundle is the folder an export wrote; archives, single files and links are not read",
        ));
    }
    let dest = canonical_dir(destination)
        .map_err(|_| ImportError::new(ImportErrorKind::DestinationInvalid, "the destination is not a folder"))?;
    let dest_path = PathBuf::from(&dest);
    let top = git_bytes(&dest_path, &["rev-parse", "--show-toplevel"])
        .map(|b| String::from_utf8_lossy(&b).trim().to_string())
        .map_err(|_| ImportError::new(ImportErrorKind::DestinationInvalid, "the destination is not a Git repository"))?;
    if canonical_dir(Path::new(&top)).ok().as_deref() != Some(dest.as_str()) {
        return Err(ImportError::new(ImportErrorKind::DestinationInvalid, "the destination is not the top of its repository"));
    }

    std::fs::create_dir_all(imports_dir(data_folder)).map_err(io)?;
    sweep_partials(data_folder);
    let id = new_id();
    let work = workdir(data_folder, &id);
    let result = (|| {
        let entries = walk(bundle, &budget)?;
        for required in ["manifest.json", "changes.patch"] {
            if !entries.contains_key(required) {
                return Err(ImportError::new(ImportErrorKind::EntryMissing, format!("the bundle has no {required}")));
            }
        }
        if entries["manifest.json"] > limits.max_manifest_bytes {
            return Err(ImportError::new(ImportErrorKind::TooLarge, "the manifest is larger than allowed"));
        }
        // Copy, hashing as it goes; everything after this reads the copy.
        std::fs::create_dir_all(&work).map_err(io)?;
        let mut hashes = BTreeMap::new();
        for rel in entries.keys() {
            budget.check()?;
            let bytes = std::fs::read(bundle.join(rel)).map_err(io)?;
            if bytes.len() as u64 > limits.max_file_bytes {
                return Err(ImportError::new(ImportErrorKind::TooLarge, format!("{rel} grew while it was read")));
            }
            let target = work.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(io)?;
            }
            std::fs::write(&target, &bytes).map_err(io)?;
            hashes.insert(rel.clone(), sha256_hex(&bytes));
            step(rel).map_err(|e| ImportError::new(ImportErrorKind::Cancelled, e))?;
        }
        let manifest_bytes = std::fs::read(work.join("manifest.json")).map_err(io)?;
        let raw: serde_json::Value = serde_json::from_slice(&manifest_bytes)
            .map_err(|e| ImportError::new(ImportErrorKind::ManifestInvalid, format!("the manifest is not JSON: {e}")))?;
        match raw.get("schemaVersion").and_then(serde_json::Value::as_u64) {
            Some(v) if v == u64::from(BUNDLE_SCHEMA) => {}
            Some(v) => {
                return Err(ImportError::new(
                    ImportErrorKind::UnsupportedVersion,
                    format!("bundle schema {v} is not one this version of Flint reads"),
                ))
            }
            None => return Err(ImportError::new(ImportErrorKind::ManifestInvalid, "the manifest has no schema version")),
        }
        let manifest: ManifestIn = serde_json::from_value(raw)
            .map_err(|e| ImportError::new(ImportErrorKind::ManifestInvalid, format!("the manifest is malformed: {e}")))?;
        let bad = |what: &str| ImportError::new(ImportErrorKind::ManifestInvalid, format!("the manifest's {what} is malformed"));
        if manifest.schema_version != BUNDLE_SCHEMA {
            return Err(bad("schemaVersion"));
        }
        if !is_hex(&manifest.base_sha, 40) {
            return Err(bad("baseSha"));
        }
        if !(manifest.head_sha.is_empty() || is_hex(&manifest.head_sha, 40)) {
            return Err(bad("headSha"));
        }
        if !is_hex(&manifest.patch_sha256, 64) {
            return Err(bad("patchSha256"));
        }
        if manifest.branch.len() > 200 || manifest.branch.chars().any(char::is_control) {
            return Err(bad("branch"));
        }
        if manifest.repository.len() > 1000 || manifest.created_at.len() > 64 || manifest.apply_with.len() > 1000 {
            return Err(bad("text fields"));
        }
        if manifest.files.is_empty() || manifest.files.len() > limits.max_entries {
            return Err(bad("file list"));
        }

        // Paths: each valid, none colliding with another.
        let mut seen = BTreeSet::new();
        let mut files: Vec<(String, &FileIn)> = Vec::new();
        for f in &manifest.files {
            let path = check_path(&f.path, &limits)?;
            if !seen.insert(collision_key(&path)) {
                return Err(ImportError::new(
                    ImportErrorKind::PathCollision,
                    format!("{path} names the same file as another entry on some file systems"),
                ));
            }
            if !matches!(f.change.as_str(), "added" | "modified" | "deleted") {
                return Err(bad("change of a file"));
            }
            if f.flags.len() > 16 || f.additions > 10_000_000 || f.deletions > 10_000_000 {
                return Err(bad("counts of a file"));
            }
            if f.whole {
                match (&f.sha256, f.change.as_str()) {
                    (_, "deleted") => {}
                    (Some(h), _) if is_hex(h, 64) => {}
                    _ => return Err(bad("hash of a whole file")),
                }
            }
            files.push((path, f));
        }

        // Entries: exactly what the manifest declares.
        let mut expected: BTreeSet<String> = ["manifest.json".into(), "changes.patch".into()].into();
        for (path, f) in &files {
            if f.whole && f.change != "deleted" {
                expected.insert(format!("files/{path}"));
            }
        }
        for entry in entries.keys() {
            if !expected.contains(entry) {
                return Err(ImportError::new(ImportErrorKind::EntryExtra, format!("{entry} is in the bundle but not in its manifest")));
            }
        }
        for entry in &expected {
            if !entries.contains_key(entry) {
                return Err(ImportError::new(ImportErrorKind::EntryMissing, format!("the bundle has no {entry}")));
            }
        }

        // Hashes.
        if hashes["changes.patch"] != manifest.patch_sha256 {
            return Err(ImportError::new(ImportErrorKind::HashMismatch, "changes.patch does not match its hash"));
        }
        for (path, f) in &files {
            if f.whole && f.change != "deleted"
                && Some(&hashes[&format!("files/{path}")]) != f.sha256.as_ref() {
                    return Err(ImportError::new(ImportErrorKind::HashMismatch, format!("files/{path} does not match its hash")));
                }
        }
        let mut basis = String::new();
        for (rel, h) in &hashes {
            basis.push_str(&format!("{rel}\0{h}\n"));
        }
        let bundle_sha256 = sha256_hex(basis.as_bytes());
        let manifest_sha256 = hashes["manifest.json"].clone();

        // The patch: exactly one section per text file, nothing else.
        let patch_text = String::from_utf8(std::fs::read(work.join("changes.patch")).map_err(io)?)
            .map_err(|_| ImportError::new(ImportErrorKind::PatchInvalid, "changes.patch is not text"))?;
        let sections = if patch_text.is_empty() { Vec::new() } else {
            split_patch(&patch_text).map_err(|e| ImportError::new(ImportErrorKind::PatchInvalid, e))?
        };
        let text_files: BTreeSet<&str> = files.iter().filter(|(_, f)| !f.whole).map(|(p, _)| p.as_str()).collect();
        let section_files: BTreeSet<&str> = sections.iter().map(|s| s.path.as_str()).collect();
        if text_files != section_files {
            return Err(ImportError::new(ImportErrorKind::PatchInvalid, "the patch and the manifest list different files"));
        }

        // Destination: the base commit must be there.
        let base = &manifest.base_sha;
        git_bytes(&dest_path, &["cat-file", "-e", &format!("{base}^{{commit}}")]).map_err(|_| {
            ImportError::new(
                ImportErrorKind::BaseMissing,
                format!("this repository does not have the bundle's base commit {}", &base[..10]),
            )
        })?;
        budget.check()?;

        // Rebuild every file against the base.
        let mut inputs = Vec::new();
        for (path, f) in &files {
            budget.check()?;
            let at_base = git_bytes(&dest_path, &["cat-file", "-e", &format!("{base}:{path}")]).is_ok();
            let base_bytes = if at_base {
                Some(git_bytes(&dest_path, &["show", &format!("{base}:{path}")]).map_err(io)?)
            } else {
                None
            };
            match (f.change.as_str(), at_base) {
                ("added", true) => {
                    return Err(ImportError::new(ImportErrorKind::PatchInvalid, format!("{path} is added but exists at the base")))
                }
                ("modified" | "deleted", false) => {
                    return Err(ImportError::new(ImportErrorKind::PatchInvalid, format!("{path} is not at the base")))
                }
                _ => {}
            }
            let proposed = if f.whole {
                if f.change == "deleted" {
                    None
                } else {
                    Some(std::fs::read(work.join("files").join(path.replace('/', std::path::MAIN_SEPARATOR_STR))).map_err(io)?)
                }
            } else {
                let section = sections.iter().find(|s| &s.path == path).expect("checked above");
                if section.added != (f.change == "added") || section.deleted != (f.change == "deleted") {
                    return Err(ImportError::new(ImportErrorKind::PatchInvalid, format!("{path}: the patch and the manifest disagree about the change")));
                }
                let base_text = match &base_bytes {
                    Some(b) => Some(
                        std::str::from_utf8(b)
                            .map_err(|_| ImportError::new(ImportErrorKind::PatchInvalid, format!("{path} is not text at the base")))?,
                    ),
                    None => None,
                };
                apply_file_patch(base_text, section)
                    .map_err(|e| ImportError::new(ImportErrorKind::PatchInvalid, e))?
                    .map(String::into_bytes)
            };
            inputs.push(FileInput { path: path.clone(), base: base_bytes, proposed });
        }

        // Already here: applied before, or every change already present.
        let _held = RECORDS.lock().unwrap_or_else(|p| p.into_inner());
        if list(data_folder, &dest).iter().any(|v| {
            v.record.bundle_sha256 == bundle_sha256
                && matches!(v.record.state, ImportState::Applied | ImportState::PartiallyApplied | ImportState::Pending)
        }) {
            return Err(ImportError::new(
                ImportErrorKind::AlreadyApplied,
                "this bundle has already been imported into this repository",
            ));
        }
        let present = inputs.iter().all(|i| std::fs::read(dest_path.join(&i.path)).ok() == i.proposed);
        if present {
            return Err(ImportError::new(ImportErrorKind::AlreadyApplied, "every change in this bundle is already in the repository"));
        }
        budget.check()?;

        let identity = worktree::identity(&dest_path).ok();
        let proposal = proposal::create(
            data_folder,
            ProposalScope {
                session: format!("import:{id}"),
                run: String::new(),
                call: String::new(),
                invocation: String::new(),
                agent: "bundle".into(),
                subject: format!(
                    "bundle {} from {} at {}",
                    &bundle_sha256[..12],
                    if manifest.branch.is_empty() { "an unnamed branch" } else { &manifest.branch },
                    &base[..10]
                ),
                project: dest.clone(),
                worktree: format!("bundle:{id}"),
            },
            base,
            inputs,
        )
        .map_err(|e| ImportError::new(ImportErrorKind::PatchInvalid, e.message()))?;
        let record = ImportRecord {
            schema_version: SCHEMA_VERSION,
            id: id.clone(),
            bundle_schema: manifest.schema_version,
            bundle_sha256,
            manifest_sha256,
            patch_sha256: manifest.patch_sha256.clone(),
            origin_repository: manifest.repository.clone(),
            branch: manifest.branch.clone(),
            base_sha: base.clone(),
            head_sha: manifest.head_sha.clone(),
            exported_at: manifest.created_at.clone(),
            destination: dest.clone(),
            destination_first_commit: identity.and_then(|i| i.first_commit),
            proposal_id: proposal.id.clone(),
            state: ImportState::Pending,
            created_at: tauri_plugin_agent_tools::audit::now(),
            ended_at: None,
            files: files
                .iter()
                .map(|(p, f)| ImportedFile { path: p.clone(), change: f.change.clone(), whole: f.whole })
                .collect(),
        };
        save(data_folder, &record)?;
        Ok(ImportView { record, proposal: Some(proposal) })
    })();
    // On every path out, the private copy goes.
    let _ = std::fs::remove_dir_all(&work);
    result
}

/// Apply an approved import. Everything the import was bound to is checked
/// again first; the proposal then checks its own hashes, flags, links and
/// conflicts, and applies atomically or not at all.
pub fn apply(data_folder: &Path, approval: &BundleApproval) -> Result<ApplyReport, ImportError> {
    let _held = RECORDS.lock().unwrap_or_else(|p| p.into_inner());
    let mut record = load(data_folder, &approval.import_id)?;
    match record.state {
        ImportState::Pending => {}
        ImportState::Applied | ImportState::PartiallyApplied => {
            return Err(ImportError::new(ImportErrorKind::AlreadyApplied, "this import was already applied"))
        }
        _ => return Err(ImportError::new(ImportErrorKind::NotFound, "this import is no longer pending")),
    }
    let mismatch = |what: &str| ImportError::new(ImportErrorKind::ApprovalMismatch, format!("the approval names a different {what}; nothing was written"));
    if approval.bundle_sha256 != record.bundle_sha256 {
        return Err(mismatch("bundle"));
    }
    if approval.manifest_sha256 != record.manifest_sha256 {
        return Err(mismatch("manifest"));
    }
    if approval.approval.proposal_id != record.proposal_id {
        return Err(mismatch("proposal"));
    }
    // The destination, resolved again now.
    let now = canonical_dir(Path::new(&approval.destination)).map_err(|_| {
        ImportError::new(ImportErrorKind::DestinationChanged, "the destination is gone; nothing was written")
    })?;
    if now != record.destination {
        return Err(ImportError::new(ImportErrorKind::DestinationChanged, "the destination is not the one reviewed; nothing was written"));
    }
    let dest = PathBuf::from(&now);
    let first = worktree::identity(&dest).ok().and_then(|i| i.first_commit);
    if first != record.destination_first_commit {
        return Err(ImportError::new(ImportErrorKind::DestinationChanged, "the destination is a different repository now; nothing was written"));
    }
    if git_bytes(&dest, &["cat-file", "-e", &format!("{}^{{commit}}", record.base_sha)]).is_err() {
        return Err(ImportError::new(ImportErrorKind::DestinationChanged, "the destination no longer has the base commit; nothing was written"));
    }
    let report = proposal::apply(data_folder, &dest, &approval.approval).map_err(|e| {
        let mut err = ImportError::new(ImportErrorKind::Refused, e.message());
        match e {
            proposal::ProposalError::Conflicts(c) => err.conflicts = Some(c),
            proposal::ProposalError::Unacknowledged(p) => err.unacknowledged = p,
            _ => {}
        }
        err
    })?;
    record.state = match report.state {
        ProposalState::Applied => ImportState::Applied,
        _ => ImportState::PartiallyApplied,
    };
    record.ended_at = Some(tauri_plugin_agent_tools::audit::now());
    save(data_folder, &record)?;
    Ok(report)
}

#[cfg(test)]
#[path = "bundle_import_tests.rs"]
mod tests;

/// Give up on a pending import: its proposal is rejected and nothing lands.
pub fn abandon(data_folder: &Path, id: &str) -> Result<ImportRecord, ImportError> {
    let _held = RECORDS.lock().unwrap_or_else(|p| p.into_inner());
    let mut record = load(data_folder, id)?;
    if record.state != ImportState::Pending {
        return Ok(record);
    }
    if let Ok(p) = proposal::load(data_folder, &record.proposal_id) {
        let _ = proposal::reject(data_folder, &record.proposal_id, &p.scope);
    }
    record.state = ImportState::Abandoned;
    record.ended_at = Some(tauri_plugin_agent_tools::audit::now());
    save(data_folder, &record)?;
    Ok(record)
}
