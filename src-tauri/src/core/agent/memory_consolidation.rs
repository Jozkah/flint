//! Idle-time memory consolidation ("autoDream").
//!
//! Folds the accumulated `<store>/memory/*.md` notes into a single
//! deduplicated, contradiction-resolved note. The intent is that after a long
//! session leaves many overlapping scraps behind, an idle machine quietly
//! reconciles them: near-identical facts collapse to one, a newer fact wins over
//! an older contradicting one (the conflict is recorded rather than silently
//! dropped), and anything that looks like a credential is filtered out before it
//! is ever rewritten.
//!
//! Everything here is off by default. [`ConsolidationConfig::default`] has
//! `enabled = false`, so the auto path (the frontend idle poller) is a no-op
//! until the store's `consolidation.json` turns it on. A manual run — the user
//! pressing "run now" — bypasses the enabled/idle gates but still honours every
//! safety guard: the cross-process lock, the path-safety check, and the atomic
//! temp-file-plus-rename write.
//!
//! ## Where the model would plug in
//!
//! The reconciliation is expressed through the [`Merger`] seam: given the raw
//! note texts, return the consolidated set. [`HeuristicMerger`] is the default,
//! deterministic implementation used by the command — it needs no model, so it
//! is always reachable and never spins up a second server. [`ModelMerger`] is
//! the drop-in that reuses the existing model-invocation path (a
//! [`ModelInvoker`], exactly as `goal::evaluate` uses one): build a request,
//! `invoke` it, parse the reply. [`run_consolidation`] selects between the two,
//! so wiring a live model later is a matter of handing it an invoker rather than
//! `None`. The command passes `None` today because constructing a live
//! `HttpModelInvoker` (provider configs, credentials, snapshot identity, quota
//! ledger) from a standalone command is more plumbing than the feature warrants.

use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri_plugin_agent_tools::harness_error::HarnessError;
use tauri_plugin_agent_tools::secrets;
use tokio::sync::mpsc;

use crate::core::agent::r#loop::ModelInvoker;

/// The single note the consolidated set is written to. Excluded from the input
/// scan so it never folds itself, and ignored by the "something new" check.
pub(crate) const OUTPUT_NOTE: &str = "consolidated";
const OUTPUT_FILE: &str = "consolidated.md";
const LOCK_FILE: &str = "consolidation.lock";
const CHECKPOINT_FILE: &str = ".consolidation-checkpoint";
const CONFIG_FILE: &str = "consolidation.json";

/// How long a held lock is trusted before it is treated as abandoned. A crash
/// leaves the lock file behind, so without a reclaim window consolidation would
/// wedge permanently after the first hard failure.
const DEFAULT_STALE_LOCK_SECS: u64 = 15 * 60;

// -- configuration ---------------------------------------------------------

/// Persisted, per-store consolidation settings. Disabled by default: reaching
/// the auto path requires the user to have turned it on for this store.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConsolidationConfig {
    /// The master switch. `false` unless the store opts in. The auto path never
    /// runs while this is false; a manual run overrides it.
    pub enabled: bool,
    /// Seconds of inactivity before the auto path is allowed to fire.
    pub idle_threshold_secs: u64,
    /// Upper bound on how many source notes one run reads, so an unbounded store
    /// cannot turn one idle tick into an arbitrarily large job.
    pub max_notes: usize,
    /// Upper bound on the total source bytes one run reads, as a coarse token
    /// proxy — a stand-in for a model context budget.
    pub max_input_bytes: usize,
}

impl Default for ConsolidationConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            idle_threshold_secs: 300,
            max_notes: 200,
            max_input_bytes: 256 * 1024,
        }
    }
}

impl ConsolidationConfig {
    /// Load `<dir>/consolidation.json`, or the disabled default when it is
    /// absent or unreadable. A malformed config is never a licence to run: it
    /// falls back to the default, which is off.
    pub(crate) fn load(dir: &Path) -> Self {
        std::fs::read_to_string(dir.join(CONFIG_FILE))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }
}

// -- activity / idle gate --------------------------------------------------

/// The last moment the user was seen active, in Unix epoch milliseconds. The
/// frontend keeps this fresh; the backend only compares against it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ActivitySnapshot {
    pub last_activity_ms: u64,
}

impl ActivitySnapshot {
    /// Whether at least `threshold_secs` have elapsed since the last activity.
    /// Saturating, so a `now` before `last_activity_ms` (clock skew) reads as
    /// "not idle" rather than instantly idle.
    pub(crate) fn is_idle(&self, now_ms: u64, threshold_secs: u64) -> bool {
        let elapsed_ms = now_ms.saturating_sub(self.last_activity_ms);
        elapsed_ms >= threshold_secs.saturating_mul(1000)
    }
}

// -- cross-process lock ----------------------------------------------------

/// A held `consolidation.lock`. Dropping it releases the lock, so a run that
/// panics still frees the store for the next attempt.
pub(crate) struct ConsolidationLock {
    path: PathBuf,
    released: bool,
}

impl ConsolidationLock {
    /// Release explicitly. Idempotent with the `Drop` release.
    pub(crate) fn release(mut self) {
        self.remove();
    }

    fn remove(&mut self) {
        if !self.released {
            let _ = std::fs::remove_file(&self.path);
            self.released = true;
        }
    }
}

impl Drop for ConsolidationLock {
    fn drop(&mut self) {
        self.remove();
    }
}

/// Try to take the store's consolidation lock.
///
/// Returns `Ok(Some(guard))` when the lock was free (or reclaimed as stale), and
/// `Ok(None)` when another process holds a fresh lock — the caller backs off
/// quietly rather than erroring. A lock older than `stale_after_secs` is treated
/// as abandoned and reclaimed, so a crashed run cannot wedge the store forever.
pub(crate) fn acquire_lock(
    dir: &Path,
    now_ms: u64,
    stale_after_secs: u64,
) -> Result<Option<ConsolidationLock>, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(LOCK_FILE);

    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(_) => {
            write_lock_body(&path, now_ms);
            Ok(Some(ConsolidationLock {
                path,
                released: false,
            }))
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let held_ms = read_lock_stamp(&path);
            let age_ms = now_ms.saturating_sub(held_ms);
            if age_ms >= stale_after_secs.saturating_mul(1000) {
                // Stale: reclaim by overwriting the stamp with ours.
                write_lock_body(&path, now_ms);
                Ok(Some(ConsolidationLock {
                    path,
                    released: false,
                }))
            } else {
                Ok(None)
            }
        }
        Err(e) => Err(e.to_string()),
    }
}

/// The lock body is `<pid> <epoch_ms>`; only the timestamp matters to staleness.
fn write_lock_body(path: &Path, now_ms: u64) {
    let _ = std::fs::write(path, format!("{} {}", std::process::id(), now_ms));
}

/// Read the stored acquisition time, defaulting to 0 (immediately stale) when
/// the body is missing or unparseable — a corrupt lock is a reclaimable one.
fn read_lock_stamp(path: &Path) -> u64 {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| s.split_whitespace().nth(1).and_then(|t| t.parse().ok()))
        .unwrap_or(0)
}

// -- checkpoint ("new since") ---------------------------------------------

/// The epoch-ms of the last completed run, or `None` when the store has never
/// been consolidated.
pub(crate) fn read_checkpoint(dir: &Path) -> Option<u64> {
    std::fs::read_to_string(dir.join(CHECKPOINT_FILE))
        .ok()
        .and_then(|s| s.trim().parse().ok())
}

fn write_checkpoint(dir: &Path, now_ms: u64) -> Result<(), String> {
    std::fs::write(dir.join(CHECKPOINT_FILE), now_ms.to_string()).map_err(|e| e.to_string())
}

/// Whether any source note has changed since the checkpoint. A never-run store
/// with notes is always "new"; a store whose only file is the consolidated
/// output (or the bookkeeping files) is never new, so an unchanged store is a
/// no-op.
pub(crate) fn has_new_since(dir: &Path, checkpoint: Option<u64>) -> bool {
    let notes = read_source_notes(dir, usize::MAX, usize::MAX);
    match checkpoint {
        None => !notes.is_empty(),
        Some(cp) => notes.iter().any(|n| n.modified_ms > cp),
    }
}

// -- planning --------------------------------------------------------------

/// The go/no-go decision, side-effect free.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Plan {
    /// Consolidation should proceed.
    Run,
    /// Consolidation is skipped; the string is the reason, surfaced to the UI.
    Skip(String),
}

/// Decide whether to run: enabled (unless manual) + idle (unless manual) +
/// something new since the last checkpoint. The lock-free requirement is
/// enforced separately by [`run_consolidation`] via [`acquire_lock`], because
/// taking the lock has side effects a pure planner must not.
pub(crate) fn plan(
    config: &ConsolidationConfig,
    snapshot: ActivitySnapshot,
    now_ms: u64,
    dir: &Path,
    manual: bool,
) -> Plan {
    if !manual {
        if !config.enabled {
            return Plan::Skip("disabled".into());
        }
        if !snapshot.is_idle(now_ms, config.idle_threshold_secs) {
            return Plan::Skip("not idle".into());
        }
    }
    if !has_new_since(dir, read_checkpoint(dir)) {
        return Plan::Skip("nothing new".into());
    }
    Plan::Run
}

// -- path safety -----------------------------------------------------------

/// Whether `candidate` is safe to write into as the consolidation target: it
/// must be `root` itself or a path strictly inside it, with no `..` climb
/// anywhere, and — when both exist — must not resolve (via a symlink) to
/// somewhere outside the canonical `root`.
///
/// This is the guard that keeps consolidation from ever writing outside the
/// intended store memory directory, whatever path it is handed.
pub(crate) fn is_safe_memory_dir(candidate: &Path, root: &Path) -> bool {
    // A parent-dir component anywhere is an escape attempt; refuse outright
    // rather than trying to reason about where it lands.
    if candidate.components().any(|c| matches!(c, Component::ParentDir)) {
        return false;
    }
    if !lexically_within(candidate, root) {
        return false;
    }
    // Symlinked-out targets: if both resolve, the resolved candidate must stay
    // within the resolved root. An unresolvable path (not yet created) falls
    // back to the lexical check already passed.
    match (candidate.canonicalize(), root.canonicalize()) {
        (Ok(c), Ok(r)) => c == r || c.starts_with(&r),
        _ => true,
    }
}

/// Case-folded on Windows, where two spellings name one path.
fn containment_key(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        raw.to_lowercase()
    } else {
        raw
    }
}

fn lexically_within(inner: &Path, outer: &Path) -> bool {
    let (inner, outer) = (containment_key(inner), containment_key(outer));
    let outer = outer.trim_end_matches('/');
    inner == outer || inner.starts_with(&format!("{outer}/"))
}

// -- notes -----------------------------------------------------------------

/// One source note: its stem name, body, and last-modified time in epoch ms.
#[derive(Debug, Clone)]
pub(crate) struct Note {
    pub name: String,
    pub content: String,
    pub modified_ms: u64,
}

/// Read every `*.md` note in `dir` except the consolidated output, newest first,
/// bounded by `max_notes` and a running `max_bytes` budget. The output file is
/// excluded so it never feeds itself; hidden/bookkeeping files are skipped by
/// the `.md` filter.
pub(crate) fn read_source_notes(dir: &Path, max_notes: usize, max_bytes: usize) -> Vec<Note> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut notes: Vec<Note> = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|x| x.to_str()) != Some("md") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if stem == OUTPUT_NOTE {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let modified_ms = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        notes.push(Note {
            name: stem.to_string(),
            content,
            modified_ms,
        });
    }
    // Newest first, so the byte budget keeps the freshest notes and the merger
    // sees recency-ordered input.
    notes.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then(a.name.cmp(&b.name)));
    notes.truncate(max_notes);
    let mut kept = Vec::new();
    let mut total = 0usize;
    for n in notes {
        total = total.saturating_add(n.content.len());
        if total > max_bytes && !kept.is_empty() {
            break;
        }
        kept.push(n);
    }
    kept
}

// -- the Merger seam -------------------------------------------------------

/// The consolidated result: one or more notes to write back atomically, plus the
/// counts the command reports.
#[derive(Debug, Clone, Default)]
pub(crate) struct MergeResult {
    pub notes: Vec<MergedNote>,
    pub facts_in: usize,
    pub facts_out: usize,
    pub conflicts_resolved: usize,
    pub secrets_filtered: usize,
}

/// A note the merger produced.
#[derive(Debug, Clone)]
pub(crate) struct MergedNote {
    pub name: String,
    pub content: String,
}

/// Given the source notes, return the consolidated set. The one seam the whole
/// feature turns on: a deterministic default ships today, a model-backed
/// implementation drops in unchanged.
#[async_trait]
pub(crate) trait Merger: Send + Sync {
    async fn merge(&self, notes: &[Note]) -> Result<MergeResult, String>;
}

/// Deterministic, model-free consolidation.
///
/// Splits every note into statements (non-empty, non-heading lines), then:
/// filters out any statement that scans as a secret; collapses near-identical
/// statements (normalised: lower-cased, punctuation-stripped, whitespace-
/// collapsed) keeping the newest; and, among statements that share a subject but
/// disagree, keeps the newest and records the superseded ones as resolved
/// conflicts.
#[derive(Debug, Default, Clone)]
pub(crate) struct HeuristicMerger;

/// A single extracted statement with the provenance the merge needs.
struct Fact {
    /// The original line, verbatim, as it will be written back.
    text: String,
    /// Grouping key for contradiction detection.
    subject: String,
    /// Exact-duplicate key.
    norm: String,
    modified_ms: u64,
    source: String,
}

#[async_trait]
impl Merger for HeuristicMerger {
    async fn merge(&self, notes: &[Note]) -> Result<MergeResult, String> {
        let mut facts: Vec<Fact> = Vec::new();
        let mut facts_in = 0usize;
        let mut secrets_filtered = 0usize;

        for note in notes {
            for line in note.content.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    continue;
                }
                facts_in += 1;
                if !secrets::scan_text(trimmed).is_empty() {
                    secrets_filtered += 1;
                    continue;
                }
                facts.push(Fact {
                    text: trimmed.to_string(),
                    subject: subject_key(trimmed),
                    norm: normalize(trimmed),
                    modified_ms: note.modified_ms,
                    source: note.name.clone(),
                });
            }
        }

        // Exact/near-identical dedup: newest wins for each normalised form.
        facts.sort_by(|a, b| a.norm.cmp(&b.norm).then(b.modified_ms.cmp(&a.modified_ms)));
        facts.dedup_by(|a, b| a.norm == b.norm);

        // Contradiction resolution: within a subject, the newest statement wins
        // and the rest are recorded as resolved conflicts.
        facts.sort_by(|a, b| {
            a.subject
                .cmp(&b.subject)
                .then(b.modified_ms.cmp(&a.modified_ms))
        });
        let mut kept: Vec<Fact> = Vec::new();
        let mut conflicts: Vec<String> = Vec::new();
        let mut i = 0;
        while i < facts.len() {
            // facts is sorted by subject ascending then modified_ms descending,
            // so facts[i] is the newest statement in this subject group.
            let winner = clone_fact(&facts[i]);
            let mut j = i + 1;
            while j < facts.len() && facts[j].subject == facts[i].subject {
                conflicts.push(format!(
                    "kept \"{}\" over \"{}\" (from {})",
                    winner.text, facts[j].text, facts[j].source
                ));
                j += 1;
            }
            kept.push(winner);
            i = j;
        }

        let conflicts_resolved = conflicts.len();
        // Stable, readable output: sort survivors by subject then text.
        kept.sort_by(|a, b| a.subject.cmp(&b.subject).then(a.text.cmp(&b.text)));
        let facts_out = kept.len();

        let content = render(&kept, &conflicts);
        Ok(MergeResult {
            notes: vec![MergedNote {
                name: OUTPUT_NOTE.to_string(),
                content,
            }],
            facts_in,
            facts_out,
            conflicts_resolved,
            secrets_filtered,
        })
    }
}

fn clone_fact(f: &Fact) -> Fact {
    Fact {
        text: f.text.clone(),
        subject: f.subject.clone(),
        norm: f.norm.clone(),
        modified_ms: f.modified_ms,
        source: f.source.clone(),
    }
}

/// Render the consolidated note: the surviving statements, then a resolved-
/// conflicts section when there was anything to resolve.
fn render(kept: &[Fact], conflicts: &[String]) -> String {
    let mut out = String::from("# Consolidated memory\n\n");
    for f in kept {
        out.push_str(&f.text);
        out.push('\n');
    }
    if !conflicts.is_empty() {
        out.push_str("\n## Conflicts resolved\n\n");
        for c in conflicts {
            out.push_str("- ");
            out.push_str(c);
            out.push('\n');
        }
    }
    out
}

/// Normalise a statement for near-identical comparison: lower-case, drop
/// punctuation, collapse whitespace.
fn normalize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_space = false;
    for ch in s.chars() {
        if ch.is_alphanumeric() {
            for lc in ch.to_lowercase() {
                out.push(lc);
            }
            prev_space = false;
        } else if ch.is_whitespace()
            && !prev_space && !out.is_empty() {
                out.push(' ');
                prev_space = true;
            }
        // punctuation dropped
    }
    out.trim_end().to_string()
}

/// The grouping key for contradiction detection: the text before the first
/// colon when present (e.g. "Default timeout" from "Default timeout: 30s"),
/// else the first few normalised words.
fn subject_key(s: &str) -> String {
    if let Some((head, _)) = s.split_once(':') {
        return normalize(head);
    }
    let norm = normalize(s);
    norm.split_whitespace()
        .take(5)
        .collect::<Vec<_>>()
        .join(" ")
}

/// A model-backed [`Merger`] that reuses the existing invocation path: build a
/// request, `invoke` it through a [`ModelInvoker`], parse the reply. Held behind
/// the same seam as [`HeuristicMerger`] so the command can swap it in by handing
/// [`run_consolidation`] an invoker instead of `None`.
pub(crate) struct ModelMerger<'a> {
    model: &'a dyn ModelInvoker,
    model_id: String,
}

impl<'a> ModelMerger<'a> {
    pub(crate) fn new(model: &'a dyn ModelInvoker, model_id: impl Into<String>) -> Self {
        Self {
            model,
            model_id: model_id.into(),
        }
    }
}

const MERGE_SYSTEM_PROMPT: &str = "You consolidate an agent's long-term memory notes. \
Given a set of notes, remove near-duplicate facts, and where two facts contradict keep the \
NEWER one and note the conflict. Never include secrets, credentials, tokens, or passwords. \
Reply with ONLY a JSON array of objects, each {\"name\": string, \"content\": string}.";

impl ModelMerger<'_> {
    fn build_request(&self, notes: &[Note]) -> Value {
        let rendered: String = notes
            .iter()
            .map(|n| format!("## {} (modified_ms={})\n{}", n.name, n.modified_ms, n.content))
            .collect::<Vec<_>>()
            .join("\n\n");
        json!({
            "model": self.model_id,
            "messages": [
                { "role": "system", "content": MERGE_SYSTEM_PROMPT },
                { "role": "user", "content": rendered },
            ],
            "temperature": 0,
        })
    }
}

/// Parse the model's `[{name, content}]` reply into merged notes. Any secret the
/// model failed to strip is filtered here as a backstop.
fn parse_model_notes(reply: &str) -> Result<Vec<MergedNote>, String> {
    let start = reply.find('[').ok_or("no JSON array in reply")?;
    let end = reply.rfind(']').ok_or("no JSON array in reply")?;
    if end < start {
        return Err("malformed JSON array in reply".into());
    }
    let arr: Vec<Value> =
        serde_json::from_str(&reply[start..=end]).map_err(|e| e.to_string())?;
    let mut notes = Vec::new();
    for item in arr {
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(OUTPUT_NOTE)
            .to_string();
        let content = item
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let content = secrets::redact_secrets(&content);
        notes.push(MergedNote { name, content });
    }
    Ok(notes)
}

#[async_trait]
impl Merger for ModelMerger<'_> {
    async fn merge(&self, notes: &[Note]) -> Result<MergeResult, String> {
        let request = self.build_request(notes);
        let (sink, _rx) = mpsc::unbounded_channel();
        let completion = self
            .model
            .invoke(&request, &sink)
            .await
            .map_err(|e: HarnessError| e.to_string())?;
        let reply = crate::core::agent::upstream::extract_choice_message(&completion)
            .and_then(|m| m.get("content").cloned())
            .and_then(|c| c.as_str().map(str::to_string))
            .unwrap_or_default();
        let merged = parse_model_notes(&reply)?;
        let facts_out = merged.iter().flat_map(|n| n.content.lines()).count();
        Ok(MergeResult {
            facts_in: facts_out,
            facts_out,
            conflicts_resolved: 0,
            secrets_filtered: 0,
            notes: merged,
        })
    }
}

// -- orchestration ---------------------------------------------------------

/// The result the command returns and the frontend renders.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsolidationOutcome {
    /// Whether a consolidation actually ran and wrote output.
    pub ran: bool,
    /// "ok" when it ran, otherwise why it was skipped (disabled / not idle /
    /// nothing new / busy).
    pub reason: String,
    pub notes_read: usize,
    pub facts_in: usize,
    pub facts_out: usize,
    pub conflicts_resolved: usize,
    pub secrets_filtered: usize,
    pub bytes_written: usize,
}

impl ConsolidationOutcome {
    fn skipped(reason: impl Into<String>) -> Self {
        Self {
            ran: false,
            reason: reason.into(),
            notes_read: 0,
            facts_in: 0,
            facts_out: 0,
            conflicts_resolved: 0,
            secrets_filtered: 0,
            bytes_written: 0,
        }
    }
}

/// Run the full pipeline against `dir`: plan, lock, read, merge, safe atomic
/// write, checkpoint. Passing `Some((model, id))` uses the model-backed merger;
/// `None` uses the deterministic [`HeuristicMerger`].
pub(crate) async fn run_consolidation(
    dir: &Path,
    config: &ConsolidationConfig,
    snapshot: ActivitySnapshot,
    now_ms: u64,
    manual: bool,
    model: Option<(&dyn ModelInvoker, &str)>,
) -> Result<ConsolidationOutcome, String> {
    match plan(config, snapshot, now_ms, dir, manual) {
        Plan::Skip(reason) => return Ok(ConsolidationOutcome::skipped(reason)),
        Plan::Run => {}
    }

    // Lock-free is the last gate: a second job that cannot take the lock backs
    // off quietly.
    let lock = match acquire_lock(dir, now_ms, DEFAULT_STALE_LOCK_SECS)? {
        Some(lock) => lock,
        None => return Ok(ConsolidationOutcome::skipped("busy")),
    };

    let notes = read_source_notes(dir, config.max_notes, config.max_input_bytes);
    let notes_read = notes.len();

    let heuristic = HeuristicMerger;
    let model_merger = model.map(|(m, id)| ModelMerger::new(m, id));
    let merger: &dyn Merger = match &model_merger {
        Some(mm) => mm,
        None => &heuristic,
    };

    let result = match merger.merge(&notes).await {
        Ok(r) => r,
        Err(e) => {
            lock.release();
            return Err(e);
        }
    };

    let mut bytes_written = 0usize;
    for note in &result.notes {
        match write_note_atomic(dir, note) {
            Ok(n) => bytes_written += n,
            Err(e) => {
                lock.release();
                return Err(e);
            }
        }
    }

    // Only advance the checkpoint once the write succeeded, so a failed run is
    // retried rather than marked done.
    write_checkpoint(dir, now_ms)?;
    lock.release();

    Ok(ConsolidationOutcome {
        ran: true,
        reason: "ok".into(),
        notes_read,
        facts_in: result.facts_in,
        facts_out: result.facts_out,
        conflicts_resolved: result.conflicts_resolved,
        secrets_filtered: result.secrets_filtered,
        bytes_written,
    })
}

/// Write one note to `<dir>/<name>.md` atomically: a uniquely-named temp file in
/// the same directory, then a rename over the target. The store is therefore
/// never left half-written — a crash mid-write leaves the temp file, not a
/// truncated note. Refuses to write anywhere the path-safety guard rejects.
fn write_note_atomic(dir: &Path, note: &MergedNote) -> Result<usize, String> {
    if !is_safe_memory_dir(dir, dir) {
        return Err(format!("unsafe memory dir: {}", dir.display()));
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    let file_name = if note.name == OUTPUT_NOTE {
        OUTPUT_FILE.to_string()
    } else {
        format!("{}.md", sanitize_stem(&note.name))
    };
    let target = dir.join(&file_name);
    // Guard the resolved target too, so a crafted name cannot climb out.
    if !is_safe_memory_dir(&target, dir) {
        return Err(format!("unsafe write target: {}", target.display()));
    }

    let tmp = dir.join(format!(
        ".{}.{}.{}.tmp",
        file_name,
        std::process::id(),
        now_ms()
    ));
    std::fs::write(&tmp, note.content.as_bytes()).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(note.content.len())
}

/// Reduce a merger-supplied note name to a safe file stem: keep alphanumerics,
/// `-` and `_`; everything else becomes `-`. Never empty, never a path.
fn sanitize_stem(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() {
        OUTPUT_NOTE.to_string()
    } else {
        trimmed.to_string()
    }
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn tmp_dir() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "flint-consolidation-test-{}-{}",
            std::process::id(),
            n
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_note(dir: &Path, name: &str, body: &str) {
        std::fs::write(dir.join(format!("{name}.md")), body).unwrap();
    }

    // -- is_idle -----------------------------------------------------------

    #[test]
    fn is_idle_respects_threshold() {
        let snap = ActivitySnapshot {
            last_activity_ms: 10_000,
        };
        // 4s later, threshold 5s -> not idle.
        assert!(!snap.is_idle(14_000, 5));
        // exactly 5s later -> idle.
        assert!(snap.is_idle(15_000, 5));
        // 10s later -> idle.
        assert!(snap.is_idle(20_000, 5));
    }

    #[test]
    fn is_idle_is_saturating_against_clock_skew() {
        let snap = ActivitySnapshot {
            last_activity_ms: 20_000,
        };
        // now < last_activity: reads as not idle rather than instantly idle.
        assert!(!snap.is_idle(10_000, 5));
    }

    // -- stale-lock recovery ----------------------------------------------

    #[test]
    fn fresh_lock_blocks_second_acquirer() {
        let dir = tmp_dir();
        let now = 1_000_000;
        let first = acquire_lock(&dir, now, 600).unwrap();
        assert!(first.is_some(), "first acquirer takes the lock");
        // A second attempt a second later finds a fresh lock and backs off.
        let second = acquire_lock(&dir, now + 1_000, 600).unwrap();
        assert!(second.is_none(), "fresh lock is busy, not reclaimed");
    }

    #[test]
    fn stale_lock_is_reclaimed() {
        let dir = tmp_dir();
        // A lock stamped long ago, left by a crashed run.
        write_lock_body(&dir.join(LOCK_FILE), 0);
        // 10 minutes later with a 5-minute stale window -> reclaimed.
        let reclaimed = acquire_lock(&dir, 10 * 60 * 1000, 5 * 60).unwrap();
        assert!(reclaimed.is_some(), "an abandoned lock is reclaimed");
    }

    #[test]
    fn dropping_the_lock_frees_it() {
        let dir = tmp_dir();
        let now = 2_000_000;
        {
            let _guard = acquire_lock(&dir, now, 600).unwrap().unwrap();
        } // dropped here
        // Now free again immediately.
        let again = acquire_lock(&dir, now + 1, 600).unwrap();
        assert!(again.is_some(), "drop releases the lock");
    }

    // -- is_safe_memory_dir ------------------------------------------------

    #[test]
    fn safe_dir_accepts_root_and_children() {
        let dir = tmp_dir();
        assert!(is_safe_memory_dir(&dir, &dir));
        assert!(is_safe_memory_dir(&dir.join("consolidated.md"), &dir));
    }

    #[test]
    fn safe_dir_rejects_parent_climb() {
        let dir = tmp_dir();
        let escape = dir.join("..").join("etc").join("passwd");
        assert!(
            !is_safe_memory_dir(&escape, &dir),
            "a .. climb is rejected"
        );
    }

    #[test]
    fn safe_dir_rejects_sibling_outside_root() {
        let dir = tmp_dir();
        let outside = dir.parent().unwrap().join("somewhere-else");
        assert!(
            !is_safe_memory_dir(&outside, &dir),
            "a path outside the root is rejected"
        );
    }

    // -- dedup + contradiction resolution ---------------------------------

    #[tokio::test]
    async fn dedup_collapses_near_identical_facts() {
        let notes = vec![
            Note {
                name: "a".into(),
                content: "The build uses cargo -j4.".into(),
                modified_ms: 100,
            },
            Note {
                name: "b".into(),
                content: "the build uses cargo -j4".into(),
                modified_ms: 200,
            },
        ];
        let result = HeuristicMerger.merge(&notes).await.unwrap();
        assert_eq!(result.facts_in, 2);
        assert_eq!(result.facts_out, 1, "near-identical facts collapse to one");
    }

    #[tokio::test]
    async fn contradiction_keeps_newer_and_notes_conflict() {
        let notes = vec![
            Note {
                name: "old".into(),
                content: "Default timeout: 30 seconds".into(),
                modified_ms: 100,
            },
            Note {
                name: "new".into(),
                content: "Default timeout: 60 seconds".into(),
                modified_ms: 200,
            },
        ];
        let result = HeuristicMerger.merge(&notes).await.unwrap();
        assert_eq!(result.facts_out, 1, "only the winner survives");
        assert_eq!(result.conflicts_resolved, 1);
        let content = &result.notes[0].content;
        assert!(
            content.contains("60 seconds"),
            "the newer fact is kept: {content}"
        );
        assert!(
            !content.lines().any(|l| l.trim() == "Default timeout: 30 seconds"),
            "the older fact is not a surviving statement: {content}"
        );
        assert!(
            content.contains("Conflicts resolved"),
            "the conflict is recorded: {content}"
        );
    }

    #[tokio::test]
    async fn secrets_are_filtered_out() {
        let token = "ghp_0123456789abcdefghijklmnopqrstuvwx";
        let notes = vec![Note {
            name: "leak".into(),
            content: format!("A normal fact.\nGitHub token: {token}"),
            modified_ms: 100,
        }];
        let result = HeuristicMerger.merge(&notes).await.unwrap();
        assert!(result.secrets_filtered >= 1, "the credential line is filtered");
        assert!(
            !result.notes[0].content.contains(token),
            "no secret reaches the output"
        );
    }

    // -- atomic write ------------------------------------------------------

    #[test]
    fn atomic_write_leaves_no_temp_and_writes_target() {
        let dir = tmp_dir();
        let note = MergedNote {
            name: OUTPUT_NOTE.into(),
            content: "# Consolidated\n\nhello\n".into(),
        };
        let n = write_note_atomic(&dir, &note).unwrap();
        assert_eq!(n, note.content.len());
        // Target present with the right content.
        let written = std::fs::read_to_string(dir.join(OUTPUT_FILE)).unwrap();
        assert_eq!(written, note.content);
        // No leftover temp files.
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "no temp file is left behind");
    }

    #[test]
    fn atomic_write_overwrites_existing_output() {
        let dir = tmp_dir();
        std::fs::write(dir.join(OUTPUT_FILE), "old content").unwrap();
        let note = MergedNote {
            name: OUTPUT_NOTE.into(),
            content: "new content".into(),
        };
        write_note_atomic(&dir, &note).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join(OUTPUT_FILE)).unwrap(),
            "new content"
        );
    }

    // -- planning ----------------------------------------------------------

    #[test]
    fn disabled_config_never_runs_the_auto_path() {
        let dir = tmp_dir();
        write_note(&dir, "a", "some fact");
        let config = ConsolidationConfig::default(); // disabled
        let snap = ActivitySnapshot { last_activity_ms: 0 };
        // Idle and with new content, but disabled -> skip.
        let plan = plan(&config, snap, 10_000_000, &dir, false);
        assert_eq!(plan, Plan::Skip("disabled".into()));
    }

    #[test]
    fn manual_bypasses_disabled_and_idle_but_not_nothing_new() {
        let dir = tmp_dir();
        let config = ConsolidationConfig::default(); // disabled
        let snap = ActivitySnapshot {
            last_activity_ms: 10_000_000,
        };
        // No notes at all -> even a manual run has nothing to do.
        assert_eq!(
            plan(&config, snap, 10_000_000, &dir, true),
            Plan::Skip("nothing new".into())
        );
        // With a note, a manual run proceeds despite disabled + not-idle.
        write_note(&dir, "a", "fact");
        assert_eq!(plan(&config, snap, 10_000_000, &dir, true), Plan::Run);
    }

    #[test]
    fn checkpoint_makes_unchanged_store_a_no_op() {
        let dir = tmp_dir();
        write_note(&dir, "a", "fact");
        let config = ConsolidationConfig {
            enabled: true,
            ..Default::default()
        };
        let snap = ActivitySnapshot { last_activity_ms: 0 };
        // Real wall-clock, safely ahead of the note's filesystem mtime, so the
        // checkpoint comparison is meaningful (the store's notes carry real
        // mtimes, not the fake times the pure-logic tests use).
        let now = now_ms() + 60_000;
        // First run is planned.
        assert_eq!(plan(&config, snap, now, &dir, false), Plan::Run);
        // After the checkpoint catches up to the notes, no new work.
        write_checkpoint(&dir, now).unwrap();
        assert_eq!(
            plan(&config, snap, now, &dir, false),
            Plan::Skip("nothing new".into())
        );
    }

    // -- Merger stub (testable pure logic) --------------------------------

    struct StubMerger;
    #[async_trait]
    impl Merger for StubMerger {
        async fn merge(&self, notes: &[Note]) -> Result<MergeResult, String> {
            Ok(MergeResult {
                notes: vec![MergedNote {
                    name: OUTPUT_NOTE.into(),
                    content: format!("stubbed {} notes\n", notes.len()),
                }],
                facts_in: notes.len(),
                facts_out: notes.len(),
                conflicts_resolved: 0,
                secrets_filtered: 0,
            })
        }
    }

    #[tokio::test]
    async fn run_consolidation_writes_and_checkpoints() {
        let dir = tmp_dir();
        write_note(&dir, "a", "one");
        write_note(&dir, "b", "two");
        let config = ConsolidationConfig {
            enabled: true,
            ..Default::default()
        };
        let snap = ActivitySnapshot { last_activity_ms: 0 };
        // Real wall-clock ahead of the notes' mtimes so the checkpoint written
        // by the first run makes the second run a genuine no-op.
        let now = now_ms() + 60_000;
        let out = run_consolidation(&dir, &config, snap, now, false, None)
            .await
            .unwrap();
        assert!(out.ran);
        assert_eq!(out.reason, "ok");
        assert_eq!(out.notes_read, 2);
        assert!(dir.join(OUTPUT_FILE).exists());
        assert_eq!(read_checkpoint(&dir), Some(now));

        // A second run with nothing new is a no-op.
        let again = run_consolidation(&dir, &config, snap, now, false, None)
            .await
            .unwrap();
        assert!(!again.ran);
        assert_eq!(again.reason, "nothing new");
    }

    #[tokio::test]
    async fn busy_lock_makes_run_back_off() {
        let dir = tmp_dir();
        write_note(&dir, "a", "one");
        let config = ConsolidationConfig {
            enabled: true,
            ..Default::default()
        };
        let snap = ActivitySnapshot { last_activity_ms: 0 };
        let now = 10_000_000;
        // Hold the lock, then a concurrent run must back off.
        let _held = acquire_lock(&dir, now, DEFAULT_STALE_LOCK_SECS)
            .unwrap()
            .unwrap();
        let out = run_consolidation(&dir, &config, snap, now, true, None)
            .await
            .unwrap();
        assert!(!out.ran);
        assert_eq!(out.reason, "busy");
    }

    #[tokio::test]
    async fn stub_merger_drives_the_seam() {
        let notes = vec![Note {
            name: "a".into(),
            content: "x".into(),
            modified_ms: 1,
        }];
        let out = StubMerger.merge(&notes).await.unwrap();
        assert_eq!(out.notes[0].content, "stubbed 1 notes\n");
    }

    #[test]
    fn parse_model_notes_reads_json_array() {
        let reply = r#"Here you go: [{"name":"consolidated","content":"a\nb"}] done"#;
        let notes = parse_model_notes(reply).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].name, "consolidated");
        assert_eq!(notes[0].content, "a\nb");
    }
}
