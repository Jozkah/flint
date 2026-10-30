//! Campaigns: one coordinator splits a prompt into dependent tasks, each run as
//! its own worktree session. See `docs/CAMPAIGNS.md`.
//!
//! This file holds the model (types, state machines, plan validation) and the
//! on-disk record. The pure scheduling decision lives in `campaign_scheduler`.
//!
//! * **The backend record is the truth for status.** Every move goes through a
//!   validated transition that rejects illegal jumps.
//! * **`completed` is a worker claim.** A task is `verified` only from
//!   `verifying` with a PASS verdict, and `merged` only from `verified`.
//! * **Nothing unfinished reads as clean.** A record written by another
//!   process whose tasks were running is rewritten as `interrupted`.
//! * **Ids name directories.** Anything outside `[A-Za-z0-9_-]` is refused
//!   before a path is built.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;
/// A plan may hold at most this many tasks.
pub const MAX_TASKS: usize = 12;
/// A failed task may be queued again this many times.
pub const MAX_RETRIES: u32 = 2;
const MAX_ID_LEN: usize = 64;
const MAX_TEXT: usize = 8000;
const MAX_HANDOFF: usize = 200_000;
const MAX_DETAIL: usize = 2000;

pub const DEFAULT_MAX_PARALLEL: u32 = 4;
pub const MAX_PARALLEL_CAP: u32 = 6;

/// The user's `campaigns.maxParallel`, forced into `1..=MAX_PARALLEL_CAP`.
pub fn clamp_max_parallel(requested: i64) -> u32 {
    requested.clamp(1, MAX_PARALLEL_CAP as i64) as u32
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CampaignStatus {
    Draft,
    Planned,
    Approved,
    Running,
    Paused,
    Reviewing,
    Merging,
    Done,
    Failed,
    Cancelled,
    Interrupted,
}

impl CampaignStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Cancelled)
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    Blocked,
    Queued,
    Running,
    AwaitingInput,
    AwaitingApproval,
    Completed,
    Verifying,
    Verified,
    Merged,
    Failed,
    Cancelled,
    Interrupted,
    Conflict,
    /// A resolver session is merging the conflicting task into the integration
    /// branch's current state. Not live (no pane yet); `running` follows.
    Resolving,
}

impl TaskStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Merged | Self::Cancelled)
    }

    /// Occupies a pane: the worker is running or waiting on a person.
    pub fn is_live(self) -> bool {
        matches!(self, Self::Running | Self::AwaitingInput | Self::AwaitingApproval)
    }

    /// Still owed work: the campaign cannot move to review while one exists.
    pub fn is_unfinished(self) -> bool {
        matches!(
            self,
            Self::Pending
                | Self::Blocked
                | Self::Queued
                | Self::Running
                | Self::AwaitingInput
                | Self::AwaitingApproval
                | Self::Resolving
        )
    }
}

/// The verifier's formal verdict. Mirrors `verification::Verdict`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum TaskVerdict {
    Pass,
    Partial,
    Fail,
    Blocked,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
/// Every field is optional on the wire: a missing one takes its default, so a
/// renderer that sends only `{maxParallel, tokenBudget}` still creates a plan.
#[serde(rename_all = "camelCase", default)]
pub struct CampaignLimits {
    pub max_parallel: u32,
    pub max_tasks: u32,
    #[serde(default)]
    pub token_budget: Option<u64>,
    #[serde(default)]
    pub task_tokens: Option<u64>,
    #[serde(default)]
    pub task_steps: Option<u32>,
    #[serde(default)]
    pub wall_clock_secs: Option<u64>,
    /// What the user chose at the plan card for how tasks work:
    /// `worktree` (edits and test commands inside the task's own folder run
    /// without asking; anything outside it, network and destructive commands
    /// still ask) or `ask` (every action asks). `None` on a plan made before
    /// the choice existed. Recorded on approval; tasks run in `auto` or
    /// `ask` mode accordingly, never `bypass`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_access: Option<String>,
}

impl Default for CampaignLimits {
    fn default() -> Self {
        CampaignLimits {
            max_parallel: DEFAULT_MAX_PARALLEL,
            max_tasks: MAX_TASKS as u32,
            token_budget: None,
            task_tokens: None,
            task_steps: None,
            wall_clock_secs: None,
            task_access: None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CampaignTask {
    pub id: String,
    pub title: String,
    pub brief: String,
    #[serde(default)]
    pub acceptance: Vec<String>,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub worktree_path: Option<String>,
    #[serde(default)]
    pub base_sha: Option<String>,
    pub status: TaskStatus,
    #[serde(default)]
    pub attempt: u32,
    #[serde(default)]
    pub verdict: Option<TaskVerdict>,
    #[serde(default)]
    pub tokens_used: u64,
    /// Relative to the campaign folder.
    #[serde(default)]
    pub handoff_path: Option<String>,
    #[serde(default)]
    pub merged_sha: Option<String>,
    #[serde(default)]
    pub fingerprint: Option<String>,
    #[serde(default)]
    pub detail: String,
    /// Set when a person accepted a task whose verification did not pass
    /// ("accept anyway"). The verdict is then PASS on the record, and this says
    /// who decided it and why, and what the verifier had said.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manual_override: Option<ManualOverride>,
    /// Tokens the verifier's own model calls cost for this task, over every
    /// verification. Kept apart from `tokens_used` (the worker's run), which a
    /// later settle overwrites; both count against the project budget.
    #[serde(default)]
    pub verify_tokens: u64,
    /// What the last verification found out by itself, independent of the
    /// verifier model's verdict: the objective check, an empty diff, markers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<TaskEvidence>,
    /// Set once a resolver session was started for this task's conflict.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolver: Option<ResolverRecord>,
    /// `gate_repair` for the one task a failed final gate asks for; empty for
    /// every planned task.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kind: String,
    /// Dependencies a person skipped and released this task from. It runs
    /// without their work, and its seed says so.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skipped_deps: Vec<String>,
}

pub const KIND_GATE_REPAIR: &str = "gate_repair";
/// A planned task that runs or reports and is not expected to change files.
pub const KIND_CHECK: &str = "check";

impl CampaignTask {
    pub(crate) fn from_plan(t: PlanTask) -> Self {
        CampaignTask {
            id: t.id,
            title: t.title.chars().take(200).collect(),
            brief: t.brief,
            acceptance: t.acceptance,
            paths: t.paths,
            depends_on: t.depends_on,
            session_id: None,
            branch: None,
            worktree_path: None,
            base_sha: None,
            status: TaskStatus::Pending,
            attempt: 0,
            verdict: None,
            tokens_used: 0,
            handoff_path: None,
            merged_sha: None,
            fingerprint: None,
            detail: String::new(),
            manual_override: None,
            verify_tokens: 0,
            evidence: None,
            resolver: None,
            kind: t.kind,
            skipped_deps: Vec::new(),
        }
    }

    /// Whether a run that changed nothing is a failure of this task: only a
    /// change task that declared paths.
    pub fn expects_changes(&self) -> bool {
        self.kind != KIND_CHECK && self.kind != KIND_GATE_REPAIR && !self.paths.is_empty()
    }

    /// Worker and verifier tokens together: what this task cost.
    pub fn tokens_total(&self) -> u64 {
        self.tokens_used.saturating_add(self.verify_tokens)
    }
}

/// The objective check a verification ran in the task's worktree.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskCheck {
    pub command: String,
    /// `agent_toml`, `agent_toml_checkout` or `detected`.
    pub source: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub passed: bool,
    /// The tail of the output, size-capped.
    pub output: String,
    pub at: String,
}

/// Facts the backend established about a task's work during verification.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvidence {
    /// Nothing changed against the base: no diff, no new file, no pending work.
    #[serde(default)]
    pub empty: bool,
    /// Files that still hold merge conflict markers (a resolver's output).
    #[serde(default)]
    pub markers: Vec<String>,
    /// The build or test command run in the worktree, when one exists.
    #[serde(default)]
    pub check: Option<TaskCheck>,
    #[serde(default)]
    pub at: String,
}

/// A resolver session for a task's merge conflict. One attempt per conflict.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolverRecord {
    /// Resolver sessions started for this task (the cap is 1).
    pub attempts: u32,
    pub files: Vec<String>,
    /// The task's own session, branch, worktree and base before the resolver
    /// took the record over.
    pub original_session_id: Option<String>,
    pub original_branch: Option<String>,
    pub original_worktree_path: Option<String>,
    pub original_base_sha: Option<String>,
    /// The resolver's worktree (a fresh branch from the integration branch, the
    /// task's branch merged in and left for the resolver to finish).
    pub worktree_path: String,
    pub branch: String,
    pub at: String,
}

/// A task accepted by a person instead of by a passing verification.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManualOverride {
    pub by: String,
    pub reason: String,
    pub at: String,
    /// The verdict the verifier had given, when it gave one.
    #[serde(default)]
    pub previous_verdict: Option<TaskVerdict>,
}

/// Who accepts a task by hand, and why. Carried on a task move to `verified`.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ManualAccept {
    pub by: String,
    #[serde(default)]
    pub reason: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Campaign {
    pub schema_version: u32,
    pub id: String,
    pub title: String,
    pub coordinator_session: String,
    pub source_root: String,
    #[serde(default)]
    pub base_branch: String,
    #[serde(default)]
    pub base_sha: String,
    #[serde(default)]
    pub integration_branch: String,
    #[serde(default)]
    pub integration_worktree: String,
    pub mode_ceiling: String,
    #[serde(default)]
    pub model: String,
    pub limits: CampaignLimits,
    pub status: CampaignStatus,
    /// Which app process last wrote this record. A different one reading
    /// running work knows it was interrupted.
    pub process_epoch: String,
    pub created_at: String,
    pub updated_at: String,
    pub tasks: Vec<CampaignTask>,
    /// The last build and test gate run on the integration worktree.
    #[serde(default)]
    pub gate: Option<GateReport>,
    /// The proposal handed to the user's checkout, once the gate passed.
    #[serde(default)]
    pub proposal_id: Option<String>,
    /// A rough token cost of the plan, made when it is recorded or edited.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimate: Option<CostEstimate>,
    /// Who runs the campaign: `renderer` (the desktop app's scheduler, the
    /// default for every record that predates the field) or `server` (the
    /// campaign driver of `flint serve --agent-run`). The renderer's campaign
    /// host leaves a `server` campaign alone.
    #[serde(default = "default_driver")]
    pub driver: String,
}

pub const DRIVER_RENDERER: &str = "renderer";
pub const DRIVER_SERVER: &str = "server";

fn default_driver() -> String {
    DRIVER_RENDERER.to_string()
}

/// A rough, honest cost range for a plan, shown before approval.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CostEstimate {
    pub tasks: u32,
    pub per_task_low: u64,
    pub per_task_expected: u64,
    pub per_task_high: u64,
    pub low: u64,
    pub expected: u64,
    pub high: u64,
    /// `history` (average of earlier campaigns' tasks) or `default`.
    pub basis: String,
    /// Earlier tasks the average came from.
    pub samples: u32,
}

/// Conservative per-task tokens (worker plus one verification) used until
/// there is history to average.
pub const DEFAULT_TASK_TOKENS: u64 = 60_000;
const MIN_HISTORY_SAMPLES: usize = 3;

/// `tasks` x tokens per task, with a range. The per-task figure is the mean of
/// finished tasks in `history` when there are at least three, else a constant.
pub fn estimate_cost(tasks: usize, history: &[Campaign]) -> CostEstimate {
    let samples: Vec<u64> = history
        .iter()
        .flat_map(|c| c.tasks.iter())
        .filter(|t| matches!(t.status, TaskStatus::Merged | TaskStatus::Verified | TaskStatus::Completed))
        .map(|t| t.tokens_total())
        .filter(|n| *n > 0)
        .collect();
    let (expected, basis) = if samples.len() >= MIN_HISTORY_SAMPLES {
        (samples.iter().sum::<u64>() / samples.len() as u64, "history")
    } else {
        (DEFAULT_TASK_TOKENS, "default")
    };
    let low = expected * 6 / 10;
    let high = expected * 18 / 10;
    let n = tasks as u64;
    CostEstimate {
        tasks: tasks as u32,
        per_task_low: low,
        per_task_expected: expected,
        per_task_high: high,
        low: low * n,
        expected: expected * n,
        high: high * n,
        basis: basis.to_string(),
        samples: if basis == "history" { samples.len() as u32 } else { 0 },
    }
}

/// What the final build and test gate did.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GateReport {
    /// `agent_toml`, `detected`, or `none` when nothing could be run.
    pub source: String,
    pub command: String,
    /// Nothing was run: no command is configured or detectable.
    pub skipped: bool,
    pub passed: bool,
    pub timed_out: bool,
    pub exit_code: Option<i32>,
    /// The tail of the combined output, size-capped.
    pub output: String,
    pub at: String,
}

impl Campaign {
    pub fn task(&self, id: &str) -> Option<&CampaignTask> {
        self.tasks.iter().find(|t| t.id == id)
    }

    pub(crate) fn task_mut(&mut self, id: &str) -> Result<&mut CampaignTask, CampaignError> {
        self.tasks
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| CampaignError::new(CampaignErrorKind::NotFound, format!("no task {id} in this campaign")))
    }
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CampaignErrorKind {
    InvalidId,
    InvalidPlan,
    IllegalTransition,
    RetryCapReached,
    VerdictRequired,
    NotFound,
    Exists,
    Corrupt,
    Io,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CampaignError {
    pub kind: CampaignErrorKind,
    pub message: String,
}

impl CampaignError {
    pub(crate) fn new(kind: CampaignErrorKind, message: impl Into<String>) -> Self {
        CampaignError { kind, message: message.into() }
    }
}

impl std::fmt::Display for CampaignError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/// `[A-Za-z0-9_-]{1,64}`. Ids become directory names, so nothing else passes.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub(crate) fn check_id(what: &str, id: &str) -> Result<(), CampaignError> {
    if valid_id(id) {
        Ok(())
    } else {
        Err(CampaignError::new(
            CampaignErrorKind::InvalidId,
            format!("{what} id must be 1-{MAX_ID_LEN} characters of letters, digits, '_' or '-'"),
        ))
    }
}

// ---------------------------------------------------------------------------
// Plan validation
// ---------------------------------------------------------------------------

/// A task as the coordinator proposes it, before any state exists.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanTask {
    pub id: String,
    pub title: String,
    pub brief: String,
    #[serde(default)]
    pub acceptance: Vec<String>,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    /// Empty for a change task; `check` for a task that runs, reads or reports
    /// and is not expected to change files (a test run, an audit).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kind: String,
}

/// Case-folded, slash-normalised, relative. `.` means the whole tree.
/// `None` for absolute paths, `..`, or an empty string.
fn normalize_path(raw: &str) -> Option<String> {
    let s = raw.trim().replace('\\', "/");
    if s.is_empty() || s.starts_with('/') || s.contains(':') {
        return None;
    }
    let mut parts = Vec::new();
    for seg in s.split('/') {
        match seg {
            "" | "." => {}
            ".." => return None,
            other => parts.push(other.to_lowercase()),
        }
    }
    Some(parts.join("/"))
}

fn covers(outer: &str, inner: &str) -> bool {
    // Spelled alike before comparing: `./src/`, `src\` and `src` are one path.
    let norm = |p: &str| {
        let p = p.trim().replace('\\', "/");
        let p = p.trim_start_matches("./").trim_end_matches('/').to_string();
        if p == "." { String::new() } else { p }
    };
    let (outer, inner) = (norm(outer), norm(inner));
    outer.is_empty() || inner == outer || inner.starts_with(&format!("{outer}/"))
}

/// Why a plan cannot run. One entry per problem, in a stable order.
pub fn validate_plan(tasks: &[PlanTask]) -> Result<(), Vec<String>> {
    let mut issues = Vec::new();
    if tasks.is_empty() {
        issues.push("the plan has no tasks".to_string());
    }
    if tasks.len() > MAX_TASKS {
        issues.push(format!("the plan has {} tasks; the limit is {MAX_TASKS}", tasks.len()));
    }
    let mut ids = BTreeSet::new();
    for t in tasks {
        if !valid_id(&t.id) {
            issues.push(format!("task id {:?} is not 1-{MAX_ID_LEN} characters of letters, digits, '_' or '-'", t.id));
        } else if !ids.insert(t.id.as_str()) {
            issues.push(format!("task id {} is used more than once", t.id));
        }
        if !t.kind.is_empty() && t.kind != KIND_CHECK {
            issues.push(format!("task {} has kind {:?}; use \"check\" or leave it out", t.id, t.kind));
        }
        if t.brief.trim().is_empty() {
            issues.push(format!("task {} has an empty brief", t.id));
        }
        if t.brief.chars().count() > MAX_TEXT {
            issues.push(format!("task {} has a brief over {MAX_TEXT} characters", t.id));
        }
        if t.kind != KIND_CHECK && t.paths.is_empty() {
            issues.push(format!(
                "task {} changes files but declares no paths; list the paths it works in, or set \"kind\":\"check\" if it only reads or runs things",
                t.id
            ));
        }
        for p in &t.paths {
            if normalize_path(p).is_none() {
                issues.push(format!("task {} declares path {p:?}, which is not a relative path inside the project", t.id));
            }
        }
    }
    for t in tasks {
        for d in &t.depends_on {
            if *d == t.id {
                issues.push(format!("task {} depends on itself", t.id));
            } else if !ids.contains(d.as_str()) {
                issues.push(format!("task {} depends on unknown task {d}", t.id));
            }
        }
    }
    if let Some(cycle) = find_cycle(tasks) {
        issues.push(format!("dependency cycle: {}", cycle.join(" -> ")));
    }
    // Overlap is only meaningful when the graph is sound.
    if issues.is_empty() {
        issues.extend(parallel_overlaps(tasks));
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(issues)
    }
}

fn find_cycle(tasks: &[PlanTask]) -> Option<Vec<String>> {
    let deps: BTreeMap<&str, Vec<&str>> = tasks
        .iter()
        .map(|t| (t.id.as_str(), t.depends_on.iter().map(String::as_str).filter(|d| *d != t.id).collect()))
        .collect();
    // 0 = unseen, 1 = on the stack, 2 = done
    let mut mark: BTreeMap<&str, u8> = BTreeMap::new();
    fn visit<'a>(
        id: &'a str,
        deps: &BTreeMap<&'a str, Vec<&'a str>>,
        mark: &mut BTreeMap<&'a str, u8>,
        stack: &mut Vec<&'a str>,
    ) -> Option<Vec<String>> {
        match mark.get(id).copied().unwrap_or(0) {
            2 => return None,
            1 => {
                let at = stack.iter().position(|s| *s == id).unwrap_or(0);
                let mut c: Vec<String> = stack[at..].iter().map(|s| s.to_string()).collect();
                c.push(id.to_string());
                return Some(c);
            }
            _ => {}
        }
        mark.insert(id, 1);
        stack.push(id);
        for d in deps.get(id).into_iter().flatten() {
            if deps.contains_key(d) {
                if let Some(c) = visit(d, deps, mark, stack) {
                    return Some(c);
                }
            }
        }
        stack.pop();
        mark.insert(id, 2);
        None
    }
    let mut ids: Vec<&str> = deps.keys().copied().collect();
    ids.sort();
    for id in ids {
        if let Some(c) = visit(id, &deps, &mut mark, &mut Vec::new()) {
            return Some(c);
        }
    }
    None
}

/// The normalized paths a change task works in. A task persisted before empty
/// paths were refused declares none; it is treated as touching the whole
/// project so it still serializes against every other change task.
fn effective_paths(t: &PlanTask) -> Vec<String> {
    let declared: Vec<String> = t.paths.iter().filter_map(|p| normalize_path(p)).collect();
    if declared.is_empty() {
        vec![String::new()]
    } else {
        declared
    }
}

/// Tasks that neither depends (transitively) on the other can run at the same
/// time; declared paths of such a pair must not overlap.
fn parallel_overlaps(tasks: &[PlanTask]) -> Vec<String> {
    let deps: BTreeMap<&str, &Vec<String>> = tasks.iter().map(|t| (t.id.as_str(), &t.depends_on)).collect();
    let ancestors = |id: &str| -> BTreeSet<String> {
        let mut seen = BTreeSet::new();
        let mut todo = vec![id.to_string()];
        while let Some(cur) = todo.pop() {
            for d in deps.get(cur.as_str()).into_iter().flat_map(|v| v.iter()) {
                if seen.insert(d.clone()) {
                    todo.push(d.clone());
                }
            }
        }
        seen
    };
    let mut out = Vec::new();
    for (i, a) in tasks.iter().enumerate() {
        let a_anc = ancestors(&a.id);
        for b in &tasks[i + 1..] {
            if a.kind == KIND_CHECK || b.kind == KIND_CHECK {
                continue;
            }
            if a_anc.contains(&b.id) || ancestors(&b.id).contains(&a.id) {
                continue;
            }
            'pair: for pa in effective_paths(a) {
                for pb in effective_paths(b) {
                    if covers(&pa, &pb) || covers(&pb, &pa) {
                        out.push(format!(
                            "tasks {} and {} can run in parallel but both declare {}; make one depend on the other",
                            a.id,
                            b.id,
                            if pa.is_empty() { "." } else { pa.as_str() }
                        ));
                        break 'pair;
                    }
                }
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// State machines
// ---------------------------------------------------------------------------

pub(crate) fn illegal(what: &str, from: impl std::fmt::Debug, to: impl std::fmt::Debug) -> CampaignError {
    CampaignError::new(CampaignErrorKind::IllegalTransition, format!("{what} cannot move from {from:?} to {to:?}"))
}

fn task_edge(from: TaskStatus, to: TaskStatus) -> bool {
    use TaskStatus::*;
    if from == to {
        return false;
    }
    // Cancelling is allowed from anything that is not already finished.
    if to == Cancelled {
        return !matches!(from, Merged | Cancelled);
    }
    matches!(
        (from, to),
        (Pending, Blocked | Queued)
            | (Blocked, Pending | Queued)
            | (Queued, Running | Blocked)
            | (Running, AwaitingInput | AwaitingApproval | Completed | Failed | Interrupted)
            | (AwaitingInput | AwaitingApproval, Running | Completed | Failed | Interrupted)
            | (Completed, Verifying | Failed)
            // Back to the claim: the verifier was interrupted.
            | (Verifying, Completed | Verified | Failed | Queued)
            | (Verified, Merged | Conflict)
            | (Conflict, Verified | Queued | Failed | Resolving)
            | (Resolving, Running | Failed | Conflict | Interrupted)
            | (Failed, Queued)
            | (Interrupted, Queued | Failed)
    )
}

/// Move a task, enforcing the edge, the retry cap and the verdict rule.
///
/// `verdict` is read when leaving `verifying`; it is recorded and `verified`
/// requires it to be PASS. A move back to `queued` from `failed`, `verifying`
/// or `conflict` is a retry and is refused once the cap is spent.
pub fn transition_task(
    task: &mut CampaignTask,
    to: TaskStatus,
    verdict: Option<TaskVerdict>,
) -> Result<(), CampaignError> {
    let from = task.status;
    if !task_edge(from, to) {
        return Err(illegal(&format!("task {}", task.id), from, to));
    }
    if from == TaskStatus::Verifying && to != TaskStatus::Completed {
        if to == TaskStatus::Verified && verdict != Some(TaskVerdict::Pass) {
            return Err(CampaignError::new(
                CampaignErrorKind::VerdictRequired,
                format!("task {} is verified only by a PASS verdict", task.id),
            ));
        }
        // A missing verdict is BLOCKED, never PASS.
        task.verdict = Some(verdict.unwrap_or(TaskVerdict::Blocked));
    }
    if to == TaskStatus::Merged && task.verdict != Some(TaskVerdict::Pass) {
        return Err(CampaignError::new(
            CampaignErrorKind::VerdictRequired,
            format!("task {} has no PASS verdict and cannot be merged", task.id),
        ));
    }
    let is_retry = to == TaskStatus::Queued
        && matches!(from, TaskStatus::Failed | TaskStatus::Verifying | TaskStatus::Conflict);
    if is_retry {
        if task.attempt >= MAX_RETRIES {
            return Err(CampaignError::new(
                CampaignErrorKind::RetryCapReached,
                format!("task {} has already been retried {MAX_RETRIES} times", task.id),
            ));
        }
        task.attempt += 1;
        task.verdict = None;
        task.fingerprint = None;
        task.manual_override = None;
    }
    if to == TaskStatus::Queued && from == TaskStatus::Interrupted {
        task.verdict = None;
    }
    if to == TaskStatus::Resolving {
        // The resolver's result is verified afresh.
        task.verdict = None;
        task.fingerprint = None;
        task.manual_override = None;
    }
    task.status = to;
    Ok(())
}

fn campaign_edge(from: CampaignStatus, to: CampaignStatus) -> bool {
    use CampaignStatus::*;
    if from == to {
        return false;
    }
    if to == Cancelled {
        return !matches!(from, Done | Failed | Cancelled);
    }
    matches!(
        (from, to),
        (Draft, Planned)
            | (Planned, Approved | Draft)
            | (Approved, Running)
            | (Running, Paused | Reviewing | Failed | Interrupted)
            | (Paused, Running)
            | (Reviewing, Merging | Running | Failed)
            | (Merging, Done | Reviewing | Failed | Interrupted)
            | (Interrupted, Running | Failed)
    )
}

/// A running campaign whose every task is merged or cancelled, with at least
/// one merged, has nothing left to do but be reviewed. Moves it there and says
/// whether it did. Called after any task move, so a skipped or cancelled last
/// task does not leave the campaign `running`.
pub(crate) fn advance_to_review(c: &mut Campaign) -> bool {
    c.status == CampaignStatus::Running
        && c.tasks.iter().all(|t| t.status.is_terminal())
        && c.tasks.iter().any(|t| t.status == TaskStatus::Merged)
        && transition_campaign(c, CampaignStatus::Reviewing).is_ok()
}

/// Move the campaign. `reviewing` needs no unfinished task; `done` needs every
/// task merged or cancelled, and at least one merged.
pub fn transition_campaign(c: &mut Campaign, to: CampaignStatus) -> Result<(), CampaignError> {
    if !campaign_edge(c.status, to) {
        return Err(illegal("the campaign", c.status, to));
    }
    match to {
        CampaignStatus::Reviewing => {
            if let Some(t) = c.tasks.iter().find(|t| t.status.is_unfinished()) {
                return Err(CampaignError::new(
                    CampaignErrorKind::IllegalTransition,
                    format!("task {} is still {:?}", t.id, t.status),
                ));
            }
        }
        CampaignStatus::Done => {
            let all = c.tasks.iter().all(|t| t.status.is_terminal());
            let any = c.tasks.iter().any(|t| t.status == TaskStatus::Merged);
            if !all || !any {
                return Err(CampaignError::new(
                    CampaignErrorKind::IllegalTransition,
                    "the campaign is done only when every task is merged or cancelled and one is merged",
                ));
            }
        }
        _ => {}
    }
    c.status = to;
    Ok(())
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

fn root(data_folder: &Path) -> PathBuf {
    data_folder.join("campaigns")
}

fn campaign_dir(data_folder: &Path, id: &str) -> Result<PathBuf, CampaignError> {
    check_id("campaign", id)?;
    Ok(root(data_folder).join(id))
}

/// Read-modify-write of one record must not interleave, within this process
/// (the mutex) or across processes sharing the data folder (the desktop app
/// and `flint serve`: a lock file next to the records).
static RECORDS: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// How long to wait for another process's lock before going ahead anyway.
const FILE_LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(10);
/// A lock file older than this is left over from a crash.
const FILE_LOCK_STALE: std::time::Duration = std::time::Duration::from_secs(60);

pub(crate) struct Held {
    _mutex: std::sync::MutexGuard<'static, ()>,
    /// The lock file and the token written into it.
    file: Option<(PathBuf, String)>,
}

impl Drop for Held {
    fn drop(&mut self) {
        if let Some((path, token)) = &self.file {
            // Remove only a lock that is still ours: another process may have
            // taken over a stale one at this path, and deleting theirs would
            // let a third writer in.
            if std::fs::read_to_string(path).is_ok_and(|text| text.trim() == token) {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

pub(crate) fn lock(data_folder: &Path) -> Held {
    let mutex = RECORDS.lock().unwrap_or_else(|p| p.into_inner());
    let dir = root(data_folder);
    if std::fs::create_dir_all(&dir).is_err() {
        return Held { _mutex: mutex, file: None };
    }
    let path = dir.join(".records.lock");
    static LOCK_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let me = epoch();
    let token = format!("{me}|{}", LOCK_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    let deadline = std::time::Instant::now() + FILE_LOCK_WAIT;
    loop {
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => {
                let _ = f.write_all(token.as_bytes());
                return Held { _mutex: mutex, file: Some((path, token)) };
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let owner = std::fs::read_to_string(&path).unwrap_or_default();
                // The owner's process epoch is the part before the `|`.
                let owner = owner.trim().split('|').next().unwrap_or_default();
                let old = std::fs::metadata(&path)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|age| age > FILE_LOCK_STALE);
                let dead = !owner.is_empty() && (owner == me || !epoch_alive(owner));
                // Age alone does not prove a crash: a live owner holding a long
                // read-modify-write keeps its lock. Age steals only when the
                // owner is unknown (empty/partial file) or not running.
                if dead || (old && (owner.is_empty() || !epoch_alive(owner))) {
                    let _ = std::fs::remove_file(&path);
                    continue;
                }
                if std::time::Instant::now() >= deadline {
                    // Better a rare lost update than a wedged campaign.
                    return Held { _mutex: mutex, file: None };
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(_) => return Held { _mutex: mutex, file: None },
        }
    }
}

fn epoch() -> String {
    tauri_plugin_agent_tools::session_mailbox::process_epoch().to_string()
}

/// Whether the process that took `epoch` (`<start ms hex>-<pid hex>`) is
/// still running. A pid since reused by a process started after the epoch was
/// taken does not count. Mobile runs one app process, so another epoch there
/// is always a dead one.
#[cfg(any(target_os = "android", target_os = "ios"))]
fn epoch_alive(_epoch: &str) -> bool {
    false
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn epoch_alive(epoch: &str) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let Some((ms, pid)) = epoch.split_once('-') else { return false };
    let (Ok(ms), Ok(pid)) = (u64::from_str_radix(ms, 16), u32::from_str_radix(pid, 16)) else {
        return false;
    };
    if pid == std::process::id() {
        // Not this process's epoch (checked by callers), so an earlier one.
        return false;
    }
    let pid = Pid::from_u32(pid);
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::Some(&[pid]), true, ProcessRefreshKind::nothing());
    system.process(pid).is_some_and(|p| p.start_time() <= ms / 1000 + 2)
}

pub(crate) fn now() -> String {
    tauri_plugin_agent_tools::audit::now()
}

pub(crate) fn io(e: impl std::fmt::Display) -> CampaignError {
    CampaignError::new(CampaignErrorKind::Io, e.to_string())
}

pub(crate) fn save(data_folder: &Path, c: &Campaign) -> Result<(), CampaignError> {
    let dir = campaign_dir(data_folder, &c.id)?;
    std::fs::create_dir_all(&dir).map_err(io)?;
    let body = serde_json::to_vec_pretty(c).map_err(io)?;
    tauri_plugin_agent_tools::atomic_file::write_atomic(&dir.join("campaign.json"), &body).map_err(io)
}

pub(crate) fn append_event(data_folder: &Path, id: &str, kind: &str, task: Option<&str>, detail: &str) {
    // The log is a trail, not the record: failing to write it never fails the
    // operation that already succeeded.
    let Ok(dir) = campaign_dir(data_folder, id) else { return };
    let line = serde_json::json!({
        "ts": now(),
        "kind": kind,
        "task": task,
        "detail": detail.chars().take(MAX_DETAIL).collect::<String>(),
    });
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("events.jsonl")) {
        let _ = writeln!(f, "{line}");
    }
}

/// Every line of `events.jsonl`, oldest first. Lines that do not parse are
/// skipped.
pub fn events(data_folder: &Path, id: &str) -> Result<Vec<serde_json::Value>, CampaignError> {
    let dir = campaign_dir(data_folder, id)?;
    let text = std::fs::read_to_string(dir.join("events.jsonl")).unwrap_or_default();
    Ok(text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect())
}

fn read_raw(data_folder: &Path, id: &str) -> Result<Campaign, CampaignError> {
    let dir = campaign_dir(data_folder, id)?;
    let text = std::fs::read_to_string(dir.join("campaign.json")).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            CampaignError::new(CampaignErrorKind::NotFound, format!("no campaign {id} was recorded"))
        } else {
            CampaignError::new(CampaignErrorKind::Corrupt, format!("the record of campaign {id} could not be read: {e}"))
        }
    })?;
    let c: Campaign = serde_json::from_str(&text).map_err(|e| {
        CampaignError::new(CampaignErrorKind::Corrupt, format!("the record of campaign {id} is unreadable: {e}"))
    })?;
    if c.id != id {
        return Err(CampaignError::new(
            CampaignErrorKind::Corrupt,
            "the campaign's record does not match its folder name",
        ));
    }
    Ok(c)
}

/// Load, and rewrite as interrupted anything another process left running.
/// Caller holds the lock.
pub(crate) fn load_reconciled(data_folder: &Path, id: &str) -> Result<Campaign, CampaignError> {
    let mut c = read_raw(data_folder, id)?;
    let me = epoch();
    // Another live process (the desktop app and `flint serve` share a data
    // folder) is driving it: its running work is not interrupted.
    if c.process_epoch == me || epoch_alive(&c.process_epoch) {
        return Ok(c);
    }
    let mut changed = Vec::new();
    for t in &mut c.tasks {
        let to = match t.status {
            s if s.is_live() => TaskStatus::Interrupted,
            // The resolver's pane is gone with the process.
            TaskStatus::Resolving => TaskStatus::Interrupted,
            // The worker finished; only the verifier was cut off.
            TaskStatus::Verifying => TaskStatus::Completed,
            _ => continue,
        };
        changed.push((t.id.clone(), t.status));
        t.status = to;
    }
    let project_cut = matches!(c.status, CampaignStatus::Running | CampaignStatus::Merging);
    if project_cut {
        c.status = CampaignStatus::Interrupted;
    }
    c.process_epoch = me;
    if project_cut || !changed.is_empty() {
        c.updated_at = now();
    }
    save(data_folder, &c)?;
    for (task, from) in changed {
        append_event(data_folder, id, "task-interrupted", Some(&task), &format!("was {from:?} when the app stopped"));
    }
    if project_cut {
        append_event(data_folder, id, "campaign-interrupted", None, "the app stopped while the campaign ran");
    }
    Ok(c)
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CreateInput {
    #[serde(default)]
    pub id: Option<String>,
    pub title: String,
    pub coordinator_session: String,
    pub source_root: String,
    #[serde(default)]
    pub base_branch: String,
    #[serde(default)]
    pub base_sha: String,
    #[serde(default)]
    pub integration_branch: String,
    #[serde(default)]
    pub integration_worktree: String,
    pub mode_ceiling: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub limits: Option<CampaignLimits>,
    pub tasks: Vec<PlanTask>,
    /// `renderer` (default) or `server`.
    #[serde(default)]
    pub driver: Option<String>,
}

fn new_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("c-{nanos:x}-{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

/// Validate the plan and write a new `planned` campaign.
pub fn create(data_folder: &Path, input: CreateInput) -> Result<Campaign, CampaignError> {
    let id = input.id.clone().unwrap_or_else(new_id);
    check_id("campaign", &id)?;
    if input.title.trim().is_empty() || input.coordinator_session.trim().is_empty() || input.source_root.trim().is_empty() {
        return Err(CampaignError::new(
            CampaignErrorKind::InvalidPlan,
            "a campaign needs a title, a coordinator session and a source root",
        ));
    }
    // A task's mode is capped by the ceiling, and bypass is never inherited.
    if input.mode_ceiling.trim().is_empty() || input.mode_ceiling.trim().eq_ignore_ascii_case("bypass") {
        return Err(CampaignError::new(
            CampaignErrorKind::InvalidPlan,
            "a campaign's mode ceiling must be set and cannot be bypass",
        ));
    }
    validate_plan(&input.tasks).map_err(|issues| {
        CampaignError::new(CampaignErrorKind::InvalidPlan, issues.join("; "))
    })?;
    let mut limits = input.limits.unwrap_or_default();
    limits.max_parallel = limits.max_parallel.clamp(1, MAX_PARALLEL_CAP);
    limits.max_tasks = MAX_TASKS as u32;

    let estimate = estimate_cost(input.tasks.len(), &list(data_folder));

    let _held = lock(data_folder);
    if campaign_dir(data_folder, &id)?.join("campaign.json").exists() {
        return Err(CampaignError::new(CampaignErrorKind::Exists, format!("campaign {id} already exists")));
    }
    let stamp = now();
    let c = Campaign {
        schema_version: SCHEMA_VERSION,
        id: id.clone(),
        title: input.title.chars().take(200).collect(),
        coordinator_session: input.coordinator_session,
        source_root: input.source_root,
        base_branch: input.base_branch,
        base_sha: input.base_sha,
        integration_branch: input.integration_branch,
        integration_worktree: input.integration_worktree,
        mode_ceiling: input.mode_ceiling,
        model: input.model,
        limits,
        status: CampaignStatus::Planned,
        process_epoch: epoch(),
        created_at: stamp.clone(),
        updated_at: stamp,
        tasks: input.tasks.into_iter().map(CampaignTask::from_plan).collect(),
        gate: None,
        proposal_id: None,
        estimate: Some(estimate),
        driver: match input.driver.as_deref().map(str::trim) {
            Some(DRIVER_SERVER) => DRIVER_SERVER.to_string(),
            _ => DRIVER_RENDERER.to_string(),
        },
    };
    save(data_folder, &c)?;
    append_event(data_folder, &id, "campaign-created", None, &format!("{} tasks", c.tasks.len()));
    Ok(c)
}

pub fn get(data_folder: &Path, id: &str) -> Result<Campaign, CampaignError> {
    let _held = lock(data_folder);
    load_reconciled(data_folder, id)
}

/// A campaign folder whose record could not be read. The folder is left as it
/// is (nothing is moved or deleted); the list skips it and says why.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkippedRecord {
    pub id: String,
    pub reason: String,
}

/// Every readable campaign, newest first, and the folders that were skipped.
/// A missing campaigns folder is an empty list, never an error.
pub fn list_with_skipped(data_folder: &Path) -> (Vec<Campaign>, Vec<SkippedRecord>) {
    let _held = lock(data_folder);
    let entries = match std::fs::read_dir(root(data_folder)) {
        Ok(entries) => entries,
        // No campaigns yet is not an error; a folder that is there but cannot
        // be read must not look like "No campaigns yet".
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (Vec::new(), Vec::new()),
        Err(e) => {
            log::warn!("campaigns folder unreadable: {e}");
            let reason = format!("the campaigns folder could not be read: {e}");
            return (Vec::new(), vec![SkippedRecord { id: "campaigns".into(), reason }]);
        }
    };
    let mut out: Vec<Campaign> = Vec::new();
    let mut skipped: Vec<SkippedRecord> = Vec::new();
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|name| valid_id(name))
        .collect();
    names.sort();
    for name in names {
        match load_reconciled(data_folder, &name) {
            Ok(c) => out.push(c),
            // A folder with no record yet (a create cut short) is not damage.
            Err(e) if e.kind == CampaignErrorKind::NotFound => {}
            Err(e) => {
                log::warn!("campaign {name} skipped: {e}");
                skipped.push(SkippedRecord { id: name, reason: e.message });
            }
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(a.id.cmp(&b.id)));
    (out, skipped)
}

/// The campaigns whose record text holds `needle` (a session id), newest
/// first: [`list`] without parsing and reconciling every record when only
/// one session's link is wanted. A needle JSON would escape falls back to
/// the full list.
pub fn list_mentioning(data_folder: &Path, needle: &str) -> Vec<Campaign> {
    if needle.is_empty() || needle.chars().any(|c| c == '"' || c == '\\' || c.is_control()) {
        return list(data_folder);
    }
    let names: Vec<String> = {
        let _held = lock(data_folder);
        let Ok(entries) = std::fs::read_dir(root(data_folder)) else { return Vec::new() };
        entries
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|name| valid_id(name))
            .filter(|name| {
                std::fs::read_to_string(root(data_folder).join(name).join("campaign.json"))
                    .map(|text| text.contains(needle))
                    .unwrap_or(false)
            })
            .collect()
    };
    let mut out: Vec<Campaign> = names
        .iter()
        .filter_map(|name| {
            let _held = lock(data_folder);
            load_reconciled(data_folder, name).ok()
        })
        .collect();
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(a.id.cmp(&b.id)));
    out
}

/// Every readable campaign, newest first. Reconciles each as it goes.
pub fn list(data_folder: &Path) -> Vec<Campaign> {
    list_with_skipped(data_folder).0
}

/// Reconcile one campaign explicitly (what `get` and `list` do on the way).
pub fn reconcile(data_folder: &Path, id: &str) -> Result<Campaign, CampaignError> {
    get(data_folder, id)
}

/// Fields the renderer may record on a task as it moves. Taken as given:
/// the merge phase re-derives worktree identity from Git before it trusts them.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskPatch {
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub worktree_path: Option<String>,
    #[serde(default)]
    pub base_sha: Option<String>,
    #[serde(default)]
    pub tokens_used: Option<u64>,
    #[serde(default)]
    pub fingerprint: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
    /// With a move to `verified` from `completed`: accept the task by hand.
    #[serde(default)]
    pub accept: Option<ManualAccept>,
}

fn apply_patch(t: &mut CampaignTask, p: TaskPatch) {
    let cap = |s: String, n: usize| s.chars().take(n).collect::<String>();
    if let Some(v) = p.session_id {
        t.session_id = Some(cap(v, 200));
    }
    if let Some(v) = p.branch {
        t.branch = Some(cap(v, 300));
    }
    if let Some(v) = p.worktree_path {
        t.worktree_path = Some(cap(v, 1000));
    }
    if let Some(v) = p.base_sha {
        // The commit the task began from is recorded once. A retry in the same
        // worktree reports the branch's current tip, which would make the diff
        // of everything already committed empty.
        if t.base_sha.as_deref().is_none_or(str::is_empty) {
            t.base_sha = Some(cap(v, 64));
        }
    }
    if let Some(v) = p.tokens_used {
        t.tokens_used = v;
    }
    if let Some(v) = p.fingerprint {
        t.fingerprint = Some(cap(v, 128));
    }
    if let Some(v) = p.detail {
        t.detail = cap(v, MAX_DETAIL);
    }
}

/// "Accept anyway": a completed task whose verification was blocked (or never
/// ran) is verified by a person. It goes through `verifying` like any other
/// verification and leaves a record of who decided it and why.
pub(crate) fn accept_manually(
    t: &mut CampaignTask,
    to: TaskStatus,
    accept: ManualAccept,
) -> Result<(), CampaignError> {
    if to != TaskStatus::Verified || t.status != TaskStatus::Completed {
        return Err(illegal(&format!("task {} (manual acceptance)", t.id), t.status, to));
    }
    let by = clip_text(accept.by.trim(), 80);
    if by.is_empty() {
        return Err(CampaignError::new(
            CampaignErrorKind::VerdictRequired,
            format!("task {} can be accepted by hand only by someone who is named", t.id),
        ));
    }
    let reason = match clip_text(accept.reason.trim(), 400) {
        r if r.is_empty() => "accepted without a passing verification".to_string(),
        r => r,
    };
    let previous = t.verdict;
    transition_task(t, TaskStatus::Verifying, None)?;
    transition_task(t, TaskStatus::Verified, Some(TaskVerdict::Pass))?;
    t.detail = clip_text(&format!("accepted by {by} without a passing verification: {reason}"), MAX_DETAIL);
    t.manual_override = Some(ManualOverride { by, reason, at: now(), previous_verdict: previous });
    Ok(())
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TaskMove {
    pub id: String,
    pub to: TaskStatus,
    #[serde(default)]
    pub verdict: Option<TaskVerdict>,
    #[serde(default)]
    pub patch: TaskPatch,
}

/// The integration branch and worktree, recorded when a plan is approved: they
/// are created only then, so a denied plan leaves nothing behind. Taken as
/// given; the merge phase re-derives worktree identity from Git.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationInfo {
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub worktree: String,
    #[serde(default)]
    pub base_branch: String,
    #[serde(default)]
    pub base_sha: String,
    /// The user's choice at the plan card, recorded with the approval: the
    /// highest mode a task may run in (`ask`, `auto`; never `bypass`) and the
    /// access choice behind it (`worktree` or `ask`). Empty keeps what the
    /// plan was created with.
    #[serde(default)]
    pub mode_ceiling: String,
    #[serde(default)]
    pub task_access: String,
}

/// Exactly one of `campaign` or `task`. `integration` rides along with a
/// campaign move only.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransitionInput {
    #[serde(default)]
    pub campaign: Option<CampaignStatus>,
    #[serde(default)]
    pub task: Option<TaskMove>,
    #[serde(default)]
    pub integration: Option<IntegrationInfo>,
}

pub fn transition(data_folder: &Path, id: &str, input: TransitionInput) -> Result<Campaign, CampaignError> {
    let _held = lock(data_folder);
    let mut c = load_reconciled(data_folder, id)?;
    match (input.campaign, input.task) {
        (Some(to), None) => {
            let from = c.status;
            transition_campaign(&mut c, to)?;
            if let Some(info) = input.integration {
                let cap = |s: String, n: usize| s.chars().take(n).collect::<String>();
                c.integration_branch = cap(info.branch, 300);
                c.integration_worktree = cap(info.worktree, 1000);
                if !info.base_branch.is_empty() {
                    c.base_branch = cap(info.base_branch, 300);
                }
                if !info.base_sha.is_empty() {
                    c.base_sha = cap(info.base_sha, 64);
                }
                let ceiling = info.mode_ceiling.trim().to_ascii_lowercase();
                if matches!(ceiling.as_str(), "review" | "ask" | "auto") {
                    c.mode_ceiling = ceiling;
                } else if !ceiling.is_empty() {
                    return Err(CampaignError::new(
                        CampaignErrorKind::InvalidPlan,
                        "a campaign's mode ceiling is review, ask or auto; bypass is never granted to tasks",
                    ));
                }
                let access = info.task_access.trim().to_ascii_lowercase();
                if matches!(access.as_str(), "worktree" | "ask") {
                    c.limits.task_access = Some(access);
                }
            }
            c.updated_at = now();
            save(data_folder, &c)?;
            append_event(data_folder, id, "campaign-status", None, &format!("{from:?} -> {to:?}"));
        }
        (None, Some(mv)) => {
            check_id("task", &mv.id)?;
            if c.status.is_terminal() {
                return Err(illegal("a task of a finished campaign", c.status, mv.to));
            }
            let t = c.task_mut(&mv.id)?;
            let from = t.status;
            let accepted = match mv.patch.accept.clone() {
                Some(accept) => {
                    accept_manually(t, mv.to, accept)?;
                    t.manual_override.clone()
                }
                None => {
                    transition_task(t, mv.to, mv.verdict)?;
                    None
                }
            };
            apply_patch(t, mv.patch);
            let reviewing = advance_to_review(&mut c);
            c.updated_at = now();
            save(data_folder, &c)?;
            append_event(data_folder, id, "task-status", Some(&mv.id), &format!("{from:?} -> {:?}", mv.to));
            if let Some(o) = accepted {
                append_event(
                    data_folder,
                    id,
                    "task-accepted-manually",
                    Some(&mv.id),
                    &format!("{}: {}", o.by, o.reason),
                );
            }
            if reviewing {
                append_event(data_folder, id, "campaign-status", None, "Running -> Reviewing");
            }
        }
        _ => {
            return Err(CampaignError::new(
                CampaignErrorKind::IllegalTransition,
                "name exactly one of a campaign status or a task move",
            ))
        }
    }
    Ok(c)
}

/// One read-modify-write under the record lock, for the integration phase
/// (`campaign_integration`). `f` returns the events to log as
/// `(kind, task, detail)`. A finished campaign is never changed.
pub(crate) fn update<T>(
    data_folder: &Path,
    id: &str,
    f: impl FnOnce(&mut Campaign) -> Result<(T, Vec<(String, Option<String>, String)>), CampaignError>,
) -> Result<(Campaign, T), CampaignError> {
    let _held = lock(data_folder);
    let mut c = load_reconciled(data_folder, id)?;
    if c.status.is_terminal() {
        return Err(illegal("a finished campaign", c.status, "a change"));
    }
    let (value, events) = f(&mut c)?;
    c.updated_at = now();
    // The last writer owns it: while that process lives, no other reads its
    // running work as interrupted.
    c.process_epoch = epoch();
    save(data_folder, &c)?;
    for (kind, task, detail) in events {
        append_event(data_folder, id, &kind, task.as_deref(), &detail);
    }
    Ok((c, value))
}

/// First `n` characters.
pub(crate) fn clip_text(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Completed,
    Failed,
    Cancelled,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SettleInput {
    pub outcome: Outcome,
    #[serde(default)]
    pub detail: String,
    /// The task's final summary, changed files and open questions.
    #[serde(default)]
    pub handoff: Option<String>,
    #[serde(default)]
    pub tokens_used: Option<u64>,
    #[serde(default)]
    pub fingerprint: Option<String>,
}

/// `tasks/<id>/handoff.md`, replaced atomically.
pub fn write_handoff(data_folder: &Path, id: &str, task_id: &str, text: &str) -> Result<String, CampaignError> {
    check_id("task", task_id)?;
    if text.len() > MAX_HANDOFF {
        return Err(CampaignError::new(
            CampaignErrorKind::InvalidPlan,
            format!("a handoff is at most {MAX_HANDOFF} bytes"),
        ));
    }
    let dir = campaign_dir(data_folder, id)?.join("tasks").join(task_id);
    std::fs::create_dir_all(&dir).map_err(io)?;
    tauri_plugin_agent_tools::atomic_file::write_atomic(&dir.join("handoff.md"), text.as_bytes()).map_err(io)?;
    Ok(format!("tasks/{task_id}/handoff.md"))
}

/// `text` cut to at most `MAX_HANDOFF` bytes on a character boundary, with a
/// marker when something was cut.
fn clip_handoff(text: &str) -> String {
    const MARK: &str = "\n[handoff cut]";
    if text.len() <= MAX_HANDOFF {
        return text.to_string();
    }
    let mut end = MAX_HANDOFF - MARK.len();
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{MARK}", &text[..end])
}

/// Record how a task's run ended. The first ending wins: a late settle of a
/// task that has already ended returns the record unchanged.
pub fn task_settle(
    data_folder: &Path,
    id: &str,
    task_id: &str,
    input: SettleInput,
) -> Result<Campaign, CampaignError> {
    check_id("task", task_id)?;
    let _held = lock(data_folder);
    let mut c = load_reconciled(data_folder, id)?;
    let t = c.task_mut(task_id)?;
    let from = t.status;
    if !from.is_live() {
        if matches!(
            from,
            TaskStatus::Completed
                | TaskStatus::Failed
                | TaskStatus::Cancelled
                | TaskStatus::Verifying
                | TaskStatus::Verified
                | TaskStatus::Merged
                | TaskStatus::Conflict
                | TaskStatus::Interrupted
        ) {
            return Ok(c);
        }
        return Err(illegal(&format!("task {task_id}"), from, input.outcome));
    }
    let to = match input.outcome {
        Outcome::Completed => TaskStatus::Completed,
        Outcome::Failed => TaskStatus::Failed,
        Outcome::Cancelled => TaskStatus::Cancelled,
    };
    transition_task(t, to, None)?;
    apply_patch(
        t,
        TaskPatch {
            tokens_used: input.tokens_used,
            fingerprint: input.fingerprint,
            detail: Some(input.detail),
            ..Default::default()
        },
    );
    if let Some(text) = input.handoff.as_deref() {
        // A handoff the model made too long, or one that cannot be written,
        // must not leave the task unsettled and stuck Running.
        let clipped = clip_handoff(text);
        match write_handoff(data_folder, id, task_id, &clipped) {
            Ok(rel) => c.task_mut(task_id)?.handoff_path = Some(rel),
            Err(e) => log::warn!("campaign {id}: handoff for {task_id} was not saved: {e:?}"),
        }
    }
    let reviewing = advance_to_review(&mut c);
    c.updated_at = now();
    save(data_folder, &c)?;
    append_event(data_folder, id, "task-settled", Some(task_id), &format!("{from:?} -> {to:?}"));
    if reviewing {
        append_event(data_folder, id, "campaign-status", None, "Running -> Reviewing");
    }
    Ok(c)
}

/// Cancel the campaign and every task that has not finished. Running ones are
/// marked here; aborting their runs is the renderer's job.
pub fn cancel(data_folder: &Path, id: &str, detail: &str) -> Result<Campaign, CampaignError> {
    let _held = lock(data_folder);
    let mut c = load_reconciled(data_folder, id)?;
    if c.status == CampaignStatus::Cancelled {
        return Ok(c);
    }
    transition_campaign(&mut c, CampaignStatus::Cancelled)?;
    for t in &mut c.tasks {
        if !t.status.is_terminal() {
            transition_task(t, TaskStatus::Cancelled, None)?;
        }
    }
    c.updated_at = now();
    save(data_folder, &c)?;
    append_event(data_folder, id, "campaign-cancelled", None, detail);
    Ok(c)
}

/// Remove a campaign's record folder (plan, events, decisions, handoffs). Only
/// a campaign that is not running may go: finished ones (done, failed,
/// cancelled) and ones that never started (draft, planned). Git branches,
/// worktrees and the project folder are left exactly where they are.
pub fn delete(data_folder: &Path, id: &str) -> Result<(), CampaignError> {
    let _held = lock(data_folder);
    let dir = campaign_dir(data_folder, id)?;
    let c = load_reconciled(data_folder, id)?;
    let idle = c.status.is_terminal() || matches!(c.status, CampaignStatus::Draft | CampaignStatus::Planned);
    if !idle {
        return Err(CampaignError::new(
            CampaignErrorKind::IllegalTransition,
            format!("campaign {id} is {:?}; cancel or finish it before deleting", c.status),
        ));
    }
    std::fs::remove_dir_all(&dir).map_err(io)
}

/// Append to `decisions.md`. Written by the coordinator only.
pub fn decisions_append(data_folder: &Path, id: &str, text: &str) -> Result<(), CampaignError> {
    let text = text.trim();
    if text.is_empty() || text.chars().count() > MAX_TEXT {
        return Err(CampaignError::new(
            CampaignErrorKind::InvalidPlan,
            format!("a decision is 1-{MAX_TEXT} characters"),
        ));
    }
    let _held = lock(data_folder);
    let dir = campaign_dir(data_folder, id)?;
    if !dir.join("campaign.json").exists() {
        return Err(CampaignError::new(CampaignErrorKind::NotFound, format!("no campaign {id} was recorded")));
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("decisions.md"))
        .map_err(io)?;
    write!(f, "## {}\n\n{}\n\n", now(), text).map_err(io)?;
    drop(f);
    append_event(data_folder, id, "decision", None, text);
    Ok(())
}

/// What a starting task, or the coordinator collecting results, reads from the
/// campaign folder. All of it is untrusted text.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CampaignContext {
    /// The tail of `decisions.md`.
    pub decisions: String,
    pub handoffs: Vec<HandoffText>,
    /// For a task with a resolver: the brief written when the resolver was
    /// prepared (both handoffs, files, conflict regions, fenced).
    pub resolutions: Vec<HandoffText>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HandoffText {
    pub task_id: String,
    pub text: String,
}

const MAX_CONTEXT_DECISIONS: usize = 16_000;
const MAX_CONTEXT_HANDOFF: usize = 12_000;
const MAX_CONTEXT_RESOLUTION: usize = 48_000;

fn tail_chars(text: &str, n: usize) -> String {
    let count = text.chars().count();
    if count <= n {
        return text.to_string();
    }
    text.chars().skip(count - n).collect()
}

/// The decisions so far and the named tasks' handoffs, each cut to a size a
/// seed turn can carry. A task with no handoff is simply absent.
pub fn context(data_folder: &Path, id: &str, task_ids: &[String]) -> Result<CampaignContext, CampaignError> {
    let dir = campaign_dir(data_folder, id)?;
    if !dir.join("campaign.json").exists() {
        return Err(CampaignError::new(CampaignErrorKind::NotFound, format!("no campaign {id} was recorded")));
    }
    let decisions = std::fs::read_to_string(dir.join("decisions.md")).unwrap_or_default();
    let mut handoffs = Vec::new();
    let mut resolutions = Vec::new();
    for task_id in task_ids {
        check_id("task", task_id)?;
        let path = dir.join("tasks").join(task_id).join("handoff.md");
        if let Ok(text) = std::fs::read_to_string(path) {
            handoffs.push(HandoffText {
                task_id: task_id.clone(),
                text: text.chars().take(MAX_CONTEXT_HANDOFF).collect(),
            });
        }
        if let Ok(text) = std::fs::read_to_string(dir.join("tasks").join(task_id).join("resolve.md")) {
            resolutions.push(HandoffText {
                task_id: task_id.clone(),
                text: text.chars().take(MAX_CONTEXT_RESOLUTION).collect(),
            });
        }
    }
    Ok(CampaignContext { decisions: tail_chars(&decisions, MAX_CONTEXT_DECISIONS), handoffs, resolutions })
}

/// `tasks/<id>/resolve.md`, replaced atomically.
pub(crate) fn write_resolution(data_folder: &Path, id: &str, task_id: &str, text: &str) -> Result<(), CampaignError> {
    check_id("task", task_id)?;
    let dir = campaign_dir(data_folder, id)?.join("tasks").join(task_id);
    std::fs::create_dir_all(&dir).map_err(io)?;
    tauri_plugin_agent_tools::atomic_file::write_atomic(&dir.join("resolve.md"), text.as_bytes()).map_err(io)
}

/// Claim the right to show one desktop notification. `true` once per `key`
/// per campaign, recorded in the event log so a restart does not repeat it.
pub fn claim_notice(data_folder: &Path, id: &str, key: &str) -> Result<bool, CampaignError> {
    let key = clip_text(key.trim(), 300);
    if key.is_empty() {
        return Ok(false);
    }
    let _held = lock(data_folder);
    let c = load_reconciled(data_folder, id)?;
    let seen = events(data_folder, &c.id)?
        .iter()
        .any(|e| e["kind"] == "desktop-notified" && e["detail"] == key.as_str());
    if seen {
        return Ok(false);
    }
    append_event(data_folder, id, "desktop-notified", None, &key);
    Ok(true)
}

// ---------------------------------------------------------------------------
// Editing a plan that is not approved yet
// ---------------------------------------------------------------------------

#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum PlanOp {
    /// Append a task (or insert it `at` an index).
    Add {
        task: PlanTask,
        #[serde(default)]
        at: Option<usize>,
    },
    /// Replace the given fields of an existing task.
    #[serde(rename_all = "camelCase")]
    Update {
        id: String,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        brief: Option<String>,
        #[serde(default)]
        acceptance: Option<Vec<String>>,
        #[serde(default)]
        paths: Option<Vec<String>>,
        #[serde(default)]
        depends_on: Option<Vec<String>>,
    },
    /// Drop a task; it is also removed from other tasks' dependencies.
    Remove { id: String },
    /// Put the tasks in this order; ids not named keep their relative order after.
    Reorder { ids: Vec<String> },
    /// Replace the whole task list.
    Replace { tasks: Vec<PlanTask> },
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlanEdit {
    #[serde(default)]
    pub ops: Vec<PlanOp>,
    #[serde(default)]
    pub title: Option<String>,
    /// `Some(0)` clears the token budget.
    #[serde(default)]
    pub token_budget: Option<u64>,
}

fn as_plan(t: &CampaignTask) -> PlanTask {
    PlanTask {
        id: t.id.clone(),
        title: t.title.clone(),
        brief: t.brief.clone(),
        acceptance: t.acceptance.clone(),
        paths: t.paths.clone(),
        depends_on: t.depends_on.clone(),
        kind: if t.kind == KIND_CHECK { t.kind.clone() } else { String::new() },
    }
}

/// Apply `edit` to a `planned` (or `draft`) campaign. The result is validated
/// as a whole with `validate_plan`; nothing is saved when it does not hold.
/// Recorded as a `plan-updated` event. Once the plan is approved the tasks are
/// fixed: an edit then is an illegal transition.
pub fn plan_update(data_folder: &Path, id: &str, edit: PlanEdit) -> Result<Campaign, CampaignError> {
    let history: Vec<Campaign> = list(data_folder).into_iter().filter(|c| c.id != id).collect();
    let _held = lock(data_folder);
    let mut c = load_reconciled(data_folder, id)?;
    if !matches!(c.status, CampaignStatus::Planned | CampaignStatus::Draft) {
        return Err(illegal("the plan of a campaign (it is edited only before approval)", c.status, "an edit"));
    }
    let mut tasks: Vec<PlanTask> = c.tasks.iter().map(as_plan).collect();
    let mut summary = Vec::new();
    let bad = |m: String| CampaignError::new(CampaignErrorKind::InvalidPlan, m);
    for op in edit.ops {
        match op {
            PlanOp::Add { task, at } => {
                summary.push(format!("add {}", task.id));
                let i = at.unwrap_or(tasks.len()).min(tasks.len());
                tasks.insert(i, task);
            }
            PlanOp::Update { id: tid, title, brief, acceptance, paths, depends_on } => {
                let t = tasks
                    .iter_mut()
                    .find(|t| t.id == tid)
                    .ok_or_else(|| bad(format!("no task {tid} in this plan")))?;
                if let Some(v) = title {
                    t.title = v;
                }
                if let Some(v) = brief {
                    t.brief = v;
                }
                if let Some(v) = acceptance {
                    t.acceptance = v;
                }
                if let Some(v) = paths {
                    t.paths = v;
                }
                if let Some(v) = depends_on {
                    t.depends_on = v;
                }
                summary.push(format!("update {tid}"));
            }
            PlanOp::Remove { id: tid } => {
                if !tasks.iter().any(|t| t.id == tid) {
                    return Err(bad(format!("no task {tid} in this plan")));
                }
                tasks.retain(|t| t.id != tid);
                for t in &mut tasks {
                    t.depends_on.retain(|d| *d != tid);
                }
                summary.push(format!("remove {tid}"));
            }
            PlanOp::Reorder { ids } => {
                let mut ordered: Vec<PlanTask> = Vec::new();
                for want in &ids {
                    let at = tasks
                        .iter()
                        .position(|t| t.id == *want)
                        .ok_or_else(|| bad(format!("no task {want} in this plan")))?;
                    ordered.push(tasks.remove(at));
                }
                ordered.append(&mut tasks);
                tasks = ordered;
                summary.push("reorder".to_string());
            }
            PlanOp::Replace { tasks: next } => {
                tasks = next;
                summary.push("replace".to_string());
            }
        }
    }
    validate_plan(&tasks).map_err(|issues| bad(issues.join("; ")))?;
    c.tasks = tasks.into_iter().map(CampaignTask::from_plan).collect();
    if let Some(title) = edit.title.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        c.title = title.chars().take(200).collect();
        summary.push("title".to_string());
    }
    if let Some(b) = edit.token_budget {
        c.limits.token_budget = (b > 0).then_some(b);
        summary.push("budget".to_string());
    }
    c.estimate = Some(estimate_cost(c.tasks.len(), &history));
    c.updated_at = now();
    save(data_folder, &c)?;
    append_event(data_folder, id, "plan-updated", None, &summary.join(", "));
    Ok(c)
}

// ---------------------------------------------------------------------------
// Skipping a task, and what happens to what waits on it
// ---------------------------------------------------------------------------

/// What skipping a task does to the tasks that depend on it.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SkipDependants {
    /// Only the task: its dependants stay blocked until a person decides.
    #[default]
    Leave,
    /// Its dependants, and theirs, are cancelled with "dependency skipped".
    Cascade,
    /// Its dependants run without it; their seed says what was skipped.
    Release,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SkipReport {
    pub campaign: Campaign,
    /// Dependants cancelled by a cascade (the skipped task itself excluded).
    pub cancelled: Vec<String>,
    /// Dependants released to run without the skipped task.
    pub released: Vec<String>,
}

/// Tasks that wait on `task_id`, directly or through other tasks, and are not
/// finished.
pub fn open_dependants(c: &Campaign, task_id: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut todo = vec![task_id.to_string()];
    while let Some(cur) = todo.pop() {
        for t in &c.tasks {
            if t.depends_on.contains(&cur) && !t.status.is_terminal() && !out.contains(&t.id) {
                out.push(t.id.clone());
                todo.push(t.id.clone());
            }
        }
    }
    out
}

/// Skip a task (cancel it) and settle its dependants as the person chose. The
/// campaign then moves to review when nothing is left to do. The backend does
/// not stop a live run: the caller aborts the sessions of what was cancelled.
pub fn skip_task(
    data_folder: &Path,
    id: &str,
    task_id: &str,
    dependants: SkipDependants,
) -> Result<SkipReport, CampaignError> {
    check_id("task", task_id)?;
    let _held = lock(data_folder);
    let mut c = load_reconciled(data_folder, id)?;
    if c.status.is_terminal() {
        return Err(illegal("a task of a finished campaign", c.status, "a skip"));
    }
    c.task(task_id)
        .ok_or_else(|| CampaignError::new(CampaignErrorKind::NotFound, format!("no task {task_id} in this campaign")))?;
    let waiting = open_dependants(&c, task_id);
    transition_task(c.task_mut(task_id)?, TaskStatus::Cancelled, None)?;
    {
        let t = c.task_mut(task_id)?;
        t.detail = "skipped".to_string();
    }
    let mut cancelled = Vec::new();
    let mut released = Vec::new();
    match dependants {
        SkipDependants::Leave => {}
        SkipDependants::Cascade => {
            for dep in &waiting {
                let t = c.task_mut(dep)?;
                if transition_task(t, TaskStatus::Cancelled, None).is_ok() {
                    t.detail = format!("dependency skipped: {task_id}");
                    cancelled.push(dep.clone());
                }
            }
        }
        SkipDependants::Release => {
            let direct: Vec<String> = c
                .tasks
                .iter()
                .filter(|t| t.depends_on.iter().any(|d| d == task_id) && !t.status.is_terminal())
                .map(|t| t.id.clone())
                .collect();
            for dep in direct {
                let t = c.task_mut(&dep)?;
                // Only work that has not started can run without it.
                if !matches!(t.status, TaskStatus::Pending | TaskStatus::Blocked | TaskStatus::Queued) {
                    continue;
                }
                t.depends_on.retain(|d| d != task_id);
                if !t.skipped_deps.iter().any(|d| d == task_id) {
                    t.skipped_deps.push(task_id.to_string());
                }
                if t.status == TaskStatus::Blocked {
                    transition_task(t, TaskStatus::Pending, None)?;
                }
                t.detail = format!("released: {task_id} was skipped");
                released.push(dep);
            }
        }
    }
    let reviewing = advance_to_review(&mut c);
    c.updated_at = now();
    save(data_folder, &c)?;
    let how = match dependants {
        SkipDependants::Leave => "dependants left waiting",
        SkipDependants::Cascade => "dependants cancelled",
        SkipDependants::Release => "dependants released",
    };
    append_event(
        data_folder,
        id,
        "task-skipped",
        Some(task_id),
        &format!("{how}: cancelled [{}], released [{}]", cancelled.join(", "), released.join(", ")),
    );
    if reviewing {
        append_event(data_folder, id, "campaign-status", None, "Running -> Reviewing");
    }
    Ok(SkipReport { campaign: c, cancelled, released })
}

/// Tasks a campaign may add after approval, once its final gate failed.
const MAX_GATE_REPAIRS: usize = 3;

/// Add the one repair task a failed gate asks for, and send the campaign back
/// to `running` so it runs like any task on the integration branch. Nothing
/// else may be added to a campaign that is under review: this is not a plan
/// edit. `brief` is built by the caller from the gate output and changed files.
pub fn add_gate_repair(data_folder: &Path, id: &str, brief: String) -> Result<(Campaign, String), CampaignError> {
    let _held = lock(data_folder);
    let mut c = load_reconciled(data_folder, id)?;
    if c.status != CampaignStatus::Reviewing {
        return Err(illegal("a gate repair (it is added while the campaign is reviewing)", c.status, "a repair task"));
    }
    let Some(gate) = c.gate.clone().filter(|g| !g.passed && !g.skipped) else {
        return Err(CampaignError::new(
            CampaignErrorKind::IllegalTransition,
            "the gate has not failed, so there is nothing to repair",
        ));
    };
    let made = c.tasks.iter().filter(|t| t.kind == KIND_GATE_REPAIR).count();
    if made >= MAX_GATE_REPAIRS {
        return Err(CampaignError::new(
            CampaignErrorKind::InvalidPlan,
            format!("the gate has already been repaired {MAX_GATE_REPAIRS} times; fix it by hand"),
        ));
    }
    let task_id = if made == 0 { "gate-repair".to_string() } else { format!("gate-repair-{}", made + 1) };
    let mut task = CampaignTask::from_plan(PlanTask {
        id: task_id.clone(),
        title: "Repair the failing final gate".to_string(),
        brief,
        acceptance: vec![format!("`{}` exits 0 in your worktree", gate.command)],
        paths: Vec::new(),
        depends_on: Vec::new(),
        kind: String::new(),
    });
    task.kind = KIND_GATE_REPAIR.to_string();
    c.tasks.push(task);
    transition_campaign(&mut c, CampaignStatus::Running)?;
    c.updated_at = now();
    save(data_folder, &c)?;
    append_event(data_folder, id, "gate-repair-added", Some(&task_id), &clip_text(&gate.command, 200));
    append_event(data_folder, id, "campaign-status", None, "Reviewing -> Running");
    Ok((c, task_id))
}

/// Record that the coordinator was told how a task ended, so a restart does
/// not tell it twice and does not forget to.
pub fn note_notified(data_folder: &Path, id: &str, task_id: &str) -> Result<(), CampaignError> {
    check_id("task", task_id)?;
    let _held = lock(data_folder);
    let c = load_reconciled(data_folder, id)?;
    c.task(task_id)
        .ok_or_else(|| CampaignError::new(CampaignErrorKind::NotFound, format!("no task {task_id} in this campaign")))?;
    append_event(data_folder, id, "coordinator-notified", Some(task_id), "");
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn plan(id: &str, deps: &[&str], paths: &[&str]) -> PlanTask {
        PlanTask {
            id: id.into(),
            title: format!("task {id}"),
            brief: format!("do {id}"),
            acceptance: vec![],
            paths: if paths.is_empty() { vec![format!("p-{id}")] } else { paths.iter().map(|s| s.to_string()).collect() },
            depends_on: deps.iter().map(|s| s.to_string()).collect(),
            kind: String::new(),
        }
    }

    pub fn campaign(tasks: Vec<PlanTask>) -> Campaign {
        Campaign {
            schema_version: SCHEMA_VERSION,
            id: "c1".into(),
            title: "t".into(),
            coordinator_session: "s".into(),
            source_root: "/src".into(),
            base_branch: "main".into(),
            base_sha: "a".repeat(40),
            integration_branch: "flint/c1".into(),
            integration_worktree: String::new(),
            mode_ceiling: "ask".into(),
            model: String::new(),
            limits: CampaignLimits::default(),
            status: CampaignStatus::Running,
            process_epoch: "x".into(),
            created_at: "0".into(),
            updated_at: "0".into(),
            tasks: tasks
                .into_iter()
                .map(|t| CampaignTask {
                    id: t.id,
                    title: t.title,
                    brief: t.brief,
                    acceptance: t.acceptance,
                    paths: t.paths,
                    depends_on: t.depends_on,
                    session_id: None,
                    branch: None,
                    worktree_path: None,
                    base_sha: None,
                    status: TaskStatus::Pending,
                    attempt: 0,
                    verdict: None,
                    tokens_used: 0,
                    handoff_path: None,
                    merged_sha: None,
                    fingerprint: None,
                    detail: String::new(),
                    manual_override: None,
                    verify_tokens: 0,
                    evidence: None,
                    resolver: None,
                    kind: String::new(),
                    skipped_deps: Vec::new(),
                })
                .collect(),
            gate: None,
            proposal_id: None,
            estimate: None,
            driver: DRIVER_RENDERER.to_string(),
        }
    }

    #[test]
    fn a_damaged_record_names_the_parse_error() {
        let d = data_dir("parse-err");
        let bad = root(&d).join("c-bad");
        std::fs::create_dir_all(&bad).unwrap();
        std::fs::write(bad.join("campaign.json"), "{ not json").unwrap();
        let (_, skipped) = list_with_skipped(&d);
        assert_eq!(skipped.len(), 1);
        assert!(skipped[0].reason.contains("unreadable: "), "{}", skipped[0].reason);
        assert!(skipped[0].reason.contains("key must be a string") || skipped[0].reason.contains("line 1"), "{}", skipped[0].reason);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_unreadable_campaigns_folder_is_reported_not_an_empty_list() {
        let d = data_dir("root-is-file");
        // A file where the campaigns folder should be: read_dir fails with an
        // error that is not NotFound.
        std::fs::create_dir_all(root(&d).parent().unwrap()).unwrap();
        std::fs::write(root(&d), "x").unwrap();
        let (ok, skipped) = list_with_skipped(&d);
        assert!(ok.is_empty());
        assert_eq!(skipped.len(), 1, "{skipped:?}");
        assert!(skipped[0].reason.contains("could not be read"), "{}", skipped[0].reason);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn list_skips_a_damaged_record_and_names_it() {
        let d = data_dir("skip");
        assert!(list_with_skipped(&d).0.is_empty(), "a missing folder is an empty list");
        let mut c = campaign(vec![plan("a", &[], &[])]);
        c.process_epoch = epoch();
        save(&d, &c).unwrap();
        let bad = root(&d).join("c-bad");
        std::fs::create_dir_all(&bad).unwrap();
        std::fs::write(bad.join("campaign.json"), "{ not json").unwrap();
        let empty = root(&d).join("c-empty");
        std::fs::create_dir_all(&empty).unwrap();
        let (ok, skipped) = list_with_skipped(&d);
        assert_eq!(ok.len(), 1);
        assert_eq!(skipped.len(), 1, "{skipped:?}");
        assert_eq!(skipped[0].id, "c-bad");
        assert!(skipped[0].reason.contains("unreadable"));
        assert!(bad.join("campaign.json").exists(), "the damaged record is left in place");
        let _ = std::fs::remove_dir_all(&d);
    }

    // `commands` (home of `campaign_listing`) is compiled out of the CLI build.
    #[cfg(not(feature = "cli"))]
    #[test]
    fn one_listing_call_returns_the_list_and_the_skipped_report() {
        let d = data_dir("listing");
        let mut c = campaign(vec![plan("a", &[], &[])]);
        c.process_epoch = epoch();
        save(&d, &c).unwrap();
        let bad = root(&d).join("c-bad");
        std::fs::create_dir_all(&bad).unwrap();
        std::fs::write(bad.join("campaign.json"), "{ not json").unwrap();
        let v = serde_json::to_value(crate::core::agent::commands::campaign_listing(&d)).unwrap();
        assert_eq!(v["campaigns"].as_array().unwrap().len(), 1);
        assert_eq!(v["skipped"][0]["id"], "c-bad");
        let _ = std::fs::remove_dir_all(&d);
    }

    fn data_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "jan-campaign-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn input(id: Option<&str>, tasks: Vec<PlanTask>) -> CreateInput {
        CreateInput {
            id: id.map(String::from),
            title: "Ship it".into(),
            coordinator_session: "coord".into(),
            source_root: "/src".into(),
            base_branch: "main".into(),
            base_sha: "b".repeat(40),
            integration_branch: "flint/c".into(),
            integration_worktree: String::new(),
            mode_ceiling: "ask".into(),
            model: "m".into(),
            limits: None,
            tasks,
            driver: None,
        }
    }

    fn err_of(tasks: &[PlanTask]) -> String {
        validate_plan(tasks).unwrap_err().join("|")
    }

    // --- plan validation -------------------------------------------------

    #[test]
    fn a_sound_plan_validates() {
        let t = vec![plan("a", &[], &["src/a"]), plan("b", &["a"], &["src/a/x.rs"]), plan("c", &[], &["docs"])];
        assert!(validate_plan(&t).is_ok());
    }

    #[test]
    fn change_task_without_paths_fails_validation() {
        let mut bare = plan("a", &[], &["x"]);
        bare.paths.clear();
        assert!(err_of(&[bare.clone()]).contains("declares no paths"));
        bare.kind = KIND_CHECK.into();
        assert!(validate_plan(&[bare]).is_ok());
    }

    #[test]
    fn empty_paths_task_overlaps_every_change_task() {
        let mut bare = plan("a", &[], &["x"]);
        bare.paths.clear();
        let other = plan("b", &[], &["src/b"]);
        assert_eq!(parallel_overlaps(&[bare.clone(), other.clone()]).len(), 1);
        let mut chained = other;
        chained.depends_on = vec!["a".into()];
        assert!(parallel_overlaps(&[bare, chained]).is_empty());
    }

    #[test]
    fn task_count_is_capped_at_twelve() {
        let ok: Vec<_> = (0..12).map(|i| plan(&format!("t{i}"), &[], &[&format!("p{i}")])).collect();
        assert!(validate_plan(&ok).is_ok());
        let too_many: Vec<_> = (0..13).map(|i| plan(&format!("t{i}"), &[], &[&format!("p{i}")])).collect();
        assert!(err_of(&too_many).contains("13 tasks"));
        assert!(err_of(&[]).contains("no tasks"));
    }

    #[test]
    fn duplicate_unknown_and_self_dependencies_are_refused() {
        assert!(err_of(&[plan("a", &[], &[]), plan("a", &[], &[])]).contains("more than once"));
        assert!(err_of(&[plan("a", &["zz"], &[])]).contains("unknown task zz"));
        assert!(err_of(&[plan("a", &["a"], &[])]).contains("depends on itself"));
    }

    #[test]
    fn cycles_are_reported_with_their_members() {
        let e = err_of(&[plan("a", &["c"], &[]), plan("b", &["a"], &[]), plan("c", &["b"], &[])]);
        assert!(e.contains("dependency cycle"), "{e}");
        assert!(e.contains("a") && e.contains("b") && e.contains("c"));
    }

    #[test]
    fn empty_briefs_and_bad_ids_and_paths_are_refused() {
        let mut t = plan("a", &[], &[]);
        t.brief = "   ".into();
        assert!(err_of(&[t]).contains("empty brief"));
        assert!(err_of(&[plan("../x", &[], &[])]).contains("not 1-64"));
        assert!(err_of(&[plan("a", &[], &["../escape"])]).contains("not a relative path"));
        assert!(err_of(&[plan("a", &[], &["/abs"])]).contains("not a relative path"));
        assert!(err_of(&[plan("a", &[], &["C:/x"])]).contains("not a relative path"));
    }

    #[test]
    fn parallel_tasks_may_not_declare_overlapping_paths() {
        let e = err_of(&[plan("a", &[], &["src"]), plan("b", &[], &["SRC/lib.rs"])]);
        assert!(e.contains("can run in parallel"), "{e}");
        // Ordered by a dependency, even a transitive one: no conflict.
        let ok = vec![plan("a", &[], &["src"]), plan("m", &["a"], &["other"]), plan("b", &["m"], &["src/lib.rs"])];
        assert!(validate_plan(&ok).is_ok());
        // Disjoint siblings are fine; a root declaration covers everything.
        assert!(validate_plan(&[plan("a", &[], &["src/a"]), plan("b", &[], &["src/b"])]).is_ok());
        assert!(err_of(&[plan("a", &[], &["."]), plan("b", &[], &["x"])]).contains("can run in parallel"));
    }

    // --- task state machine ----------------------------------------------

    fn task_at(status: TaskStatus) -> CampaignTask {
        let mut t = campaign(vec![plan("a", &[], &[])]).tasks.remove(0);
        t.status = status;
        t
    }

    #[test]
    fn a_task_walks_the_happy_path() {
        let mut t = task_at(TaskStatus::Pending);
        for to in [TaskStatus::Queued, TaskStatus::Running, TaskStatus::Completed, TaskStatus::Verifying] {
            transition_task(&mut t, to, None).unwrap();
        }
        transition_task(&mut t, TaskStatus::Verified, Some(TaskVerdict::Pass)).unwrap();
        transition_task(&mut t, TaskStatus::Merged, None).unwrap();
        assert_eq!(t.verdict, Some(TaskVerdict::Pass));
    }

    /// D2: a blocked verification is recoverable by a person, on the record.
    #[test]
    fn a_blocked_task_can_be_accepted_by_hand_with_who_and_why() {
        let mut t = task_at(TaskStatus::Completed);
        t.verdict = Some(TaskVerdict::Blocked);
        let nobody = ManualAccept { by: "  ".into(), reason: "looks right".into() };
        assert_eq!(
            accept_manually(&mut t, TaskStatus::Verified, nobody).unwrap_err().kind,
            CampaignErrorKind::VerdictRequired
        );
        assert_eq!((t.status, t.verdict), (TaskStatus::Completed, Some(TaskVerdict::Blocked)));
        accept_manually(
            &mut t,
            TaskStatus::Verified,
            ManualAccept { by: "jozkah".into(), reason: "read the diff myself".into() },
        )
        .unwrap();
        assert_eq!((t.status, t.verdict), (TaskStatus::Verified, Some(TaskVerdict::Pass)));
        let o = t.manual_override.clone().unwrap();
        assert_eq!((o.by.as_str(), o.reason.as_str()), ("jozkah", "read the diff myself"));
        assert_eq!(o.previous_verdict, Some(TaskVerdict::Blocked));
        assert!(t.detail.contains("jozkah"), "{}", t.detail);
        // It merges like any verified task, and a later retry forgets it.
        let mut again = task_at(TaskStatus::Completed);
        assert!(accept_manually(&mut again, TaskStatus::Merged, ManualAccept { by: "x".into(), reason: String::new() }).is_err());
        let mut running = task_at(TaskStatus::Running);
        assert!(accept_manually(&mut running, TaskStatus::Verified, ManualAccept { by: "x".into(), reason: String::new() }).is_err());
        let mut failed = task_at(TaskStatus::Failed);
        failed.manual_override = Some(o);
        transition_task(&mut failed, TaskStatus::Queued, None).unwrap();
        assert!(failed.manual_override.is_none());
    }

    #[test]
    fn the_recorded_base_is_not_replaced_and_the_approval_records_the_choice() {
        let d = data_dir("choice");
        create(&d, input(Some("c"), vec![plan("a", &[], &[])])).unwrap();
        let go = |campaign: Option<CampaignStatus>, task: Option<TaskMove>, integration: Option<IntegrationInfo>| {
            transition(&d, "c", TransitionInput { campaign, task, integration })
        };
        // Bypass is never a task ceiling, even asked for at approval.
        let bad = IntegrationInfo {
            branch: "flint/c".into(),
            worktree: "/w".into(),
            mode_ceiling: "bypass".into(),
            ..Default::default()
        };
        assert!(go(Some(CampaignStatus::Approved), None, Some(bad)).is_err());
        let chosen = IntegrationInfo {
            branch: "flint/c".into(),
            worktree: "/w".into(),
            mode_ceiling: "auto".into(),
            task_access: "worktree".into(),
            ..Default::default()
        };
        let c = go(Some(CampaignStatus::Approved), None, Some(chosen)).unwrap();
        assert_eq!(c.mode_ceiling, "auto");
        assert_eq!(c.limits.task_access.as_deref(), Some("worktree"));
        go(Some(CampaignStatus::Running), None, None).unwrap();
        let mv = |to, base: &str| TaskMove {
            id: "a".into(),
            to,
            verdict: None,
            patch: TaskPatch { base_sha: Some(base.into()), ..Default::default() },
        };
        go(None, Some(mv(TaskStatus::Queued, "")), None).unwrap();
        go(None, Some(mv(TaskStatus::Running, "aaaa")), None).unwrap();
        go(None, Some(mv(TaskStatus::Failed, "bbbb")), None).unwrap();
        let c = get(&d, "c").unwrap();
        assert_eq!(c.task("a").unwrap().base_sha.as_deref(), Some("aaaa"));
    }

    #[test]
    fn completed_is_never_verified_without_a_pass() {
        let mut t = task_at(TaskStatus::Completed);
        assert_eq!(
            transition_task(&mut t, TaskStatus::Verified, Some(TaskVerdict::Pass)).unwrap_err().kind,
            CampaignErrorKind::IllegalTransition
        );
        let mut v = task_at(TaskStatus::Verifying);
        for verdict in [None, Some(TaskVerdict::Partial), Some(TaskVerdict::Fail), Some(TaskVerdict::Blocked)] {
            assert_eq!(
                transition_task(&mut v, TaskStatus::Verified, verdict).unwrap_err().kind,
                CampaignErrorKind::VerdictRequired
            );
            assert_eq!(v.status, TaskStatus::Verifying);
        }
        // A task cannot be forced to merged without a recorded PASS.
        let mut verified = task_at(TaskStatus::Verified);
        assert_eq!(
            transition_task(&mut verified, TaskStatus::Merged, None).unwrap_err().kind,
            CampaignErrorKind::VerdictRequired
        );
    }

    #[test]
    fn a_missing_verdict_is_recorded_as_blocked() {
        let mut v = task_at(TaskStatus::Verifying);
        transition_task(&mut v, TaskStatus::Failed, None).unwrap();
        assert_eq!(v.verdict, Some(TaskVerdict::Blocked));
    }

    #[test]
    fn illegal_moves_are_rejected() {
        for (from, to) in [
            (TaskStatus::Pending, TaskStatus::Running),
            (TaskStatus::Queued, TaskStatus::Completed),
            (TaskStatus::Merged, TaskStatus::Queued),
            (TaskStatus::Cancelled, TaskStatus::Queued),
            (TaskStatus::Completed, TaskStatus::Merged),
            (TaskStatus::Running, TaskStatus::Running),
        ] {
            let mut t = task_at(from);
            assert!(transition_task(&mut t, to, None).is_err(), "{from:?} -> {to:?}");
            assert_eq!(t.status, from);
        }
    }

    #[test]
    fn retries_are_capped_at_two() {
        let mut t = task_at(TaskStatus::Failed);
        for expected in 1..=MAX_RETRIES {
            transition_task(&mut t, TaskStatus::Queued, None).unwrap();
            assert_eq!(t.attempt, expected);
            transition_task(&mut t, TaskStatus::Running, None).unwrap();
            transition_task(&mut t, TaskStatus::Failed, None).unwrap();
        }
        assert_eq!(
            transition_task(&mut t, TaskStatus::Queued, None).unwrap_err().kind,
            CampaignErrorKind::RetryCapReached
        );
        assert_eq!(t.status, TaskStatus::Failed);
        // Giving up is still possible.
        transition_task(&mut t, TaskStatus::Cancelled, None).unwrap();
    }

    #[test]
    fn a_repair_round_after_a_failed_verdict_requeues_and_clears_it() {
        let mut t = task_at(TaskStatus::Verifying);
        transition_task(&mut t, TaskStatus::Queued, Some(TaskVerdict::Fail)).unwrap();
        assert_eq!((t.attempt, t.verdict), (1, None));
    }

    // --- campaign state machine ------------------------------------------

    #[test]
    fn a_campaign_walks_draft_to_done() {
        let mut c = campaign(vec![plan("a", &[], &[])]);
        c.status = CampaignStatus::Draft;
        for to in [CampaignStatus::Planned, CampaignStatus::Approved, CampaignStatus::Running] {
            transition_campaign(&mut c, to).unwrap();
        }
        // A pending task blocks review.
        assert!(transition_campaign(&mut c, CampaignStatus::Reviewing).is_err());
        c.tasks[0].status = TaskStatus::Verified;
        transition_campaign(&mut c, CampaignStatus::Reviewing).unwrap();
        transition_campaign(&mut c, CampaignStatus::Merging).unwrap();
        // Done needs the merge to have happened.
        assert!(transition_campaign(&mut c, CampaignStatus::Done).is_err());
        c.tasks[0].status = TaskStatus::Merged;
        transition_campaign(&mut c, CampaignStatus::Done).unwrap();
        assert!(transition_campaign(&mut c, CampaignStatus::Running).is_err());
        assert!(transition_campaign(&mut c, CampaignStatus::Cancelled).is_err());
    }

    #[test]
    fn the_campaign_rejects_skips() {
        let mut c = campaign(vec![plan("a", &[], &[])]);
        c.status = CampaignStatus::Planned;
        assert!(transition_campaign(&mut c, CampaignStatus::Running).is_err());
        assert!(transition_campaign(&mut c, CampaignStatus::Done).is_err());
        transition_campaign(&mut c, CampaignStatus::Cancelled).unwrap();
    }

    // --- skipping and the gate repair ------------------------------------

    fn dag() -> Campaign {
        // a <- b <- c, a <- d, e alone
        let mut c = campaign(vec![
            plan("a", &[], &["pa"]),
            plan("b", &["a"], &["pb"]),
            plan("c", &["b"], &["pc"]),
            plan("d", &["a"], &["pd"]),
            plan("e", &[], &["pe"]),
        ]);
        c.process_epoch = epoch();
        c
    }

    fn stored(name: &str, c: &Campaign) -> (PathBuf, String) {
        let d = data_dir(name);
        save(&d, c).unwrap();
        (d, c.id.clone())
    }

    #[test]
    fn skipping_with_cascade_cancels_what_waits_on_it() {
        let mut c = dag();
        c.tasks[0].status = TaskStatus::Failed;
        c.tasks[1].status = TaskStatus::Blocked;
        c.tasks[2].status = TaskStatus::Blocked;
        c.tasks[3].status = TaskStatus::Blocked;
        let (d, id) = stored("skip-cascade", &c);
        let r = skip_task(&d, &id, "a", SkipDependants::Cascade).unwrap();
        let mut got = r.cancelled.clone();
        got.sort();
        assert_eq!(got, ["b", "c", "d"]);
        let t = |n: &str| r.campaign.task(n).unwrap().clone();
        assert_eq!(t("a").status, TaskStatus::Cancelled);
        assert_eq!(t("c").detail, "dependency skipped: a");
        assert_eq!(t("d").detail, "dependency skipped: a", "a transitive dependant carries the same reason");
        for n in ["a", "b", "c", "d"] {
            assert_eq!(t(n).status, TaskStatus::Cancelled, "{n} is skipped, not failed");
        }
        assert!(r.campaign.tasks.iter().all(|x| x.status != TaskStatus::Failed));
        assert_eq!(t("e").status, TaskStatus::Pending, "an unrelated task is untouched");
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn skipping_with_release_lets_dependants_run_without_it() {
        let mut c = dag();
        c.tasks[0].status = TaskStatus::Failed;
        c.tasks[1].status = TaskStatus::Blocked;
        let (d, id) = stored("skip-release", &c);
        let r = skip_task(&d, &id, "a", SkipDependants::Release).unwrap();
        assert_eq!(r.released.len(), 2);
        let b = r.campaign.task("b").unwrap();
        assert!(b.depends_on.is_empty());
        assert_eq!(b.skipped_deps, vec!["a".to_string()]);
        assert_eq!(b.status, TaskStatus::Pending, "a blocked dependant is pending again");
        // The scheduler now starts it: every dependency is merged (none left).
        let acts = crate::core::agent::campaign_scheduler::next_actions(&r.campaign, &Default::default(), 4);
        assert!(acts.iter().any(|a| matches!(a,
            crate::core::agent::campaign_scheduler::Action::Start { task_id } if task_id == "b")));
        // c still waits on b.
        assert_eq!(r.campaign.task("c").unwrap().depends_on, vec!["b".to_string()]);
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn skipping_the_last_open_task_moves_the_campaign_to_review() {
        let mut c = campaign(vec![plan("a", &[], &["pa"]), plan("b", &["a"], &["pb"]), plan("m", &[], &["pm"])]);
        c.process_epoch = epoch();
        c.tasks[2].status = TaskStatus::Merged;
        c.tasks[2].verdict = Some(TaskVerdict::Pass);
        c.tasks[0].status = TaskStatus::Failed;
        c.tasks[1].status = TaskStatus::Blocked;
        let (d, id) = stored("skip-review", &c);
        let r = skip_task(&d, &id, "a", SkipDependants::Cascade).unwrap();
        assert_eq!(r.campaign.status, CampaignStatus::Reviewing);
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn a_failed_gate_adds_one_repair_task_and_nothing_else_is_added() {
        let mut c = campaign(vec![plan("a", &[], &["pa"])]);
        c.process_epoch = epoch();
        c.tasks[0].status = TaskStatus::Merged;
        c.tasks[0].verdict = Some(TaskVerdict::Pass);
        c.status = CampaignStatus::Reviewing;
        let (d, id) = stored("gate-repair", &c);
        // Gate did not fail yet: refused.
        assert!(add_gate_repair(&d, &id, "fix".into()).is_err());
        let mut c = get(&d, &id).unwrap();
        c.gate = Some(GateReport {
            source: "detected".into(),
            command: "npm run test".into(),
            skipped: false,
            passed: false,
            timed_out: false,
            exit_code: Some(1),
            output: "boom".into(),
            at: "0".into(),
        });
        save(&d, &c).unwrap();
        let (c, task) = add_gate_repair(&d, &id, "gate output".into()).unwrap();
        assert_eq!(task, "gate-repair");
        assert_eq!(c.status, CampaignStatus::Running);
        let t = c.task("gate-repair").unwrap();
        assert_eq!(t.kind, KIND_GATE_REPAIR);
        assert!(t.acceptance[0].contains("npm run test"));
        // Not under review any more, so a second one is refused.
        assert!(add_gate_repair(&d, &id, "again".into()).is_err());
        // Plan edits stay closed for an approved campaign.
        assert!(plan_update(&d, &id, PlanEdit::default()).is_err());
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn parallel_setting_is_clamped() {
        assert_eq!(clamp_max_parallel(-3), 1);
        assert_eq!(clamp_max_parallel(0), 1);
        assert_eq!(clamp_max_parallel(4), 4);
        assert_eq!(clamp_max_parallel(99), 6);
        assert_eq!(DEFAULT_MAX_PARALLEL, 4);
    }

    // --- persistence -----------------------------------------------------

    #[test]
    fn a_campaign_round_trips_through_disk() {
        let d = data_dir("roundtrip");
        let made = create(&d, input(Some("camp-1"), vec![plan("a", &[], &["x"]), plan("b", &["a"], &[])])).unwrap();
        assert_eq!(made.status, CampaignStatus::Planned);
        assert_eq!(made.limits.max_parallel, DEFAULT_MAX_PARALLEL);
        assert!(d.join("campaigns/camp-1/campaign.json").exists());
        let got = get(&d, "camp-1").unwrap();
        assert_eq!(got, made);
        assert_eq!(list(&d).len(), 1);
        // The camelCase wire shape.
        let v = serde_json::to_value(&got).unwrap();
        assert!(v.get("coordinatorSession").is_some() && v["tasks"][1]["dependsOn"][0] == "a");
        assert_eq!(create(&d, input(Some("camp-1"), vec![plan("a", &[], &[])])).unwrap_err().kind, CampaignErrorKind::Exists);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn create_refuses_a_bad_plan_and_bypass() {
        let d = data_dir("refuse");
        let bad = create(&d, input(None, vec![plan("a", &["a"], &[])])).unwrap_err();
        assert_eq!(bad.kind, CampaignErrorKind::InvalidPlan);
        let mut i = input(None, vec![plan("a", &[], &[])]);
        i.mode_ceiling = "bypass".into();
        assert_eq!(create(&d, i).unwrap_err().kind, CampaignErrorKind::InvalidPlan);
        assert!(list(&d).is_empty());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_partial_limits_payload_from_the_renderer_deserializes() {
        // The exact shape `campaignTools.ts` sends to agent_campaign_create.
        let payload = serde_json::json!({
            "title": "Ship it",
            "coordinatorSession": "coord",
            "sourceRoot": "/src",
            "modeCeiling": "ask",
            "model": "p/m",
            "limits": { "maxParallel": 3, "tokenBudget": null },
            "tasks": [{ "id": "a", "title": "A", "brief": "do a", "paths": ["src"] }]
        });
        let i: CreateInput = serde_json::from_value(payload).unwrap();
        let l = i.limits.clone().unwrap();
        assert_eq!((l.max_parallel, l.max_tasks, l.task_tokens), (3, MAX_TASKS as u32, None));
        let d = data_dir("partial-limits");
        let made = create(&d, i).unwrap();
        assert_eq!(made.limits.max_tasks, MAX_TASKS as u32);
        assert_eq!(made.limits.max_parallel, 3);
        // An empty limits object and a zero parallel are both safe.
        let l: CampaignLimits = serde_json::from_str("{}").unwrap();
        assert_eq!(l, CampaignLimits::default());
        let l: CampaignLimits = serde_json::from_str(r#"{"maxParallel":0}"#).unwrap();
        assert_eq!(l.max_parallel.clamp(1, MAX_PARALLEL_CAP), 1);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_running_campaign_with_one_merged_and_the_rest_cancelled_moves_to_review() {
        let d = data_dir("advance");
        create(&d, input(Some("c"), vec![plan("a", &[], &[]), plan("b", &[], &[])])).unwrap();
        let mv = |id: &str, to| TransitionInput {
            campaign: None,
            task: Some(TaskMove { id: id.into(), to, verdict: None, patch: TaskPatch::default() }),
            integration: None,
        };
        for s in [CampaignStatus::Approved, CampaignStatus::Running] {
            transition(&d, "c", TransitionInput { campaign: Some(s), task: None, integration: None }).unwrap();
        }
        // The merged half is recorded straight into the file, as the
        // integration phase does, then the other task is cancelled.
        let mut c = get(&d, "c").unwrap();
        c.tasks[0].status = TaskStatus::Merged;
        save(&d, &c).unwrap();
        let c = transition(&d, "c", mv("b", TaskStatus::Cancelled)).unwrap();
        assert_eq!(c.status, CampaignStatus::Reviewing);
        assert_eq!(get(&d, "c").unwrap().status, CampaignStatus::Reviewing);

        // Nothing merged: stays running, the plan produced nothing to review.
        create(&d, input(Some("d"), vec![plan("a", &[], &[])])).unwrap();
        for s in [CampaignStatus::Approved, CampaignStatus::Running] {
            transition(&d, "d", TransitionInput { campaign: Some(s), task: None, integration: None }).unwrap();
        }
        let c = transition(&d, "d", mv("a", TaskStatus::Cancelled)).unwrap();
        assert_eq!(c.status, CampaignStatus::Running);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn max_parallel_in_a_plan_is_clamped() {
        let d = data_dir("clamp");
        let mut i = input(Some("c"), vec![plan("a", &[], &[])]);
        i.limits = Some(CampaignLimits { max_parallel: 40, ..Default::default() });
        assert_eq!(create(&d, i).unwrap().limits.max_parallel, MAX_PARALLEL_CAP);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn settle_with_oversized_handoff_still_settles() {
        let d = data_dir("big-handoff");
        create(&d, input(Some("c"), vec![plan("a", &[], &[])])).unwrap();
        for s in [CampaignStatus::Approved, CampaignStatus::Running] {
            transition(&d, "c", TransitionInput { campaign: Some(s), task: None, integration: None }).unwrap();
        }
        for to in [TaskStatus::Queued, TaskStatus::Running] {
            let mv = TransitionInput {
                campaign: None,
                task: Some(TaskMove { id: "a".into(), to, verdict: None, patch: TaskPatch::default() }),
                integration: None,
            };
            transition(&d, "c", mv).unwrap();
        }
        let huge = "é".repeat(MAX_HANDOFF);
        let c = task_settle(
            &d,
            "c",
            "a",
            SettleInput { outcome: Outcome::Completed, detail: "ok".into(), handoff: Some(huge), tokens_used: None, fingerprint: None },
        )
        .unwrap();
        assert_eq!(c.tasks[0].status, TaskStatus::Completed);
        let written = std::fs::read_to_string(d.join("campaigns/c/tasks/a/handoff.md")).unwrap();
        assert!(written.len() <= MAX_HANDOFF && written.ends_with("[handoff cut]"));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn transitions_settle_handoff_decisions_and_events_persist() {
        let d = data_dir("flow");
        create(&d, input(Some("c"), vec![plan("a", &[], &[])])).unwrap();
        let mv = |to, verdict| TransitionInput {
            campaign: None,
            task: Some(TaskMove { id: "a".into(), to, verdict, patch: TaskPatch::default() }),
            integration: None,
        };
        for s in [CampaignStatus::Approved, CampaignStatus::Running] {
            transition(&d, "c", TransitionInput { campaign: Some(s), task: None, integration: None }).unwrap();
        }
        transition(&d, "c", mv(TaskStatus::Queued, None)).unwrap();
        let running = TransitionInput {
            campaign: None,
            task: Some(TaskMove {
                id: "a".into(),
                to: TaskStatus::Running,
                verdict: None,
                patch: TaskPatch { session_id: Some("sess-a".into()), branch: Some("flint/a".into()), ..Default::default() },
            }),
            integration: None,
        };
        let c = transition(&d, "c", running).unwrap();
        assert_eq!(c.tasks[0].session_id.as_deref(), Some("sess-a"));

        // Illegal move leaves the file as it was.
        assert!(transition(&d, "c", mv(TaskStatus::Merged, None)).is_err());
        assert_eq!(get(&d, "c").unwrap().tasks[0].status, TaskStatus::Running);

        let c = task_settle(
            &d,
            "c",
            "a",
            SettleInput {
                outcome: Outcome::Completed,
                detail: "ok".into(),
                handoff: Some("# done\nchanged x\n".into()),
                tokens_used: Some(1234),
                fingerprint: Some("fp".into()),
            },
        )
        .unwrap();
        assert_eq!(c.tasks[0].status, TaskStatus::Completed);
        assert_eq!(c.tasks[0].tokens_used, 1234);
        assert_eq!(c.tasks[0].handoff_path.as_deref(), Some("tasks/a/handoff.md"));
        assert_eq!(std::fs::read_to_string(d.join("campaigns/c/tasks/a/handoff.md")).unwrap(), "# done\nchanged x\n");

        // A late cancel does not relabel a completed task.
        let again = task_settle(
            &d,
            "c",
            "a",
            SettleInput { outcome: Outcome::Cancelled, detail: String::new(), handoff: None, tokens_used: None, fingerprint: None },
        )
        .unwrap();
        assert_eq!(again.tasks[0].status, TaskStatus::Completed);

        decisions_append(&d, "c", "use sqlite").unwrap();
        decisions_append(&d, "c", "no ORM").unwrap();
        let md = std::fs::read_to_string(d.join("campaigns/c/decisions.md")).unwrap();
        assert!(md.contains("use sqlite") && md.contains("no ORM"));
        assert!(md.find("use sqlite").unwrap() < md.find("no ORM").unwrap());
        assert_eq!(decisions_append(&d, "c", "  ").unwrap_err().kind, CampaignErrorKind::InvalidPlan);

        let kinds: Vec<String> = events(&d, "c").unwrap().iter().map(|e| e["kind"].as_str().unwrap().to_string()).collect();
        assert_eq!(kinds.first().map(String::as_str), Some("campaign-created"));
        assert!(kinds.contains(&"task-settled".to_string()) && kinds.contains(&"decision".to_string()));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn cancel_marks_every_unfinished_task_and_keeps_merged_ones() {
        let d = data_dir("cancel");
        create(&d, input(Some("c"), vec![plan("a", &[], &[]), plan("b", &[], &[]), plan("m", &[], &[])])).unwrap();
        let mut c = read_raw(&d, "c").unwrap();
        c.status = CampaignStatus::Running;
        c.process_epoch = epoch();
        c.tasks[0].status = TaskStatus::Running;
        c.tasks[2].status = TaskStatus::Merged;
        c.tasks[2].verdict = Some(TaskVerdict::Pass);
        save(&d, &c).unwrap();
        let c = cancel(&d, "c", "user stopped").unwrap();
        assert_eq!(c.status, CampaignStatus::Cancelled);
        assert_eq!(
            c.tasks.iter().map(|t| t.status).collect::<Vec<_>>(),
            vec![TaskStatus::Cancelled, TaskStatus::Cancelled, TaskStatus::Merged]
        );
        // Cancelling twice is not an error; moving a task afterwards is.
        assert!(cancel(&d, "c", "").is_ok());
        let mv = TransitionInput {
            campaign: None,
            task: Some(TaskMove { id: "a".into(), to: TaskStatus::Queued, verdict: None, patch: TaskPatch::default() }),
            integration: None,
        };
        assert!(transition(&d, "c", mv).is_err());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn delete_removes_only_idle_campaigns() {
        let d = data_dir("delete");
        create(&d, input(Some("c"), vec![plan("a", &[], &[])])).unwrap();
        // A planned campaign has not started: it may go.
        assert!(delete(&d, "c").is_ok());
        assert_eq!(get(&d, "c").unwrap_err().kind, CampaignErrorKind::NotFound);
        assert_eq!(delete(&d, "c").unwrap_err().kind, CampaignErrorKind::NotFound);

        create(&d, input(Some("r"), vec![plan("a", &[], &[])])).unwrap();
        let mut c = read_raw(&d, "r").unwrap();
        c.status = CampaignStatus::Running;
        c.process_epoch = epoch();
        save(&d, &c).unwrap();
        assert!(delete(&d, "r").is_err());
        assert!(get(&d, "r").is_ok());
        cancel(&d, "r", "stop").unwrap();
        assert!(delete(&d, "r").is_ok());
        assert!(delete(&d, "../x").is_err());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn approval_records_the_integration_branch() {
        let d = data_dir("integration");
        create(&d, input(Some("c"), vec![plan("a", &[], &[])])).unwrap();
        let c = transition(
            &d,
            "c",
            TransitionInput {
                campaign: Some(CampaignStatus::Approved),
                task: None,
                integration: Some(IntegrationInfo {
                    branch: "flint/campaign-c".into(),
                    worktree: "/w/c".into(),
                    base_branch: "main".into(),
                    base_sha: "abc123".into(),
                    mode_ceiling: String::new(),
                    task_access: String::new(),
                }),
            },
        )
        .unwrap();
        assert_eq!(c.integration_branch, "flint/campaign-c");
        assert_eq!((c.base_branch.as_str(), c.base_sha.as_str()), ("main", "abc123"));
        assert_eq!(get(&d, "c").unwrap().integration_worktree, "/w/c");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn context_returns_decisions_and_requested_handoffs_only() {
        let d = data_dir("context");
        create(&d, input(Some("c"), vec![plan("a", &[], &[]), plan("b", &[], &[])])).unwrap();
        decisions_append(&d, "c", "use serde").unwrap();
        write_handoff(&d, "c", "a", "a is done").unwrap();
        let ctx = context(&d, "c", &["a".into(), "b".into()]).unwrap();
        assert!(ctx.decisions.contains("use serde"));
        assert_eq!(ctx.handoffs, vec![HandoffText { task_id: "a".into(), text: "a is done".into() }]);
        assert!(context(&d, "c", &["../x".into()]).is_err());
        assert!(context(&d, "nope", &[]).is_err());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_notice_is_recorded_only_for_a_real_task() {
        let d = data_dir("notified");
        create(&d, input(Some("c"), vec![plan("a", &[], &[])])).unwrap();
        note_notified(&d, "c", "a").unwrap();
        assert!(note_notified(&d, "c", "zzz").is_err());
        let seen = events(&d, "c").unwrap().iter().filter(|e| e["kind"] == "coordinator-notified").count();
        assert_eq!(seen, 1);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn work_driven_by_another_live_process_is_left_running() {
        let mut child = if cfg!(windows) {
            let mut c = std::process::Command::new("ping");
            c.args(["-n", "30", "127.0.0.1"]).stdout(std::process::Stdio::null());
            c
        } else {
            let mut c = std::process::Command::new("sleep");
            c.arg("30");
            c
        };
        let mut child = child.spawn().unwrap();
        let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
        let theirs = format!("{ms:x}-{:x}", child.id());
        assert!(epoch_alive(&theirs));
        // The same pid with an epoch from before it started is a reused pid.
        assert!(!epoch_alive(&format!("0-{:x}", child.id())));

        let d = data_dir("live-epoch");
        create(&d, input(Some("c"), vec![plan("a", &[], &[])])).unwrap();
        let mut c = read_raw(&d, "c").unwrap();
        c.status = CampaignStatus::Running;
        c.tasks[0].status = TaskStatus::Running;
        c.process_epoch = theirs.clone();
        save(&d, &c).unwrap();
        let got = reconcile(&d, "c").unwrap();
        assert_eq!(got.status, CampaignStatus::Running);
        assert_eq!(got.tasks[0].status, TaskStatus::Running);
        assert_eq!(got.process_epoch, theirs);

        let _ = child.kill();
        let _ = child.wait();
        assert!(!epoch_alive(&theirs));
        assert_eq!(reconcile(&d, "c").unwrap().status, CampaignStatus::Interrupted);
        // The cross-process lock file is gone once released.
        assert!(!root(&d).join(".records.lock").exists());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn work_left_running_by_another_process_reads_as_interrupted() {
        let d = data_dir("epoch");
        create(&d, input(Some("c"), vec![plan("a", &[], &[]), plan("b", &["a"], &[]), plan("v", &[], &[])])).unwrap();
        let mut c = read_raw(&d, "c").unwrap();
        c.status = CampaignStatus::Running;
        c.tasks[0].status = TaskStatus::Running;
        c.tasks[2].status = TaskStatus::Verifying;
        c.process_epoch = "an-earlier-process".into();
        save(&d, &c).unwrap();

        let got = reconcile(&d, "c").unwrap();
        assert_eq!(got.status, CampaignStatus::Interrupted);
        assert_eq!(got.tasks[0].status, TaskStatus::Interrupted);
        assert_eq!(got.tasks[1].status, TaskStatus::Pending);
        assert_eq!(got.tasks[2].status, TaskStatus::Completed);
        assert_eq!(got.process_epoch, epoch());
        // Persisted, and stable on the next read.
        assert_eq!(read_raw(&d, "c").unwrap(), got);
        assert_eq!(get(&d, "c").unwrap(), got);
        assert!(events(&d, "c").unwrap().iter().any(|e| e["kind"] == "task-interrupted"));

        // The interrupted task can be re-queued without spending a retry.
        let mv = TransitionInput {
            campaign: None,
            task: Some(TaskMove { id: "a".into(), to: TaskStatus::Queued, verdict: None, patch: TaskPatch::default() }),
            integration: None,
        };
        let c = transition(&d, "c", mv).unwrap();
        assert_eq!((c.tasks[0].status, c.tasks[0].attempt), (TaskStatus::Queued, 0));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_paused_campaign_from_another_process_is_left_alone() {
        let d = data_dir("epoch-paused");
        create(&d, input(Some("c"), vec![plan("a", &[], &[])])).unwrap();
        let mut c = read_raw(&d, "c").unwrap();
        c.status = CampaignStatus::Paused;
        c.process_epoch = "old".into();
        save(&d, &c).unwrap();
        assert_eq!(get(&d, "c").unwrap().status, CampaignStatus::Paused);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn ids_that_escape_are_rejected_everywhere() {
        let d = data_dir("escape");
        for bad in ["", "..", "../x", "a/b", "a\\b", "a b", "a.b", "/abs", "C:x", &"x".repeat(65)] {
            assert!(!valid_id(bad), "{bad:?}");
            assert_eq!(get(&d, bad).unwrap_err().kind, CampaignErrorKind::InvalidId, "{bad:?}");
            assert_eq!(cancel(&d, bad, "").unwrap_err().kind, CampaignErrorKind::InvalidId);
            assert_eq!(decisions_append(&d, bad, "x").unwrap_err().kind, CampaignErrorKind::InvalidId);
            assert_eq!(create(&d, input(Some(bad), vec![plan("a", &[], &[])])).unwrap_err().kind, CampaignErrorKind::InvalidId);
        }
        create(&d, input(Some("ok"), vec![plan("a", &[], &[])])).unwrap();
        for bad in ["../evil", "a/b", ""] {
            assert!(write_handoff(&d, "ok", bad, "x").is_err(), "{bad:?}");
            let s = SettleInput { outcome: Outcome::Failed, detail: String::new(), handoff: None, tokens_used: None, fingerprint: None };
            assert_eq!(task_settle(&d, "ok", bad, s).unwrap_err().kind, CampaignErrorKind::InvalidId);
        }
        // Nothing was written outside the campaigns folder.
        assert!(!d.join("evil").exists());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_swapped_or_corrupt_record_is_refused() {
        let d = data_dir("corrupt");
        create(&d, input(Some("a"), vec![plan("t", &[], &[])])).unwrap();
        create(&d, input(Some("b"), vec![plan("t", &[], &[])])).unwrap();
        std::fs::copy(d.join("campaigns/b/campaign.json"), d.join("campaigns/a/campaign.json")).unwrap();
        assert_eq!(get(&d, "a").unwrap_err().kind, CampaignErrorKind::Corrupt);
        std::fs::write(d.join("campaigns/b/campaign.json"), "{nope").unwrap();
        assert_eq!(get(&d, "b").unwrap_err().kind, CampaignErrorKind::Corrupt);
        // One bad record does not hide the others from the list.
        assert!(list(&d).is_empty());
        assert_eq!(get(&d, "zzz").unwrap_err().kind, CampaignErrorKind::NotFound);
        std::fs::remove_dir_all(&d).ok();
    }

    // --- editable plan, estimate, notices ----------------------------------

    fn edit(ops: Vec<PlanOp>) -> PlanEdit {
        PlanEdit { ops, ..Default::default() }
    }

    #[test]
    fn a_planned_campaign_can_be_edited_and_is_revalidated_whole() {
        let d = data_dir("planedit");
        create(&d, input(Some("c"), vec![plan("a", &[], &["src/a"]), plan("b", &["a"], &["src/b"])])).unwrap();
        let c = plan_update(
            &d,
            "c",
            PlanEdit {
                ops: vec![
                    PlanOp::Add { task: plan("z", &[], &["docs"]), at: Some(0) },
                    PlanOp::Update {
                        id: "b".into(),
                        title: Some("renamed".into()),
                        brief: Some("new brief".into()),
                        acceptance: Some(vec!["touches src/b".into()]),
                        paths: None,
                        depends_on: None,
                    },
                ],
                title: Some("New title".into()),
                token_budget: Some(500_000),
            },
        )
        .unwrap();
        assert_eq!(c.tasks.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["z", "a", "b"]);
        assert_eq!(c.task("b").unwrap().title, "renamed");
        assert_eq!(c.title, "New title");
        assert_eq!(c.limits.token_budget, Some(500_000));
        assert_eq!(c.estimate.as_ref().unwrap().tasks, 3);
        // Reorder, then removing a task also drops it from dependencies.
        let c = plan_update(&d, "c", edit(vec![PlanOp::Reorder { ids: vec!["b".into()] }])).unwrap();
        assert_eq!(c.tasks[0].id, "b");
        let c = plan_update(&d, "c", edit(vec![PlanOp::Remove { id: "a".into() }])).unwrap();
        assert!(c.task("b").unwrap().depends_on.is_empty());
        assert_eq!(get(&d, "c").unwrap().tasks.len(), 2);
        assert!(events(&d, "c").unwrap().iter().any(|e| e["kind"] == "plan-updated"));
    }

    #[test]
    fn a_bad_edit_changes_nothing_and_an_approved_plan_cannot_be_edited() {
        let d = data_dir("planbad");
        create(&d, input(Some("c"), vec![plan("a", &[], &[]), plan("b", &["a"], &[])])).unwrap();
        let cycle = edit(vec![PlanOp::Update {
            id: "a".into(),
            title: None,
            brief: None,
            acceptance: None,
            paths: None,
            depends_on: Some(vec!["b".into()]),
        }]);
        let e = plan_update(&d, "c", cycle).unwrap_err();
        assert_eq!(e.kind, CampaignErrorKind::InvalidPlan);
        assert!(e.message.contains("cycle"), "{}", e.message);
        assert!(get(&d, "c").unwrap().task("a").unwrap().depends_on.is_empty());
        let e = plan_update(&d, "c", edit(vec![PlanOp::Remove { id: "nope".into() }])).unwrap_err();
        assert!(e.message.contains("no task nope"));
        let too_many: Vec<PlanTask> = (0..13).map(|i| plan(&format!("t{i}"), &[], &[&format!("p{i}")])).collect();
        assert!(plan_update(&d, "c", edit(vec![PlanOp::Replace { tasks: too_many }])).is_err());
        transition(&d, "c", TransitionInput { campaign: Some(CampaignStatus::Approved), task: None, integration: None })
            .unwrap();
        let e = plan_update(&d, "c", edit(vec![PlanOp::Remove { id: "b".into() }])).unwrap_err();
        assert_eq!(e.kind, CampaignErrorKind::IllegalTransition);
        assert_eq!(get(&d, "c").unwrap().tasks.len(), 2);
    }

    #[test]
    fn the_estimate_uses_a_constant_until_there_is_history() {
        let none = estimate_cost(4, &[]);
        assert_eq!((none.basis.as_str(), none.samples), ("default", 0));
        assert_eq!(none.expected, 4 * DEFAULT_TASK_TOKENS);
        assert!(none.low < none.expected && none.expected < none.high);
        let mut old = campaign(vec![plan("a", &[], &[]), plan("b", &[], &[]), plan("c", &[], &[])]);
        for t in &mut old.tasks {
            t.status = TaskStatus::Merged;
            t.tokens_used = 9_000;
            t.verify_tokens = 1_000;
        }
        let hist = estimate_cost(2, &[old]);
        assert_eq!((hist.basis.as_str(), hist.samples, hist.per_task_expected), ("history", 3, 10_000));
        assert_eq!(hist.expected, 20_000);
    }

    #[test]
    fn a_new_campaign_carries_an_estimate() {
        let d = data_dir("est");
        let c = create(&d, input(Some("c"), vec![plan("a", &[], &[]), plan("b", &[], &[])])).unwrap();
        let e = c.estimate.unwrap();
        assert_eq!((e.tasks, e.basis.as_str()), (2, "default"));
    }

    #[test]
    fn a_desktop_notice_is_claimed_once_across_restarts() {
        let d = data_dir("notice");
        create(&d, input(Some("c"), vec![plan("a", &[], &[])])).unwrap();
        assert!(claim_notice(&d, "c", "reviewing").unwrap());
        assert!(!claim_notice(&d, "c", "reviewing").unwrap());
        assert!(claim_notice(&d, "c", "done").unwrap());
        assert!(!claim_notice(&d, "c", "  ").unwrap());
    }
}
