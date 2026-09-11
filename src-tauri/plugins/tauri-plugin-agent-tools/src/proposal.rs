//! A proposed change, stored before anyone approves it. AH-146/147/148/109.
//!
//! One record carries a change from the moment an agent produces it to the
//! moment it lands, is rejected, or is abandoned:
//!
//! * **Immutable before approval.** The exact base and proposed bytes of every
//!   file are written to a content-addressed blob store when the proposal is
//!   created. Nothing is regenerated afterwards; what is applied is read back
//!   from those blobs, so the change that lands is the change that was shown.
//! * **Approval binds to identities, not to intentions.** An approval names
//!   the proposal's patch hash, its base-state hash and the exact hunks chosen.
//!   If any of those differ from the stored record, the approval is refused.
//!   The renderer sends ids and hashes, never content.
//! * **The backend builds the result.** Selecting hunks, checking the
//!   destination, merging around unrelated edits and writing the files all
//!   happen here. A renderer that wanted to add a line has no field to put it in.
//! * **Conflicts are refused, never resolved.** A selected hunk whose base lines
//!   were also changed at the destination is reported by file and hunk, and
//!   nothing is written. Edits elsewhere in the same file are preserved.
//! * **All or nothing.** Every file is written through a temporary file and a
//!   rename; if any write fails, every file already written is put back.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use similar::{DiffOp, TextDiff};

pub const SCHEMA_VERSION: u32 = 1;

/// Files larger than this are proposed whole: no hunks, approve or reject.
pub const OVERSIZED_BYTES: usize = 1024 * 1024;

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/// Who produced the change and where it may land. Every approval must name the
/// same scope, which is what stops a proposal from one project or one agent
/// being approved as though it came from another.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProposalScope {
    pub session: String,
    #[serde(default)]
    pub run: String,
    #[serde(default)]
    pub call: String,
    #[serde(default)]
    pub invocation: String,
    #[serde(default)]
    pub agent: String,
    #[serde(default)]
    pub subject: String,
    /// The destination root, canonical, as the backend resolved it.
    pub project: String,
    /// The isolated worktree the change was produced in, when there was one.
    #[serde(default)]
    pub worktree: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Change {
    Added,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedHunk {
    /// Stable and content-derived: the same change always has the same id, and
    /// an id cannot be reused for different content.
    pub id: String,
    pub old_start: usize,
    pub old_len: usize,
    pub new_start: usize,
    pub new_len: usize,
    pub removed: Vec<String>,
    pub added: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedFile {
    /// Relative to the destination root, forward slashes.
    pub path: String,
    pub change: Change,
    /// Blob id of the content the change was computed against; `None` for an
    /// added file.
    pub base_blob: Option<String>,
    /// Blob id of the proposed content; `None` for a deleted file.
    pub proposed_blob: Option<String>,
    pub binary: bool,
    pub oversized: bool,
    /// A credential-shaped path or content. Never applied.
    pub sensitive: bool,
    pub additions: usize,
    pub deletions: usize,
    /// Empty for binary and oversized files, which are decided whole.
    pub hunks: Vec<ProposedHunk>,
    /// A dependency, lock file or migration change (AH-154/155/156). Shown to
    /// the reviewer; applying the file needs it acknowledged. Worked out again
    /// from the stored content when the change is applied.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub flags: Vec<crate::review_flags::ReviewFlag>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProposalState {
    Pending,
    Applied,
    PartiallyApplied,
    Rejected,
}

/// One transition, for the proposal's own history. Ids and counts only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEvent {
    pub at: String,
    pub event: String,
    #[serde(default)]
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalRecord {
    pub schema_version: u32,
    pub id: String,
    pub scope: ProposalScope,
    #[serde(default)]
    pub base_commit: String,
    pub files: Vec<ProposedFile>,
    pub patch_hash: String,
    pub base_state_hash: String,
    pub created_at: String,
    pub state: ProposalState,
    #[serde(default)]
    pub history: Vec<HistoryEvent>,
}

/// One file as the producer saw it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileInput {
    pub path: String,
    pub base: Option<Vec<u8>>,
    pub proposed: Option<Vec<u8>>,
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "ids")]
pub enum HunkChoice {
    All,
    Only(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSelection {
    pub path: String,
    pub hunks: HunkChoice,
}

/// What a person approved. Files not named are rejected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub proposal_id: String,
    pub patch_hash: String,
    pub base_state_hash: String,
    pub scope: ProposalScope,
    pub files: Vec<FileSelection>,
    /// Flagged files the person said they reviewed as flagged. A selected
    /// file with a flag that is not named here is not applied.
    #[serde(default)]
    pub acknowledged: Vec<String>,
}

/// A selected hunk that cannot be applied without overwriting an edit made at
/// the destination.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub path: String,
    /// Empty when the conflict is about the whole file (created or deleted
    /// underneath, or a binary file that changed).
    pub hunk: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProposalError {
    NotFound,
    InvalidPath(String),
    DuplicatePath(String),
    NotPending(ProposalState),
    PatchChanged,
    BaseChanged,
    ScopeMismatch(&'static str),
    UnknownFile(String),
    UnknownHunk(String),
    DuplicateSelection(String),
    WholeFileOnly(String),
    Sensitive(String),
    /// A path at the destination that passes through a symlink, junction or
    /// other reparse point, so writing it would land somewhere else.
    LinkedDestination(String),
    /// Selected files with a dependency, lock file or migration flag that the
    /// approval did not acknowledge.
    Unacknowledged(Vec<String>),
    Conflicts(Vec<Conflict>),
    Io(String),
}

impl ProposalError {
    /// For the person and the model. Always says whether anything was written.
    pub fn message(&self) -> String {
        match self {
            ProposalError::NotFound => "that proposal does not exist".into(),
            ProposalError::InvalidPath(p) => format!("{p} is not a path inside the project"),
            ProposalError::DuplicatePath(p) => format!("{p} appears twice in the change"),
            ProposalError::NotPending(state) => {
                format!("that proposal is already {state:?}; nothing was written")
            }
            ProposalError::PatchChanged => {
                "the approval was for a different version of this change; nothing was written"
                    .into()
            }
            ProposalError::BaseChanged => {
                "the approval was for a different starting state; nothing was written".into()
            }
            ProposalError::ScopeMismatch(what) => {
                format!("the approval names a different {what}; nothing was written")
            }
            ProposalError::UnknownFile(p) => format!("{p} is not part of this change"),
            ProposalError::UnknownHunk(h) => format!("hunk {h} is not part of this change"),
            ProposalError::DuplicateSelection(x) => format!("{x} was selected twice"),
            ProposalError::WholeFileOnly(p) => {
                format!("{p} is binary or too large to split; approve or reject it whole")
            }
            ProposalError::Sensitive(p) => {
                format!("{p} looks like it holds a credential, so it is never applied")
            }
            ProposalError::LinkedDestination(p) => format!(
                "{p} passes through a link in your folder, so writing it would land elsewhere; nothing was written"
            ),
            ProposalError::Unacknowledged(paths) => format!(
                "{} changes a dependency, lock file or migration and was not acknowledged as reviewed; nothing was written",
                paths.join(", ")
            ),
            ProposalError::Conflicts(c) => format!(
                "{} selected change(s) overlap edits made since the proposal; nothing was written",
                c.len()
            ),
            ProposalError::Io(e) => format!("could not apply the change ({e}); nothing was left half-written"),
        }
    }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

fn proposals_root(data_folder: &Path) -> PathBuf {
    data_folder.join("proposals")
}

fn blob_path(data_folder: &Path, id: &str) -> PathBuf {
    proposals_root(data_folder).join("blobs").join(id)
}

fn record_path(data_folder: &Path, id: &str) -> PathBuf {
    proposals_root(data_folder).join(format!("{id}.json"))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        e.to_string()
    })
}

/// Content-addressed and write-once: the id is the hash of the bytes.
fn store_blob(data_folder: &Path, bytes: &[u8]) -> Result<String, String> {
    let id = sha256_hex(bytes);
    let path = blob_path(data_folder, &id);
    if !path.exists() {
        write_atomic(&path, bytes)?;
    }
    Ok(id)
}

fn read_blob(data_folder: &Path, id: &str) -> Result<Vec<u8>, String> {
    let bytes = std::fs::read(blob_path(data_folder, id)).map_err(|e| e.to_string())?;
    // A blob that no longer matches its own name has been tampered with or
    // corrupted; applying it would apply something nobody approved.
    if sha256_hex(&bytes) != id {
        return Err(format!("stored content {id} does not match its hash"));
    }
    Ok(bytes)
}

fn save(data_folder: &Path, record: &ProposalRecord) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(record).map_err(|e| e.to_string())?;
    write_atomic(&record_path(data_folder, &record.id), &body)
}

pub fn load(data_folder: &Path, id: &str) -> Result<ProposalRecord, ProposalError> {
    if !valid_id(id) {
        return Err(ProposalError::NotFound);
    }
    let text = std::fs::read_to_string(record_path(data_folder, id))
        .map_err(|_| ProposalError::NotFound)?;
    serde_json::from_str(&text).map_err(|_| ProposalError::NotFound)
}

/// Every proposal for `project`, newest first.
pub fn list(data_folder: &Path, project: &str) -> Vec<ProposalRecord> {
    let Ok(entries) = std::fs::read_dir(proposals_root(data_folder)) else {
        return Vec::new();
    };
    let mut out: Vec<ProposalRecord> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|t| serde_json::from_str::<ProposalRecord>(&t).ok())
        .filter(|r| r.scope.project == project)
        .collect();
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    out
}

fn valid_id(id: &str) -> bool {
    id.starts_with("prop-")
        && id.len() <= 80
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn new_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("prop-{nanos:x}-{}-{n}", std::process::id())
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditLine<'a> {
    v: u32,
    at: String,
    proposal: &'a str,
    event: &'a str,
    session: &'a str,
    run: &'a str,
    agent: &'a str,
    project: &'a str,
    patch_hash: &'a str,
    base_state_hash: &'a str,
    detail: String,
}

/// Append-only, ids and hashes only: never file content. Never fails the
/// operation it describes.
fn audit(data_folder: &Path, record: &ProposalRecord, event: &str, detail: String) {
    use std::io::Write;
    let line = AuditLine {
        v: 1,
        at: crate::audit::now(),
        proposal: &record.id,
        event,
        session: &record.scope.session,
        run: &record.scope.run,
        agent: &record.scope.agent,
        project: &record.scope.project,
        patch_hash: &record.patch_hash,
        base_state_hash: &record.base_state_hash,
        detail,
    };
    let path = data_folder.join("audit").join("proposals.jsonl");
    let result = (|| -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut text = serde_json::to_string(&line).map_err(|e| e.to_string())?;
        text.push('\n');
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        f.flush().map_err(|e| e.to_string())
    })();
    if let Err(e) = result {
        eprintln!("proposal audit: could not record {event}: {e}");
    }
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/// A path the change may name: relative, no `..`, no drive or root, and not
/// Jan's own state directory or Git's.
///
/// Judged by what Windows would open, not by the spelling: `.git.` and
/// `.GIT ` name `.git` there, `a.txt:stream` names a stream of `a.txt`, and
/// `NUL` or `con.txt` name a device. Each is refused on every platform, so a
/// proposal made on one machine cannot mean something else on another.
fn normalize_path(raw: &str) -> Result<String, ProposalError> {
    let raw = raw.replace('\\', "/");
    let path = Path::new(&raw);
    let mut parts = Vec::new();
    for c in path.components() {
        match c {
            Component::Normal(p) => {
                let part = p.to_string_lossy().to_string();
                if !portable_component(&part) {
                    return Err(ProposalError::InvalidPath(raw.clone()));
                }
                parts.push(part)
            }
            Component::CurDir => {}
            _ => return Err(ProposalError::InvalidPath(raw.clone())),
        }
    }
    if parts.is_empty() || parts.iter().any(|p| is_reserved_name(p)) {
        return Err(ProposalError::InvalidPath(raw));
    }
    Ok(parts.join("/"))
}

/// A path from outside Jan, checked the way a proposal checks its own:
/// relative, no `..`, no drive, root, UNC or stream, no device name, not
/// Git's or Jan's state under any spelling. The normalized form on success.
pub fn validate_path(raw: &str) -> Result<String, ProposalError> {
    if raw.starts_with('/') || raw.starts_with('\\') {
        return Err(ProposalError::InvalidPath(raw.to_string()));
    }
    normalize_path(raw)
}

/// `.git` or `.jan`, however Windows lets it be spelled.
///
/// NTFS gives `.git` an 8.3 short name, `GIT~1`, and opens the directory by
/// either. A proposal naming `GIT~1/hooks/pre-commit` would write the user's
/// Git hooks. The number is not always 1 -- it depends on what else was named
/// alike first -- so every `git~N` and `jan~N` is refused, as Git itself does.
pub fn is_reserved_name(part: &str) -> bool {
    let lower = part.trim_end_matches(['.', ' ']).to_ascii_lowercase();
    if lower == ".git" || lower == ".jan" {
        return true;
    }
    ["git~", "jan~"].iter().any(|prefix| {
        lower
            .strip_prefix(prefix)
            .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
    })
}

/// Whether `root/rel` resolves into `root/.git` or `root/.jan`, whatever it
/// is spelled as.
///
/// The spelling rules above know the aliases Windows has today; this asks the
/// file system. The deepest part of the path that exists is resolved, and a
/// write whose real location is inside Git's or Jan's state is refused. It is
/// the check that still holds if a new alias turns up.
pub fn resolves_into_reserved(root: &Path, rel: &str) -> bool {
    let Ok(root) = root.canonicalize() else {
        return false;
    };
    let reserved: Vec<PathBuf> = [".git", ".jan"]
        .iter()
        .filter_map(|name| root.join(name).canonicalize().ok())
        .collect();
    if reserved.is_empty() {
        return false;
    }
    let mut deepest = root.clone();
    let mut probe = root.clone();
    for part in rel.split('/').filter(|p| !p.is_empty()) {
        probe.push(part);
        match probe.canonicalize() {
            Ok(real) => deepest = real,
            Err(_) => break,
        }
    }
    reserved.iter().any(|r| deepest.starts_with(r))
}

/// One path component that names the same file on every platform Jan runs on.
fn portable_component(part: &str) -> bool {
    const DEVICES: &[&str] = &[
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7",
        "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    ];
    if part.is_empty() || part.ends_with('.') || part.ends_with(' ') {
        return false;
    }
    if part
        .chars()
        .any(|c| c.is_control() || matches!(c, ':' | '<' | '>' | '"' | '|' | '?' | '*'))
    {
        return false;
    }
    let stem = part.split('.').next().unwrap_or(part).to_ascii_lowercase();
    !DEVICES.contains(&stem.trim_end())
}

/// Whether anything between `root` and `root/rel` is a link.
///
/// Every existing component is looked at without following it. A symlink, a
/// junction or any other reparse point part-way down means the path names
/// something other than what its spelling says, and a write through it lands
/// wherever the link points. Components that do not exist yet end the walk:
/// nothing beneath a missing directory can be a link.
pub fn passes_through_link(root: &Path, rel: &str) -> bool {
    let mut at = root.to_path_buf();
    for part in rel.split('/').filter(|p| !p.is_empty()) {
        at.push(part);
        match std::fs::symlink_metadata(&at) {
            Ok(meta) => {
                if is_link(&meta) {
                    return true;
                }
            }
            Err(_) => return false,
        }
    }
    false
}

fn is_link(meta: &std::fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(8192)].contains(&0) || std::str::from_utf8(bytes).is_err()
}

fn is_sensitive(path: &str, proposed: Option<&[u8]>) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    if crate::project_browse::is_sensitive_name(name) {
        return true;
    }
    match proposed.and_then(|b| std::str::from_utf8(b).ok()) {
        Some(text) => !crate::secrets::scan_text(text).is_empty(),
        None => false,
    }
}

fn hunk_id(file_index: usize, hunk_index: usize, h: &crate::patch::Hunk) -> String {
    let mut basis = format!("{}\u{0}{}\u{0}", h.old_start, h.new_start);
    for l in &h.removed {
        basis.push('-');
        basis.push_str(l);
        basis.push('\n');
    }
    for l in &h.added {
        basis.push('+');
        basis.push_str(l);
        basis.push('\n');
    }
    format!("{file_index}.{hunk_index}-{}", &sha256_hex(basis.as_bytes())[..10])
}

fn base_state_hash_of(files: &[ProposedFile]) -> String {
    let mut basis = String::new();
    for f in files {
        basis.push_str(&f.path);
        basis.push('\t');
        basis.push_str(f.base_blob.as_deref().unwrap_or("absent"));
        basis.push('\n');
    }
    sha256_hex(basis.as_bytes())
}

fn patch_hash_of(files: &[ProposedFile]) -> String {
    // Field order is fixed by the struct, so this serialization is canonical.
    sha256_hex(&serde_json::to_vec(files).unwrap_or_default())
}

/// Store a proposal. Nothing at the destination is touched.
pub fn create(
    data_folder: &Path,
    scope: ProposalScope,
    base_commit: &str,
    inputs: Vec<FileInput>,
) -> Result<ProposalRecord, ProposalError> {
    let mut seen = BTreeSet::new();
    let mut normalized = Vec::with_capacity(inputs.len());
    for input in inputs {
        let path = normalize_path(&input.path)?;
        if !seen.insert(path.to_ascii_lowercase()) {
            // Case-insensitively: on Windows two spellings are one file.
            return Err(ProposalError::DuplicatePath(path));
        }
        if input.base == input.proposed {
            continue;
        }
        normalized.push((path, input));
    }
    normalized.sort_by(|a, b| a.0.cmp(&b.0));

    let mut files = Vec::with_capacity(normalized.len());
    for (file_index, (path, input)) in normalized.into_iter().enumerate() {
        let change = match (&input.base, &input.proposed) {
            (None, Some(_)) => Change::Added,
            (Some(_), None) => Change::Deleted,
            _ => Change::Modified,
        };
        let base_blob = match &input.base {
            Some(b) => Some(store_blob(data_folder, b).map_err(ProposalError::Io)?),
            None => None,
        };
        let proposed_blob = match &input.proposed {
            Some(b) => Some(store_blob(data_folder, b).map_err(ProposalError::Io)?),
            None => None,
        };
        let binary = input.base.as_deref().is_some_and(is_binary)
            || input.proposed.as_deref().is_some_and(is_binary);
        let size = input
            .base
            .as_ref()
            .map_or(0, Vec::len)
            .max(input.proposed.as_ref().map_or(0, Vec::len));
        let oversized = size > OVERSIZED_BYTES;
        let sensitive = is_sensitive(&path, input.proposed.as_deref());
        let flags = crate::review_flags::flags_for(
            &path,
            input.base.as_deref(),
            input.proposed.as_deref(),
        );

        let (mut additions, mut deletions, mut hunks) = (0, 0, Vec::new());
        if !binary && !oversized {
            let base_text = input.base.as_deref().map(|b| String::from_utf8_lossy(b).to_string());
            let new_text = input
                .proposed
                .as_deref()
                .map(|b| String::from_utf8_lossy(b).to_string())
                .unwrap_or_default();
            let staged = crate::patch::StagedPatch::stage(base_text.as_deref(), &new_text);
            for (hunk_index, h) in staged.hunks().iter().enumerate() {
                additions += h.added.len();
                deletions += h.removed.len();
                hunks.push(ProposedHunk {
                    id: hunk_id(file_index, hunk_index, h),
                    old_start: h.old_start,
                    old_len: h.old_len,
                    new_start: h.new_start,
                    new_len: h.new_len,
                    removed: h.removed.clone(),
                    added: h.added.clone(),
                });
            }
        }
        files.push(ProposedFile {
            path,
            change,
            base_blob,
            proposed_blob,
            binary,
            oversized,
            sensitive,
            additions,
            deletions,
            hunks,
            flags,
        });
    }

    let record = ProposalRecord {
        schema_version: SCHEMA_VERSION,
        id: new_id(),
        patch_hash: patch_hash_of(&files),
        base_state_hash: base_state_hash_of(&files),
        scope,
        base_commit: base_commit.to_string(),
        files,
        created_at: crate::audit::now(),
        state: ProposalState::Pending,
        history: vec![HistoryEvent {
            at: crate::audit::now(),
            event: "created".into(),
            detail: String::new(),
        }],
    };
    save(data_folder, &record).map_err(ProposalError::Io)?;
    audit(
        data_folder,
        &record,
        "created",
        format!("{} file(s)", record.files.len()),
    );
    Ok(record)
}

/// One file of a change, counted the way a proposal would count it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSummary {
    pub path: String,
    pub change: Change,
    pub additions: usize,
    pub deletions: usize,
    pub binary: bool,
}

/// What a set of changes amounts to, without storing anything.
///
/// For a list of work waiting for review: the counts are staged exactly as
/// [`create`] stages them, so the number beside a file in the list is the
/// number the review shows when it is opened.
pub fn summarize(inputs: &[FileInput]) -> Result<Vec<FileSummary>, ProposalError> {
    let mut out = Vec::with_capacity(inputs.len());
    for input in inputs {
        if input.base == input.proposed {
            continue;
        }
        let path = normalize_path(&input.path)?;
        let change = match (&input.base, &input.proposed) {
            (None, Some(_)) => Change::Added,
            (Some(_), None) => Change::Deleted,
            _ => Change::Modified,
        };
        let binary = input.base.as_deref().is_some_and(is_binary)
            || input.proposed.as_deref().is_some_and(is_binary);
        let size = input
            .base
            .as_ref()
            .map_or(0, Vec::len)
            .max(input.proposed.as_ref().map_or(0, Vec::len));
        let (mut additions, mut deletions) = (0, 0);
        if !binary && size <= OVERSIZED_BYTES {
            let base_text = input.base.as_deref().map(|b| String::from_utf8_lossy(b).to_string());
            let new_text = input
                .proposed
                .as_deref()
                .map(|b| String::from_utf8_lossy(b).to_string())
                .unwrap_or_default();
            for h in crate::patch::StagedPatch::stage(base_text.as_deref(), &new_text).hunks() {
                additions += h.added.len();
                deletions += h.removed.len();
            }
        }
        out.push(FileSummary {
            path,
            change,
            additions,
            deletions,
            binary,
        });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

// ---------------------------------------------------------------------------
// Planning: validation and a dry run
// ---------------------------------------------------------------------------

/// One file's outcome, computed without touching the destination.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedFile {
    pub path: String,
    /// `None` removes the file.
    pub content: Option<Vec<u8>>,
    /// What the destination held when planned, for rollback.
    pub current: Option<Vec<u8>>,
}

fn split_keep(text: &str) -> Vec<&str> {
    text.split_inclusive('\n').collect()
}

/// A change to a base range: `[start, end)` in base lines replaced by `lines`.
#[derive(Debug, Clone)]
struct Edit<'a> {
    start: usize,
    end: usize,
    lines: Vec<&'a str>,
    hunk: Option<String>,
}

fn edits_between<'a>(base: &str, current: &'a str) -> Vec<Edit<'a>> {
    let diff = TextDiff::from_lines(base, current);
    let new_lines = split_keep(current);
    let mut out: Vec<Edit<'a>> = Vec::new();
    for op in diff.ops() {
        if matches!(op, DiffOp::Equal { .. }) {
            continue;
        }
        let (o, n) = (op.old_range(), op.new_range());
        // Adjacent non-equal ops are one edit.
        if let Some(last) = out.last_mut() {
            if last.end == o.start {
                last.end = o.end;
                last.lines.extend_from_slice(&new_lines[n.clone()]);
                continue;
            }
        }
        out.push(Edit {
            start: o.start,
            end: o.end,
            lines: new_lines[n].to_vec(),
            hunk: None,
        });
    }
    out
}

/// Two edits collide when their base ranges overlap or touch. Touching counts:
/// an insertion right beside a changed line is a change to the same place, and
/// merging it silently is how an edit ends up in the middle of another.
fn collides(a: &Edit, b: &Edit) -> bool {
    a.start <= b.end && b.start <= a.end
}

fn merge_text<'a>(
    base: &'a str,
    user: &[Edit<'a>],
    selected: &[Edit<'a>],
    path: &str,
) -> Result<String, Vec<Conflict>> {
    // A selected hunk the destination already holds, exactly, is not a
    // conflict with itself: it is what a second proposal from the same
    // worktree looks like after part of the first was applied.
    let same = |s: &Edit, u: &Edit| s.start == u.start && s.end == u.end && s.lines == u.lines;
    let selected: Vec<Edit<'a>> = selected
        .iter()
        .filter(|s| !user.iter().any(|u| same(s, u)))
        .cloned()
        .collect();
    let selected = selected.as_slice();
    let conflicts: Vec<Conflict> = selected
        .iter()
        .filter(|s| user.iter().any(|u| collides(s, u)))
        .map(|s| Conflict {
            path: path.to_string(),
            hunk: s.hunk.clone().unwrap_or_default(),
            reason: "the same lines were changed at the destination".into(),
        })
        .collect();
    if !conflicts.is_empty() {
        return Err(conflicts);
    }
    let base_lines = split_keep(base);
    let mut all: Vec<&Edit> = user.iter().chain(selected.iter()).collect();
    all.sort_by_key(|e| (e.start, e.end));
    let mut out = String::with_capacity(base.len());
    let mut at = 0;
    for e in all {
        out.extend(base_lines[at..e.start].iter().copied());
        out.extend(e.lines.iter().copied());
        at = e.end;
    }
    out.extend(base_lines[at..].iter().copied());
    Ok(out)
}

fn read_current(dest_root: &Path, path: &str) -> Result<Option<Vec<u8>>, ProposalError> {
    match std::fs::read(dest_root.join(path)) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(ProposalError::Io(e.to_string())),
    }
}

/// Validate an approval against the stored record and compute every file's
/// result against the destination as it is now. Writes nothing.
pub fn plan(
    data_folder: &Path,
    dest_root: &Path,
    approval: &Approval,
) -> Result<(ProposalRecord, Vec<PlannedFile>), ProposalError> {
    let record = load(data_folder, &approval.proposal_id)?;
    if record.state != ProposalState::Pending {
        return Err(ProposalError::NotPending(record.state));
    }
    if approval.patch_hash != record.patch_hash {
        return Err(ProposalError::PatchChanged);
    }
    if approval.base_state_hash != record.base_state_hash {
        return Err(ProposalError::BaseChanged);
    }
    // Identity, field by field: a match on session alone would let one agent's
    // change be approved as another's.
    for (what, a, b) in [
        ("session", &approval.scope.session, &record.scope.session),
        ("project", &approval.scope.project, &record.scope.project),
        ("agent", &approval.scope.agent, &record.scope.agent),
        ("worktree", &approval.scope.worktree, &record.scope.worktree),
        ("run", &approval.scope.run, &record.scope.run),
    ] {
        if a != b {
            return Err(ProposalError::ScopeMismatch(what));
        }
    }
    // The stored record must still hash to what it says. A record edited on
    // disk after it was shown is not the record that was approved.
    if patch_hash_of(&record.files) != record.patch_hash {
        return Err(ProposalError::PatchChanged);
    }

    let by_path: BTreeMap<&str, &ProposedFile> =
        record.files.iter().map(|f| (f.path.as_str(), f)).collect();
    let mut seen_paths = BTreeSet::new();
    let mut planned = Vec::new();
    let mut conflicts = Vec::new();
    let mut unacknowledged = Vec::new();

    for sel in &approval.files {
        let Some(file) = by_path.get(sel.path.as_str()).copied() else {
            return Err(ProposalError::UnknownFile(sel.path.clone()));
        };
        if !seen_paths.insert(sel.path.as_str()) {
            return Err(ProposalError::DuplicateSelection(sel.path.clone()));
        }
        if file.sensitive {
            return Err(ProposalError::Sensitive(file.path.clone()));
        }
        // Looked at now, immediately before anything is written, rather than
        // when the proposal was made: a directory replaced by a junction
        // after the review was shown is exactly the substitution this stops.
        if passes_through_link(dest_root, &file.path) {
            return Err(ProposalError::LinkedDestination(file.path.clone()));
        }
        if resolves_into_reserved(dest_root, &file.path) {
            return Err(ProposalError::InvalidPath(file.path.clone()));
        }
        let chosen: Vec<&ProposedHunk> = match &sel.hunks {
            HunkChoice::All => file.hunks.iter().collect(),
            HunkChoice::Only(ids) => {
                if file.binary || file.oversized {
                    return Err(ProposalError::WholeFileOnly(file.path.clone()));
                }
                let mut seen = BTreeSet::new();
                let mut out = Vec::new();
                for id in ids {
                    if !seen.insert(id.as_str()) {
                        return Err(ProposalError::DuplicateSelection(id.clone()));
                    }
                    let Some(h) = file.hunks.iter().find(|h| &h.id == id) else {
                        return Err(ProposalError::UnknownHunk(id.clone()));
                    };
                    out.push(h);
                }
                out
            }
        };
        if chosen.is_empty() && !(file.binary || file.oversized) {
            continue;
        }

        let base = match &file.base_blob {
            Some(id) => Some(read_blob(data_folder, id).map_err(ProposalError::Io)?),
            None => None,
        };
        let proposed = match &file.proposed_blob {
            Some(id) => Some(read_blob(data_folder, id).map_err(ProposalError::Io)?),
            None => None,
        };
        // From the content, not from the record's `flags`: a record whose
        // flags were emptied on disk still needs the acknowledgement.
        let flagged = !file.flags.is_empty()
            || !crate::review_flags::flags_for(&file.path, base.as_deref(), proposed.as_deref())
                .is_empty();
        if flagged && !approval.acknowledged.iter().any(|p| p == &file.path) {
            unacknowledged.push(file.path.clone());
            continue;
        }
        let current = read_current(dest_root, &file.path)?;

        // Whole-file changes: the destination must still be the base.
        let whole = file.binary || file.oversized || file.change != Change::Modified;
        if whole {
            if current != base {
                conflicts.push(Conflict {
                    path: file.path.clone(),
                    hunk: String::new(),
                    reason: match (&base, &current) {
                        (None, Some(_)) => "the file was created at the destination".into(),
                        (Some(_), None) => "the file was deleted at the destination".into(),
                        _ => "the file was changed at the destination".into(),
                    },
                });
                continue;
            }
            planned.push(PlannedFile {
                path: file.path.clone(),
                content: proposed,
                current,
            });
            continue;
        }

        let base_text = String::from_utf8_lossy(base.as_deref().unwrap_or_default()).to_string();
        let proposed_text =
            String::from_utf8_lossy(proposed.as_deref().unwrap_or_default()).to_string();
        let Some(current_bytes) = current.clone() else {
            conflicts.push(Conflict {
                path: file.path.clone(),
                hunk: String::new(),
                reason: "the file was deleted at the destination".into(),
            });
            continue;
        };
        let Ok(current_text) = String::from_utf8(current_bytes) else {
            conflicts.push(Conflict {
                path: file.path.clone(),
                hunk: String::new(),
                reason: "the file at the destination is no longer text".into(),
            });
            continue;
        };
        let proposed_lines = split_keep(&proposed_text);
        let selected: Vec<Edit> = chosen
            .iter()
            .map(|h| {
                let from = h.new_start.saturating_sub(1).min(proposed_lines.len());
                let to = (from + h.new_len).min(proposed_lines.len());
                // `old_start` is the 1-based start of the base range, empty or
                // not: `patch.rs` does not use unified diff's "the line it
                // follows" convention for pure insertions.
                let start = h.old_start.saturating_sub(1);
                Edit {
                    start,
                    end: start + h.old_len,
                    lines: proposed_lines[from..to].to_vec(),
                    hunk: Some(h.id.clone()),
                }
            })
            .collect();
        let user = edits_between(&base_text, &current_text);
        match merge_text(&base_text, &user, &selected, &file.path) {
            Ok(merged) => planned.push(PlannedFile {
                path: file.path.clone(),
                content: Some(merged.into_bytes()),
                current: Some(current_text.into_bytes()),
            }),
            Err(mut c) => conflicts.append(&mut c),
        }
    }

    if !unacknowledged.is_empty() {
        return Err(ProposalError::Unacknowledged(unacknowledged));
    }
    if !conflicts.is_empty() {
        return Err(ProposalError::Conflicts(conflicts));
    }
    Ok((record, planned))
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReport {
    pub proposal_id: String,
    pub state: ProposalState,
    pub files_written: usize,
}

fn write_file(dest_root: &Path, path: &str, content: Option<&[u8]>) -> Result<(), String> {
    let target = dest_root.join(path);
    match content {
        Some(bytes) => write_atomic(&target, bytes),
        None => match std::fs::remove_file(&target) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        },
    }
}

/// Apply an approval. All files land, or none do.
pub fn apply(
    data_folder: &Path,
    dest_root: &Path,
    approval: &Approval,
) -> Result<ApplyReport, ProposalError> {
    let (mut record, planned) = match plan(data_folder, dest_root, approval) {
        Ok(ok) => ok,
        Err(err) => {
            // Refusals and conflicts are part of the proposal's story; the
            // proposal itself is kept for review and retry.
            if let Ok(mut record) = load(data_folder, &approval.proposal_id) {
                let (event, detail) = match &err {
                    ProposalError::Conflicts(c) => (
                        "conflict",
                        c.iter()
                            .map(|c| format!("{}#{}", c.path, c.hunk))
                            .collect::<Vec<_>>()
                            .join(","),
                    ),
                    other => ("refused", format!("{other:?}")),
                };
                record.history.push(HistoryEvent {
                    at: crate::audit::now(),
                    event: event.into(),
                    detail: detail.clone(),
                });
                let _ = save(data_folder, &record);
                audit(data_folder, &record, event, detail);
            }
            return Err(err);
        }
    };

    let mut written: Vec<&PlannedFile> = Vec::new();
    for file in &planned {
        if let Err(e) = write_file(dest_root, &file.path, file.content.as_deref()) {
            // Put back everything already written, in reverse.
            for done in written.iter().rev() {
                let _ = write_file(dest_root, &done.path, done.current.as_deref());
            }
            audit(data_folder, &record, "rolled-back", format!("{}: {e}", file.path));
            return Err(ProposalError::Io(e));
        }
        written.push(file);
    }

    let total_hunks: usize = record.files.iter().map(|f| f.hunks.len().max(1)).sum();
    let chosen_hunks: usize = approval
        .files
        .iter()
        .map(|s| {
            let file = record.files.iter().find(|f| f.path == s.path);
            match (&s.hunks, file) {
                (HunkChoice::All, Some(f)) => f.hunks.len().max(1),
                (HunkChoice::Only(ids), _) => ids.len(),
                _ => 0,
            }
        })
        .sum();
    record.state = if chosen_hunks >= total_hunks {
        ProposalState::Applied
    } else {
        ProposalState::PartiallyApplied
    };
    let detail = format!("{} file(s), {chosen_hunks}/{total_hunks} hunk(s)", planned.len());
    record.history.push(HistoryEvent {
        at: crate::audit::now(),
        event: "applied".into(),
        detail: detail.clone(),
    });
    save(data_folder, &record).map_err(ProposalError::Io)?;
    audit(data_folder, &record, "applied", detail);
    Ok(ApplyReport {
        proposal_id: record.id.clone(),
        state: record.state,
        files_written: planned.len(),
    })
}

/// Reject a proposal outright. Nothing at the destination changes.
pub fn reject(
    data_folder: &Path,
    id: &str,
    scope: &ProposalScope,
) -> Result<ProposalRecord, ProposalError> {
    let mut record = load(data_folder, id)?;
    if record.state != ProposalState::Pending {
        return Err(ProposalError::NotPending(record.state));
    }
    if scope.session != record.scope.session || scope.project != record.scope.project {
        return Err(ProposalError::ScopeMismatch("session or project"));
    }
    record.state = ProposalState::Rejected;
    record.history.push(HistoryEvent {
        at: crate::audit::now(),
        event: "rejected".into(),
        detail: String::new(),
    });
    save(data_folder, &record).map_err(ProposalError::Io)?;
    audit(data_folder, &record, "rejected", String::new());
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dirs(name: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "jan-proposal-{name}-{}-{}",
            std::process::id(),
            new_id()
        ));
        let data = root.join("data");
        let dest = root.join("project");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&dest).unwrap();
        (data, dest)
    }

    fn scope(dest: &Path) -> ProposalScope {
        ProposalScope {
            session: "s1".into(),
            run: "r1".into(),
            agent: "main".into(),
            project: dest.to_string_lossy().to_string(),
            ..Default::default()
        }
    }

    const BASE: &str = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n";
    const PROPOSED: &str = "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\nEIGHT\n";

    fn two_hunks(data: &Path, dest: &Path) -> ProposalRecord {
        std::fs::write(dest.join("a.txt"), BASE).unwrap();
        create(
            data,
            scope(dest),
            "abc123",
            vec![FileInput {
                path: "a.txt".into(),
                base: Some(BASE.as_bytes().to_vec()),
                proposed: Some(PROPOSED.as_bytes().to_vec()),
            }],
        )
        .unwrap()
    }

    fn approve(record: &ProposalRecord, dest: &Path, files: Vec<FileSelection>) -> Approval {
        Approval {
            proposal_id: record.id.clone(),
            patch_hash: record.patch_hash.clone(),
            base_state_hash: record.base_state_hash.clone(),
            scope: scope(dest),
            files,
            acknowledged: Vec::new(),
        }
    }

    fn all(path: &str) -> FileSelection {
        FileSelection {
            path: path.into(),
            hunks: HunkChoice::All,
        }
    }

    #[test]
    fn a_proposal_is_stored_before_anything_is_approved() {
        let (data, dest) = dirs("stored");
        let record = two_hunks(&data, &dest);
        assert_eq!(record.files[0].hunks.len(), 2);
        let loaded = load(&data, &record.id).unwrap();
        assert_eq!(loaded, record);
        // The destination is untouched by creating a proposal.
        assert_eq!(std::fs::read_to_string(dest.join("a.txt")).unwrap(), BASE);
    }

    #[test]
    fn approving_everything_lands_the_proposal() {
        let (data, dest) = dirs("all");
        let record = two_hunks(&data, &dest);
        let report = apply(&data, &dest, &approve(&record, &dest, vec![all("a.txt")])).unwrap();
        assert_eq!(report.state, ProposalState::Applied);
        assert_eq!(std::fs::read_to_string(dest.join("a.txt")).unwrap(), PROPOSED);
    }

    #[test]
    fn approving_one_of_two_hunks_lands_only_that_one() {
        let (data, dest) = dirs("one");
        let record = two_hunks(&data, &dest);
        let first = record.files[0].hunks[0].id.clone();
        let report = apply(
            &data,
            &dest,
            &approve(
                &record,
                &dest,
                vec![FileSelection {
                    path: "a.txt".into(),
                    hunks: HunkChoice::Only(vec![first]),
                }],
            ),
        )
        .unwrap();
        assert_eq!(report.state, ProposalState::PartiallyApplied);
        let text = std::fs::read_to_string(dest.join("a.txt")).unwrap();
        assert!(text.starts_with("ONE\n"));
        // The rejected hunk is not applied.
        assert!(text.ends_with("eight\n"), "{text}");
    }

    #[test]
    fn an_unrelated_edit_at_the_destination_is_preserved() {
        let (data, dest) = dirs("preserve");
        let record = two_hunks(&data, &dest);
        std::fs::write(dest.join("a.txt"), BASE.replace("four\n", "four (mine)\n")).unwrap();
        apply(&data, &dest, &approve(&record, &dest, vec![all("a.txt")])).unwrap();
        let text = std::fs::read_to_string(dest.join("a.txt")).unwrap();
        assert!(text.contains("four (mine)"), "{text}");
        assert!(text.starts_with("ONE\n") && text.ends_with("EIGHT\n"), "{text}");
    }

    #[test]
    fn an_overlapping_edit_is_a_conflict_and_nothing_is_written() {
        let (data, dest) = dirs("conflict");
        let record = two_hunks(&data, &dest);
        let edited = BASE.replace("one\n", "one, edited by someone else\n");
        std::fs::write(dest.join("a.txt"), &edited).unwrap();
        let err = apply(&data, &dest, &approve(&record, &dest, vec![all("a.txt")])).unwrap_err();
        let ProposalError::Conflicts(c) = err else {
            panic!("expected conflicts")
        };
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].hunk, record.files[0].hunks[0].id);
        assert_eq!(std::fs::read_to_string(dest.join("a.txt")).unwrap(), edited);
        // Kept for review and retry, with the conflict in its history.
        let kept = load(&data, &record.id).unwrap();
        assert_eq!(kept.state, ProposalState::Pending);
        assert!(kept.history.iter().any(|h| h.event == "conflict"));
    }

    #[test]
    fn a_changed_patch_or_base_is_refused() {
        let (data, dest) = dirs("hashes");
        let record = two_hunks(&data, &dest);
        let mut a = approve(&record, &dest, vec![all("a.txt")]);
        a.patch_hash = "0".repeat(64);
        assert_eq!(apply(&data, &dest, &a), Err(ProposalError::PatchChanged));
        let mut a = approve(&record, &dest, vec![all("a.txt")]);
        a.base_state_hash = "0".repeat(64);
        assert_eq!(apply(&data, &dest, &a), Err(ProposalError::BaseChanged));
        assert_eq!(std::fs::read_to_string(dest.join("a.txt")).unwrap(), BASE);
    }

    #[test]
    fn a_record_edited_on_disk_after_it_was_shown_is_refused() {
        let (data, dest) = dirs("tamper");
        let record = two_hunks(&data, &dest);
        let mut tampered = record.clone();
        tampered.files[0].hunks[0].added = vec!["rm -rf /".into()];
        save(&data, &tampered).unwrap();
        let err = apply(&data, &dest, &approve(&record, &dest, vec![all("a.txt")])).unwrap_err();
        assert_eq!(err, ProposalError::PatchChanged);
        assert_eq!(std::fs::read_to_string(dest.join("a.txt")).unwrap(), BASE);
    }

    #[test]
    fn a_cross_agent_or_cross_project_approval_is_refused() {
        let (data, dest) = dirs("scope");
        let record = two_hunks(&data, &dest);
        let mut a = approve(&record, &dest, vec![all("a.txt")]);
        a.scope.agent = "reviewer".into();
        assert_eq!(apply(&data, &dest, &a), Err(ProposalError::ScopeMismatch("agent")));
        let mut a = approve(&record, &dest, vec![all("a.txt")]);
        a.scope.project = "C:/elsewhere".into();
        assert_eq!(apply(&data, &dest, &a), Err(ProposalError::ScopeMismatch("project")));
    }

    #[test]
    fn unknown_and_duplicate_selections_are_refused() {
        let (data, dest) = dirs("selection");
        let record = two_hunks(&data, &dest);
        let id = record.files[0].hunks[0].id.clone();
        let only = |ids: Vec<String>| {
            approve(
                &record,
                &dest,
                vec![FileSelection {
                    path: "a.txt".into(),
                    hunks: HunkChoice::Only(ids),
                }],
            )
        };
        assert_eq!(
            apply(&data, &dest, &only(vec!["0.9-nope".into()])),
            Err(ProposalError::UnknownHunk("0.9-nope".into()))
        );
        assert_eq!(
            apply(&data, &dest, &only(vec![id.clone(), id.clone()])),
            Err(ProposalError::DuplicateSelection(id))
        );
        assert_eq!(
            apply(&data, &dest, &approve(&record, &dest, vec![all("a.txt"), all("a.txt")])),
            Err(ProposalError::DuplicateSelection("a.txt".into()))
        );
        assert_eq!(
            apply(&data, &dest, &approve(&record, &dest, vec![all("other.txt")])),
            Err(ProposalError::UnknownFile("other.txt".into()))
        );
    }

    #[test]
    fn an_applied_proposal_cannot_be_applied_again() {
        let (data, dest) = dirs("stale");
        let record = two_hunks(&data, &dest);
        let a = approve(&record, &dest, vec![all("a.txt")]);
        apply(&data, &dest, &a).unwrap();
        assert_eq!(
            apply(&data, &dest, &a),
            Err(ProposalError::NotPending(ProposalState::Applied))
        );
    }

    #[test]
    fn a_sensitive_file_is_never_applied() {
        let (data, dest) = dirs("sensitive");
        let record = create(
            &data,
            scope(&dest),
            "",
            vec![FileInput {
                path: "config.txt".into(),
                base: None,
                proposed: Some(b"api_key = sk-live-abcdefghijklmnopqrstuvwxyz0123\n".to_vec()),
            }],
        )
        .unwrap();
        assert!(record.files[0].sensitive);
        let err = apply(&data, &dest, &approve(&record, &dest, vec![all("config.txt")])).unwrap_err();
        assert_eq!(err, ProposalError::Sensitive("config.txt".into()));
        assert!(!dest.join("config.txt").exists());
    }

    #[test]
    fn a_binary_file_is_decided_whole_and_lands_byte_for_byte() {
        let (data, dest) = dirs("binary");
        let bytes: Vec<u8> = vec![0, 159, 146, 150, 0, 1, 2];
        let record = create(
            &data,
            scope(&dest),
            "",
            vec![FileInput {
                path: "img.bin".into(),
                base: None,
                proposed: Some(bytes.clone()),
            }],
        )
        .unwrap();
        assert!(record.files[0].binary && record.files[0].hunks.is_empty());
        let partial = approve(
            &record,
            &dest,
            vec![FileSelection {
                path: "img.bin".into(),
                hunks: HunkChoice::Only(vec![]),
            }],
        );
        assert_eq!(
            apply(&data, &dest, &partial),
            Err(ProposalError::WholeFileOnly("img.bin".into()))
        );
        // A binary file is flagged: it lands only once acknowledged (AH-169).
        assert_eq!(
            apply(&data, &dest, &approve(&record, &dest, vec![all("img.bin")])),
            Err(ProposalError::Unacknowledged(vec!["img.bin".into()]))
        );
        let mut ok = approve(&record, &dest, vec![all("img.bin")]);
        ok.acknowledged = vec!["img.bin".into()];
        apply(&data, &dest, &ok).unwrap();
        assert_eq!(std::fs::read(dest.join("img.bin")).unwrap(), bytes);
    }

    #[test]
    fn a_file_created_underneath_an_added_file_is_a_conflict() {
        let (data, dest) = dirs("created");
        let record = create(
            &data,
            scope(&dest),
            "",
            vec![FileInput {
                path: "new.txt".into(),
                base: None,
                proposed: Some(b"from the agent\n".to_vec()),
            }],
        )
        .unwrap();
        std::fs::write(dest.join("new.txt"), "from the user\n").unwrap();
        let err = apply(&data, &dest, &approve(&record, &dest, vec![all("new.txt")])).unwrap_err();
        assert!(matches!(err, ProposalError::Conflicts(_)));
        assert_eq!(
            std::fs::read_to_string(dest.join("new.txt")).unwrap(),
            "from the user\n"
        );
    }

    /// All or nothing: a failure part-way puts back what was already written.
    #[test]
    fn a_failed_write_rolls_back_the_files_already_written() {
        let (data, dest) = dirs("rollback");
        std::fs::write(dest.join("a.txt"), "a\n").unwrap();
        let record = create(
            &data,
            scope(&dest),
            "",
            vec![
                FileInput {
                    path: "a.txt".into(),
                    base: Some(b"a\n".to_vec()),
                    proposed: Some(b"A\n".to_vec()),
                },
                FileInput {
                    path: "b/c.txt".into(),
                    base: None,
                    proposed: Some(b"c\n".to_vec()),
                },
            ],
        )
        .unwrap();
        // `b` is a file, so `b/c.txt` cannot be written.
        std::fs::write(dest.join("b"), "in the way\n").unwrap();
        let err = apply(
            &data,
            &dest,
            &approve(&record, &dest, vec![all("a.txt"), all("b/c.txt")]),
        )
        .unwrap_err();
        assert!(matches!(err, ProposalError::Io(_)));
        assert_eq!(std::fs::read_to_string(dest.join("a.txt")).unwrap(), "a\n");
    }

    #[test]
    fn paths_outside_the_project_are_refused_at_creation() {
        let (data, dest) = dirs("paths");
        for bad in ["../escape.txt", "/etc/passwd", "C:/Windows/x", ".jan/state"] {
            let err = create(
                &data,
                scope(&dest),
                "",
                vec![FileInput {
                    path: bad.into(),
                    base: None,
                    proposed: Some(b"x\n".to_vec()),
                }],
            )
            .unwrap_err();
            assert!(matches!(err, ProposalError::InvalidPath(_)), "{bad}");
        }
    }

    #[test]
    fn two_spellings_of_one_path_are_one_file_on_windows() {
        let (data, dest) = dirs("casing");
        let err = create(
            &data,
            scope(&dest),
            "",
            vec![
                FileInput {
                    path: "Src/Main.rs".into(),
                    base: None,
                    proposed: Some(b"a\n".to_vec()),
                },
                FileInput {
                    path: "src/main.rs".into(),
                    base: None,
                    proposed: Some(b"b\n".to_vec()),
                },
            ],
        )
        .unwrap_err();
        assert!(matches!(err, ProposalError::DuplicatePath(_)));
    }

    #[test]
    fn the_audit_links_creation_and_application_and_holds_no_content() {
        let (data, dest) = dirs("audit");
        let record = two_hunks(&data, &dest);
        apply(&data, &dest, &approve(&record, &dest, vec![all("a.txt")])).unwrap();
        let log = std::fs::read_to_string(data.join("audit").join("proposals.jsonl")).unwrap();
        let events: Vec<&str> = log.lines().collect();
        assert!(events.iter().any(|l| l.contains("\"event\":\"created\"")));
        assert!(events.iter().any(|l| l.contains("\"event\":\"applied\"")));
        assert!(events.iter().all(|l| l.contains(&record.id)));
        assert!(!log.contains("ONE") && !log.contains("EIGHT"), "content leaked: {log}");
    }

    /// Pure insertions have no base lines of their own; their position is the
    /// line they follow. Top, middle and end of file each land exactly.
    #[test]
    fn insertions_land_where_they_were_proposed() {
        for (base, proposed) in [
            ("a\nb\n", "X\na\nb\n"),
            ("a\nb\n", "a\nX\nb\n"),
            ("a\nb\n", "a\nb\nX\n"),
            ("a\nb\nc\nd\ne\nf\ng\n", "a\nX\nb\nc\nd\ne\nf\nY\ng\n"),
        ] {
            let (data, dest) = dirs("insert");
            std::fs::write(dest.join("f.txt"), base).unwrap();
            let record = create(
                &data,
                scope(&dest),
                "",
                vec![FileInput {
                    path: "f.txt".into(),
                    base: Some(base.as_bytes().to_vec()),
                    proposed: Some(proposed.as_bytes().to_vec()),
                }],
            )
            .unwrap();
            apply(&data, &dest, &approve(&record, &dest, vec![all("f.txt")])).unwrap();
            assert_eq!(
                std::fs::read_to_string(dest.join("f.txt")).unwrap(),
                proposed,
                "from {base:?}"
            );
        }
    }

    /// Each hunk of a multi-hunk insertion can be taken on its own.
    #[test]
    fn one_insertion_of_two_can_be_taken_alone() {
        let (data, dest) = dirs("insert-one");
        let base = "a\nb\nc\nd\ne\nf\ng\n";
        std::fs::write(dest.join("f.txt"), base).unwrap();
        let record = create(
            &data,
            scope(&dest),
            "",
            vec![FileInput {
                path: "f.txt".into(),
                base: Some(base.as_bytes().to_vec()),
                proposed: Some(b"a\nX\nb\nc\nd\ne\nf\nY\ng\n".to_vec()),
            }],
        )
        .unwrap();
        assert_eq!(record.files[0].hunks.len(), 2);
        let second = record.files[0].hunks[1].id.clone();
        apply(
            &data,
            &dest,
            &approve(
                &record,
                &dest,
                vec![FileSelection {
                    path: "f.txt".into(),
                    hunks: HunkChoice::Only(vec![second]),
                }],
            ),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(dest.join("f.txt")).unwrap(),
            "a\nb\nc\nd\ne\nf\nY\ng\n"
        );
    }

    #[test]
    fn a_deleted_file_is_removed_only_if_it_is_still_the_base() {
        let (data, dest) = dirs("delete");
        std::fs::write(dest.join("old.txt"), "gone\n").unwrap();
        let record = create(
            &data,
            scope(&dest),
            "",
            vec![FileInput {
                path: "old.txt".into(),
                base: Some(b"gone\n".to_vec()),
                proposed: None,
            }],
        )
        .unwrap();
        // A deletion is flagged: it needs acknowledging (AH-169).
        let err = apply(&data, &dest, &approve(&record, &dest, vec![all("old.txt")])).unwrap_err();
        assert_eq!(err, ProposalError::Unacknowledged(vec!["old.txt".into()]));
        let acked = || {
            let mut a = approve(&record, &dest, vec![all("old.txt")]);
            a.acknowledged = vec!["old.txt".into()];
            a
        };
        std::fs::write(dest.join("old.txt"), "kept by the user\n").unwrap();
        let err = apply(&data, &dest, &acked()).unwrap_err();
        assert!(matches!(err, ProposalError::Conflicts(_)));
        assert!(dest.join("old.txt").exists());
        std::fs::write(dest.join("old.txt"), "gone\n").unwrap();
        apply(&data, &dest, &acked()).unwrap();
        assert!(!dest.join("old.txt").exists());
    }

    /// After part of a proposal landed, a fresh proposal from the same worktree
    /// carries that part again. The destination already holding it exactly is
    /// not a conflict.
    #[test]
    fn a_hunk_the_destination_already_holds_is_not_a_conflict() {
        let (data, dest) = dirs("already");
        let record = two_hunks(&data, &dest);
        std::fs::write(dest.join("a.txt"), BASE.replace("one\n", "ONE\n")).unwrap();
        apply(&data, &dest, &approve(&record, &dest, vec![all("a.txt")])).unwrap();
        assert_eq!(std::fs::read_to_string(dest.join("a.txt")).unwrap(), PROPOSED);
    }

    #[test]
    fn a_rejected_proposal_changes_nothing_and_cannot_then_be_applied() {
        let (data, dest) = dirs("reject");
        let record = two_hunks(&data, &dest);
        reject(&data, &record.id, &scope(&dest)).unwrap();
        assert_eq!(
            apply(&data, &dest, &approve(&record, &dest, vec![all("a.txt")])),
            Err(ProposalError::NotPending(ProposalState::Rejected))
        );
        assert_eq!(std::fs::read_to_string(dest.join("a.txt")).unwrap(), BASE);
    }

    /// Spellings that Windows resolves to Git's directory, a device or an
    /// alternate stream are refused, on every platform.
    #[test]
    fn a_path_windows_would_read_differently_is_refused() {
        for bad in [
            ".git/config",
            ".GIT/hooks/pre-commit",
            ".git./config",
            ".git /config",
            "sub/.git/config",
            ".Jan/state",
            "notes.txt:hidden",
            "NUL",
            "src/con.txt",
            "Lpt1.log",
            "trailing.",
            "trailing ",
            "../outside.txt",
            "/abs.txt",
            "C:/abs.txt",
            "a/../../b.txt",
            // 8.3 short names of `.git` and `.jan`.
            "GIT~1/hooks/pre-commit",
            "git~2/config",
            "sub/Git~13/HEAD",
            "JAN~1/state",
        ] {
            assert!(
                matches!(normalize_path(bad), Err(ProposalError::InvalidPath(_))),
                "{bad} was accepted"
            );
        }
        for good in [
            "a.txt",
            "src/a.rs",
            "./b.txt",
            "console.txt",
            "com10.txt",
            ".gitignore",
            "git~notes.txt",
            "git~",
        ] {
            assert!(normalize_path(good).is_ok(), "{good} was refused");
        }
    }

    /// Whatever it is spelled as, a destination that resolves into the
    /// folder's `.git` is refused at apply time. Measured with the short name
    /// NTFS gives `.git`, where the volume has short names at all.
    #[cfg(windows)]
    #[test]
    fn a_short_name_for_git_is_refused_by_where_it_resolves() {
        let (_data, dest) = dirs("shortname");
        std::fs::create_dir_all(dest.join(".git").join("hooks")).unwrap();
        let alias = dest.join("GIT~1");
        if !alias.exists() {
            eprintln!("short names are off on this volume; nothing to measure");
            return;
        }
        assert!(resolves_into_reserved(&dest, "GIT~1/hooks/pre-commit"));
        assert!(resolves_into_reserved(&dest, "GIT~1"));
        assert!(!resolves_into_reserved(&dest, "src/GIT~1.txt"));
        assert!(!resolves_into_reserved(&dest, "a.txt"));
    }

    fn link_dir(link: &Path, target: &Path) -> bool {
        #[cfg(windows)]
        {
            // A junction needs no privilege, which is why it is the link a
            // user's folder is most likely to hold.
            std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }

    /// A directory in the folder replaced by a link after the review was shown
    /// is refused at apply time, with nothing written anywhere.
    #[test]
    fn a_destination_path_through_a_link_is_refused_and_nothing_is_written() {
        let (data, dest) = dirs("linked");
        let outside = dest.parent().unwrap().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::create_dir_all(dest.join("sub")).unwrap();
        std::fs::write(dest.join("sub").join("a.txt"), BASE).unwrap();
        std::fs::write(outside.join("a.txt"), BASE).unwrap();
        let record = create(
            &data,
            scope(&dest),
            "abc123",
            vec![FileInput {
                path: "sub/a.txt".into(),
                base: Some(BASE.as_bytes().to_vec()),
                proposed: Some(PROPOSED.as_bytes().to_vec()),
            }],
        )
        .unwrap();
        // The swap: the reviewed directory becomes a link to somewhere else.
        std::fs::remove_dir_all(dest.join("sub")).unwrap();
        assert!(link_dir(&dest.join("sub"), &outside), "could not make a link");
        let err = apply(&data, &dest, &approve(&record, &dest, vec![all("sub/a.txt")])).unwrap_err();
        assert_eq!(err, ProposalError::LinkedDestination("sub/a.txt".into()));
        assert_eq!(std::fs::read_to_string(outside.join("a.txt")).unwrap(), BASE);
        assert_eq!(load(&data, &record.id).unwrap().state, ProposalState::Pending);
    }

    #[test]
    fn a_summary_counts_what_the_proposal_would_show() {
        let (data, dest) = dirs("summary");
        let inputs = vec![
            FileInput {
                path: "a.txt".into(),
                base: Some(BASE.as_bytes().to_vec()),
                proposed: Some(PROPOSED.as_bytes().to_vec()),
            },
            FileInput {
                path: "new.txt".into(),
                base: None,
                proposed: Some(b"x\ny\n".to_vec()),
            },
        ];
        let summary = summarize(&inputs).unwrap();
        let record = create(&data, scope(&dest), "abc", inputs).unwrap();
        assert_eq!(summary.len(), record.files.len());
        for (s, f) in summary.iter().zip(&record.files) {
            assert_eq!((&s.path, s.change, s.additions, s.deletions), (&f.path, f.change, f.additions, f.deletions));
        }
        assert_eq!((summary[0].additions, summary[0].deletions), (2, 2));
    }

    // ---- AH-154/155/156: flagged changes need acknowledging ---------------

    const PKG_BEFORE: &str = "{\n  \"dependencies\": {\n    \"react\": \"^18.0.0\"\n  }\n}\n";
    const PKG_AFTER: &str =
        "{\n  \"dependencies\": {\n    \"react\": \"^18.0.0\",\n    \"left-pad\": \"1.3.0\"\n  }\n}\n";

    fn flagged(data: &Path, dest: &Path) -> ProposalRecord {
        std::fs::write(dest.join("package.json"), PKG_BEFORE).unwrap();
        std::fs::write(dest.join("a.txt"), BASE).unwrap();
        create(
            data,
            scope(dest),
            "abc123",
            vec![
                FileInput {
                    path: "package.json".into(),
                    base: Some(PKG_BEFORE.as_bytes().to_vec()),
                    proposed: Some(PKG_AFTER.as_bytes().to_vec()),
                },
                FileInput {
                    path: "a.txt".into(),
                    base: Some(BASE.as_bytes().to_vec()),
                    proposed: Some(PROPOSED.as_bytes().to_vec()),
                },
            ],
        )
        .unwrap()
    }

    #[test]
    fn a_dependency_change_is_flagged_and_not_applied_unacknowledged() {
        let (data, dest) = dirs("flag-refused");
        let record = flagged(&data, &dest);
        let pkg = record.files.iter().find(|f| f.path == "package.json").unwrap();
        assert_eq!(pkg.flags[0].kind, crate::review_flags::FlagKind::Dependency);
        assert!(pkg.flags[0].details.iter().any(|d| d.contains("left-pad")));
        assert!(record.files.iter().find(|f| f.path == "a.txt").unwrap().flags.is_empty());

        let err = apply(&data, &dest, &approve(&record, &dest, vec![all("package.json"), all("a.txt")]))
            .unwrap_err();
        assert_eq!(err, ProposalError::Unacknowledged(vec!["package.json".into()]));
        // Nothing was written, the unflagged file included.
        assert_eq!(std::fs::read_to_string(dest.join("package.json")).unwrap(), PKG_BEFORE);
        assert_eq!(std::fs::read_to_string(dest.join("a.txt")).unwrap(), BASE);
        assert_eq!(load(&data, &record.id).unwrap().state, ProposalState::Pending);

        // Acknowledging another file does not cover this one.
        let mut other = approve(&record, &dest, vec![all("package.json")]);
        other.acknowledged = vec!["a.txt".into(), "PACKAGE.JSON".into()];
        assert!(matches!(apply(&data, &dest, &other), Err(ProposalError::Unacknowledged(_))));
    }

    #[test]
    fn an_acknowledged_dependency_change_applies() {
        let (data, dest) = dirs("flag-acked");
        let record = flagged(&data, &dest);
        let mut ok = approve(&record, &dest, vec![all("package.json"), all("a.txt")]);
        ok.acknowledged = vec!["package.json".into()];
        apply(&data, &dest, &ok).unwrap();
        assert_eq!(std::fs::read_to_string(dest.join("package.json")).unwrap(), PKG_AFTER);
        // An unflagged file alone never needed it.
        let (data2, dest2) = dirs("flag-unflagged");
        let r2 = flagged(&data2, &dest2);
        apply(&data2, &dest2, &approve(&r2, &dest2, vec![all("a.txt")])).unwrap();
        assert_eq!(std::fs::read_to_string(dest2.join("a.txt")).unwrap(), PROPOSED);
    }

    /// The flag is worked out again from the stored content: emptying it in
    /// the record on disk, and re-hashing so the record still verifies, does
    /// not let the change through unacknowledged.
    #[test]
    fn a_flag_removed_from_the_stored_record_still_needs_acknowledging() {
        let (data, dest) = dirs("flag-tampered");
        let mut record = flagged(&data, &dest);
        for f in &mut record.files {
            f.flags.clear();
        }
        record.patch_hash = patch_hash_of(&record.files);
        save(&data, &record).unwrap();
        let err = apply(&data, &dest, &approve(&record, &dest, vec![all("package.json")])).unwrap_err();
        assert_eq!(err, ProposalError::Unacknowledged(vec!["package.json".into()]));
        assert_eq!(std::fs::read_to_string(dest.join("package.json")).unwrap(), PKG_BEFORE);
    }

    #[test]
    fn lock_files_and_migrations_need_acknowledging_too() {
        let (data, dest) = dirs("flag-lock-migration");
        std::fs::create_dir_all(dest.join("db/migrations")).unwrap();
        let record = create(
            &data,
            scope(&dest),
            "abc",
            vec![
                FileInput { path: "Cargo.lock".into(), base: None, proposed: Some(b"x\n".to_vec()) },
                FileInput {
                    path: "db/migrations/0002.sql".into(),
                    base: None,
                    proposed: Some(b"DROP TABLE users;\n".to_vec()),
                },
            ],
        )
        .unwrap();
        let err = apply(&data, &dest, &approve(&record, &dest, vec![all("Cargo.lock"), all("db/migrations/0002.sql")]))
            .unwrap_err();
        assert_eq!(
            err,
            ProposalError::Unacknowledged(vec!["Cargo.lock".into(), "db/migrations/0002.sql".into()])
        );
        assert!(!dest.join("Cargo.lock").exists());
        assert!(!dest.join("db/migrations/0002.sql").exists());
    }
}
