//! Native execution of the built-in tools. Sandbox escape is enforced by the
//! gate before these run; handlers only resolve paths and perform the operation.
//! Errors are returned as a String starting with "ERROR" (matching
//! `execute_mcp_tool_calls`) so the loop flags `is_error` correctly.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};

use ignore::WalkBuilder;
use tokio::sync::oneshot;

use crate::memory;
use crate::skills;
use crate::tools::jail;
use crate::tools::proc;
use crate::tools::sandbox::{
    escapes_write_roots, in_scratch, is_hidden_jan_path, lexical_normalize, resolve_path,
    scratch_display_path, symlink_escapes_any_root, symlink_escapes_root,
};
use crate::tools::{BuiltinTool, ImageContentPart, ToolContext};

const MAX_BYTES: usize = 64 * 1024;
const MAX_LINES: usize = 2000;
/// Cap on a `read` image payload returned as an `image_url` content part.
/// Mirrors the TUI's `MAX_IMAGE_BYTES` so an oversized raster (or a large
/// text file whose name ends in an image extension) cannot flood the model
/// context as a base64 blob.
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
/// bash output caps: generous enough that typical command output reaches the
/// model intact on a large-context run, spilling to a temp file only past this.
const BASH_MAX_BYTES: usize = 256 * 1024;
const BASH_MAX_LINES: usize = 10_000;
const GREP_MAX_LINE: usize = 500;
const LS_DEFAULT_LIMIT: usize = 500;
const FIND_DEFAULT_LIMIT: usize = 1000;
const GREP_DEFAULT_LIMIT: usize = 100;
/// How long a `bash` call waits for the command before backgrounding it, when
/// the caller doesn't specify `timeout`.
const DEFAULT_BASH_TIMEOUT_SECS: u64 = 30;

/// Counter for unique temp-file names for truncated bash output.
static TEMP_COUNTER: AtomicUsize = AtomicUsize::new(0);
/// Counter for unique bash background job ids.
static BASH_JOB_COUNTER: AtomicUsize = AtomicUsize::new(0);
/// Background jobs one owner may hold at once. Past this the oldest finished,
/// uncollected job is dropped; with none finished, a new command is refused a
/// place in the background rather than growing the registry without bound.
const MAX_JOBS_PER_OWNER: usize = 32;
/// How much of a running job's recent output a status check can show.
const JOB_TAIL_BYTES: usize = 8 * 1024;

/// A per-process prefix for job ids.
///
/// The counter restarts at zero every launch while the records that name job
/// ids are persisted, so `bash-0` alone would name a different command after
/// every restart. The prefix makes an id from a previous run never match one
/// minted now.
fn job_id_prefix() -> &'static str {
    static PREFIX: OnceLock<String> = OnceLock::new();
    PREFIX.get_or_init(|| {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let mixed = (nanos as u64) ^ ((std::process::id() as u64) << 20);
        format!("{:05x}", mixed & 0xf_ffff)
    })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The most recent output of a running job, bounded, for status checks.
#[derive(Default)]
struct LiveTail {
    text: String,
    /// Bytes dropped from the front to stay within the bound.
    dropped: usize,
}

impl LiveTail {
    fn push(&mut self, chunk: &str) {
        self.text.push_str(chunk);
        if self.text.len() > JOB_TAIL_BYTES {
            let mut cut = self.text.len() - JOB_TAIL_BYTES;
            while !self.text.is_char_boundary(cut) {
                cut += 1;
            }
            self.dropped += cut;
            self.text.drain(..cut);
        }
    }
}

/// The exit code a formatted `bash` result reports on its final marker line.
fn exit_code_of(output: &str) -> Option<i32> {
    output
        .lines()
        .rev()
        .find_map(|line| line.trim().strip_prefix("[exit ")?.strip_suffix(']')?.parse().ok())
}

/// One command still running past its `bash` call's timeout.
///
/// The receiver resolves with the same formatted output a foreground call
/// would have returned. The rest is metadata a UI needs to describe the job
/// without collecting it: the command itself, when it started, and which tool
/// call backgrounded it.
pub struct BashJob {
    /// Taken once the output has been received, by a peek or by collection.
    rx: Option<oneshot::Receiver<String>>,
    /// The finished output, when a peek got there before the collector did.
    ///
    /// `oneshot::Receiver::try_recv` *consumes* the value on success, so a
    /// status check cannot simply discard what it observes — that would steal
    /// the result the agent is waiting to collect. It is parked here instead
    /// and handed over by [`await_bash_job`].
    output: Option<String>,
    pub command: String,
    pub started: std::time::Instant,
    pub call_id: Option<String>,
    /// The shell's pid, which is also its process-group id (see `proc::spawn`).
    /// Held so one job can be reaped on its own; `None` only when the child had
    /// already exited before its id could be read.
    pub pid: Option<u32>,
    /// A collector is awaiting this job's receiver right now.
    ///
    /// The receiver has to leave the entry to be awaited — it cannot be held
    /// across an await while the registry is locked — but the *entry* stays,
    /// so a command being collected can still be listed and still be killed.
    /// Without this the whole of a long collection was invisible: the panel
    /// dropped the row and its Stop button reported "unknown job".
    collecting: bool,
    /// The conversation that started the command. Listing, inspecting,
    /// collecting and stopping are all confined to it, so one session cannot
    /// read or kill another's work. `None` is a surface with no conversation
    /// (a one-shot CLI run), and only another `None` caller matches it.
    owner: Option<String>,
    /// Wall-clock start and end, for a surface that shows when it ran.
    started_at_ms: u64,
    finished_at_ms: Option<u64>,
    /// Stopped on request rather than by exiting.
    stopped_by_request: bool,
    /// Recent output, fed by the same stream the live view reads.
    tail: std::sync::Arc<Mutex<LiveTail>>,
}

impl BashJob {
    /// Has the command finished? Non-destructive from the caller's point of
    /// view: anything received is retained for collection.
    fn poll_finished(&mut self) -> bool {
        let finished = self.poll_finished_inner();
        if finished && self.finished_at_ms.is_none() {
            self.finished_at_ms = Some(now_ms());
        }
        finished
    }

    fn poll_finished_inner(&mut self) -> bool {
        if self.output.is_some() {
            return true;
        }
        // Being collected: the receiver is with the collector, and the command
        // is still running until that collector says otherwise.
        if self.collecting {
            return false;
        }
        let Some(rx) = self.rx.as_mut() else {
            return true;
        };
        match rx.try_recv() {
            Ok(value) => {
                self.output = Some(value);
                self.rx = None;
                true
            }
            Err(oneshot::error::TryRecvError::Empty) => false,
            Err(oneshot::error::TryRecvError::Closed) => {
                self.output =
                    Some("ERROR: background command ended without producing output".to_string());
                self.rx = None;
                true
            }
        }
    }
}

/// A job as reported to a caller that is listing, not collecting.
///
/// The command is redacted (see [`crate::audit::redact`]): this is metadata a
/// panel shows and a store may keep, and a command line is where a credential
/// most often appears.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BashJobStatus {
    pub job_id: String,
    pub command: String,
    pub elapsed_ms: u64,
    pub finished: bool,
    pub call_id: Option<String>,
    pub started_at_ms: u64,
    pub finished_at_ms: Option<u64>,
    /// From the finished output's `[exit N]` marker, when it has one.
    pub exit_code: Option<i32>,
    /// Killed by a signal rather than exiting (including a stop request).
    pub signalled: bool,
    /// Someone asked for it to be stopped, and it was.
    pub stopped_by_request: bool,
    /// Its output is waiting to be collected. False while running.
    pub output_available: bool,
}

impl BashJob {
    fn status(&mut self, job_id: &str) -> BashJobStatus {
        let finished = self.poll_finished();
        let output = self.output.as_deref();
        BashJobStatus {
            job_id: job_id.to_string(),
            command: crate::audit::redact(&self.command),
            elapsed_ms: match self.finished_at_ms {
                Some(end) => end.saturating_sub(self.started_at_ms),
                None => self.started.elapsed().as_millis() as u64,
            },
            finished,
            call_id: self.call_id.clone(),
            started_at_ms: self.started_at_ms,
            finished_at_ms: self.finished_at_ms,
            exit_code: output.and_then(exit_code_of),
            signalled: output.is_some_and(|o| {
                o.lines().any(|l| l.trim() == "[terminated by signal]")
            }),
            stopped_by_request: self.stopped_by_request,
            output_available: output.is_some(),
        }
    }
}

/// Why a kill request ended the way it did. Reported rather than inferred so a
/// caller can tell "there was nothing left to kill" from "the kill failed".
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BashJobKillOutcome {
    /// The process tree was signalled.
    Killed,
    /// The command had already finished; its output is still collectable.
    AlreadyFinished,
    /// No job by that id: never existed, or already collected.
    Unknown,
    /// The job exists but its pid was never captured, so nothing can be
    /// signalled. The command is left alone rather than reported as killed.
    NoPid,
    /// The OS refused to stop it. The command is still running, and the pid is
    /// kept so the request can be made again.
    Failed,
}

/// The result of asking for one background job to be killed.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BashJobKill {
    pub job_id: String,
    pub outcome: BashJobKillOutcome,
    /// Why it failed, when it did. Safe to show: it names the OS refusal,
    /// never a path or an environment value.
    pub error: Option<String>,
}

/// Commands still running past their `bash` call's timeout, keyed by job_id.
/// Entries are removed once collected via `job_id`; uncollected jobs live for
/// the process's lifetime, same tradeoff as the bash-output temp files this
/// module already leaves on disk.
fn bash_jobs() -> &'static Mutex<HashMap<String, BashJob>> {
    static JOBS: OnceLock<Mutex<HashMap<String, BashJob>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Every backgrounded command `owner` started, newest first. Listing never
/// consumes a result: see [`BashJob::poll_finished`].
///
/// Another owner's jobs are not listed at all -- not even as a count -- so a
/// session can learn nothing about work it did not start.
pub fn list_bash_jobs(owner: Option<&str>) -> Vec<BashJobStatus> {
    let mut jobs = bash_jobs().lock().unwrap();
    let mut out: Vec<BashJobStatus> = jobs
        .iter_mut()
        .filter(|(_, job)| job.owner.as_deref() == owner)
        .map(|(job_id, job)| job.status(job_id))
        .collect();
    // Newest first, by when it started; the id breaks ties.
    out.sort_by(|a, b| {
        b.started_at_ms
            .cmp(&a.started_at_ms)
            .then(b.job_id.len().cmp(&a.job_id.len()))
            .then(b.job_id.cmp(&a.job_id))
    });
    out
}

/// One job's status, if `owner` may see it.
pub fn inspect_bash_job(job_id: &str, owner: Option<&str>) -> Option<BashJobStatus> {
    let mut jobs = bash_jobs().lock().unwrap();
    let job = jobs.get_mut(job_id)?;
    if job.owner.as_deref() != owner {
        return None;
    }
    Some(job.status(job_id))
}

/// A job's recent output, redacted, for a status check. Never consumes the
/// result the collector is waiting for.
fn peek_tail(job_id: &str, owner: Option<&str>) -> Option<(String, usize)> {
    let jobs = bash_jobs().lock().unwrap();
    let job = jobs.get(job_id)?;
    if job.owner.as_deref() != owner {
        return None;
    }
    let tail = job.tail.lock().ok()?;
    Some((crate::audit::redact(&tail.text), tail.dropped))
}

/// Make room for one more job under `owner`. Drops the oldest *finished*
/// uncollected job when the owner is at its limit; returns false when every
/// job it holds is still running, so the caller refuses rather than grows.
fn make_room_for(owner: Option<&str>) -> bool {
    let mut jobs = bash_jobs().lock().unwrap();
    let mut mine: Vec<(String, u64, bool)> = jobs
        .iter_mut()
        .filter(|(_, job)| job.owner.as_deref() == owner)
        .map(|(id, job)| (id.clone(), job.started_at_ms, job.poll_finished() && !job.collecting))
        .collect();
    if mine.len() < MAX_JOBS_PER_OWNER {
        return true;
    }
    mine.sort_by_key(|(_, started, _)| *started);
    match mine.iter().find(|(_, _, done)| *done) {
        Some((oldest, _, _)) => {
            jobs.remove(oldest);
            true
        }
        None => false,
    }
}

/// Kill one backgrounded command and every process it spawned.
///
/// The job is kept, not removed: the detached collector still resolves once the
/// shell dies, so the agent's `bash {"job_id": ...}` collection returns whatever
/// the command printed before it was killed instead of `unknown job_id`. A job
/// that has already finished is left alone — killing it would signal a pid the
/// OS may since have reused.
pub fn kill_bash_job(job_id: &str, owner: Option<&str>) -> BashJobKill {
    let mut jobs = bash_jobs().lock().unwrap();
    let (outcome, error) = match jobs.get_mut(job_id) {
        // Someone else's job reads exactly like no job: saying "not yours"
        // would confirm that it exists.
        Some(job) if job.owner.as_deref() != owner => (BashJobKillOutcome::Unknown, None),
        None => (BashJobKillOutcome::Unknown, None),
        Some(job) => {
            if job.poll_finished() {
                (BashJobKillOutcome::AlreadyFinished, None)
            } else {
                match job.pid {
                    None => (BashJobKillOutcome::NoPid, None),
                    // Borrowed, not taken. The pid is surrendered only once the
                    // process is known to be gone, so a refused kill can be
                    // asked again — and a *successful* one is never repeated
                    // against a number the OS may since have reused.
                    Some(pid) => match super::proc::kill_tree(pid) {
                        // Signalled, or already gone: either way it is stopped,
                        // which also covers the command exiting between the
                        // poll above and the signal. Its output stays
                        // collectable because the entry is kept.
                        outcome if outcome.stopped() => {
                            job.pid = None;
                            job.stopped_by_request = true;
                            super::proc::unregister(pid);
                            (BashJobKillOutcome::Killed, None)
                        }
                        super::proc::KillOutcome::Failed(reason) => {
                            (BashJobKillOutcome::Failed, Some(reason))
                        }
                        // `stopped()` covers every other variant; saying so
                        // beats a fallthrough that would report a kill that
                        // did not happen.
                        other => (
                            BashJobKillOutcome::Failed,
                            Some(format!("unexpected kill outcome: {other:?}")),
                        ),
                    },
                }
            }
        }
    };
    BashJobKill {
        job_id: job_id.to_string(),
        outcome,
        error,
    }
}

fn arg_str<'a>(args: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(|v| v.as_str())
}

fn arg_u64(args: &serde_json::Value, key: &str) -> Option<u64> {
    args.get(key).and_then(|v| v.as_u64())
}

fn arg_bool(args: &serde_json::Value, key: &str) -> bool {
    args.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

/// Single-quote a value for a POSIX shell. Single quotes disable `$`/backtick
/// expansion and globbing, and the only escape (closing quote) is handled by
/// the `'\''` idiom. Used when launching headless Chrome through the shell.
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn rel_to(base: &Path, path: &Path) -> String {
    path.strip_prefix(base)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// How a mutated path is named back to the model: relative inside the project,
/// absolute once it escapes. Normalizes first, since `root/../x` strips to a
/// misleading `../x` against an un-normalized root. A target inside the session
/// scratch is named by whichever spelling the shell can also use there.
fn display_path(root: &Path, scratch: Option<&Path>, target: &Path) -> String {
    if in_scratch(scratch, target) {
        return scratch_display_path(scratch, target);
    }
    rel_to(&lexical_normalize(root), &lexical_normalize(target))
}

/// Truncate `s` to the smaller of `max_lines` or `max_bytes`, appending
/// `note` when truncation occurred.
fn cap_output(s: &str, max_lines: usize, max_bytes: usize, note: &str) -> String {
    let mut out = String::new();
    let mut truncated = false;
    for (lines, line) in s.split_inclusive('\n').enumerate() {
        if lines >= max_lines || out.len() + line.len() > max_bytes {
            truncated = true;
            break;
        }
        out.push_str(line);
    }
    if truncated {
        out.push_str(note);
    }
    out
}

/// Collapse carriage-return redraws (`git`/`curl`-style progress lines) to what
/// a terminal would actually show: text after the last `\r` on each line wins.
/// Without this, thousands of `\r`-separated progress frames read as one giant
/// line and blow past the byte cap, so tiny visible output looks truncated.
fn collapse_carriage_returns(s: &str) -> String {
    if !s.contains('\r') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    for line in s.split_inclusive('\n') {
        let (body, nl) = match line.strip_suffix('\n') {
            Some(b) => (b, "\n"),
            None => (line, ""),
        };
        let body = body.strip_suffix('\r').unwrap_or(body);
        out.push_str(body.rsplit('\r').next().unwrap_or(body));
        out.push_str(nl);
    }
    out
}

/// Execute a built-in tool. Returns the tool-result text plus, for a `read` of
/// an image file, the base64 `image_url` content parts the model needs to see
/// the image. Errors are returned as a String STARTING WITH "ERROR" rather than
/// as Err.
pub async fn execute_builtin(
    tool: &BuiltinTool,
    args: &serde_json::Value,
    ctx: &ToolContext<'_>,
) -> (String, Option<Vec<ImageContentPart>>) {
    let project_root = ctx.project_root;
    let scratch = ctx.scratch_root;

    // AH-020/AH-023. Every built-in runs under a deadline and a cancellation
    // token, not just `bash`. A filesystem call that wedges on a stale network
    // mount, or a web fetch to a host that accepts and never answers, used to
    // hang the whole run with nothing able to interrupt it.
    //
    // `bash` keeps its own inner deadline: it owns a process tree and has to
    // kill it, which the generic wrapper cannot do. The wrapper is still the
    // outer bound, so a bash call whose own handling stalls is not exempt.
    let token = ctx
        .cancel
        .clone()
        .unwrap_or_else(crate::lifecycle::Token::detached);
    let limit = crate::lifecycle::Timeouts::default().for_tool(tool.name);

    // AH-127/AH-129. The project's own hooks run around the call. They are
    // read per call rather than cached: the file is small, and a user who
    // fixes a hook mid-run means the fixed one, not the one that was read
    // when the run started.
    let hook_ctx = crate::hooks::Context {
        project_root,
        allow_network: ctx.allow_network,
        home_readonly: ctx.home_readonly,
        sandbox: ctx.sandbox,
        // The same folder `bash` has masked from it on this surface.
        mask_root: ctx.mask_root,
        cancel: ctx.cancel.clone(),
    };
    let hooks = match crate::hooks::load(project_root) {
        Ok(hooks) => hooks,
        // A hooks file that cannot be read is not silently no hooks: a
        // project that declared a policy and got none would be the worst of
        // the three outcomes.
        Err(error) => {
            let harness: crate::harness_error::HarnessError = (&error).into();
            return (
                format!(
                    "ERROR [{}]: this project's hooks could not be read, so no tool ran: {}",
                    harness.kind().tag(),
                    error.message
                ),
                None,
            );
        }
    };
    let before =
        crate::hooks::run(&hooks, crate::hooks::Event::PreTool, Some(tool.name), &hook_ctx).await;
    if let Some(blocked) = before.blocked {
        let harness: crate::harness_error::HarnessError = (&blocked).into();
        return (
            format!(
                "ERROR [{}]: a pre-tool hook refused this call: {}",
                harness.kind().tag(),
                blocked.message
            ),
            None,
        );
    }

    let work = async {
        match tool.name {
            "read" => read(args, project_root, scratch, ctx.read_roots).await,
            "screenshot" => screenshot(args, project_root, scratch, ctx.read_roots).await,
            _ => (execute_text(tool, args, ctx).await, None),
        }
    };

    let (mut content, images) = match crate::lifecycle::run_with_deadline(&token, limit, work).await {
        Ok(pair) => pair,
        // Named, and distinguishable: a person reading the transcript needs to
        // know whether they stopped this or it ran out of time.
        Err(reason) => (
            format!(
                "ERROR: tool '{}' {} after {}s and was stopped. No result is available.",
                tool.name,
                match reason {
                    crate::lifecycle::StopReason::Timeout => "exceeded its time limit",
                    crate::lifecycle::StopReason::Cancelled => "was cancelled",
                },
                limit.as_secs()
            ),
            None,
        ),
    };

    // A post-tool hook cannot undo what the tool did, so it never blocks. What
    // it can do is say something went wrong, where the model and the person
    // reading the transcript will both see it.
    let after =
        crate::hooks::run(&hooks, crate::hooks::Event::PostTool, Some(tool.name), &hook_ctx).await;
    for warning in &after.warnings {
        content.push_str(&format!("\n\n[post-tool hook] {}", warning.message));
    }
    for warning in &before.warnings {
        content.push_str(&format!("\n\n[pre-tool hook] {}", warning.message));
    }
    (content, images)
}

/// The text result for every tool except `read`. Split out so `read` can also
/// return image parts without duplicating the remaining tool dispatch.
pub(crate) async fn execute_text(
    tool: &BuiltinTool,
    args: &serde_json::Value,
    ctx: &ToolContext<'_>,
) -> String {
    let project_root = ctx.project_root;
    let scratch = ctx.scratch_root;
    match tool.name {
        // Read tools consult the attached read-only roots; `write`/`edit`
        // deliberately do not, which is what keeps an attached folder
        // readable and unwritable.
        "read" => read(args, project_root, scratch, ctx.read_roots).await.0,
        "ls" => ls(args, project_root, scratch, ctx.sandbox, ctx.read_roots).await,
        "write" => {
            write(
                args,
                project_root,
                scratch,
                ctx.confine_writes,
                ctx.write_roots,
            )
            .await
        }
        "edit" => {
            edit(
                args,
                project_root,
                scratch,
                ctx.confine_writes,
                ctx.write_roots,
            )
            .await
        }
        "bash" => bash(args, ctx).await,
        "find" => find(args, project_root, scratch, ctx.sandbox, ctx.read_roots).await,
        "grep" => grep(args, project_root, scratch, ctx.sandbox, ctx.read_roots).await,
        // Memory and skills live in the store root, not the sandbox: they must
        // outlive the conversation the filesystem tools are scoped to.
        "memory_list" => memory_list(ctx.store_root).await,
        "memory_read" => memory_read(args, ctx.store_root).await,
        "memory_write" => memory_write(args, ctx.store_root).await,
        "memory_propose" => memory_propose(args, ctx).await,
        "message_send" => message_send(args, ctx),
        "message_check" => message_check(ctx),
        // Skills go through the skills module so the tool honors the folder form
        // (`<name>/SKILL.md`) and frontmatter, matching what the UI writes.
        "skill_list" => skill_list(ctx),
        "skill_read" => skill_read(args, ctx),
        "skill_write" => skill_write(args, ctx),
        // Native web tools: compiled into the agent core, not an MCP server.
        "web_search" => crate::tools::web::web_search(args).await,
        "web_fetch" => crate::tools::web::web_fetch(args).await,
        // Cross-session messaging. Refuses unless the dispatcher bound this
        // call to a session and a mailbox (desktop, session scope only).
        "list_sessions" | "send_message" | "read_messages" | "wait_for_reply" => {
            crate::session_mailbox::run_tool(tool.name, args, ctx).await
        }
        other => format!("ERROR: unknown built-in tool '{other}'"),
    }
}

/// Apply `edits` to `content` in order, each against the result of the last.
///
/// Shared by `edit` and by [`stage_change`], so the change a person reviews is
/// computed by the same code that later makes it. Two implementations would be
/// two answers to "what will this edit do".
fn apply_edits(
    content: &str,
    edits: &[serde_json::Value],
    shown: &str,
) -> Result<String, String> {
    let mut content = content.to_string();
    for (i, e) in edits.iter().enumerate() {
        let Some(old_string) = e.get("old_string").and_then(|v| v.as_str()) else {
            return Err(format!("ERROR: {shown}: edit {}: missing 'old_string'", i + 1));
        };
        let Some(new_string) = e.get("new_string").and_then(|v| v.as_str()) else {
            return Err(format!("ERROR: {shown}: edit {}: missing 'new_string'", i + 1));
        };
        let count = content.matches(old_string).count();
        if count == 0 {
            return Err(format!("ERROR: {shown}: edit {}: old_string not found", i + 1));
        }
        if count > 1 {
            return Err(format!(
                "ERROR: {shown}: edit {}: old_string not unique ({count} matches)",
                i + 1
            ));
        }
        content = content.replacen(old_string, new_string, 1);
    }
    Ok(content)
}

/// The change a `write` or `edit` call would make, staged as reviewable hunks
/// against the file as it is now. AH-146/AH-148.
///
/// Returns the resolved target alongside the patch, because the patch is only
/// meaningful against the file it was computed from: the caller keeps both,
/// and before acting on an approval checks that the file is still that file.
/// `None` for every other tool, for a call that would change nothing, and for
/// a call whose own arguments are invalid -- the tool reports that itself.
pub async fn stage_change(
    tool: &BuiltinTool,
    args: &serde_json::Value,
    ctx: &ToolContext<'_>,
) -> Option<(PathBuf, crate::patch::StagedPatch)> {
    let path = arg_str(args, "path")?;
    let target = resolve_path(ctx.project_root, ctx.scratch_root, path);
    let prior = match tokio::fs::read(&target).await {
        // Text only. A binary file has no lines to review, and refusing to
        // stage it is not refusing the write -- the prompt still shows it.
        Ok(bytes) => Some(String::from_utf8(bytes).ok()?),
        Err(_) => None,
    };
    let proposed = match tool.name {
        "write" => arg_str(args, "content")?.to_string(),
        "edit" => {
            let edits = args.get("edits").and_then(|v| v.as_array())?;
            apply_edits(prior.as_deref()?, edits, path).ok()?
        }
        _ => return None,
    };
    let patch = crate::patch::StagedPatch::stage(prior.as_deref(), &proposed);
    (!patch.is_empty()).then_some((target, patch))
}

/// Focused diff previewing what a `write`/`edit` call would change, without
/// running it. Line-prefixed (`-`/`+`) hunk text with each line numbered against
/// its position in the file; `None` for other tools or when nothing would
/// change. Used to show the change in the permission prompt. Both variants read
/// the prior file: `write` to show its `created`/`overwrote` header, `edit` to
/// locate `old_string` and number the hunk against real file lines.
pub async fn preview_diff(
    tool: &BuiltinTool,
    args: &serde_json::Value,
    ctx: &ToolContext<'_>,
) -> Option<String> {
    let project_root = ctx.project_root;
    let scratch = ctx.scratch_root;
    match tool.name {
        "edit" => {
            let edits = args.get("edits").and_then(|v| v.as_array())?;
            if edits.is_empty() {
                return None;
            }
            let prior = match arg_str(args, "path") {
                Some(p) => tokio::fs::read_to_string(resolve_path(project_root, scratch, p))
                    .await
                    .unwrap_or_default(),
                None => String::new(),
            };
            let d = render_edit_diff(edits, &prior);
            (!d.is_empty()).then_some(d)
        }
        "write" => {
            let prior = match arg_str(args, "path") {
                Some(p) => tokio::fs::read_to_string(resolve_path(project_root, scratch, p))
                    .await
                    .ok(),
                None => None,
            };
            let new = arg_str(args, "content").unwrap_or("");
            // A rewrite with identical content changes nothing; showing a full
            // `+` block would misrepresent it as an overwrite.
            if prior.as_deref() == Some(new) {
                return None;
            }
            Some(render_write_diff(prior.as_deref(), new))
        }
        _ => None,
    }
}

/// Run a built-in tool and, for `write`/`edit`, also produce a focused diff.
/// Returns `(content, diff)`. The diff is line-prefixed (`-`/`+`) hunk text for
/// **display only**: the model gets the concise summary in `content`, since the
/// hunk merely replays an edit it just authored and would cost context on every
/// mutating call. Diffs are computed against the pre-execution file so line
/// numbers match the file as the model saw it. `None` for non-mutating tools
/// and on error.
pub async fn execute_builtin_with_diff(
    tool: &BuiltinTool,
    args: &serde_json::Value,
    ctx: &ToolContext<'_>,
) -> (String, Option<String>, Option<Vec<ImageContentPart>>) {
    match tool.name {
        "write" | "edit" => {
            let diff = preview_diff(tool, args, ctx).await;
            // Kept from before the call so the post-format diff can be drawn
            // against the file as the model saw it, rather than against what
            // the model wrote and the formatter then rewrote.
            let before = match arg_str(args, "path") {
                Some(p) => tokio::fs::read_to_string(resolve_path(
                    ctx.project_root,
                    ctx.scratch_root,
                    p,
                ))
                .await
                .ok(),
                None => None,
            };

            // A credential in what this change *adds* stops it before it
            // lands. AH-157. Catching it afterwards is not the same thing: a
            // key that reaches the working tree is a key that has to be
            // rotated, and by then it may already be in a commit.
            //
            // The removals are ignored on purpose -- a secret on a deleted
            // line is someone taking it out, and refusing that would fire the
            // warning on the fix.
            if let Some(preview) = diff.as_deref() {
                let findings = crate::secrets::scan_diff(preview);
                if !findings.is_empty() {
                    let where_ = findings
                        .iter()
                        .map(|f| {
                            let file = if f.file.is_empty() {
                                "the file"
                            } else {
                                &f.file
                            };
                            format!("{} line {} ({})", file, f.line, f.kind.as_str())
                        })
                        .collect::<Vec<_>>()
                        .join(", ");
                    return (
                        format!(
                            "ERROR: this change was not written: it adds what looks like a \
                             credential at {where_}. Nothing was changed. Use a placeholder \
                             and read the real value from the environment, or ask the user \
                             to add it themselves."
                        ),
                        None,
                        None,
                    );
                }
            }

            let (content, images) = execute_builtin(tool, args, ctx).await;
            if content.starts_with("ERROR") {
                return (content, None, None);
            }
            // AH-149: the project's own formatter has the last word on layout,
            // and the diff a person reviews should be what the file now holds
            // -- not a version the next `cargo fmt` will rewrite.
            let diff = format_after_edit(args, ctx, before.as_deref(), diff).await;
            (content, diff, images)
        }
        "read" => {
            let (content, images) = execute_builtin(tool, args, ctx).await;
            (content, None, images)
        }
        _ => (execute_builtin(tool, args, ctx).await.0, None, None),
    }
}

/// Hand the edited file to the project's formatter, and redraw the diff
/// against what the file now holds (AH-149, AH-150).
///
/// The diff is redrawn rather than annotated because the point of showing one
/// is that it is what happened. A formatter that could not run, or refused the
/// file, leaves the original diff exactly as it was and says so underneath:
/// silence there would read as "nothing to format".
async fn format_after_edit(
    args: &serde_json::Value,
    ctx: &ToolContext<'_>,
    before: Option<&str>,
    diff: Option<String>,
) -> Option<String> {
    if !ctx.format_on_edit {
        return diff;
    }
    let path = arg_str(args, "path")?;
    let file = resolve_path(ctx.project_root, ctx.scratch_root, path);
    let formatter = crate::format::detect(ctx.project_root, &file)?;
    let project_root = ctx.project_root.to_path_buf();
    let running = formatter.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        crate::format::run(&running, &project_root, &file)
    })
    .await
    .unwrap_or_else(|e| crate::format::Formatted::Failed(format!("the formatter could not be run: {e}")));
    match outcome {
        crate::format::Formatted::Unchanged => diff,
        crate::format::Formatted::Failed(why) => Some(format!(
            "{}\n[{}]",
            diff.unwrap_or_default().trim_end(),
            why
        )),
        crate::format::Formatted::Changed(after) => {
            let redrawn = render_hunk_diff(before.unwrap_or(""), &after, 1);
            Some(format!(
                "{}\n[formatted with {} ({})]",
                redrawn.trim_end(),
                formatter.name,
                formatter.evidence
            ))
        }
    }
}

/// 1-based line number of the start of `pos` within `text`.
fn line_number_at(text: &str, pos: usize) -> usize {
    text[..pos].matches('\n').count() + 1
}

/// Lines of surrounding file context kept around a change, and the threshold
/// past which one edit's hunk is split with a `...` gap. Matches the feel of a
/// unified diff without the `@@ -a,b +c,d @@` range header (the existing
/// `@@ edit i/n @@` marker already identifies the hunk).
const DIFF_CONTEXT: usize = 2;

/// Per-edit hunks computed with a real line-level diff (`similar`), so a
/// one-line change inside a large `old_string`/`new_string` pair shows only the
/// lines that actually differ instead of the whole block as removed and
/// re-added. The compared blocks are widened from the raw arguments to whole
/// lines plus up to `DIFF_CONTEXT` unchanged lines taken from the file, so a
/// change is shown in place even when `old_string` carries no context of its
/// own. Deleted lines are numbered against the file before the edit, kept and
/// inserted lines against the file after it. Multiple edits are separated by
/// `@@ edit i/n @@` and applied in order so later edits number against the
/// state left by earlier ones, matching what `edit()` does.
fn render_edit_diff(edits: &[serde_json::Value], prior: &str) -> String {
    let n = edits.len();
    let mut working = prior.to_string();
    let mut out = String::new();
    for (i, e) in edits.iter().enumerate() {
        let old = e.get("old_string").and_then(|v| v.as_str()).unwrap_or("");
        let new = e.get("new_string").and_then(|v| v.as_str()).unwrap_or("");
        if n > 1 {
            out.push_str(&format!("@@ edit {}/{} @@\n", i + 1, n));
        }
        match working.find(old) {
            Some(pos) => {
                let (old_block, new_block, start) = expand_hunk(&working, pos, old, new);
                out.push_str(&render_hunk_diff(&old_block, &new_block, start));
                working.replace_range(pos..pos + old.len(), new);
            }
            // `edit()` will reject this call, but the arguments are still worth
            // showing; there is no file position to number them against.
            None => out.push_str(&render_hunk_diff(old, new, 1)),
        }
    }
    out.trim_end().to_string()
}

/// Widen the replacement of `old` at `pos` in `text` to whole lines plus
/// `DIFF_CONTEXT` lines of surrounding file context, returning the before and
/// after blocks and the 1-based line the blocks start at. Both blocks share the
/// context verbatim, so the diff renders it as unchanged lines; whole-line
/// bounds keep a match that starts or ends mid-line from being diffed against a
/// line fragment.
fn expand_hunk(text: &str, pos: usize, old: &str, new: &str) -> (String, String, usize) {
    let end = pos + old.len();
    let mut ctx_start = text[..pos].rfind('\n').map_or(0, |i| i + 1);
    for _ in 0..DIFF_CONTEXT {
        if ctx_start == 0 {
            break;
        }
        ctx_start = text[..ctx_start - 1].rfind('\n').map_or(0, |i| i + 1);
    }
    let mut ctx_end = text[end..].find('\n').map_or(text.len(), |i| end + i);
    for _ in 0..DIFF_CONTEXT {
        if ctx_end >= text.len() {
            break;
        }
        ctx_end = text[ctx_end + 1..]
            .find('\n')
            .map_or(text.len(), |i| ctx_end + 1 + i);
    }
    let old_block = text[ctx_start..ctx_end].to_string();
    let new_block = format!("{}{new}{}", &text[ctx_start..pos], &text[end..ctx_end]);
    (old_block, new_block, line_number_at(text, ctx_start))
}

/// Line-diff `old` against `new`, rendering each changed/context line with its
/// real line number (`start`-based on both sides, since old and new begin at
/// the same position). Groups distant changes with a `...` gap.
fn render_hunk_diff(old: &str, new: &str, start: usize) -> String {
    use similar::{ChangeTag, TextDiff};

    // `old_string`/`new_string` are exact source snippets and often lack a
    // trailing newline on their last line. `from_lines` tokenizes by keeping
    // each line's newline, so a shared last line would otherwise mismatch
    // (`"b"` vs `"b\n"`) and show as a spurious delete+insert instead of
    // context. Padding both sides equally doesn't change indices or output,
    // since `\n` is stripped again before each line is printed.
    let pad = |s: &str| {
        if s.is_empty() || s.ends_with('\n') {
            s.to_string()
        } else {
            format!("{s}\n")
        }
    };
    let (old, new) = (pad(old), pad(new));
    let diff = TextDiff::from_lines(&old, &new);
    let mut out = String::new();
    for (gi, group) in diff.grouped_ops(DIFF_CONTEXT).iter().enumerate() {
        if gi > 0 {
            out.push_str("      ...\n");
        }
        for op in group {
            for change in diff.iter_changes(op) {
                let text = change.value();
                let text = text.strip_suffix('\n').unwrap_or(text);
                match change.tag() {
                    // Numbered on the new side: context below an insertion or
                    // deletion has moved, and an old-side number there would
                    // run backwards against the `+` lines just above it.
                    ChangeTag::Equal => {
                        let line = start + change.new_index().unwrap_or(0);
                        out.push_str(&format!("  {line:>4} | {text}\n"));
                    }
                    ChangeTag::Delete => {
                        let line = start + change.old_index().unwrap_or(0);
                        out.push_str(&format!("- {line:>4} | {text}\n"));
                    }
                    ChangeTag::Insert => {
                        let line = start + change.new_index().unwrap_or(0);
                        out.push_str(&format!("+ {line:>4} | {text}\n"));
                    }
                }
            }
        }
    }
    out
}

/// Whole-file `+` preview for a write, headed by created/overwrote, each line
/// numbered by its position in the new content. Display-only; the TUI
/// collapses long output.
fn render_write_diff(prior: Option<&str>, content: &str) -> String {
    let mut out = String::from(if prior.is_some() {
        "@@ overwrote file @@\n"
    } else {
        "@@ created file @@\n"
    });
    for (i, line) in content.lines().enumerate() {
        out.push_str(&format!("+ {:>4} | {line}\n", i + 1));
    }
    out.trim_end().to_string()
}

/// What a skill declares it depends on and this run cannot supply (AH-123,
/// AH-124): a skill that is not installed, one installed at a version the
/// requirement rules out, or a tool nothing here provides.
///
/// Resolution is the caller's, not the skills module's: a dependency may live
/// in the project's store or in the user's, and only here is that known.
fn skill_requirements_unmet(ctx: &ToolContext<'_>, name: &str, parsed: &skills::ParsedSkill) -> Vec<String> {
    let lookup = |wanted: &str| {
        ctx.skill_project
            .and_then(|project| skills::read_raw(project, wanted).ok())
            .or_else(|| skills::read_raw_with_user(ctx.store_root, ctx.user_skills_root, wanted).ok())
    };
    skills::unmet_requirements(name, parsed, &lookup, ctx.available_tools)
}

/// `skill_list` tool: catalog of `name — description` lines for ENABLED skills
/// only (disabled skills must stay invisible to the model). Empty if none.
///
/// With an attached project (`ctx.skill_project`), that project's skills and
/// its enabled plugins' skills come first, filtered by the project's own
/// `[skills].enabled`; see [`skills::catalog_for_model`].
fn skill_list(ctx: &ToolContext<'_>) -> String {
    let offered = skills::catalog_for_model_with_user(
        ctx.skill_project,
        ctx.store_root,
        ctx.user_skills_root,
        ctx.enabled_skills,
    );
    offered
        .into_iter()
        // A skill this run could not carry out is not offered: a catalogue
        // entry is an invitation, and one that always ends in a refusal is a
        // worse answer than not listing it.
        .filter(|meta| match (ctx.permissions, ctx.subject) {
            (Some(permissions), Some(subject)) => {
                skills::unusable_tools(&meta.needs, permissions, subject).is_empty()
            }
            _ => true,
        })
        // AH-124: and neither is a skill whose dependencies are not here. The
        // catalogue is an offer; one that cannot be taken up is worse than no
        // entry at all.
        .filter(|meta| {
            // The body the listing layer would hand over, not a same-named
            // skill of another layer.
            match skills::read_for_model_with_user(
                ctx.skill_project,
                ctx.store_root,
                ctx.user_skills_root,
                ctx.enabled_skills,
                &meta.name,
            ) {
                Ok(raw) => skill_requirements_unmet(ctx, &meta.name, &skills::parse(&raw)).is_empty(),
                Err(_) => true,
            }
        })
        .collect::<Vec<_>>()
        .iter()
        .map(|m| {
            // AH-123: a declared version is part of a skill's identity, so it
            // is shown where the skill is named. A skill that declares none is
            // listed as it always was, rather than as some invented version.
            let name = match &m.version {
                Some(version) => format!("{} (v{version})", m.name),
                None => m.name.clone(),
            };
            if m.description.is_empty() {
                name
            } else {
                format!("{name} — {}", m.description)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `skill_read` tool: a skill's full instructions (frontmatter stripped). A
/// disabled skill, a skill of a disabled plugin, or one with
/// `disable-model-invocation: true` is treated as absent so it never reaches
/// the model. Reading a skill grants nothing: scripts it mentions still run
/// only through `bash`, under the gate.
fn skill_read(args: &serde_json::Value, ctx: &ToolContext<'_>) -> String {
    let Some(name) = arg_str(args, "name") else {
        return "ERROR: missing required argument 'name'".to_string();
    };
    // The whitelist is applied per layer: an attached project's own
    // `[skills].enabled`, the caller's for the store and the user's skills.
    let raw = match skills::read_for_model_with_user(
        ctx.skill_project,
        ctx.store_root,
        ctx.user_skills_root,
        ctx.enabled_skills,
        name,
    ) {
        Ok(raw) => raw,
        Err(e) => return e,
    };
    let parsed = skills::parse(&raw);
    if !parsed.model_invocable {
        return format!("ERROR: skill '{name}' not found");
    }
    // AH-040: a skill that says which tools it needs is withheld where this
    // run may not use them. Handing over instructions whose every step will be
    // refused wastes a turn and reads, to the model, as the harness being
    // broken rather than as a policy it cannot cross.
    if let (Some(permissions), Some(subject)) = (ctx.permissions, ctx.subject) {
        let blocked = skills::unusable_tools(&parsed.needs, permissions, subject);
        if !blocked.is_empty() {
            return format!(
                "ERROR [permission_denied]: the skill '{name}' needs {}, which this run may not \
                 use. Its instructions are not loaded; do the work with what you have, or ask \
                 for the policy to be changed.",
                blocked.join(", ")
            );
        }
    }
    // AH-124: a skill whose dependencies are absent is not loaded. Failing
    // here, naming what is missing, is worth more than instructions that refer
    // to a skill the model will be told does not exist three turns from now.
    let unmet = skill_requirements_unmet(ctx, name, &parsed);
    if !unmet.is_empty() {
        return format!(
            "ERROR [invalid_input]: the skill '{name}' cannot be loaded here: {}. Its \
             instructions are not loaded; install what it needs, or do the work without it.",
            unmet.join("; ")
        );
    }
    parsed.body
}

/// `skill_write` tool: create/update a skill (new ones as `<name>/SKILL.md`).
/// The `[skills].enabled` whitelist is honored for writes too: a disabled skill
/// is treated as read-only so the model cannot silently overwrite (or resurrect)
/// a skill the user has turned off or locked out of the catalog.
fn skill_write(args: &serde_json::Value, ctx: &ToolContext<'_>) -> String {
    let Some(name) = arg_str(args, "name") else {
        return "ERROR: missing required argument 'name'".to_string();
    };
    let Some(content) = arg_str(args, "content") else {
        return "ERROR: missing required argument 'content'".to_string();
    };
    // An attached project's skills (its own and its plugins') are read-only
    // here: the folder is mounted read-only, and a same-named store skill
    // would be shadowed by it and never read back.
    if let Some(project) = ctx.skill_project {
        if skills::project_claims(project, name) {
            return format!(
                "ERROR: skill '{name}' is provided by the attached project folder \
                 and is read-only here"
            );
        }
    }
    if !skills::is_enabled(ctx.enabled_skills, name) {
        return format!("ERROR: skill '{name}' is disabled and read-only");
    }
    match skills::write(ctx.store_root, name, content) {
        Ok(()) => format!("Wrote skill '{name}'"),
        Err(e) => e,
    }
}

/// The memory tools delegate to `crate::memory` so the built-ins and the
/// management commands share one implementation.
async fn memory_list(store: &Path) -> String {
    memory::list(store).await.join("\n")
}

async fn memory_read(args: &serde_json::Value, store: &Path) -> String {
    let Some(name) = arg_str(args, "name") else {
        return "ERROR: missing required argument 'name'".to_string();
    };
    match memory::read(store, name).await {
        Ok(content) => content,
        Err(e) => e,
    }
}

async fn memory_write(args: &serde_json::Value, store: &Path) -> String {
    let Some(name) = arg_str(args, "name") else {
        return "ERROR: missing required argument 'name'".to_string();
    };
    let Some(content) = arg_str(args, "content") else {
        return "ERROR: missing required argument 'content'".to_string();
    };
    match memory::write(store, name, content).await {
        Ok(file) => format!("Wrote {} bytes to memory/{file}", content.len()),
        Err(e) => e,
    }
}

async fn read(
    args: &serde_json::Value,
    root: &Path,
    scratch: Option<&Path>,
    read_roots: &[PathBuf],
) -> (String, Option<Vec<ImageContentPart>>) {
    let Some(path) = arg_str(args, "path") else {
        return ("ERROR: missing required argument 'path'".to_string(), None);
    };
    let offset = arg_u64(args, "offset").map(|v| v as usize);
    let limit = arg_u64(args, "limit").map(|v| v as usize);
    let target = resolve_path(root, scratch, path);
    // Fail closed: a component swapped to a symlink after the gate validated
    // the path must not redirect the open out of the workspace.
    if symlink_escapes_any_root(root, scratch, read_roots, &target) {
        return (
            format!("ERROR: refused to read through a symlink out of the workspace: {path}"),
            None,
        );
    }

    let bytes = match tokio::fs::read(&target).await {
        Ok(b) => b,
        Err(e) => return (format!("ERROR: {e}"), None),
    };

    // An image file is returned as an OpenAI `image_url` content part rather
    // than text: the model cannot see a raster through a base64 string. Only a
    // plain read (no offset/limit) does this, since slicing an image makes no
    // sense and offset/limit still refers to text lines.
    if offset.is_none() && limit.is_none() && bytes.len() <= MAX_IMAGE_BYTES {
        if let Some(mime) = crate::tools::image::detect(&target) {
            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            let name = target
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("image")
                .to_string();
            let note = format!("Read image {name} ({mime}, {} bytes)", bytes.len());
            let image = ImageContentPart {
                data_url: format!("data:{mime};base64,{b64}"),
                name,
            };
            return (note, Some(vec![image]));
        }
    }

    let content = match String::from_utf8(bytes) {
        Ok(c) => c,
        Err(_) => return ("ERROR: not a UTF-8 text file".to_string(), None),
    };

    let selected = if offset.is_some() || limit.is_some() {
        let lines: Vec<&str> = content.split('\n').collect();
        let start = offset.map(|o| o.saturating_sub(1)).unwrap_or(0);
        if start >= lines.len() {
            return (
                format!(
                    "ERROR: offset {} is beyond end of file ({} lines total)",
                    offset.unwrap_or(1),
                    lines.len()
                ),
                None,
            );
        }
        let end = match limit {
            Some(l) => (start + l).min(lines.len()),
            None => lines.len(),
        };
        lines[start..end].join("\n")
    } else {
        content
    };

    (
        cap_output(
            &selected,
            MAX_LINES,
            MAX_BYTES,
            "\n[truncated: use offset/limit to read more]",
        ),
        None,
    )
}

async fn ls(
    args: &serde_json::Value,
    root: &Path,
    scratch: Option<&Path>,
    hide_jan: bool,
    read_roots: &[PathBuf],
) -> String {
    let path = arg_str(args, "path").unwrap_or(".");
    let limit = arg_u64(args, "limit")
        .map(|v| v as usize)
        .unwrap_or(LS_DEFAULT_LIMIT);
    let target = resolve_path(root, scratch, path);
    // Names are content too: a symlinked directory would list a host directory.
    if symlink_escapes_any_root(root, scratch, read_roots, &target) {
        return format!("ERROR: refused to list through a symlink out of the workspace: {path}");
    }
    let mut entries = match tokio::fs::read_dir(&target).await {
        Ok(rd) => rd,
        Err(e) => return format!("ERROR: {e}"),
    };
    let mut names: Vec<String> = Vec::new();
    loop {
        match entries.next_entry().await {
            Ok(Some(entry)) => {
                // Hidden state is omitted, not reported-then-denied: an entry the
                // agent can never open is only an invitation to try. Skipped when
                // not hiding, so an unconfined CLI run sees its own `.jan`.
                if hide_jan && is_hidden_jan_path(root, &entry.path().to_string_lossy()) {
                    continue;
                }
                let mut name = entry.file_name().to_string_lossy().into_owned();
                if entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false) {
                    name.push('/');
                }
                names.push(name);
            }
            Ok(None) => break,
            Err(e) => return format!("ERROR: {e}"),
        }
    }
    names.sort_by_key(|n| n.to_lowercase());
    let entry_limited = names.len() > limit;
    names.truncate(limit);
    let mut joined = names.join("\n");
    if entry_limited {
        joined.push_str(&format!("\n[truncated: {limit} entry limit]"));
    }
    cap_output(&joined, usize::MAX, MAX_BYTES, "\n[truncated: 64KB limit]")
}

async fn write(
    args: &serde_json::Value,
    root: &Path,
    scratch: Option<&Path>,
    confine: bool,
    write_roots: &[PathBuf],
) -> String {
    let Some(path) = arg_str(args, "path") else {
        return "ERROR: missing required argument 'path'".to_string();
    };
    let Some(content) = arg_str(args, "content") else {
        return "ERROR: missing required argument 'content'".to_string();
    };
    // Defense in depth: when the caller confines writes, re-canonicalize on the
    // canonical root (not the raw argument) so `..` and absolute paths are
    // caught even if the gate's decision was made against a stale view.
    let target = resolve_path(root, scratch, path);
    if confine && escapes_write_roots(root, scratch, write_roots, path).unwrap_or(true) {
        return format!("ERROR: refused to write outside the agent workspace: {path}");
    }
    // Report the resolved location, not the raw argument: an absolute or `../`
    // path lands outside the project and the model must see where it went.
    let shown = display_path(root, scratch, &target);
    // Re-validate before `create_dir_all`, not just before the write: a
    // concurrent sandboxed process can swap a path component between the gate
    // decision and this call, and creating the parents first would already have
    // made directories through the swapped link. Fail closed.
    if symlink_escapes_root(root, scratch, &target) {
        return format!("ERROR: refused to write through a symlink out of the workspace: {path}");
    }
    if let Some(parent) = target.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            return format!("ERROR: {shown}: {e}");
        }
    }
    // Existence decides created/overwrote; a non-UTF8 file still exists, so it
    // must not be read_to_string's error path that answers that question.
    let existed = tokio::fs::try_exists(&target).await.unwrap_or(false);
    let unchanged = existed
        && tokio::fs::read_to_string(&target)
            .await
            .is_ok_and(|prior| prior == content);
    let bytes = content.len();
    match tokio::fs::write(&target, content).await {
        Ok(()) if unchanged => format!("No change: {shown} already had these {bytes} bytes"),
        Ok(()) if existed => format!("Overwrote {shown} ({bytes} bytes)"),
        Ok(()) => format!("Created {shown} ({bytes} bytes)"),
        Err(e) => format!("ERROR: {shown}: {e}"),
    }
}

async fn edit(
    args: &serde_json::Value,
    root: &Path,
    scratch: Option<&Path>,
    confine: bool,
    write_roots: &[PathBuf],
) -> String {
    let Some(path) = arg_str(args, "path") else {
        return "ERROR: missing required argument 'path'".to_string();
    };
    let Some(edits) = args.get("edits").and_then(|v| v.as_array()) else {
        return "ERROR: missing required argument 'edits'".to_string();
    };
    if edits.is_empty() {
        return "ERROR: edits must contain at least one replacement".to_string();
    }
    let target = resolve_path(root, scratch, path);
    if confine && escapes_write_roots(root, scratch, write_roots, path).unwrap_or(true) {
        return format!("ERROR: refused to edit outside the agent workspace: {path}");
    }
    let shown = display_path(root, scratch, &target);
    // Re-validate before the final read+write pair so a swapped symlink cannot
    // redirect either the read or the later write.
    if symlink_escapes_root(root, scratch, &target) {
        return format!("ERROR: refused to edit through a symlink out of the workspace: {path}");
    }
    let content = match tokio::fs::read_to_string(&target).await {
        Ok(c) => c,
        Err(e) => return format!("ERROR: {shown}: {e}"),
    };
    let content = match apply_edits(&content, edits, &shown) {
        Ok(content) => content,
        Err(message) => return message,
    };

    match tokio::fs::write(&target, content).await {
        Ok(()) => format!("Applied {} edit(s) to {shown}", edits.len()),
        Err(e) => format!("ERROR: {shown}: {e}"),
    }
}

/// `path` made absolute against this process's working directory, with `.`
/// and `..` resolved lexically. Nothing has to exist yet.
fn anchored(path: &Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_path_buf();
    }
    match std::env::current_dir() {
        Ok(cwd) => lexical_normalize(&cwd.join(path)),
        Err(_) => path.to_path_buf(),
    }
}

async fn bash(args: &serde_json::Value, ctx: &ToolContext<'_>) -> String {
    let owner = ctx.job_owner;
    let Some(command) = arg_str(args, "command").filter(|command| !command.trim().is_empty())
    else {
        let action = arg_str(args, "action").map(str::trim).unwrap_or("");
        let job_id = arg_str(args, "job_id").map(str::trim).filter(|id| !id.is_empty());
        return match (action, job_id) {
            ("" | "await", Some(job_id)) => {
                let out = await_bash_job(job_id, owner).await;
                // AH-102: how it ended, on the record, so a listing after a
                // restart says what became of it.
                end_job_record(
                    ctx,
                    owner,
                    job_id,
                    match exit_code_of(&out) {
                        Some(0) | None => crate::job_record::JobState::Completed,
                        Some(_) => crate::job_record::JobState::Failed,
                    },
                    exit_code_of(&out),
                    "",
                );
                out
            }
            ("status", Some(job_id)) => bash_job_status_text(job_id, owner),
            ("cancel", Some(job_id)) => {
                let out = bash_job_cancel_text(job_id, owner);
                if out.starts_with("Stopped job") {
                    end_job_record(
                        ctx,
                        owner,
                        job_id,
                        crate::job_record::JobState::Cancelled,
                        None,
                        "stopped on request, with every process it started",
                    );
                }
                out
            }
            ("list", _) => bash_job_list_text(owner),
            (other, _) if !other.is_empty() && !matches!(other, "await" | "status" | "cancel") => {
                format!(
                    "ERROR: unknown action '{other}'. Use \"list\", or \"await\", \"status\" or \
                     \"cancel\" with a job_id."
                )
            }
            _ => "ERROR: missing required argument 'command' (or 'job_id' to collect a \
                  backgrounded job, or {\"action\": \"list\"})"
                .to_string(),
        };
    };
    // Opt-in: a command that outlives its deadline is terminated unless the
    // caller explicitly asked for it to keep running and be polled by job_id.
    let background = arg_bool(args, "background");
    // A command the caller *asked* to run in the background is backgrounded
    // straight away rather than after an arbitrary wait. A timeout given with
    // it still means "wait this long first".
    let timeout_secs = arg_u64(args, "timeout").unwrap_or(if background {
        0
    } else {
        DEFAULT_BASH_TIMEOUT_SECS
    });

    // Every path the sandbox is given is made absolute first. The confined
    // helper runs with its working directory set to the workspace, so a
    // relative path means somewhere else by the time the helper reads it, and
    // Jan's data folder defaults to the relative `./data`. The shell then
    // failed in the helper's setup ("workspace does not exist") on every
    // command, even with a sandbox that works.
    let root_abs = anchored(ctx.project_root);
    let root = root_abs.as_path();
    let mask_abs = ctx.mask_root.map(anchored);
    let scratch_abs = ctx.scratch_root.map(anchored);
    let read_abs: Vec<PathBuf> = ctx.read_roots.iter().map(|p| anchored(p)).collect();
    let write_abs: Vec<PathBuf> = ctx.write_roots.iter().map(|p| anchored(p)).collect();
    if !root.is_dir() {
        return format!(
            "ERROR: working directory does not exist: {}",
            root.display()
        );
    }

    let mut policy =
        jail::Policy::new(root, ctx.allow_network).with_home_readonly(ctx.home_readonly);
    // While the shell is sandboxed, hide the project's own `.jan` state directory
    // from it (see [`Policy::with_hide_root`]). When the shell runs unconfined the
    // hide is both pointless (there is no OS mount to layer it on) and wrong
    // (the agent should see its own state), so it is only applied when sandboxed.
    if ctx.sandbox {
        policy = policy.with_hide_root(&root.join(crate::tools::sandbox::JAN_DIR));
    }
    if let Some(mask) = mask_abs.as_deref() {
        policy = policy.with_mask_root(mask);
    }
    if let Some(scratch) = scratch_abs.as_deref() {
        policy = policy.with_scratch_root(scratch);
    }
    if !read_abs.is_empty() {
        policy = policy.with_read_roots(read_abs.clone());
    }
    // The same roots the file tools were granted. Refused outright where the
    // backend cannot confine a shell to them, so `bash` is never the loose end
    // that makes an access mode untrue: on such a platform the run keeps its
    // sandbox-only shell and the mode is not offered in the first place.
    // On AppContainer that means Jan-owned worktrees only: see
    // [`jail::can_confine_write_roots`].
    let owned = mask_abs.as_deref().map(crate::workspace::worktrees_dir);
    if !write_abs.is_empty()
        && jail::can_confine_write_roots(jail::backend(), &write_abs, owned.as_deref())
    {
        policy = policy.with_write_roots(write_abs.clone());
    }
    // With the sandbox off the shell is spawned bare, the way the user's own
    // terminal would: no wrapper, no policy, the real `$HOME` and `/tmp`. Only
    // a surface that opted in gets here (the CLI's `--sandbox`/`sandbox`
    // setting); the desktop never does, so `bash` there is still confined or
    // withheld. `policy` is still built either way -- it is what
    // `denial_hint` reads, and an unconfined command can still hit a plain
    // filesystem permission error worth explaining.
    let shell = if ctx.sandbox {
        // Which shell can be confined is decided by probing, not by assuming.
        // A shell that starts fine on its own can still fail inside the
        // sandbox: on Windows, Git Bash is built on the MSYS2 runtime, which
        // cannot initialise inside an AppContainer however it was installed.
        // No confinement available means no shell either: running unsandboxed
        // would give the command the whole machine, which is never what the
        // caller asked for.
        let selected = match jail::select_shell(&policy) {
            Ok(selected) => selected,
            Err(detail) => {
                return format!(
                    "ERROR: bash is unavailable because no shell could be started in a                      sandbox on this system. Use the read/ls/find/grep tools instead.
{detail}"
                )
            }
        };
        // A command written for bash is refused rather than handed to PowerShell
        // or cmd, which would not fail cleanly: `cmd` given `foo $(bar)` runs
        // something, just not what was asked for.
        if selected.report.cfg.flavor != proc::ShellFlavor::Posix {
            if let Some(construct) = proc::requires_posix_shell(command) {
                return proc::posix_unavailable_error(
                    construct,
                    &selected.report.cfg,
                    selected
                        .posix_rejected
                        .as_deref()
                        .unwrap_or("no POSIX shell could be started in the sandbox"),
                );
            }
        }
        selected.wrapped
    } else {
        proc::shell().clone()
    };

    let sandbox_tmp = if ctx.sandbox {
        jail::scratch_env_path(jail::backend(), &policy)
    } else {
        None
    };
    let child = match proc::spawn(&shell, command, root, sandbox_tmp.as_deref()).await {
        Ok(c) => c,
        Err(e) => return format!("ERROR: failed to run command: {e}"),
    };
    let pid = child.id();
    // AH-174: measured from here to exit, as a process tree, and kept against
    // the run and call that started it. A measurement that cannot start is
    // recorded as such, never as zero.
    let meter = match pid {
        Some(pid) => crate::resources::Meter::attach(pid),
        None => Err("the command exited before it could be measured".to_string()),
    };
    let measured_run = ctx.run_id.map(str::to_string);
    let measured_call = ctx.call_id.map(str::to_string);
    // Captured before the command is moved into its task, so a job's elapsed
    // time counts from the spawn rather than from the timeout that shelved it.
    let job_started = std::time::Instant::now();

    // The child is handed to a detached task immediately so it keeps running
    // (and its output keeps being collected) no matter what the race below
    // does; only the *receiver* end is at risk of being dropped on timeout.
    // The child's pid stays registered until the task ends so a shutdown can
    // reap its whole process tree if it is still running.
    let (tx, mut rx) = oneshot::channel();
    let spill_scratch = ctx.scratch_root.map(Path::to_path_buf);
    // Cloned into the detached task, which is what keeps a backgrounded command
    // reporting after this call has already returned its `job_id`. Every chunk
    // also lands in a bounded tail, which is what a status check shows while
    // the command is still running.
    let tail = std::sync::Arc::new(Mutex::new(LiveTail::default()));
    let sink: Option<crate::tools::OutputSink> = {
        let tail = tail.clone();
        let live = ctx.on_output.clone();
        Some(std::sync::Arc::new(move |chunk: String| {
            if let Ok(mut t) = tail.lock() {
                t.push(&chunk);
            }
            if let Some(live) = live.as_ref() {
                live(chunk);
            }
        }))
    };
    let sandboxed = ctx.sandbox;
    // The model writes POSIX commands by default, which `cmd` rejects. Surface
    // the resolved shell so it can adapt when the only shell on a Windows box
    // is cmd, instead of the tool silently presenting cmd as bash.
    let shell_description = shell.description;
    tokio::spawn(async move {
        let mut out = collect_and_format(child, spill_scratch, sink).await;
        // The tree has exited (or been stopped): what it used is final.
        let used = match &meter {
            Ok(meter) => meter.read(),
            Err(reason) => crate::resources::Resources::unmeasured(reason.clone()),
        };
        drop(meter);
        crate::resources::record(measured_run.as_deref(), measured_call.as_deref(), used);
        // Appended inside the task so a backgrounded job carries the hint too.
        // `Permission denied` on its own tells the model nothing about *why*;
        // without this it retries the same command until it gives up. Only when
        // confined: unsandboxed, a denial is an ordinary filesystem permission
        // and the hint would name limits that are not in force.
        if sandboxed && bash_result_failed(&out) && jail::looks_denied(&out) {
            out.push_str(&jail::denial_hint(&policy));
        }
        if shell_description == "cmd" {
            out.insert_str(
                0,
                "[shell: cmd.exe - no bash is installed. Write commands in cmd syntax \
                 (e.g. `dir`, `type`, `set`, `mkdir`, `%VAR%` for variables), not \
                 POSIX/bash. Alternatively install git-bash and this tool will use it.]\n",
            );
        }
        if let Some(pid) = pid {
            proc::unregister(pid);
        }
        let _ = tx.send(out);
    });

    tokio::select! {
        res = &mut rx => res.unwrap_or_else(|_| "ERROR: background command ended without producing output".to_string()),
        _ = deadline(root, timeout_secs) => {
            // AH-020. A timeout used to *background* the command: it kept
            // running, unowned, after the call that started it had returned,
            // so "the timeout expired" and "the work stopped" were different
            // events and a runaway command outlived every limit placed on it.
            // The timeout now terminates the process tree it owns.
            //
            // Backgrounding is still available, but only when the caller asks
            // for it -- see the `background` argument below. A command the
            // model did not ask to background does not get to survive its
            // deadline.
            if background && !make_room_for(owner) {
                // Every job this conversation holds is still running. Refused
                // rather than let the registry grow without bound -- and the
                // command is stopped, since nothing would own it.
                let stopped = match pid {
                    Some(pid) => proc::kill_tree(pid).stopped(),
                    None => true,
                };
                return format!(
                    "ERROR: this conversation already has {MAX_JOBS_PER_OWNER} background commands \
                     running, so this one was not backgrounded and was stopped{}. Collect or \
                     cancel one first ({{\"action\": \"list\"}} shows them).",
                    if stopped { "" } else { " (the process tree may not have terminated cleanly)" }
                );
            }
            if background {
                let job_id = format!(
                    "bash-{}-{}",
                    job_id_prefix(),
                    BASH_JOB_COUNTER.fetch_add(1, Ordering::SeqCst)
                );
                // AH-101/AH-102: a durable record, so a job that outlives the
                // app is still a job somebody has a record of -- and one whose
                // process is gone is honestly interrupted rather than
                // eternally "running". Best effort: the note must never fail
                // the job it describes.
                if let (Some(data), Some(owner)) = (ctx.job_record_to, owner) {
                    let identity = crate::job_record::ProcessIdentity {
                        pid: pid.unwrap_or(0),
                        created: pid.and_then(crate::job_record::creation_time_of).unwrap_or(0),
                    };
                    let record =
                        crate::job_record::JobRecord::started(&job_id, owner, command, identity);
                    // Dropped quietly on failure: the record is a witness, and
                    // losing one must not fail the job it describes.
                    let _ = crate::job_record::save(data, &record);
                }
                bash_jobs().lock().unwrap().insert(
                    job_id.clone(),
                    BashJob {
                        rx: Some(rx),
                        output: None,
                        command: command.to_string(),
                        started: job_started,
                        call_id: ctx.call_id.map(str::to_string),
                        pid,
                        collecting: false,
                        owner: owner.map(str::to_string),
                        started_at_ms: now_ms().saturating_sub(job_started.elapsed().as_millis() as u64),
                        finished_at_ms: None,
                        stopped_by_request: false,
                        tail,
                    },
                );
                // Both forms end in the same fixed sentence, which is what the
                // desktop reads the job id from (`backgroundJobId`).
                let waited = if timeout_secs == 0 {
                    "Command was started as a background job and".to_string()
                } else {
                    format!("Command exceeded {timeout_secs}s and")
                };
                return format!(
                    "{waited} is continuing in the background \
                     (job_id={job_id}). Call bash again with {{\"job_id\": \"{job_id}\"}} (no \
                     command) to wait for and collect its output once it finishes, \
                     {{\"job_id\": \"{job_id}\", \"action\": \"status\"}} to check on it without \
                     waiting, or {{\"job_id\": \"{job_id}\", \"action\": \"cancel\"}} to stop it."
                );
            }

            let killed = match pid {
                Some(pid) => proc::kill_tree(pid),
                // No pid means the child never started; nothing is left running.
                None => proc::KillOutcome::Gone,
            };
            // Whatever the command managed to print is still worth having, and
            // the collector flushes it once the child is gone. Bounded, so a
            // process that ignores the kill cannot hold the call open.
            let partial = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                &mut rx,
            )
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or_default();

            let mut out = format!(
                "ERROR: command timed out after {timeout_secs}s and was terminated. \
                 This is a timeout, not a cancellation: the command was still running \
                 when its deadline passed. Re-run it with a larger {{\"timeout\": N}}, \
                 or with {{\"background\": true}} to let it continue and poll it by \
                 job_id."
            );
            if !killed.stopped() {
                // Fail loudly rather than claim a clean stop we did not achieve.
                out.push_str(
                    "\n[warning: the process tree may not have terminated cleanly]",
                );
            }
            if !partial.trim().is_empty() {
                out.push_str("\n--- output before the timeout ---\n");
                out.push_str(&partial);
            }
            out
        }
    }
}

/// A job's state, for the model, without waiting and without collecting.
fn bash_job_status_text(job_id: &str, owner: Option<&str>) -> String {
    let Some(status) = inspect_bash_job(job_id, owner) else {
        return format!("ERROR: unknown or already-collected job_id '{job_id}'");
    };
    let state = if !status.finished {
        "running".to_string()
    } else if status.stopped_by_request {
        "stopped (cancelled)".to_string()
    } else {
        match (status.exit_code, status.signalled) {
            (Some(code), _) => format!("finished (exit {code})"),
            (None, true) => "finished (terminated by signal)".to_string(),
            (None, false) => "finished".to_string(),
        }
    };
    let mut out = format!(
        "job_id={job_id} state={state} elapsed={}s\ncommand: {}",
        status.elapsed_ms / 1000,
        status.command
    );
    if let Some((tail, dropped)) = peek_tail(job_id, owner) {
        if !tail.trim().is_empty() {
            let note = if dropped > 0 {
                format!(" (last {} bytes; {dropped} earlier bytes not shown)", tail.len())
            } else {
                String::new()
            };
            out.push_str(&format!("\n--- recent output{note} ---\n{tail}"));
        }
    }
    if status.finished {
        out.push_str(&format!(
            "\nIts full output is waiting: call bash with {{\"job_id\": \"{job_id}\"}} to collect it."
        ));
    }
    out
}

/// Close a job's durable record, if this surface keeps one.
///
/// Only a record this owner already has is touched: an ending for a job that
/// was never written down, or that belongs to another conversation, writes
/// nothing rather than inventing history.
fn end_job_record(
    ctx: &ToolContext<'_>,
    owner: Option<&str>,
    job_id: &str,
    state: crate::job_record::JobState,
    exit_code: Option<i32>,
    note: &str,
) {
    let (Some(data), Some(owner)) = (ctx.job_record_to, owner) else {
        return;
    };
    let Some(mut record) = crate::job_record::read_owner(data, owner)
        .into_iter()
        .find(|r| r.id == job_id)
    else {
        return;
    };
    if record.state.is_ended() {
        return;
    }
    record.state = state;
    record.exit_code = exit_code;
    record.ended_at_ms = Some(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    );
    if !note.is_empty() {
        record.note = note.to_string();
    }
    // Nothing may act on the process afterwards.
    record.identity = crate::job_record::ProcessIdentity::default();
    let _ = crate::job_record::save(data, &record);
}

/// Stop a job on the model's behalf, and say exactly what happened.
fn bash_job_cancel_text(job_id: &str, owner: Option<&str>) -> String {
    let killed = kill_bash_job(job_id, owner);
    match killed.outcome {
        BashJobKillOutcome::Killed => format!(
            "Stopped job {job_id} and every process it started. Call bash with \
             {{\"job_id\": \"{job_id}\"}} to collect what it printed before it stopped."
        ),
        BashJobKillOutcome::AlreadyFinished => format!(
            "Job {job_id} had already finished; nothing was stopped. Its output is still \
             collectable."
        ),
        BashJobKillOutcome::Unknown => {
            format!("ERROR: unknown or already-collected job_id '{job_id}'")
        }
        BashJobKillOutcome::NoPid => format!(
            "ERROR: job {job_id} has no process to stop (it never reported one); nothing was \
             signalled."
        ),
        BashJobKillOutcome::Failed => format!(
            "ERROR: could not stop job {job_id}: {}. It is still running; try again.",
            killed.error.unwrap_or_default()
        ),
    }
}

/// This conversation's background commands, for the model.
fn bash_job_list_text(owner: Option<&str>) -> String {
    let jobs = list_bash_jobs(owner);
    if jobs.is_empty() {
        return "No background commands.".to_string();
    }
    let mut out = String::from("Background commands (newest first):");
    for job in jobs {
        let state = if !job.finished {
            "running".to_string()
        } else if job.stopped_by_request {
            "stopped".to_string()
        } else {
            match job.exit_code {
                Some(code) => format!("finished, exit {code}, not yet collected"),
                None => "finished, not yet collected".to_string(),
            }
        };
        out.push_str(&format!(
            "\n- {} [{state}, {}s] {}",
            job.job_id,
            job.elapsed_ms / 1000,
            job.command
        ));
    }
    out
}

/// When a foreground command's deadline passes: `timeout_secs` from now.
///
/// A test can stand in its own moment for a project root (see
/// [`test_deadline`]), so a deadline test is decided by the event it is about
/// -- the command having printed -- rather than by how fast a sandboxed shell
/// happened to start on a busy machine.
#[cfg_attr(not(test), allow(unused_variables))]
async fn deadline(root: &Path, timeout_secs: u64) {
    #[cfg(test)]
    {
        let injected = test_deadlines().lock().unwrap().get(root).cloned();
        if let Some(fire) = injected {
            fire.notified().await;
            return;
        }
    }
    tokio::time::sleep(std::time::Duration::from_secs(timeout_secs)).await
}

#[cfg(test)]
fn test_deadlines(
) -> &'static Mutex<HashMap<PathBuf, std::sync::Arc<tokio::sync::Notify>>> {
    static DEADLINES: std::sync::OnceLock<
        Mutex<HashMap<PathBuf, std::sync::Arc<tokio::sync::Notify>>>,
    > = std::sync::OnceLock::new();
    DEADLINES.get_or_init(Default::default)
}

/// Replace the deadline of every `bash` call made in `root` with the returned
/// trigger. Keyed by root, which every test owns alone, so parallel tests keep
/// their real deadlines.
#[cfg(test)]
pub(crate) fn test_deadline(root: &Path) -> std::sync::Arc<tokio::sync::Notify> {
    let fire = std::sync::Arc::new(tokio::sync::Notify::new());
    test_deadlines()
        .lock()
        .unwrap()
        .insert(root.to_path_buf(), fire.clone());
    fire
}

/// Wait for a previously backgrounded command to finish and return its
/// (already-formatted) output, or an error if `job_id` is unknown, was
/// already collected, or belongs to another conversation.
async fn await_bash_job(job_id: &str, owner: Option<&str>) -> String {
    // The receiver is taken, but the entry is left behind: for however long
    // this command still runs, it must stay listable and killable. Removed
    // only once it has actually produced its output.
    enum Collect {
        Parked(String),
        Awaiting(oneshot::Receiver<String>),
        Drained,
        Unknown,
    }

    let taken = {
        let mut jobs = bash_jobs().lock().unwrap();
        match jobs.get_mut(job_id) {
            None => Collect::Unknown,
            // Another conversation's job: the same answer as no job at all.
            Some(job) if job.owner.as_deref() != owner => Collect::Unknown,
            Some(job) => {
                if let Some(done) = job.output.take() {
                    Collect::Parked(done)
                } else if let Some(rx) = job.rx.take() {
                    job.collecting = true;
                    Collect::Awaiting(rx)
                } else {
                    Collect::Drained
                }
            }
        }
    };

    let result = match taken {
        // A status check already received the output; hand over what it parked.
        Collect::Parked(done) => done,
        Collect::Awaiting(rx) => rx.await.unwrap_or_else(|_| {
            "ERROR: background command ended without producing output".to_string()
        }),
        Collect::Drained => "ERROR: background command ended without producing output".to_string(),
        Collect::Unknown => {
            return format!("ERROR: unknown or already-collected job_id '{job_id}'")
        }
    };
    bash_jobs().lock().unwrap().remove(job_id);
    result
}

/// Drain a running child's stdout+stderr into a bounded rolling buffer (so a
/// runaway command cannot exhaust memory), then format the result. Output is
/// combined chronologically and spilled to a temp file once it outgrows the
/// in-memory window, so the full text stays readable even though only a bounded
/// tail is kept in RAM.
async fn collect_and_format(
    mut child: tokio::process::Child,
    scratch: Option<PathBuf>,
    sink: Option<crate::tools::OutputSink>,
) -> String {
    use tokio::io::AsyncReadExt;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let mut cap = BashCapture::new(scratch);
    let mut bo = vec![0u8; 8192];
    let mut be = vec![0u8; 8192];
    let mut out_open = stdout.is_some();
    let mut err_open = stderr.is_some();
    // A read boundary can land mid-character, so decoding each chunk on its own
    // would emit a replacement character for any multi-byte sequence unlucky
    // enough to straddle one. Hold the incomplete tail back for the next chunk.
    let mut carry: Vec<u8> = Vec::new();
    let tee = |bytes: &[u8], carry: &mut Vec<u8>| {
        let Some(sink) = sink.as_ref() else { return };
        carry.extend_from_slice(bytes);
        let text = match std::str::from_utf8(carry) {
            Ok(_) => std::mem::take(carry),
            // Everything before the first bad byte is complete; the rest is
            // either a split character or genuinely invalid, and waiting one
            // more chunk tells us which.
            Err(e) => carry.drain(..e.valid_up_to()).collect(),
        };
        if !text.is_empty() {
            sink(String::from_utf8_lossy(&text).into_owned());
        }
    };
    while out_open || err_open {
        tokio::select! {
            r = stdout.as_mut().unwrap().read(&mut bo), if out_open => match r {
                Ok(0) | Err(_) => out_open = false,
                Ok(n) => { cap.push(&bo[..n]); tee(&bo[..n], &mut carry); }
            },
            r = stderr.as_mut().unwrap().read(&mut be), if err_open => match r {
                Ok(0) | Err(_) => err_open = false,
                Ok(n) => { cap.push(&be[..n]); tee(&be[..n], &mut carry); }
            },
        }
    }
    // Whatever is left was never completed: emit it lossily rather than losing it.
    if !carry.is_empty() {
        if let Some(sink) = sink.as_ref() {
            sink(String::from_utf8_lossy(&carry).into_owned());
        }
    }
    match child.wait().await {
        Ok(status) => cap.finish(status.code()),
        Err(e) => format!("ERROR: failed to run command: {e}"),
    }
}

/// Bounded, tail-preserving accumulator for a command's combined output.
/// Keeps only the last [`BASH_MAX_BYTES`] raw bytes in memory; once total
/// output exceeds that window it spills every byte to a temp file so nothing
/// is lost while memory stays bounded.
struct BashCapture {
    tail: std::collections::VecDeque<u8>,
    total_bytes: usize,
    total_newlines: usize,
    spill: Option<std::io::BufWriter<std::fs::File>>,
    spill_path: Option<PathBuf>,
    scratch: Option<PathBuf>,
}

impl BashCapture {
    fn new(scratch: Option<PathBuf>) -> Self {
        BashCapture {
            tail: std::collections::VecDeque::new(),
            total_bytes: 0,
            total_newlines: 0,
            spill: None,
            spill_path: None,
            scratch,
        }
    }

    fn push(&mut self, chunk: &[u8]) {
        use std::io::Write;
        // Open the spill file the moment the window would overflow: at that
        // point `tail` still holds every byte seen so far (nothing dropped
        // yet), so dumping it captures the full prefix before we start
        // dropping from the front.
        if self.spill.is_none() && self.tail.len() + chunk.len() > BASH_MAX_BYTES {
            if let Some(path) = new_temp_path(self.scratch.as_deref()) {
                if let Ok(file) = open_spill_file(&path) {
                    let mut w = std::io::BufWriter::new(file);
                    let (a, b) = self.tail.as_slices();
                    let _ = w.write_all(a);
                    let _ = w.write_all(b);
                    self.spill = Some(w);
                    self.spill_path = Some(path);
                }
            }
        }
        if let Some(w) = self.spill.as_mut() {
            let _ = w.write_all(chunk);
        }
        self.total_bytes += chunk.len();
        self.total_newlines += bytecount_newlines(chunk);
        self.tail.extend(chunk.iter().copied());
        while self.tail.len() > BASH_MAX_BYTES {
            self.tail.pop_front();
        }
    }

    fn finish(mut self, code: Option<i32>) -> String {
        use std::io::Write;
        if let Some(w) = self.spill.as_mut() {
            let _ = w.flush();
        }
        let retained = String::from_utf8_lossy(self.tail.make_contiguous()).into_owned();
        let collapsed = sanitize_control(&collapse_carriage_returns(&retained));
        let capped = tail_cap(&collapsed, BASH_MAX_LINES, BASH_MAX_BYTES);
        let shown_lines = capped.matches('\n').count();
        // Truncated when the model-facing output lost real lines (front dropped)
        // or bytes (tail cap). CR-only progress redraws collapse to a single
        // line, so they read as complete rather than truncated.
        let truncated = self.total_newlines > shown_lines || capped.len() < collapsed.len();

        // Always emit an explicit exit marker on its own line. A bare exit code
        // (including 0) is the only reliable success signal: commands like
        // `git push` write their normal status to stderr on success, so stderr
        // text must not be read as failure.
        let mut body = capped;
        if !body.is_empty() && !body.ends_with('\n') {
            body.push('\n');
        }
        match code {
            Some(code) => body.push_str(&format!("[exit {code}]")),
            None => body.push_str("[terminated by signal]"),
        }

        if !truncated {
            if let Some(p) = self.spill_path.take() {
                remove_spill_file(&p);
            }
            return body;
        }

        let path = match self.spill_path.take() {
            Some(p) => Some(p),
            None => write_temp_output(&collapsed, self.scratch.as_deref()),
        }
        .map(|p| crate::tools::sandbox::scratch_display_path(self.scratch.as_deref(), &p));
        match path {
            Some(p) => format!(
                "{body}\n[output truncated at {} of {} bytes; full output written \
                 to {p}. Use the read tool (with offset/limit) on that path to see \
                 the rest]",
                body.len(),
                self.total_bytes,
            ),
            None => format!(
                "{body}\n[output truncated at {} of {} bytes]",
                body.len(),
                self.total_bytes,
            ),
        }
    }
}

/// True when a `bash` tool result reports failure via its exit marker: a
/// non-zero `[exit N]` or a signal termination. The marker is emitted by
/// [`BashCapture::finish`] on its own line and a truncation note may follow it,
/// so scan every line rather than only the tail. Model-facing content is
/// deliberately left unprefixed (a non-zero exit is not an "ERROR" string, since
/// commands like `grep`/`diff`/`test` exit non-zero without failing); this feeds
/// the display-only `is_error` flag so the TUI marks the call failed.
pub fn bash_result_failed(content: &str) -> bool {
    content.lines().any(|line| {
        let l = line.trim();
        if l == "[terminated by signal]" {
            return true;
        }
        l.strip_prefix("[exit ")
            .and_then(|r| r.strip_suffix(']'))
            .and_then(|n| n.parse::<i32>().ok())
            .is_some_and(|code| code != 0)
    })
}

impl Drop for BashCapture {
    /// Reclaim the spill file on any path that drops the capture without
    /// consuming it via `finish` (e.g. `child.wait()` erroring). `finish`
    /// clears `spill_path` for files it keeps or deletes itself, so this only
    /// fires on the leak paths.
    fn drop(&mut self) {
        if let Some(p) = self.spill_path.take() {
            remove_spill_file(&p);
        }
    }
}

fn bytecount_newlines(bytes: &[u8]) -> usize {
    bytes.iter().filter(|&&b| b == b'\n').count()
}

/// Drop control characters that would corrupt the model's view of the output
/// (NUL, bell, ANSI escapes, etc.), keeping only tab and newline. Carriage
/// returns are already resolved by [`collapse_carriage_returns`] beforehand.
fn sanitize_control(s: &str) -> String {
    if !s.chars().any(|c| c.is_control() && c != '\t' && c != '\n') {
        return s.to_string();
    }
    s.chars()
        .filter(|&c| !c.is_control() || c == '\t' || c == '\n')
        .collect()
}

/// Keep the last `max_lines` lines and last `max_bytes` bytes of `s` (trimming
/// at a UTF-8 boundary). Unlike [`cap_output`], this preserves the *end* of the
/// output so a command's final result and error lines survive truncation.
fn tail_cap(s: &str, max_lines: usize, max_bytes: usize) -> String {
    let lines: Vec<&str> = s.split_inclusive('\n').collect();
    let kept = if lines.len() > max_lines {
        &lines[lines.len() - max_lines..]
    } else {
        &lines[..]
    };
    let mut out: String = kept.concat();
    if out.len() > max_bytes {
        let mut cut = out.len() - max_bytes;
        while cut < out.len() && !out.is_char_boundary(cut) {
            cut += 1;
        }
        out = out[cut..].to_string();
    }
    out
}

/// Directory holding bash-output spill files: inside the session scratch when
/// there is one, so the file the truncation note points at is reachable by the
/// same `/tmp/jan-bash/...` name from both the filesystem tools and the shell,
/// and is reclaimed when the session's scratch is removed.
///
/// The directory is validated as a real, non-symlink directory before use: the
/// sandboxed shell can write the scratch, so it could have redirected `jan-bash`
/// at a host directory. Refuse to spill through a redirect (returning `None`)
/// rather than write the model's bytes through an attacker-chosen path.
///
/// Deliberately not swept on first use: the files are removed individually by
/// [`BashCapture::finish`] and its `Drop`, and the host fallback is a shared
/// path, so a global purge there would delete a concurrent instance's live
/// spill files rather than only stale ones.
fn spill_dir(scratch: Option<&Path>) -> Option<PathBuf> {
    let base = scratch
        .map(Path::to_path_buf)
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join("jan-bash");
    match std::fs::symlink_metadata(&dir) {
        Ok(meta) if !meta.is_dir() => return None,
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // create_dir (not create_dir_all) refuses to follow a planted
            // symlink in the path it creates.
            let r = std::fs::create_dir(&dir);
            if let Err(e) = r {
                if e.kind() != std::io::ErrorKind::AlreadyExists {
                    return None;
                }
            }
        }
        Err(_) => return None,
    }
    // Re-verify the node is a real directory, not a symlink a concurrent
    // process swapped in between the create and this check.
    match std::fs::symlink_metadata(&dir) {
        Ok(meta) if !meta.file_type().is_symlink() && meta.is_dir() => Some(dir),
        _ => None,
    }
}

fn new_temp_path(scratch: Option<&Path>) -> Option<PathBuf> {
    let n = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
    Some(spill_dir(scratch)?.join(format!("jan-bash-{}-{}.txt", std::process::id(), n)))
}

/// Open a spill file atomically with `O_EXCL` so we never truncate or write
/// through an existing symlink the shell planted: `create_new` fails if the
/// path already exists (as a file or a symlink). Combined with the validated
/// non-symlink parent from [`spill_dir`], the model-controlled spill bytes
/// cannot be redirected onto a host file.
fn open_spill_file(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
}

/// Write `content` to a uniquely named temp file, returning its path on
/// success. Uses [`open_spill_file`] so the write never follows a symlink.
fn write_temp_output(content: &str, scratch: Option<&Path>) -> Option<PathBuf> {
    use std::io::Write;
    let path = new_temp_path(scratch)?;
    let mut file = open_spill_file(&path).ok()?;
    file.write_all(content.as_bytes()).ok()?;
    Some(path)
}

/// Remove a spill file only through a real, non-symlink parent directory. The
/// shell controls the scratch, so a redirected `jan-bash` dir must not redirect
/// our cleanup either; if it has been swapped, leave the file behind (it is
/// reclaimed with the session's scratch). `remove_file` itself unlinks a
/// symlink rather than following it, so only the parent needs re-checking.
fn remove_spill_file(path: &Path) {
    if let Some(parent) = path.parent() {
        match std::fs::symlink_metadata(parent) {
            Ok(meta) if !meta.file_type().is_symlink() && meta.is_dir() => {}
            _ => return,
        }
    }
    let _ = std::fs::remove_file(path);
}

const SCREENSHOT_MAX_PNG_BYTES: usize = 4 * 1024 * 1024; // 4 MiB

fn chrome_binary() -> Option<PathBuf> {
    if let Ok(env) = std::env::var("CHROME_PATH") {
        if !env.is_empty() {
            return Some(PathBuf::from(env));
        }
    }
    const CANDIDATES: &[&str] = &[
        // macOS (bundled browsers)
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        // Linux
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ];
    CANDIDATES
        .iter()
        .find(|p| Path::new(p).exists())
        .map(PathBuf::from)
}

/// Render a local HTML/SVG file to PNG bytes with headless Chrome.
///
/// Shared by the model-facing `screenshot` tool and the `agent_render_preview`
/// command the annotation overlay calls, so both agree on Chrome discovery,
/// viewport clamping and the output cap. `width`/`height` are the viewport in
/// CSS pixels; the caller picks them (the overlay passes its own stage size so
/// the PNG lines up pixel-for-pixel with what the user drew on).
///
/// `scale` is the device pixel ratio: the PNG comes out `width*scale` pixels
/// wide with the layout unchanged. The overlay passes the webview's own ratio
/// so a HiDPI screen doesn't composite crisp marks over an upscaled blur.
pub async fn render_html_png(
    target: &Path,
    width: u64,
    height: u64,
    scale: f64,
) -> Result<Vec<u8>, String> {
    let ext = target
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if ext != "html" && ext != "htm" && ext != "svg" {
        return Err(format!(
            "screenshot only renders .html/.htm/.svg files, got .{ext}"
        ));
    }
    if !target.is_file() {
        return Err(format!("file not found: {}", target.display()));
    }

    let Some(chrome) = chrome_binary() else {
        return Err(
            "no Chrome/Chromium binary found (set CHROME_PATH to point at one)".to_string(),
        );
    };

    let width = width.clamp(320, 4096);
    let height = height.clamp(240, 4096);
    let scale = if scale.is_finite() {
        scale.clamp(1.0, 3.0)
    } else {
        1.0
    };
    // A per-call profile (pid + nanos) keeps headless Chrome from colliding
    // with a running browser or a leftover from a previous call; `--screenshot`
    // exits after writing, but the wait below is bounded in case it lingers.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let shot = std::env::temp_dir().join(format!("jan-shot-{}-{nanos}.png", std::process::id()));
    let profile = std::env::temp_dir().join(format!("jan-chrome-{}-{nanos}", std::process::id()));

    // file:// lets the page resolve relative assets against its own directory,
    // matching what the artifact preview does.
    let file_url = format!("file://{}", target.display());
    // Chrome is spawned through the shell (`sh -c`): on macOS, a Chrome
    // headless-new process spawned directly by a non-bundled parent fails its
    // singleton/TCC check with "Multiple targets are not supported in headless
    // mode", while the same invocation via the shell succeeds. The `bash` tool
    // already relies on this property, so we inherit it here.
    let profile_quoted = shell_quote(profile.to_str().unwrap_or_default());
    let shot_quoted = shell_quote(shot.to_str().unwrap_or_default());
    let url_quoted = shell_quote(&file_url);
    let chrome_quoted = shell_quote(chrome.to_str().unwrap_or_default());
    let cmd = format!(
        "{chrome_quoted} --headless=new --disable-gpu --hide-scrollbars --no-sandbox \
         --disable-dev-shm-usage --no-first-run --user-data-dir={profile_quoted} \
         --force-device-scale-factor={scale} \
         --window-size={width},{height} --screenshot={shot_quoted} {url_quoted}"
    );
    let shell = proc::shell();
    let mut child = match tokio::process::Command::new(shell.program.clone())
        .args(shell.args.clone())
        .arg(&cmd)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return Err(format!("failed to launch Chrome: {e}")),
    };
    // Bounded: headless Chrome can linger after writing the PNG. Give it a
    // generous window, then reap whatever is left and proceed if the file
    // exists. stderr is drained on a background task so a chatty Chrome never
    // fills the pipe and deadlocks.
    let stderr_pipe = child.stderr.take();
    let drain = tokio::spawn(async move {
        use tokio::io::AsyncReadExt as _;
        let mut buf = Vec::new();
        if let Some(mut pipe) = stderr_pipe {
            let _ = pipe.read_to_end(&mut buf).await;
        }
        String::from_utf8_lossy(&buf).into_owned()
    });
    let _ = tokio::time::timeout(std::time::Duration::from_secs(30), child.wait()).await;
    let _ = child.kill().await;
    let stderr = drain.await.unwrap_or_default();
    let _ = tokio::fs::remove_dir_all(&profile).await;

    let png = match tokio::fs::read(&shot).await {
        Ok(b) => b,
        Err(e) => {
            let detail = stderr.lines().take(3).collect::<Vec<_>>().join(" | ");
            return Err(format!("screenshot not produced: {e} (chrome: {detail})"));
        }
    };
    let _ = tokio::fs::remove_file(&shot).await;

    if png.is_empty() {
        return Err("Chrome produced an empty screenshot (page may be blank)".to_string());
    }
    if png.len() > SCREENSHOT_MAX_PNG_BYTES {
        return Err(format!(
            "screenshot is {} KiB, over the {}-MiB cap; try a smaller viewport",
            png.len() / 1024,
            SCREENSHOT_MAX_PNG_BYTES / 1024 / 1024
        ));
    }
    Ok(png)
}

/// Render a local HTML/SVG file and hand the model the image.
///
/// Returns an `ImageContentPart` rather than a data URL pasted into the text,
/// matching what `read` does for images: that is the form a vision model
/// actually consumes, and it keeps a megabyte of base64 out of the transcript.
async fn screenshot(
    args: &serde_json::Value,
    root: &Path,
    scratch: Option<&Path>,
    read_roots: &[PathBuf],
) -> (String, Option<Vec<ImageContentPart>>) {
    let Some(path) = arg_str(args, "path") else {
        return ("ERROR: missing required argument 'path'".to_string(), None);
    };
    let width = arg_u64(args, "width").unwrap_or(1280).clamp(320, 4096);
    let height = arg_u64(args, "height").unwrap_or(960).clamp(240, 4096);
    let target = resolve_path(root, scratch, path);
    if symlink_escapes_any_root(root, scratch, read_roots, &target) {
        return (
            format!("ERROR: refused to screenshot through a symlink out of the workspace: {path}"),
            None,
        );
    }
    let png = match render_html_png(&target, width, height, 1.0).await {
        Ok(b) => b,
        Err(e) => return (format!("ERROR: {e}"), None),
    };
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    (
        format!("Screenshot of {path} ({width}x{height})"),
        Some(vec![ImageContentPart {
            data_url: format!("data:image/png;base64,{b64}"),
            name,
        }]),
    )
}

async fn find(
    args: &serde_json::Value,
    root: &Path,
    scratch: Option<&Path>,
    hide_jan: bool,
    read_roots: &[PathBuf],
) -> String {
    let pattern = arg_str(args, "pattern").map(String::from);
    let path = arg_str(args, "path").unwrap_or(".").to_string();
    let limit = arg_u64(args, "limit")
        .map(|v| v as usize)
        .unwrap_or(FIND_DEFAULT_LIMIT);
    let base = resolve_path(root, scratch, &path);
    if symlink_escapes_any_root(root, scratch, read_roots, &base) {
        return format!("ERROR: refused to search through a symlink out of the workspace: {path}");
    }
    let root_owned = root.to_path_buf();

    let Some(pattern) = pattern else {
        return "ERROR: missing required argument 'pattern'".to_string();
    };
    let res = tokio::task::spawn_blocking(move || {
        let pat = match glob::Pattern::new(&pattern) {
            Ok(p) => p,
            Err(e) => return format!("ERROR: invalid pattern: {e}"),
        };
        let opts = glob::MatchOptions {
            case_sensitive: true,
            require_literal_separator: false,
            require_literal_leading_dot: false,
        };
        let mut matches: Vec<String> = Vec::new();
        for entry in WalkBuilder::new(&base)
            .hidden(false)
            .require_git(false)
            .build()
            .flatten()
        {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(true) {
                continue;
            }
            if hide_jan && is_hidden_jan_path(&root_owned, &entry.path().to_string_lossy()) {
                continue;
            }
            let rel = rel_to(&base, entry.path());
            if pat.matches_with(&rel, opts) {
                matches.push(rel);
                if matches.len() >= limit {
                    break;
                }
            }
        }
        if matches.is_empty() {
            "No matches.".to_string()
        } else {
            matches.join("\n")
        }
    })
    .await;
    res.unwrap_or_else(|e| format!("ERROR: {e}"))
}

async fn grep(
    args: &serde_json::Value,
    root: &Path,
    scratch: Option<&Path>,
    hide_jan: bool,
    read_roots: &[PathBuf],
) -> String {
    let pattern = arg_str(args, "pattern").map(String::from);
    let path = arg_str(args, "path").unwrap_or(".").to_string();
    let glob_filter = arg_str(args, "glob").map(String::from);
    let ignore_case = arg_bool(args, "ignore_case");
    let literal = arg_bool(args, "literal");
    let context = arg_u64(args, "context").map(|v| v as usize).unwrap_or(0);
    let limit = arg_u64(args, "limit")
        .map(|v| v as usize)
        .unwrap_or(GREP_DEFAULT_LIMIT);
    let base = resolve_path(root, scratch, &path);
    if symlink_escapes_any_root(root, scratch, read_roots, &base) {
        return format!("ERROR: refused to search through a symlink out of the workspace: {path}");
    }
    let root_owned = root.to_path_buf();
    let scratch_owned = scratch.map(Path::to_path_buf);
    // Owned for the blocking walk closure, which outlives this frame.
    let roots_owned = read_roots.to_vec();

    let Some(pattern) = pattern else {
        return "ERROR: missing required argument 'pattern'".to_string();
    };
    let res = tokio::task::spawn_blocking(move || {
        let effective = if literal {
            regex::escape(&pattern)
        } else {
            pattern.clone()
        };
        let re = match regex::RegexBuilder::new(&effective)
            .case_insensitive(ignore_case)
            .build()
        {
            Ok(r) => r,
            Err(e) => return format!("ERROR: invalid pattern: {e}"),
        };
        let glob_pat = match &glob_filter {
            Some(g) => match glob::Pattern::new(g) {
                Ok(p) => Some(p),
                Err(e) => return format!("ERROR: invalid glob: {e}"),
            },
            None => None,
        };

        let is_file = base.is_file();
        let mut matches: Vec<String> = Vec::new();
        let mut count = 0usize;

        let mut search_file = |file: &Path, rel_base: &Path| -> bool {
            if let Some(gp) = &glob_pat {
                let rel = rel_to(rel_base, file);
                if !gp.matches(&rel)
                    && !gp.matches(
                        &file
                            .file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_default(),
                    )
                {
                    return true;
                }
            }
            let content = match std::fs::read_to_string(file) {
                Ok(c) => c,
                Err(_) => return true,
            };
            let rel = rel_to(rel_base, file);
            let lines: Vec<&str> = content.lines().collect();
            for (i, line) in lines.iter().enumerate() {
                if re.is_match(line) {
                    if context > 0 {
                        let start = i.saturating_sub(context);
                        let end = (i + context + 1).min(lines.len());
                        for (j, item) in lines.iter().enumerate().take(end).skip(start) {
                            let text = truncate_line(item);
                            if j == i {
                                matches.push(format!("{rel}:{}:{text}", j + 1));
                            } else {
                                matches.push(format!("{rel}-{}-{text}", j + 1));
                            }
                        }
                    } else {
                        matches.push(format!("{rel}:{}:{}", i + 1, truncate_line(line)));
                    }
                    count += 1;
                    if count >= limit {
                        return false;
                    }
                }
            }
            true
        };

        if is_file {
            let rel_base = base.parent().unwrap_or(&base);
            search_file(&base, rel_base);
        } else {
            for entry in WalkBuilder::new(&base)
                .hidden(false)
                .require_git(false)
                .build()
                .flatten()
            {
                let Some(file_type) = entry.file_type() else {
                    continue;
                };
                if file_type.is_dir() {
                    continue;
                }
                // The walk does not descend symlinked directories, but a symlink
                // to a *file* is not a directory and would be opened and read.
                // Checked (not skipped outright) so a link that stays inside the
                // workspace -- every yarn workspace has them -- is still searched.
                if file_type.is_symlink()
                    && symlink_escapes_any_root(
                        &root_owned,
                        scratch_owned.as_deref(),
                        &roots_owned,
                        entry.path(),
                    )
                {
                    continue;
                }
                if hide_jan && is_hidden_jan_path(&root_owned, &entry.path().to_string_lossy()) {
                    continue;
                }
                if !search_file(entry.path(), &base) {
                    break;
                }
            }
        }

        if matches.is_empty() {
            "No matches.".to_string()
        } else {
            cap_output(
                &matches.join("\n"),
                usize::MAX,
                MAX_BYTES,
                "\n[truncated: 64KB limit]",
            )
        }
    })
    .await;
    res.unwrap_or_else(|e| format!("ERROR: {e}"))
}

fn truncate_line(line: &str) -> String {
    if line.chars().count() > GREP_MAX_LINE {
        let truncated: String = line.chars().take(GREP_MAX_LINE).collect();
        format!("{truncated}...")
    } else {
        line.to_string()
    }
}

#[cfg(test)]
mod bash_job_registry_tests {
    use super::*;

    fn park(job_id: &str, command: &str) -> tokio::sync::oneshot::Sender<String> {
        park_with_pid(job_id, command, None)
    }

    fn park_with_pid(
        job_id: &str,
        command: &str,
        pid: Option<u32>,
    ) -> tokio::sync::oneshot::Sender<String> {
        let (tx, rx) = oneshot::channel::<String>();
        bash_jobs().lock().unwrap().insert(
            job_id.to_string(),
            BashJob {
                rx: Some(rx),
                output: None,
                command: command.to_string(),
                started: std::time::Instant::now(),
                call_id: Some("call-1".to_string()),
                pid,
                collecting: false,
                owner: None,
                started_at_ms: now_ms(),
                finished_at_ms: None,
                stopped_by_request: false,
                tail: Default::default(),
            },
        );
        tx
    }

    /// A kill the OS refuses must not be reported as a kill, and must leave the
    /// pid in place so the request can be made again.
    ///
    /// Unix only, and not for want of trying. The test needs a pid that exists,
    /// cannot be signalled, and is safe to *attempt* -- on Unix that is pid 1.
    /// Windows has no equivalent: the processes that refuse termination are
    /// System (pid 4) and Idle (pid 0), and a test that aimed a kill at System
    /// on a developer's machine would be betting their uptime on the refusal
    /// working. The refusal path itself is covered on Windows by
    /// `proc::windows_tests::a_refusal_is_reported_as_a_failure_with_a_reason`,
    /// which classifies the OS error without aiming a kill at anything.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_refused_kill_is_reported_and_the_job_stays_killable() {
        // pid 1 is init/launchd: it exists, and an unprivileged process may not
        // signal it. That is the refusal path, exercised against the real OS
        // rather than a stub.
        let _tx = park_with_pid("bash-kill-refused", "sleep 300", Some(1));

        let first = kill_bash_job("bash-kill-refused", None);
        assert_eq!(first.outcome, BashJobKillOutcome::Failed);
        assert!(first.error.is_some(), "a refusal must say why");

        // Still killable: the pid was not surrendered.
        let second = kill_bash_job("bash-kill-refused", None);
        assert_eq!(second.outcome, BashJobKillOutcome::Failed);
        let _ = bash_jobs().lock().unwrap().remove("bash-kill-refused");
    }

    /// A pid that no longer exists is not a failure: there is nothing to kill,
    /// and the job is stopped either way.
    #[tokio::test]
    async fn killing_a_process_that_has_already_exited_counts_as_stopped() {
        let tx = park_with_pid("bash-kill-gone", "true", Some(u32::MAX - 5));
        let killed = kill_bash_job("bash-kill-gone", None);
        assert_eq!(killed.outcome, BashJobKillOutcome::Killed);
        assert!(killed.error.is_none());

        // And its output still reaches the agent.
        tx.send("printed before it died".to_string()).unwrap();
        assert_eq!(
            await_bash_job("bash-kill-gone", None).await,
            "printed before it died"
        );
    }

    /// A command being collected is still running, so it must still be listed
    /// and still be killable. It used to leave the registry the instant the
    /// agent asked for it, hiding the whole of a long build from the panel.
    #[tokio::test]
    async fn a_job_stays_listable_and_killable_while_it_is_collected() {
        let tx = park_with_pid("bash-collect-live", "npm run build", Some(u32::MAX - 8));

        let collector = tokio::spawn(async { await_bash_job("bash-collect-live", None).await });
        // Let the collector take the receiver.
        for _ in 0..100 {
            if bash_jobs()
                .lock()
                .unwrap()
                .get("bash-collect-live")
                .is_some_and(|j| j.rx.is_none())
            {
                break;
            }
            tokio::task::yield_now().await;
        }

        let listed = list_bash_jobs(None);
        let job = listed
            .iter()
            .find(|j| j.job_id == "bash-collect-live")
            .expect("a job being collected is still a job");
        assert!(!job.finished, "it is still running");
        assert_eq!(
            kill_bash_job("bash-collect-live", None).outcome,
            BashJobKillOutcome::Killed
        );

        tx.send("built".to_string()).unwrap();
        assert_eq!(collector.await.unwrap(), "built");
        // Collected: now it is gone.
        assert!(!list_bash_jobs(None)
            .iter()
            .any(|j| j.job_id == "bash-collect-live"));
    }

    #[tokio::test]
    async fn killing_an_unknown_job_reports_it_rather_than_claiming_success() {
        let killed = kill_bash_job("bash-never-existed", None);
        assert_eq!(killed.outcome, BashJobKillOutcome::Unknown);
        assert_eq!(killed.job_id, "bash-never-existed");
    }

    #[tokio::test]
    async fn killing_a_finished_job_leaves_its_output_collectable() {
        // The pid may already have been reused by the OS, so a finished job is
        // never signalled — and its output must still reach the agent.
        let tx = park_with_pid("bash-kill-finished", "true", Some(u32::MAX - 2));
        tx.send("all done".to_string()).unwrap();

        let killed = kill_bash_job("bash-kill-finished", None);
        assert_eq!(killed.outcome, BashJobKillOutcome::AlreadyFinished);
        assert_eq!(await_bash_job("bash-kill-finished", None).await, "all done");
    }

    #[tokio::test]
    async fn a_job_with_no_pid_is_reported_rather_than_reported_killed() {
        let _tx = park("bash-kill-nopid", "sleep 5");
        let killed = kill_bash_job("bash-kill-nopid", None);
        assert_eq!(killed.outcome, BashJobKillOutcome::NoPid);
        // Still listed: nothing was signalled, so nothing has stopped.
        assert!(list_bash_jobs(None)
            .iter()
            .any(|j| j.job_id == "bash-kill-nopid"));
        let _ = bash_jobs().lock().unwrap().remove("bash-kill-nopid");
    }

    /// The whole point of keeping the entry: a killed command's partial output
    /// is what the agent needs to see, and `unknown job_id` would hide it.
    #[tokio::test]
    async fn a_killed_job_still_hands_over_what_it_printed() {
        let tx = park_with_pid("bash-kill-partial", "sleep 300", Some(u32::MAX - 3));

        let killed = kill_bash_job("bash-kill-partial", None);
        assert_eq!(killed.outcome, BashJobKillOutcome::Killed);

        // The detached collector resolves when the shell dies.
        tx.send("half a line before the kill".to_string()).unwrap();
        assert_eq!(
            await_bash_job("bash-kill-partial", None).await,
            "half a line before the kill"
        );
    }

    /// A second kill must not signal the pid again: by then the OS is free to
    /// have handed that number to an unrelated process. The pid is surrendered
    /// on success, so the repeat has nothing to signal.
    #[tokio::test]
    async fn killing_twice_signals_once() {
        let _tx = park_with_pid("bash-kill-twice", "sleep 300", Some(u32::MAX - 4));

        assert_eq!(
            kill_bash_job("bash-kill-twice", None).outcome,
            BashJobKillOutcome::Killed
        );
        assert_eq!(
            kill_bash_job("bash-kill-twice", None).outcome,
            BashJobKillOutcome::NoPid
        );
        let _ = bash_jobs().lock().unwrap().remove("bash-kill-twice");
    }

    #[tokio::test]
    async fn listing_reports_a_running_job_without_consuming_it() {
        let tx = park("bash-listing-running", "sleep 5");

        let listed = list_bash_jobs(None);
        let job = listed
            .iter()
            .find(|j| j.job_id == "bash-listing-running")
            .expect("the job should be listed");
        assert_eq!(job.command, "sleep 5");
        assert!(!job.finished, "a running command is not finished");
        assert_eq!(job.call_id.as_deref(), Some("call-1"));

        // The output still reaches the collector: listing took nothing.
        tx.send("done at last".to_string()).unwrap();
        assert_eq!(await_bash_job("bash-listing-running", None).await, "done at last");
    }

    #[tokio::test]
    async fn a_peek_after_completion_still_hands_the_output_to_the_collector() {
        // `try_recv` consumes on success, so peeking a *finished* job is where
        // a naive status check would steal the agent's result.
        let tx = park("bash-peek-finished", "echo hi");
        tx.send("hi\n".to_string()).unwrap();

        let listed = list_bash_jobs(None);
        let job = listed
            .iter()
            .find(|j| j.job_id == "bash-peek-finished")
            .expect("the job should be listed");
        assert!(job.finished, "the command has produced its output");

        assert_eq!(await_bash_job("bash-peek-finished", None).await, "hi\n");
    }

    #[tokio::test]
    async fn a_job_outlives_the_call_that_backgrounded_it() {
        let tx = park("bash-outlives", "long build");
        // Nothing collects it for now: it stays listed, still running.
        assert!(list_bash_jobs(None)
            .iter()
            .any(|j| j.job_id == "bash-outlives" && !j.finished));

        tx.send("built".to_string()).unwrap();
        // Finishing does not remove it either — only collection does.
        assert!(list_bash_jobs(None)
            .iter()
            .any(|j| j.job_id == "bash-outlives" && j.finished));

        assert_eq!(await_bash_job("bash-outlives", None).await, "built");
        assert!(!list_bash_jobs(None).iter().any(|j| j.job_id == "bash-outlives"));
    }

    #[tokio::test]
    async fn collecting_twice_reports_the_second_as_unknown() {
        let tx = park("bash-twice", "echo x");
        tx.send("x".to_string()).unwrap();
        assert_eq!(await_bash_job("bash-twice", None).await, "x");
        assert!(await_bash_job("bash-twice", None)
            .await
            .contains("already-collected"));
    }

    fn park_owned(job_id: &str, command: &str, owner: &str) -> tokio::sync::oneshot::Sender<String> {
        let tx = park(job_id, command);
        bash_jobs().lock().unwrap().get_mut(job_id).unwrap().owner = Some(owner.to_string());
        tx
    }

    /// A job id learned in one conversation reaches nothing from another:
    /// not a listing, not a status, not a collection, not a kill -- and the
    /// refusal reads exactly like "no such job", so it confirms nothing.
    #[tokio::test]
    async fn another_conversations_job_is_invisible_and_untouchable() {
        let tx = park_owned("bash-owned-a", "make build", "session-a");

        assert!(list_bash_jobs(Some("session-b"))
            .iter()
            .all(|j| j.job_id != "bash-owned-a"));
        assert!(list_bash_jobs(None).iter().all(|j| j.job_id != "bash-owned-a"));
        assert!(inspect_bash_job("bash-owned-a", Some("session-b")).is_none());
        assert_eq!(
            kill_bash_job("bash-owned-a", Some("session-b")).outcome,
            BashJobKillOutcome::Unknown
        );
        tx.send("secret build log".to_string()).unwrap();
        let stolen = await_bash_job("bash-owned-a", Some("session-b")).await;
        assert!(stolen.contains("unknown or already-collected"), "{stolen}");
        assert!(!stolen.contains("secret build log"));
        assert!(bash_job_status_text("bash-owned-a", Some("session-b")).starts_with("ERROR"));

        // Its own conversation still gets it, exactly once.
        assert!(list_bash_jobs(Some("session-a"))
            .iter()
            .any(|j| j.job_id == "bash-owned-a"));
        assert_eq!(
            await_bash_job("bash-owned-a", Some("session-a")).await,
            "secret build log"
        );
    }

    /// A status check shows state and recent output and leaves the result for
    /// the collector.
    #[tokio::test]
    async fn a_status_check_never_takes_the_output() {
        let tx = park_owned("bash-status", "cargo test", "s-status");
        bash_jobs()
            .lock()
            .unwrap()
            .get("bash-status")
            .unwrap()
            .tail
            .lock()
            .unwrap()
            .push("running 12 tests\n");

        let running = bash_job_status_text("bash-status", Some("s-status"));
        assert!(running.contains("state=running"), "{running}");
        assert!(running.contains("running 12 tests"), "{running}");

        tx.send("test result: ok\n[exit 0]".to_string()).unwrap();
        let done = bash_job_status_text("bash-status", Some("s-status"));
        assert!(done.contains("finished (exit 0)"), "{done}");
        assert!(done.contains("waiting"), "{done}");
        // Still collectable, once.
        assert_eq!(
            await_bash_job("bash-status", Some("s-status")).await,
            "test result: ok\n[exit 0]"
        );
        assert!(bash_job_status_text("bash-status", Some("s-status")).starts_with("ERROR"));
    }

    /// What the panel and the model are shown of a command never carries its
    /// credentials, and neither does its recent output.
    #[tokio::test]
    async fn listed_commands_and_peeked_output_are_redacted() {
        let _tx = park_owned(
            "bash-redact",
            "curl -H token=sk-live1234567890abcdefgh https://api.example.com",
            "s-redact",
        );
        bash_jobs()
            .lock()
            .unwrap()
            .get("bash-redact")
            .unwrap()
            .tail
            .lock()
            .unwrap()
            .push("using PGPASSWORD=hunter2hunter2\n");
        let listed = list_bash_jobs(Some("s-redact"));
        let job = listed.iter().find(|j| j.job_id == "bash-redact").unwrap();
        assert!(!job.command.contains("sk-live"), "{}", job.command);
        let status = bash_job_status_text("bash-redact", Some("s-redact"));
        assert!(!status.contains("hunter2"), "{status}");
        assert!(!status.contains("sk-live"), "{status}");
        let _ = bash_jobs().lock().unwrap().remove("bash-redact");
    }

    /// Finished work reports how it ended; a stop request is recorded as such.
    #[tokio::test]
    async fn a_finished_job_reports_its_exit_and_a_stopped_one_says_so() {
        let tx = park_owned("bash-exit", "false", "s-exit");
        tx.send("nope\n[exit 3]".to_string()).unwrap();
        let st = inspect_bash_job("bash-exit", Some("s-exit")).unwrap();
        assert!(st.finished && st.output_available);
        assert_eq!(st.exit_code, Some(3));
        assert!(st.finished_at_ms.is_some());
        assert!(!st.stopped_by_request);
        let _ = await_bash_job("bash-exit", Some("s-exit")).await;

        let _tx2 = park_with_pid("bash-stopped", "sleep 300", Some(u32::MAX - 9));
        assert_eq!(kill_bash_job("bash-stopped", None).outcome, BashJobKillOutcome::Killed);
        assert!(inspect_bash_job("bash-stopped", None).unwrap().stopped_by_request);
        let _ = bash_jobs().lock().unwrap().remove("bash-stopped");
    }

    /// The registry is bounded per conversation: the oldest finished job makes
    /// room, and with every job still running a new one is refused.
    #[tokio::test]
    async fn a_conversation_holds_a_bounded_number_of_jobs() {
        let owner = "s-bound";
        let mut senders = Vec::new();
        for n in 0..MAX_JOBS_PER_OWNER {
            let id = format!("bash-bound-{n}");
            senders.push(park_owned(&id, "sleep 300", owner));
            bash_jobs().lock().unwrap().get_mut(&id).unwrap().started_at_ms = 1_000 + n as u64;
        }
        assert!(!make_room_for(Some(owner)), "every job is running: no room");
        // Another conversation is unaffected by this one's limit.
        assert!(make_room_for(Some("s-other")));

        senders.remove(3).send("done\n[exit 0]".to_string()).unwrap();
        assert!(make_room_for(Some(owner)));
        assert!(
            inspect_bash_job("bash-bound-3", Some(owner)).is_none(),
            "the finished job made room"
        );
        for n in 0..MAX_JOBS_PER_OWNER {
            let _ = bash_jobs().lock().unwrap().remove(&format!("bash-bound-{n}"));
        }
    }

    #[test]
    fn job_ids_carry_a_per_process_prefix() {
        let p = job_id_prefix();
        assert_eq!(p.len(), 5);
        assert!(p.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(p, job_id_prefix(), "stable within the process");
    }

    #[test]
    fn the_live_tail_is_bounded_and_keeps_the_end() {
        let mut tail = LiveTail::default();
        tail.push(&"a".repeat(JOB_TAIL_BYTES));
        tail.push("é the end");
        assert!(tail.text.len() <= JOB_TAIL_BYTES + 1);
        assert!(tail.text.ends_with("the end"));
        assert!(tail.dropped > 0);
    }

    #[test]
    fn the_exit_marker_is_read_from_the_last_line_that_has_one() {
        assert_eq!(exit_code_of("x\n[exit 0]"), Some(0));
        assert_eq!(exit_code_of("[exit 1]\nmore\n[exit 7]\n[output truncated at 1 of 2 bytes]"), Some(7));
        assert_eq!(exit_code_of("[terminated by signal]"), None);
    }
}

/// Record a fact the model inferred, subject to Jan's own gates.
///
/// The model proposes; it does not decide. `memory::inferred::decide` reads the
/// "Automatically save local memories" setting and the existing records, and
/// answers with one of three outcomes. The reply tells the model what happened
/// in a sentence, because a tool that silently succeeds teaches it to propose
/// more, and one that silently fails teaches it to propose the same thing
/// again.
///
/// A proposal is never authority. Nothing here can widen what the model may do:
/// the worst case is a record the user is asked about.
/// AH-103. Who the message is from is this run, as the loop told us; the
/// model supplies only who it is for and what it says.
fn message_send(args: &serde_json::Value, ctx: &ToolContext<'_>) -> String {
    let (Some(data), Some(run), Some(session)) = (ctx.data_folder, ctx.run_id, ctx.session_id)
    else {
        return "ERROR [unsupported]: this surface has no run mailbox, so there is nobody to \
                write to."
            .to_string();
    };
    let to = args.get("to").and_then(|v| v.as_str()).unwrap_or_default().trim();
    let body = args.get("body").and_then(|v| v.as_str()).unwrap_or_default();
    if to.is_empty() || body.trim().is_empty() {
        return "ERROR [invalid_input]: message_send needs `to` and a non-empty `body`."
            .to_string();
    }
    let subject = args.get("subject").and_then(|v| v.as_str()).unwrap_or_default();

    let parsed = crate::identity::SessionId::parse(session).and_then(|session| {
        let from = crate::identity::RunId::parse(run)?;
        let to = crate::identity::RunId::parse(to)?;
        Ok((session, from, to))
    });
    let (session, from, to) = match parsed {
        Ok(ids) => ids,
        Err(e) => return format!("ERROR [{}]: {}", e.kind().tag(), e.message()),
    };
    match crate::mailbox::send(data, &session, &from, &to, subject, body) {
        Ok(message) => format!(
            "Delivered to {} as message {} of their mailbox.",
            message.to, message.seq
        ),
        Err(e) => {
            let harness: crate::harness_error::HarnessError = (&e).into();
            format!("ERROR [{}]: {}", harness.kind().tag(), e.message)
        }
    }
}

/// AH-103. What other runs have said to this one since it last looked.
fn message_check(ctx: &ToolContext<'_>) -> String {
    let (Some(data), Some(run)) = (ctx.data_folder, ctx.run_id) else {
        return "ERROR [unsupported]: this surface has no run mailbox.".to_string();
    };
    let run = match crate::identity::RunId::parse(run) {
        Ok(run) => run,
        Err(e) => return format!("ERROR [{}]: {}", e.kind().tag(), e.message()),
    };
    // One step, so what is handed back is exactly what was marked delivered:
    // asking what is unread and then marking everything unread would stamp a
    // message that arrived in between and never show it to anyone.
    match crate::mailbox::collect(data, &run) {
        Ok(fresh) => {
            if fresh.is_empty() {
                return "No messages.".to_string();
            }
            let mut out = String::new();
            for message in &fresh {
                // Named as what it is: another agent's words, which are
                // information and not an instruction this run has to follow.
                out.push_str(&format!(
                    "From run {} at {}{}\n{}\n\n",
                    message.from,
                    message.at,
                    if message.subject.is_empty() {
                        String::new()
                    } else {
                        format!(" -- {}", message.subject)
                    },
                    message.body
                ));
            }
            out.trim_end().to_string()
        }
        Err(e) => {
            let harness: crate::harness_error::HarnessError = (&e).into();
            format!("ERROR [{}]: {}", harness.kind().tag(), e.message)
        }
    }
}

async fn memory_propose(args: &serde_json::Value, ctx: &ToolContext<'_>) -> String {
    use crate::memory::inferred::{self, Decision};
    use crate::memory::record::{MemoryId, Scope};

    let Some(content) = arg_str(args, "content") else {
        return "ERROR: memory_propose needs `content`.".to_string();
    };
    let content = content.trim();
    if content.is_empty() {
        return "ERROR: memory_propose needs a non-empty `content`.".to_string();
    }

    // Narrowest scope that is true, and `session` when the model does not say:
    // a guess that applies too widely is the expensive mistake.
    let scope = match args
        .get("scope")
        .and_then(|v| v.as_str())
        .unwrap_or("session")
    {
        "user" => Scope::User,
        "project" => Scope::Project,
        _ => Scope::Session,
    };

    // Project records live in the project's own store, the one every reader
    // (`commands`, `context::load_memories`, the settings page) opens. This
    // used to write to `<project>/.jan`, one level above it, so a project
    // memory the model proposed was saved where nothing ever looked.
    let store_root = match scope {
        Scope::Project => crate::workspace::project_store(ctx.project_root),
        _ => ctx.store_root.to_path_buf(),
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let existing = inferred::existing_records(&store_root, scope);
    let decision = inferred::decide(
        MemoryId::new(format!("mem-{now}-{:016x}", fnv1a(content))),
        content,
        &existing,
        &inferred::Context {
            scope,
            project_id: crate::memory::identity::project_id(ctx.project_root).as_deref(),
            session_id: ctx.session_id,
            temporary: ctx.temporary,
            now,
            automatically_save: inferred::automatic_saving_enabled(ctx.store_root),
        },
    );

    match decision {
        Decision::Save(proposal) => match crate::memory::create::commit(&store_root, &proposal) {
            Ok(id) => format!(
                "Remembered ({}). id: {}",
                scope_name(scope),
                id.as_str()
            ),
            Err(e) => format!("ERROR: could not save that memory: {e}"),
        },
        Decision::Pending { proposal, reason } => {
            // Stored, not dropped. The question has to survive the turn that
            // asked it -- and a restart -- or the user is asked once, in a
            // place they may not be looking, and never again.
            // `Status::Proposed` keeps it out of every prompt meanwhile.
            let pending = inferred::as_pending(&proposal, reason);
            match crate::memory::store::upsert(&store_root, &pending) {
                Ok(()) => format!(
                    "Not saved yet -- the user has been asked. {} Do not propose it again in this conversation.",
                    reason.explain()
                ),
                Err(e) => format!("ERROR: could not record that proposal: {e}"),
            }
        }
        Decision::Refused { reason } => {
            format!("ERROR: refused: {reason} Do not propose this again.")
        }
    }
}

fn scope_name(scope: crate::memory::record::Scope) -> &'static str {
    use crate::memory::record::Scope;
    match scope {
        Scope::Session => "this conversation",
        Scope::Project => "this project",
        Scope::User => "everywhere",
    }
}

/// FNV-1a over the content, so the same fact proposed twice lands on the same
/// id and confirms rather than multiplying.
fn fnv1a(bytes: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::lookup;
    use serde_json::json;

    // Root-taking shims over the `ToolContext` entry points. These shadow the
    // glob-imported originals so the tool tests, which almost never care about
    // the skill whitelist, stay readable. Tests that do care build a
    // `ToolContext` and call `super::*` directly.
    //
    // They co-locate the store inside the root (`<root>/.jan/agent`), the layout
    // a project uses, so the memory/skill tests keep asserting against paths
    // relative to their one temp dir. The desktop's split roots are covered in
    // `workspace` and `commands`.
    async fn execute_builtin(tool: &BuiltinTool, args: &serde_json::Value, root: &Path) -> String {
        let store = crate::workspace::project_store(root);
        super::execute_builtin(tool, args, &ToolContext::new(root, &store, &[]))
            .await
            .0
    }

    async fn execute_builtin_with_diff(
        tool: &BuiltinTool,
        args: &serde_json::Value,
        root: &Path,
    ) -> (String, Option<String>) {
        let store = crate::workspace::project_store(root);
        let (content, diff, _images) =
            super::execute_builtin_with_diff(tool, args, &ToolContext::new(root, &store, &[]))
                .await;
        (content, diff)
    }

    async fn preview_diff(
        tool: &BuiltinTool,
        args: &serde_json::Value,
        root: &Path,
    ) -> Option<String> {
        let store = crate::workspace::project_store(root);
        super::preview_diff(tool, args, &ToolContext::new(root, &store, &[])).await
    }

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// AH-148, through the function the approval flow actually calls. The
    /// window is real: a prompt can sit unanswered for minutes while an editor,
    /// a formatter or another agent writes the same file.
    #[tokio::test]
    async fn a_file_changed_after_staging_is_caught_before_it_is_written() {
        let root = unique_root();
        let store = root.join("store");
        let ctx = ToolContext::new(&root, &store, &[]);
        std::fs::write(root.join("notes.txt"), "one\ntwo\n").unwrap();

        let (target, patch) = stage_change(
            lookup("write").unwrap(),
            &json!({"path": "notes.txt", "content": "one\nTWO\n"}),
            &ctx,
        )
        .await
        .expect("a change to stage");
        assert_eq!(patch.hunks().len(), 1);
        assert!(patch
            .check_base(crate::patch::BaseStamp::read(&target).await)
            .is_ok());

        // Someone else writes the file while the prompt is open.
        std::fs::write(root.join("notes.txt"), "one\ntwo\nthree\n").unwrap();
        let refused = patch.check_base(crate::patch::BaseStamp::read(&target).await);
        assert!(refused.is_err(), "an approval must not land on a changed file");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn an_edit_is_staged_by_the_same_code_that_applies_it() {
        let root = unique_root();
        let store = root.join("store");
        let ctx = ToolContext::new(&root, &store, &[]);
        std::fs::write(root.join("a.rs"), "fn a() {}\nfn b() {}\n").unwrap();
        let args = json!({"path": "a.rs", "edits": [
            {"old_string": "fn a() {}", "new_string": "fn a() { 1 }"}
        ]});

        let (_, patch) = stage_change(lookup("edit").unwrap(), &args, &ctx)
            .await
            .expect("staged");
        // What was reviewed is what `edit` writes.
        let out = super::execute_builtin(lookup("edit").unwrap(), &args, &ctx).await.0;
        assert!(out.starts_with("Applied"), "{out}");
        assert_eq!(
            std::fs::read_to_string(root.join("a.rs")).unwrap(),
            patch.proposed()
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn nothing_is_staged_for_a_change_that_changes_nothing_or_an_invalid_edit() {
        let root = unique_root();
        let store = root.join("store");
        let ctx = ToolContext::new(&root, &store, &[]);
        std::fs::write(root.join("same.txt"), "x\n").unwrap();
        assert!(stage_change(
            lookup("write").unwrap(),
            &json!({"path": "same.txt", "content": "x\n"}),
            &ctx
        )
        .await
        .is_none());
        assert!(stage_change(
            lookup("edit").unwrap(),
            &json!({"path": "same.txt", "edits": [{"old_string": "absent", "new_string": "y"}]}),
            &ctx
        )
        .await
        .is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    fn unique_root() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir =
            std::env::temp_dir().join(format!("jan_handlers_test_{}_{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).expect("create test root");
        dir
    }

    // -- shell-aware command fixtures ----------------------------------------
    //
    // These tests are about what the `bash` tool does with a command's *output*
    // -- truncation, spilling, carriage-return collapsing, where the exit
    // marker goes. None of that is about POSIX, but every one of them was
    // written as a POSIX one-liner, so on a host whose sandboxed shell is not
    // POSIX they failed for a reason that had nothing to do with what they
    // test. On Windows that is every one of them: the MSYS2 runtime Git Bash
    // is built on cannot start inside an AppContainer, so the confined shell is
    // PowerShell.
    //
    // The fix is to say what shape of output is wanted and let the fixture
    // write it in whatever language the shell that will actually run it
    // speaks. The assertions are unchanged: they were never the problem.

    /// An output shape a test needs, independent of how it is produced.
    #[derive(Debug, Clone, Copy)]
    enum Shape {
        /// `count` newline-terminated lines, each `L1`, `L2`, ...
        Lines { count: usize },
        /// `count` newline-terminated lines, each a 64-character zero-padded
        /// number. Used to make output cross a byte cap predictably.
        PaddedLines { count: usize },
        /// Text on stderr with no trailing newline, like `git push`.
        StderrNoNewline(&'static str),
        /// One logical line redrawn `count` times with `\r` and no `\n`, on
        /// stderr. Mimics git progress.
        StderrRedraw { count: usize, prefix: &'static str },
        /// Read stdin to end and echo nothing.
        ReadStdin,
        /// Exactly this text, no trailing newline.
        Literal(&'static str),
        /// Wait, producing nothing. For deadline and cancellation tests.
        Sleep { seconds: u32 },
        /// Print a line, then wait. The line has to arrive before the deadline
        /// does, which is the whole point of the tests that use it.
        PrintThenSleep { text: &'static str, seconds: u32 },
        /// Wait, then print a line.
        SleepThenPrint { seconds: u32, text: &'static str },
        /// Start a child that waits, print `pid=<shell>` and `child=<child>`
        /// (OS process ids), then a line, then wait for the child. The ids let
        /// a test check that the whole tree is gone, not just the shell.
        PrintPidThenSleep { text: &'static str, seconds: u32 },
    }

    /// The command language the sandboxed shell for `root` actually speaks.
    ///
    // ---- AH-040: a skill declares the tools it needs, and the gate says ---

    /// A skill's declared tools are checked against what this run may do. It
    /// can only ever withhold the skill; nothing here grants a tool.
    #[tokio::test]
    async fn a_skill_that_needs_a_denied_tool_is_withheld_and_says_why() {
        use crate::permissions::{PermissionDefault, ToolPermissions};
        let root = unique_root();
        let store = crate::workspace::project_store(&root);
        let skills = store.join("skills");
        std::fs::create_dir_all(skills.join("deployer")).unwrap();
        std::fs::write(
            skills.join("deployer").join("SKILL.md"),
            "---\nname: deployer\ndescription: deploys the thing\nallowed-tools: [bash, write]\n---\nRun the deploy script.\n",
        )
        .unwrap();
        std::fs::create_dir_all(skills.join("reader")).unwrap();
        std::fs::write(
            skills.join("reader").join("SKILL.md"),
            "---\nname: reader\ndescription: reads things\nallowed-tools: [read]\n---\nRead the file.\n",
        )
        .unwrap();

        let enabled = vec!["deployer".to_string(), "reader".to_string()];
        let subject = crate::subject::Subject::MainAgent;
        // This run may not run a shell.
        let denied = ToolPermissions::new(PermissionDefault::Allow, &[], &["bash".into()], &[]);
        let ctx = ToolContext::new(&root, &store, &enabled).with_permissions(&denied, &subject);

        let refused = super::execute_builtin(
            lookup("skill_read").unwrap(),
            &json!({ "name": "deployer" }),
            &ctx,
        )
        .await
        .0;
        assert!(
            refused.starts_with("ERROR [permission_denied]"),
            "a skill needing a denied tool must be withheld: {refused}"
        );
        assert!(refused.contains("bash"), "and say which tool: {refused}");
        assert!(
            !refused.contains("Run the deploy script"),
            "its instructions must not be handed over anyway: {refused}"
        );

        // The one this run can carry out is unaffected.
        let allowed = super::execute_builtin(
            lookup("skill_read").unwrap(),
            &json!({ "name": "reader" }),
            &ctx,
        )
        .await
        .0;
        assert!(allowed.contains("Read the file"), "{allowed}");

        // And the catalogue does not offer what it would refuse.
        let listed = super::execute_builtin(lookup("skill_list").unwrap(), &json!({}), &ctx)
            .await
            .0;
        assert!(listed.contains("reader"), "{listed}");
        assert!(!listed.contains("deployer"), "a skill that cannot run was offered: {listed}");

        // With nothing denied, both are available: the check withholds, it
        // never grants.
        let open = ToolPermissions::allow_all();
        let open_ctx =
            ToolContext::new(&root, &store, &enabled).with_permissions(&open, &subject);
        let now = super::execute_builtin(
            lookup("skill_read").unwrap(),
            &json!({ "name": "deployer" }),
            &open_ctx,
        )
        .await
        .0;
        assert!(now.contains("Run the deploy script"), "{now}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A skill that says nothing about tools behaves as it always did: its
    /// calls are gated when they are made, like anybody else's.
    #[tokio::test]
    async fn a_skill_that_declares_nothing_is_not_withheld() {
        use crate::permissions::{PermissionDefault, ToolPermissions};
        let root = unique_root();
        let store = crate::workspace::project_store(&root);
        let skills = store.join("skills");
        std::fs::create_dir_all(skills.join("quiet")).unwrap();
        std::fs::write(
            skills.join("quiet").join("SKILL.md"),
            "---\nname: quiet\ndescription: says nothing about tools\n---\nDo the thing.\n",
        )
        .unwrap();
        let enabled = vec!["quiet".to_string()];
        let subject = crate::subject::Subject::MainAgent;
        let denied = ToolPermissions::new(PermissionDefault::Allow, &[], &["bash".into()], &[]);
        let ctx = ToolContext::new(&root, &store, &enabled).with_permissions(&denied, &subject);
        let out = super::execute_builtin(
            lookup("skill_read").unwrap(),
            &json!({ "name": "quiet" }),
            &ctx,
        )
        .await
        .0;
        assert!(out.contains("Do the thing"), "{out}");
        let _ = std::fs::remove_dir_all(&root);
    }

    // ---- AH-103: one run writing to another, through the tools ------------

    #[tokio::test]
    async fn a_run_writes_to_another_run_and_cannot_pretend_to_be_someone_else() {
        let root = unique_root();
        let store = crate::workspace::project_store(&root);
        let data = root.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let session = "s-tools";
        let me = format!("{session}#run-child");
        let parent = format!("{session}#run-parent");

        let ctx = ToolContext::new(&root, &store, &[])
            .in_session(Some(session), false)
            .with_run(&me, &data);
        let sent = super::execute_builtin(
            lookup("message_send").unwrap(),
            &json!({ "to": parent, "subject": "schema", "body": "the migration is applied" }),
            &ctx,
        )
        .await
        .0;
        assert!(!sent.starts_with("ERROR"), "{sent}");

        // The parent reads it, and the message says who it is really from --
        // which is this run, not anything the arguments claimed.
        let parent_ctx = ToolContext::new(&root, &store, &[])
            .in_session(Some(session), false)
            .with_run(&parent, &data);
        let inbox = super::execute_builtin(lookup("message_check").unwrap(), &json!({}), &parent_ctx)
            .await
            .0;
        assert!(inbox.contains("the migration is applied"), "{inbox}");
        assert!(inbox.contains(&me), "the reader is told who wrote: {inbox}");

        // Read once: a second check has nothing new.
        let again = super::execute_builtin(lookup("message_check").unwrap(), &json!({}), &parent_ctx)
            .await
            .0;
        assert_eq!(again, "No messages.");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_message_to_another_conversation_is_refused_at_the_tool() {
        let root = unique_root();
        let store = crate::workspace::project_store(&root);
        let data = root.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let ctx = ToolContext::new(&root, &store, &[])
            .in_session(Some("s-mine"), false)
            .with_run("s-mine#run-a", &data);

        for (target, expected) in [
            ("s-theirs#run-b", "policy_violation"),
            ("../elsewhere", "invalid_input"),
            ("s-mine#run-a", "policy_violation"),
        ] {
            let out = super::execute_builtin(
                lookup("message_send").unwrap(),
                &json!({ "to": target, "body": "hello" }),
                &ctx,
            )
            .await
            .0;
            assert!(
                out.contains(&format!("ERROR [{expected}]")),
                "{target} should be refused as {expected}: {out}"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A surface with nowhere to keep a message says so rather than
    /// pretending to have sent one.
    #[tokio::test]
    async fn without_a_mailbox_the_tools_say_there_is_nobody_to_write_to() {
        let root = unique_root();
        let out = execute_builtin(
            lookup("message_send").unwrap(),
            &json!({ "to": "s#run-x", "body": "hello" }),
            &root,
        )
        .await;
        assert!(out.contains("ERROR [unsupported]"), "{out}");
        let read = execute_builtin(lookup("message_check").unwrap(), &json!({}), &root).await;
        assert!(read.contains("ERROR [unsupported]"), "{read}");
        let _ = std::fs::remove_dir_all(&root);
    }

    // ---- AH-127/AH-129: the project's own hooks, around a real tool call ----

    /// Write a hooks file for `root`. Commands here must run under whichever
    /// shell can be confined on this host, so they use only `echo` and `exit`.
    fn write_hooks(root: &Path, body: &str) {
        let dir = root.join(".jan").join("agent");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("hooks.toml"), body).unwrap();
    }

    #[tokio::test]
    async fn a_block_hook_refuses_the_tool_call_and_the_tool_does_not_run() {
        let root = unique_root();
        write_hooks(
            &root,
            "[[hook]]
event = \"pre-tool\"
command = \"exit 3\"
on_failure = \"block\"
tools = [\"write\"]
",
        );
        let out = execute_builtin(
            lookup("write").unwrap(),
            &json!({ "path": "new.txt", "content": "hello" }),
            &root,
        )
        .await;
        assert!(
            out.starts_with("ERROR [policy_violation]:"),
            "a refused call must say what kind of refusal it was: {out}"
        );
        assert!(
            !root.join("new.txt").exists(),
            "the tool ran anyway; a blocked call must not have happened"
        );
        // AH-009: what the run sees is the typed failure, and it is not
        // something to try again or to try elsewhere.
        let classified = crate::harness_error::classify_tool("write", &out)
            .expect("a refusal is a classified failure");
        assert_eq!(classified.kind(), crate::harness_error::ErrorKind::PolicyViolation);
        assert!(!crate::harness_error::may_try_another(&classified));

        // A tool the hook does not name is untouched.
        let read_back =
            execute_builtin(lookup("ls").unwrap(), &json!({ "path": "." }), &root).await;
        assert!(!read_back.starts_with("ERROR"), "{read_back}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_warn_hook_lets_the_call_through_and_says_it_failed() {
        let root = unique_root();
        write_hooks(
            &root,
            "[[hook]]
event = \"post-tool\"
command = \"exit 1\"
on_failure = \"warn\"
",
        );
        let out = execute_builtin(
            lookup("write").unwrap(),
            &json!({ "path": "new.txt", "content": "hello" }),
            &root,
        )
        .await;
        assert!(!out.starts_with("ERROR"), "a warn hook must not refuse the call: {out}");
        assert!(root.join("new.txt").exists(), "the write still happened");
        assert!(
            out.contains("[post-tool hook]"),
            "the failure has to be visible to whoever reads the result: {out}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A hooks file that is wrong stops tools rather than quietly meaning no
    /// hooks: a project that declared a policy and silently got none is the
    /// outcome worth refusing loudest.
    #[tokio::test]
    async fn a_hooks_file_that_cannot_be_read_stops_the_call() {
        let root = unique_root();
        write_hooks(&root, "[[hook]]\nevent = \"whenever\"\ncommand = \"echo hi\"\n");
        let out =
            execute_builtin(lookup("ls").unwrap(), &json!({ "path": "." }), &root).await;
        assert!(out.starts_with("ERROR [invalid_input]:"), "{out}");
        assert!(out.contains("hooks"), "{out}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Asked of the same code the handler asks, so a fixture cannot be written
    /// for one shell while the command runs in another.
    fn sandbox_flavor(root: &Path) -> Option<proc::ShellFlavor> {
        let policy = jail::Policy::new(root, false);
        jail::select_shell(&policy)
            .ok()
            .map(|selected| selected.report.cfg.flavor)
    }

    /// `shape` as a command, or `None` when the sandboxed shell speaks a
    /// language this fixture cannot express it in.
    ///
    /// `cmd.exe` is the `None` case. It has no loop that can emit 16,000 lines
    /// without a temporary batch file, and writing one would be testing the
    /// fixture rather than the tool. A host with only `cmd` is real, and these
    /// tests skip there loudly rather than asserting something weaker.
    fn script(root: &Path, shape: Shape) -> Option<String> {
        match sandbox_flavor(root)? {
            proc::ShellFlavor::Posix => Some(match shape {
                Shape::Lines { count } => {
                    format!("for i in $(seq 1 {count}); do echo \"L$i\"; done")
                }
                Shape::PaddedLines { count } => format!(
                    "for i in $(seq 1 {count}); do printf '%064d\\n' \"$i\"; done"
                ),
                Shape::StderrNoNewline(text) => format!("printf '{text}' 1>&2"),
                Shape::StderrRedraw { count, prefix } => format!(
                    "for i in $(seq 1 {count}); do printf '{prefix}%d\\r' \"$i\"; done 1>&2"
                ),
                Shape::ReadStdin => "cat".to_string(),
                Shape::Literal(text) => format!("printf '{text}'"),
                Shape::Sleep { seconds } => format!("sleep {seconds}"),
                Shape::PrintThenSleep { text, seconds } => {
                    format!("printf '{text}\\n'; sleep {seconds}")
                }
                Shape::SleepThenPrint { seconds, text } => {
                    format!("sleep {seconds}; printf '{text}\\n'")
                }
                // Under MSYS `$$` is not a Windows pid; `/proc/$$/winpid` is.
                Shape::PrintPidThenSleep { text, seconds } => format!(
                    "sleep {seconds} & \
                     printf 'pid=%s\\nchild=%s\\n' \
                       \"$(cat /proc/$$/winpid 2>/dev/null || echo $$)\" \
                       \"$(cat /proc/$!/winpid 2>/dev/null || echo $!)\"; \
                     printf '{text}\\n'; wait"
                ),
            }),
            proc::ShellFlavor::PowerShell => Some(match shape {
                Shape::Lines { count } => {
                    format!("1..{count} | ForEach-Object {{ \"L$_\" }}")
                }
                // `-f` formatting rather than string padding: it produces the
                // same 64 characters as `%064d` without a second allocation
                // per line, which matters at 16,000 lines.
                Shape::PaddedLines { count } => format!(
                    "1..{count} | ForEach-Object {{ '{{0:D64}}' -f $_ }}"
                ),
                // `[Console]::Error.Write` rather than `Write-Error`: the
                // latter emits a formatted error record, and the shape wanted
                // here is bare text with no trailing newline.
                Shape::StderrNoNewline(text) => {
                    format!("[Console]::Error.Write('{text}')")
                }
                Shape::StderrRedraw { count, prefix } => format!(
                    "1..{count} | ForEach-Object {{ [Console]::Error.Write('{prefix}' + $_ + [char]13) }}"
                ),
                Shape::ReadStdin => {
                    "$input | Out-Null".to_string()
                }
                Shape::Literal(text) => format!("[Console]::Out.Write('{text}')"),
                Shape::Sleep { seconds } => format!("Start-Sleep -Seconds {seconds}"),
                // The write is flushed before the sleep starts, so the line is
                // already through the pipe when the deadline fires.
                Shape::PrintThenSleep { text, seconds } => format!(
                    "[Console]::Out.WriteLine('{text}'); [Console]::Out.Flush(); Start-Sleep -Seconds {seconds}"
                ),
                Shape::SleepThenPrint { seconds, text } => format!(
                    "Start-Sleep -Seconds {seconds}; [Console]::Out.WriteLine('{text}')"
                ),
                // Concatenation, not `"$(...)"`: the handler reads `$(` as POSIX
                // command substitution and refuses the command under PowerShell.
                Shape::PrintPidThenSleep { text, seconds } => format!(
                    // The working directory is the project root, named: inside
                    // the AppContainer the inherited one is not accessible to a
                    // new process ("The directory name is invalid") and `$PWD`
                    // is unset.
                    "$c = Start-Process -FilePath powershell -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds {seconds}' -WorkingDirectory '{root}' -NoNewWindow -PassThru; \
                     [Console]::Out.WriteLine('pid=' + $PID); [Console]::Out.WriteLine('child=' + $c.Id); \
                     [Console]::Out.WriteLine('{text}'); [Console]::Out.Flush(); $c.WaitForExit()",
                    root = root.display()
                ),
            }),
            proc::ShellFlavor::Cmd => None,
        }
    }

    /// Skip the body when the sandboxed shell cannot express `shape`, saying
    /// so rather than passing quietly.
    macro_rules! command_or_skip {
        ($root:expr, $shape:expr) => {
            match script($root, $shape) {
                Some(command) => command,
                None => {
                    eprintln!(
                        "skipped: the sandboxed shell here cannot express {:?}",
                        $shape
                    );
                    return;
                }
            }
        };
    }

    #[tokio::test]
    async fn read_returns_contents() {
        let root = unique_root();
        std::fs::write(root.join("a.txt"), b"hello").unwrap();
        let out = execute_builtin(lookup("read").unwrap(), &json!({"path": "a.txt"}), &root).await;
        assert_eq!(out, "hello");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn read_with_offset_and_limit_slices_lines() {
        let root = unique_root();
        std::fs::write(root.join("lines.txt"), b"l1\nl2\nl3\nl4\nl5").unwrap();
        let out = execute_builtin(
            lookup("read").unwrap(),
            &json!({"path": "lines.txt", "offset": 2, "limit": 2}),
            &root,
        )
        .await;
        assert_eq!(out, "l2\nl3");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn read_rejects_binary() {
        let root = unique_root();
        std::fs::write(root.join("bin"), [0xff, 0xfe, 0x00]).unwrap();
        let out = execute_builtin(lookup("read").unwrap(), &json!({"path": "bin"}), &root).await;
        assert!(out.starts_with("ERROR"), "unexpected: {out}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn read_returns_image_payload_for_a_png() {
        let root = unique_root();
        // Minimal valid PNG signature suffices for detection; the payload is
        // what the tool validates, not a decodable image.
        let bytes: Vec<u8> = vec![
            0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
            0x44, 0x52,
        ];
        std::fs::write(root.join("pic.png"), &bytes).unwrap();
        let (content, images) = super::execute_builtin(
            lookup("read").unwrap(),
            &json!({"path": "pic.png"}),
            &ToolContext::new(&root, &crate::workspace::project_store(&root), &[]),
        )
        .await;
        assert!(content.contains("image/png"), "note: {content}");
        let img = images.expect("an image read must return image parts");
        assert_eq!(img.len(), 1);
        assert_eq!(img[0].name, "pic.png");
        assert!(img[0].data_url.starts_with("data:image/png;base64,"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn read_extension_fallback_catches_a_misnamed_image() {
        let root = unique_root();
        // No valid signature header, but the extension says PNG: the extension
        // fallback still returns an image payload.
        std::fs::write(root.join("scanned.png"), b"not a real png").unwrap();
        let (content, images) = super::execute_builtin(
            lookup("read").unwrap(),
            &json!({"path": "scanned.png"}),
            &ToolContext::new(&root, &crate::workspace::project_store(&root), &[]),
        )
        .await;
        assert!(!content.starts_with("ERROR"), "got: {content}");
        assert!(
            images.is_some(),
            "extension-matching png must yield an image"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn read_image_with_offset_falls_back_to_text_error() {
        let root = unique_root();
        let bytes: Vec<u8> = vec![0x89, b'P', b'N', b'G'];
        std::fs::write(root.join("pic.png"), &bytes).unwrap();
        let out = execute_builtin(
            lookup("read").unwrap(),
            &json!({"path": "pic.png", "offset": 1, "limit": 1}),
            &root,
        )
        .await;
        assert!(
            out.starts_with("ERROR"),
            "slicing an image must not render: {out}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn read_image_over_cap_falls_back_to_text_error() {
        let root = unique_root();
        // Valid PNG signature but far larger than MAX_IMAGE_BYTES: the size
        // gate must refuse to base64-dump it into model context.
        let mut bytes: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        bytes.resize(MAX_IMAGE_BYTES + 1, 0u8);
        std::fs::write(root.join("huge.png"), &bytes).unwrap();
        let (content, images) = super::execute_builtin(
            lookup("read").unwrap(),
            &json!({"path": "huge.png"}),
            &ToolContext::new(&root, &crate::workspace::project_store(&root), &[]),
        )
        .await;
        assert!(
            images.is_none(),
            "an over-cap image must not yield image parts"
        );
        assert!(content.starts_with("ERROR"), "got: {content}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn write_then_read_roundtrips() {
        let root = unique_root();
        let w = execute_builtin(
            lookup("write").unwrap(),
            &json!({"path": "sub/b.txt", "content": "data"}),
            &root,
        )
        .await;
        assert_eq!(w, "Created sub/b.txt (4 bytes)");
        let r = execute_builtin(
            lookup("read").unwrap(),
            &json!({"path": "sub/b.txt"}),
            &root,
        )
        .await;
        assert_eq!(r, "data");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn edit_applies_two_edits_atomically() {
        let root = unique_root();
        std::fs::write(root.join("c.txt"), b"foo bar baz").unwrap();
        let ok = execute_builtin(
            lookup("edit").unwrap(),
            &json!({"path": "c.txt", "edits": [
                {"old_string": "foo", "new_string": "FOO"},
                {"old_string": "baz", "new_string": "BAZ"}
            ]}),
            &root,
        )
        .await;
        assert_eq!(ok, "Applied 2 edit(s) to c.txt");
        assert_eq!(
            std::fs::read_to_string(root.join("c.txt")).unwrap(),
            "FOO bar BAZ"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn edit_errors_without_partial_write() {
        let root = unique_root();
        std::fs::write(root.join("d.txt"), b"one two two").unwrap();
        // First edit ok, second not unique -> whole op fails, file unchanged.
        let out = execute_builtin(
            lookup("edit").unwrap(),
            &json!({"path": "d.txt", "edits": [
                {"old_string": "one", "new_string": "ONE"},
                {"old_string": "two", "new_string": "TWO"}
            ]}),
            &root,
        )
        .await;
        assert!(
            out.starts_with("ERROR: d.txt: edit 2: old_string not unique"),
            "unexpected: {out}"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("d.txt")).unwrap(),
            "one two two"
        );

        let miss = execute_builtin(
            lookup("edit").unwrap(),
            &json!({"path": "d.txt", "edits": [{"old_string": "nope", "new_string": "x"}]}),
            &root,
        )
        .await;
        assert!(
            miss.starts_with("ERROR: d.txt: edit 1: old_string not found"),
            "unexpected: {miss}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn edit_diff_single_hunk_has_no_header() {
        let d = render_edit_diff(&[json!({"old_string": "foo", "new_string": "bar"})], "foo");
        assert_eq!(d, "-    1 | foo\n+    1 | bar");
    }

    #[test]
    fn edit_diff_multi_hunk_is_numbered_and_multiline() {
        let d = render_edit_diff(
            &[
                json!({"old_string": "a\nb", "new_string": "A"}),
                json!({"old_string": "c", "new_string": "C\nD"}),
            ],
            "a\nb\nc",
        );
        assert_eq!(
            d,
            "@@ edit 1/2 @@\n-    1 | a\n-    2 | b\n+    1 | A\n     2 | c\n@@ edit 2/2 @@\n     1 | A\n-    2 | c\n+    2 | C\n+    3 | D"
        );
    }

    #[test]
    fn edit_diff_numbers_against_real_file_position() {
        let d = render_edit_diff(
            &[json!({"old_string": "two", "new_string": "TWO"})],
            "one\ntwo\nthree",
        );
        assert_eq!(
            d,
            "     1 | one\n-    2 | two\n+    2 | TWO\n     3 | three"
        );
    }

    /// Two edits far apart in one call: each hunk carries its own file context
    /// and nothing in between, and the second is numbered against the state the
    /// first left behind (edit 1 adds a line, so `eight` is renumbered 8 -> 9).
    #[test]
    fn edit_diff_numbers_later_edits_against_earlier_ones() {
        let d = render_edit_diff(
            &[
                json!({"old_string": "two", "new_string": "TWO\nTWO.5"}),
                json!({"old_string": "eight", "new_string": "EIGHT"}),
            ],
            "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n",
        );
        assert_eq!(
            d,
            concat!(
                "@@ edit 1/2 @@\n",
                "     1 | one\n",
                "-    2 | two\n",
                "+    2 | TWO\n",
                "+    3 | TWO.5\n",
                "     4 | three\n",
                "     5 | four\n",
                "@@ edit 2/2 @@\n",
                "     7 | six\n",
                "     8 | seven\n",
                "-    9 | eight\n",
                "+    9 | EIGHT\n",
                "    10 | nine",
            )
        );
    }

    /// A later edit may target text an earlier one inserted, since both run
    /// against the same `working` copy that `edit()` mutates in order.
    #[test]
    fn edit_diff_lets_a_later_edit_target_inserted_text() {
        let d = render_edit_diff(
            &[
                json!({"old_string": "b", "new_string": "b\nBETA"}),
                json!({"old_string": "BETA", "new_string": "GAMMA"}),
            ],
            "a\nb\nc",
        );
        assert_eq!(
            d,
            concat!(
                "@@ edit 1/2 @@\n",
                "     1 | a\n",
                "     2 | b\n",
                "+    3 | BETA\n",
                "     4 | c\n",
                "@@ edit 2/2 @@\n",
                "     1 | a\n",
                "     2 | b\n",
                "-    3 | BETA\n",
                "+    3 | GAMMA\n",
                "     4 | c",
            )
        );
    }

    /// The context around a change comes from the file, not just from whatever
    /// `old_string` happened to include, and stops at `DIFF_CONTEXT` lines.
    #[test]
    fn edit_diff_pads_hunk_with_file_context() {
        let d = render_edit_diff(
            &[json!({"old_string": "four", "new_string": "FOUR"})],
            "one\ntwo\nthree\nfour\nfive\nsix\nseven",
        );
        assert_eq!(
            d,
            "     2 | two\n     3 | three\n-    4 | four\n+    4 | FOUR\n     5 | five\n     6 | six"
        );
    }

    /// A match that starts and ends mid-line is diffed as the whole lines it
    /// sits in, so the surrounding text on those lines is visible.
    #[test]
    fn edit_diff_widens_a_mid_line_match_to_whole_lines() {
        let d = render_edit_diff(
            &[json!({"old_string": "b = 1", "new_string": "b = 2"})],
            "let a = 0;\nlet b = 1;\nlet c = 0;\n",
        );
        assert_eq!(
            d,
            "     1 | let a = 0;\n-    2 | let b = 1;\n+    2 | let b = 2;\n     3 | let c = 0;"
        );
    }

    /// Distant changes inside one edit stay in one hunk, split by a `...` gap
    /// rather than dumping the untouched lines between them.
    #[test]
    fn edit_diff_splits_distant_changes_with_a_gap() {
        let d = render_edit_diff(
            &[json!({
                "old_string": "a\nb\nc\nd\ne\nf\ng\nh\ni",
                "new_string": "A\nb\nc\nd\ne\nf\ng\nh\nI",
            })],
            "a\nb\nc\nd\ne\nf\ng\nh\ni",
        );
        assert_eq!(
            d,
            "-    1 | a\n+    1 | A\n     2 | b\n     3 | c\n      ...\n     7 | g\n     8 | h\n-    9 | i\n+    9 | I"
        );
    }

    /// Nothing to show when the arguments do not change the file: the caller
    /// turns an empty diff into `None`.
    #[test]
    fn edit_diff_is_empty_for_a_no_op_edit() {
        let d = render_edit_diff(
            &[json!({"old_string": "two", "new_string": "two"})],
            "one\ntwo\nthree",
        );
        assert!(d.is_empty(), "unexpected: {d}");
    }

    #[test]
    fn edit_diff_shows_only_the_changed_line_amid_shared_context() {
        let d = render_edit_diff(
            &[json!({
                "old_string": "one\ntwo\nthree",
                "new_string": "one\nTWO\nthree",
            })],
            "one\ntwo\nthree",
        );
        assert_eq!(
            d,
            "     1 | one\n-    2 | two\n+    2 | TWO\n     3 | three"
        );
    }

    #[test]
    fn edit_diff_numbers_inserted_lines_against_new_content() {
        let d = render_edit_diff(
            &[json!({"old_string": "b", "new_string": "b\nc\nd"})],
            "a\nb\ne",
        );
        assert_eq!(
            d,
            "     1 | a\n     2 | b\n+    3 | c\n+    4 | d\n     5 | e"
        );
    }

    #[test]
    fn write_diff_headers_created_vs_overwrote() {
        assert_eq!(
            render_write_diff(None, "x\ny"),
            "@@ created file @@\n+    1 | x\n+    2 | y"
        );
        assert_eq!(
            render_write_diff(Some("old"), "x"),
            "@@ overwrote file @@\n+    1 | x"
        );
    }

    #[tokio::test]
    async fn preview_diff_does_not_write_and_matches_execution_diff() {
        let root = unique_root();
        // edit preview reads the current file to number the hunk, but never writes.
        std::fs::write(root.join("p.txt"), b"foo").unwrap();
        let edit_preview = preview_diff(
            lookup("edit").unwrap(),
            &json!({"path": "p.txt", "edits": [{"old_string": "foo", "new_string": "bar"}]}),
            &root,
        )
        .await;
        assert_eq!(edit_preview.as_deref(), Some("-    1 | foo\n+    1 | bar"));
        assert_eq!(std::fs::read_to_string(root.join("p.txt")).unwrap(), "foo");

        // write preview reflects prior-file state and does not create the file.
        let write_preview = preview_diff(
            lookup("write").unwrap(),
            &json!({"path": "new.txt", "content": "hello"}),
            &root,
        )
        .await;
        assert_eq!(
            write_preview.as_deref(),
            Some("@@ created file @@\n+    1 | hello")
        );
        assert!(!root.join("new.txt").exists(), "preview must not write");

        // non-mutating tools have no preview.
        assert!(
            preview_diff(lookup("read").unwrap(), &json!({"path": "x"}), &root)
                .await
                .is_none()
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The diff is display-only for `edit` as well as `write`: the UI renders it,
    /// the model gets the concise summary and never the replayed hunk.
    #[tokio::test]
    async fn edit_diff_is_display_only_and_absent_from_model_content() {
        let root = unique_root();
        std::fs::write(root.join("e.txt"), b"foo").unwrap();
        let (content, diff) = execute_builtin_with_diff(
            lookup("edit").unwrap(),
            &json!({"path": "e.txt", "edits": [{"old_string": "foo", "new_string": "bar"}]}),
            &root,
        )
        .await;
        assert_eq!(content, "Applied 1 edit(s) to e.txt");
        assert!(
            !content.contains('+') && !content.contains('|'),
            "edit content must stay concise: {content}"
        );
        assert_eq!(diff.as_deref(), Some("-    1 | foo\n+    1 | bar"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn write_with_diff_keeps_content_concise() {
        let root = unique_root();
        let (content, diff) = execute_builtin_with_diff(
            lookup("write").unwrap(),
            &json!({"path": "w.txt", "content": "hello"}),
            &root,
        )
        .await;
        assert_eq!(content, "Created w.txt (5 bytes)");
        assert!(!content.contains('+'), "write content must stay concise");
        assert_eq!(diff.as_deref(), Some("@@ created file @@\n+    1 | hello"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The model sees only `content`, not the display diff, so an overwrite must
    /// be distinguishable from a create there -- otherwise clobbering a file
    /// reads exactly like creating one.
    #[tokio::test]
    async fn write_content_distinguishes_overwrite_from_create() {
        let root = unique_root();
        let w = lookup("write").unwrap();
        std::fs::write(root.join("o.txt"), b"ORIGINAL").unwrap();

        let (over, over_diff) =
            execute_builtin_with_diff(w, &json!({"path": "o.txt", "content": "new"}), &root).await;
        assert_eq!(over, "Overwrote o.txt (3 bytes)");
        assert!(over_diff.unwrap().starts_with("@@ overwrote file @@"));

        let created =
            execute_builtin(w, &json!({"path": "fresh.txt", "content": "new"}), &root).await;
        assert_eq!(created, "Created fresh.txt (3 bytes)");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn rewriting_identical_content_reports_no_change_and_no_diff() {
        let root = unique_root();
        let w = lookup("write").unwrap();
        std::fs::write(root.join("same.txt"), b"keep").unwrap();
        let (content, diff) =
            execute_builtin_with_diff(w, &json!({"path": "same.txt", "content": "keep"}), &root)
                .await;
        assert_eq!(content, "No change: same.txt already had these 4 bytes");
        assert!(diff.is_none(), "no-op write must not show a diff: {diff:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Byte count must be UTF-8 bytes actually on disk, not character count.
    #[tokio::test]
    async fn write_reports_utf8_byte_count() {
        let root = unique_root();
        let out = execute_builtin(
            lookup("write").unwrap(),
            &json!({"path": "u.txt", "content": "héllo→"}),
            &root,
        )
        .await;
        let on_disk = std::fs::metadata(root.join("u.txt")).unwrap().len();
        assert_eq!(on_disk, 9);
        assert_eq!(out, "Created u.txt (9 bytes)");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A `../` path really does land outside the project, so the reported
    /// location must be the resolved target rather than the raw argument.
    #[tokio::test]
    async fn write_reports_resolved_path_when_it_escapes_the_project() {
        let root = unique_root();
        let outside = root.parent().unwrap().join("jan_escape_probe.txt");
        // The probe lands in the shared temp directory, so a leftover from an
        // earlier run turns the write into "No change" and the test into a
        // check of nothing. Removed before and after rather than trusted.
        let _ = std::fs::remove_file(&outside);
        let out = execute_builtin(
            lookup("write").unwrap(),
            &json!({"path": "../jan_escape_probe.txt", "content": "x"}),
            &root,
        )
        .await;
        assert!(outside.exists(), "precondition: the write escapes the root");
        // Compared in the separator the tool reports in. It normalises to
        // forward slashes so one path has one spelling everywhere; asserting
        // against the raw `PathBuf` would be asserting Windows' separator
        // rather than the destination.
        let expected = outside.to_string_lossy().replace('\\', "/");
        assert!(
            out.contains(&expected),
            "must name the real destination, got: {out}"
        );
        assert!(!out.contains(".."), "must not echo the raw path: {out}");
        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// With write confinement enabled, a `..` write is refused at the handler,
    /// independent of the gate -- the defense-in-depth layer.
    #[tokio::test]
    async fn confined_write_refuses_escape_at_handler() {
        let root = unique_root();
        let store = crate::workspace::project_store(&root);
        let ctx = ToolContext::new(&root, &store, &[]).with_confined_writes(true);
        let out = super::execute_builtin(
            lookup("write").unwrap(),
            &json!({"path": "../escape.txt", "content": "x"}),
            &ctx,
        )
        .await
        .0;
        assert!(
            out.starts_with("ERROR: refused to write outside"),
            "got: {out}"
        );
        assert!(!root.parent().unwrap().join("escape.txt").exists());

        let out = super::execute_builtin(
            lookup("edit").unwrap(),
            &json!({"path": "../escape.txt", "edits": [{"old_string": "a", "new_string": "b"}]}),
            &ctx,
        )
        .await
        .0;
        assert!(
            out.starts_with("ERROR: refused to edit outside"),
            "got: {out}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn write_and_edit_errors_name_the_path() {
        let root = unique_root();
        std::fs::write(root.join("blocker"), b"x").unwrap();
        let w = execute_builtin(
            lookup("write").unwrap(),
            &json!({"path": "blocker/child.txt", "content": "d"}),
            &root,
        )
        .await;
        assert!(w.starts_with("ERROR: blocker/child.txt: "), "got: {w}");

        std::fs::write(root.join("e.txt"), b"foo").unwrap();
        let e = execute_builtin(
            lookup("edit").unwrap(),
            &json!({"path": "e.txt", "edits": [{"old_string": "nope", "new_string": "x"}]}),
            &root,
        )
        .await;
        assert_eq!(e, "ERROR: e.txt: edit 1: old_string not found");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `find` from a legitimate `/tmp` base must not walk *out* through a
    /// symlinked directory inside the scratch. Pins `WalkBuilder`'s
    /// no-follow default, which is what the containment check cannot cover:
    /// the base path here is honest, only the recursion would escape.
    #[tokio::test]
    #[cfg(target_os = "linux")]
    async fn find_does_not_recurse_out_of_the_scratch_via_a_symlink() {
        let root = unique_root();
        let scratch = unique_root();
        let outside = unique_root();
        std::fs::write(outside.join("secret.txt"), b"classified").unwrap();
        std::os::unix::fs::symlink(&outside, scratch.join("esc")).unwrap();
        let store = crate::workspace::project_store(&root);
        let ctx = ToolContext::new(&root, &store, &[]).with_scratch_root(&scratch);
        let out = super::execute_builtin(
            lookup("find").unwrap(),
            &json!({"pattern": "*.txt", "path": "/tmp"}),
            &ctx,
        )
        .await
        .0;
        assert!(
            !out.contains("secret.txt"),
            "walked out of the scratch through a symlink: {out}"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&scratch);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// A recursive `grep` must not follow a *file* symlink out of the root.
    /// The directory-symlink case is covered by WalkBuilder's no-follow default
    /// (directories are recursed, symlinks to dirs are not entered), but a
    /// symlink to a file is not classified as a directory and would be opened
    /// and read. Skip every symlink so a planted `key -> $HOME/.ssh/id_rsa`
    /// cannot be disclosed without a separate approval.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn grep_does_not_read_a_file_symlink_out_of_the_root() {
        let root = unique_root();
        let outside = unique_root();
        std::fs::write(outside.join("secret.txt"), b"classified").unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("key.txt")).unwrap();
        std::fs::write(root.join("real.txt"), b"plain").unwrap();
        let out = execute_builtin(
            lookup("grep").unwrap(),
            &json!({"pattern": "classified", "path": "."}),
            &root,
        )
        .await;
        assert!(
            !out.contains("secret") && !out.contains("classified"),
            "read through a file symlink outside the root: {out}"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// The escaping-symlink refusals must not become a blanket "no symlinks":
    /// a link that stays inside the workspace is ordinary (every yarn workspace
    /// links `node_modules/<pkg>` back into the repo), so `grep` still searches
    /// through it and `read` still opens it.
    #[cfg(unix)]
    #[tokio::test]
    async fn in_root_symlinks_stay_readable_and_searchable() {
        let root = unique_root();
        std::fs::create_dir_all(root.join("pkg")).unwrap();
        std::fs::write(root.join("pkg/index.js"), b"needle here").unwrap();
        std::os::unix::fs::symlink(root.join("pkg/index.js"), root.join("linked.js")).unwrap();

        let out = execute_builtin(
            lookup("read").unwrap(),
            &json!({"path": "linked.js"}),
            &root,
        )
        .await;
        assert!(out.contains("needle"), "in-root symlink was refused: {out}");

        let out = execute_builtin(
            lookup("grep").unwrap(),
            &json!({"pattern": "needle", "path": "."}),
            &root,
        )
        .await;
        assert!(
            out.contains("linked.js"),
            "in-root symlink was skipped: {out}"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A redirected spill directory must refuse to write through it. The shell
    /// can replace `scratch/jan-bash` with a symlink to a host directory (or
    /// point `jan-bash` at one), so both spill entry points must come up empty
    /// rather than place the model's bytes at an attacker-chosen location.
    #[cfg(unix)]
    #[test]
    fn spill_writing_refuses_a_redirected_spill_dir() {
        let scratch = unique_root();
        let outside = unique_root();
        std::os::unix::fs::symlink(&outside, scratch.join("jan-bash")).unwrap();

        assert!(
            new_temp_path(Some(&scratch)).is_none(),
            "dir symlink accepted"
        );
        assert!(
            write_temp_output("x", Some(&scratch)).is_none(),
            "wrote through a redirected spill dir"
        );
        // The outside host directory is untouched.
        assert_eq!(
            std::fs::read_dir(&outside).unwrap().count(),
            0,
            "host files created via a symlinked spill dir"
        );
        let _ = std::fs::remove_dir_all(&scratch);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// A spill *file* that is a planted symlink must never be opened (truncated
    /// and written through), so the host target it points at stays intact.
    #[cfg(unix)]
    #[test]
    fn spill_file_writes_never_follow_a_planted_symlink() {
        let scratch = unique_root();
        let outside = unique_root();
        std::fs::create_dir_all(scratch.join("jan-bash")).unwrap();
        let victim = outside.join("victim.txt");
        std::fs::write(&victim, b"precious").unwrap();
        let planted = scratch.join("jan-bash/spill.txt");
        std::os::unix::fs::symlink(&victim, &planted).unwrap();

        assert!(open_spill_file(&planted).is_err(), "opened a spill symlink");
        assert_eq!(
            std::fs::read_to_string(&victim).unwrap(),
            "precious",
            "wrote through the spill symlink to the host file"
        );
        let _ = std::fs::remove_dir_all(&scratch);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// The write escape the scratch clamp is there to stop, spelled with a
    /// symlink instead of `..`: a confined `write` through `/tmp/esc` must be
    /// refused and must leave nothing behind outside the scratch.
    #[tokio::test]
    #[cfg(target_os = "linux")]
    async fn confined_write_refuses_a_tmp_symlink_escape() {
        let root = unique_root();
        let scratch = unique_root();
        let outside = unique_root();
        std::os::unix::fs::symlink(&outside, scratch.join("esc")).unwrap();
        let store = crate::workspace::project_store(&root);
        let ctx = ToolContext::new(&root, &store, &[])
            .with_scratch_root(&scratch)
            .with_confined_writes(true);
        let out = super::execute_builtin(
            lookup("write").unwrap(),
            &json!({"path": "/tmp/esc/pwned.txt", "content": "x"}),
            &ctx,
        )
        .await
        .0;
        assert!(out.starts_with("ERROR"), "must be refused, got: {out}");
        assert!(
            !outside.join("pwned.txt").exists(),
            "wrote outside the scratch via a symlink"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&scratch);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// The handler itself re-checks for symlinks immediately before opening,
    /// closing the gate-vs-use window. A read through a planted symlink must be
    /// refused (not silently resolved), even when the gate already allowed the
    /// path inside the root.
    #[cfg(unix)]
    #[tokio::test]
    async fn read_refuses_a_symlink_redirected_file() {
        let root = unique_root();
        let outside = unique_root();
        std::fs::write(outside.join("secret.txt"), b"classified").unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("link.txt")).unwrap();
        let out =
            execute_builtin(lookup("read").unwrap(), &json!({"path": "link.txt"}), &root).await;
        assert!(out.starts_with("ERROR"), "must refuse, got: {out}");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// The same re-check on the writing side, and it must fire *before* the
    /// parent directories are created: a refused write that has already made
    /// directories through the planted link has still touched the host.
    #[cfg(unix)]
    #[tokio::test]
    async fn write_and_edit_refuse_a_symlink_redirected_file() {
        let root = unique_root();
        let outside = unique_root();
        std::fs::write(outside.join("victim.txt"), b"precious").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();

        let out = execute_builtin(
            lookup("write").unwrap(),
            &json!({"path": "escape/victim.txt", "content": "owned"}),
            &root,
        )
        .await;
        assert!(out.starts_with("ERROR"), "write must refuse, got: {out}");

        let out = execute_builtin(
            lookup("edit").unwrap(),
            &json!({"path": "escape/victim.txt", "edits": [{"old_string": "precious", "new_string": "owned"}]}),
            &root,
        )
        .await;
        assert!(out.starts_with("ERROR"), "edit must refuse, got: {out}");

        assert_eq!(
            std::fs::read_to_string(outside.join("victim.txt")).unwrap(),
            "precious"
        );
        // Nothing was created through the link on the way to the refusal.
        assert_eq!(
            std::fs::read_dir(&outside).unwrap().count(),
            1,
            "directories were created through the symlink"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// A `write` to `/tmp/x` lands in the session scratch, and a `read` of the
    /// same path sees it: every fs tool shares the one `/tmp` the shell sees.
    #[tokio::test]
    #[cfg(target_os = "linux")]
    async fn write_then_read_via_tmp_persists_in_scratch() {
        let root = unique_root();
        let scratch = unique_root();
        let store = crate::workspace::project_store(&root);
        let ctx = ToolContext::new(&root, &store, &[]).with_scratch_root(&scratch);
        let out = super::execute_builtin(
            lookup("write").unwrap(),
            &json!({"path": "/tmp/scratch.txt", "content": "persist"}),
            &ctx,
        )
        .await
        .0;
        assert!(out.starts_with("Created /tmp/scratch.txt"), "got: {out}");
        assert!(scratch.join("scratch.txt").exists(), "wrote into scratch");

        let out = super::execute_builtin(
            lookup("read").unwrap(),
            &json!({"path": "/tmp/scratch.txt"}),
            &ctx,
        )
        .await
        .0;
        assert_eq!(out, "persist");

        // No stray file on the real host /tmp.
        assert!(!Path::new("/tmp/scratch.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&scratch);
    }

    /// The bare `/tmp` dir resolves to the scratch root; files written there by
    /// the shell (or a sibling tool) are listable through the file tools.
    #[test]
    #[cfg(target_os = "linux")]
    fn resolve_path_maps_tmp_into_scratch() {
        let root = unique_root();
        let scratch = unique_root();
        assert_eq!(
            crate::tools::sandbox::resolve_path(&root, Some(&scratch), "/tmp/a/b.txt"),
            scratch.join("a/b.txt")
        );
        assert_eq!(
            crate::tools::sandbox::resolve_path(&root, Some(&scratch), "/tmp"),
            scratch
        );
        // Without a scratch, /tmp stays the host path (i.e. never the project).
        assert_eq!(
            crate::tools::sandbox::resolve_path(&root, None, "/tmp/a.txt"),
            Path::new("/tmp/a.txt")
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&scratch);
    }

    /// A `..` climb inside `/tmp` must NOT escape the session scratch: an
    /// absolute path maps into the scratch, and a `..` is clamped back to the
    /// scratch root (chroot semantics, matching the `/tmp` bind mount), so it
    /// can never reach the host temp.
    #[test]
    #[cfg(target_os = "linux")]
    fn tmp_path_cannot_climb_out_with_dotdot() {
        let root = unique_root();
        let scratch = unique_root();
        // `/tmp/../evil.txt` clamps inside the scratch, never the host parent.
        let out = crate::tools::sandbox::resolve_path(&root, Some(&scratch), "/tmp/../evil.txt");
        assert!(
            out.starts_with(&scratch),
            "must stay inside the scratch, got: {out:?}"
        );
        assert_eq!(out, scratch.join("evil.txt"));
        // Even a deeper climb stays clamped at the scratch root.
        let deep =
            crate::tools::sandbox::resolve_path(&root, Some(&scratch), "/tmp/../../deep.txt");
        assert_eq!(deep, scratch.join("deep.txt"));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&scratch);
    }

    /// The gate treats a scratch-backed `/tmp` write as inside, not an escape.
    #[test]
    #[cfg(target_os = "linux")]
    fn gate_allows_tmp_write_when_scratch_is_set() {
        let root = unique_root();
        let scratch = unique_root();
        let d = crate::tools::gate::resolve_decision(
            lookup("write").unwrap(),
            &json!({"path": "/tmp/x.txt", "content": "y"}),
            &root,
            Some(&scratch),
            &[],
            &crate::permissions::ToolPermissions::default(),
            &crate::tools::gate::SessionGrants::default(),
            true,
            &crate::subject::Subject::MainAgent,
        );
        assert_eq!(
            d,
            crate::tools::gate::Decision::Prompt(crate::tools::gate::PromptKind::Write),
            "in-scratch write is an in-project write, not an escape"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&scratch);
    }

    /// The counterpart: the same write spelled through a symlink out of the
    /// scratch is an escape, so it takes the escape prompt (refused outright on
    /// the desktop) rather than the ordinary in-project one.
    #[test]
    #[cfg(target_os = "linux")]
    fn gate_treats_a_tmp_symlink_escape_as_an_escape() {
        let root = unique_root();
        let scratch = unique_root();
        let outside = unique_root();
        std::os::unix::fs::symlink(&outside, scratch.join("esc")).unwrap();
        let d = crate::tools::gate::resolve_decision(
            lookup("write").unwrap(),
            &json!({"path": "/tmp/esc/x.txt", "content": "y"}),
            &root,
            Some(&scratch),
            &[],
            &crate::permissions::ToolPermissions::default(),
            &crate::tools::gate::SessionGrants::default(),
            true,
            &crate::subject::Subject::MainAgent,
        );
        assert_eq!(
            d,
            crate::tools::gate::Decision::Prompt(crate::tools::gate::PromptKind::WriteEscape)
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&scratch);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[tokio::test]
    async fn edit_error_yields_no_diff() {
        let root = unique_root();
        std::fs::write(root.join("err.txt"), b"foo").unwrap();
        let (content, diff) = execute_builtin_with_diff(
            lookup("edit").unwrap(),
            &json!({"path": "err.txt", "edits": [{"old_string": "nope", "new_string": "x"}]}),
            &root,
        )
        .await;
        assert!(content.starts_with("ERROR"), "unexpected: {content}");
        assert!(diff.is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn ls_lists_created_file() {
        let root = unique_root();
        std::fs::write(root.join("listed.txt"), b"x").unwrap();
        let out = execute_builtin(lookup("ls").unwrap(), &json!({}), &root).await;
        assert!(out.contains("listed.txt"), "unexpected: {out}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Hidden means absent from the listing, not present-but-unopenable: an
    /// entry the agent can never read is only an invitation to try.
    #[tokio::test]
    async fn ls_omits_the_hidden_jan_dir() {
        let root = unique_root();
        std::fs::create_dir_all(root.join(".jan/agent")).unwrap();
        std::fs::write(root.join("src.rs"), b"x").unwrap();
        std::fs::write(root.join("JAN.md"), b"x").unwrap();
        let out = execute_builtin(lookup("ls").unwrap(), &json!({}), &root).await;
        assert!(out.contains("src.rs"), "unexpected: {out}");
        assert!(out.contains("JAN.md"), "unexpected: {out}");
        assert!(
            !out.contains(".jan/"),
            "must not list the agent state dir: {out}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// When the shell is unconfined (CLI with --no-sandbox) the `.jan` directory
    /// is ordinary project state and is listed, not hidden.
    #[tokio::test]
    async fn ls_lists_the_jan_dir_when_unconfined() {
        let root = unique_root();
        std::fs::create_dir_all(root.join(".jan/agent")).unwrap();
        std::fs::write(root.join(".jan/agent/agent.toml"), b"[tools]\n").unwrap();
        std::fs::write(root.join("src.rs"), b"x").unwrap();
        let store = crate::workspace::project_store(&root);
        let ctx = ToolContext::new(&root, &store, &[]).with_sandbox(false);
        let out = super::execute_builtin(lookup("ls").unwrap(), &json!({}), &ctx)
            .await
            .0;
        assert!(out.contains("src.rs"), "unexpected: {out}");
        assert!(
            out.contains(".jan/"),
            "must list .jan when unconfined: {out}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn find_glob_respects_gitignore() {
        let root = unique_root();
        std::fs::create_dir_all(root.join("keep")).unwrap();
        std::fs::create_dir_all(root.join("skip")).unwrap();
        std::fs::write(root.join("keep/a.txt"), b"x").unwrap();
        std::fs::write(root.join("skip/b.txt"), b"x").unwrap();
        std::fs::write(root.join(".gitignore"), b"skip/\n").unwrap();
        let out = execute_builtin(
            lookup("find").unwrap(),
            &json!({"pattern": "**/*.txt"}),
            &root,
        )
        .await;
        assert!(out.contains("keep/a.txt"), "should include keep: {out}");
        assert!(
            !out.contains("skip/b.txt"),
            "should exclude gitignored skip: {out}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn find_does_not_leak_the_hidden_jan_tree() {
        let root = unique_root();
        std::fs::create_dir_all(root.join(".jan/agent/threads/t1")).unwrap();
        std::fs::write(root.join(".jan/agent/threads/t1/thread.json"), b"{}").unwrap();
        std::fs::write(root.join(".jan/agent/agent.toml"), b"[tools]\n").unwrap();
        // Directly under `.jan`, outside `agent/`: hidden by the same rule.
        std::fs::write(root.join(".jan/stray.txt"), b"x").unwrap();
        std::fs::write(root.join("JAN.md"), b"instructions").unwrap();
        std::fs::write(root.join("README.md"), b"x").unwrap();
        let out =
            execute_builtin(lookup("find").unwrap(), &json!({"pattern": "**/*"}), &root).await;
        assert!(
            out.contains("README.md"),
            "should include project file: {out}"
        );
        assert!(
            out.contains("JAN.md"),
            "the root instructions file is an ordinary project file: {out}"
        );
        assert!(
            !out.contains("thread.json"),
            "must not leak thread storage: {out}"
        );
        assert!(
            !out.contains("agent.toml"),
            "must not leak agent config: {out}"
        );
        assert!(
            !out.contains("stray.txt"),
            "the whole .jan dir is hidden, not just agent/: {out}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn grep_does_not_leak_hidden_jan_contents() {
        let root = unique_root();
        std::fs::create_dir_all(root.join(".jan/agent/threads/t1")).unwrap();
        std::fs::write(
            root.join(".jan/agent/threads/t1/messages.jsonl"),
            b"SECRET_MARKER thread content",
        )
        .unwrap();
        std::fs::write(root.join(".jan/agent/agent.toml"), b"SECRET_MARKER config").unwrap();
        std::fs::write(root.join("README.md"), b"SECRET_MARKER readme").unwrap();
        let out = execute_builtin(
            lookup("grep").unwrap(),
            &json!({"pattern": "SECRET_MARKER"}),
            &root,
        )
        .await;
        assert!(
            out.contains("README.md"),
            "should match project file: {out}"
        );
        assert!(
            !out.contains("messages.jsonl"),
            "must not grep thread storage: {out}"
        );
        assert!(
            !out.contains("agent.toml"),
            "must not grep agent config: {out}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn grep_regex_and_literal_and_ignore_case() {
        let root = unique_root();
        std::fs::write(
            root.join("code.rs"),
            b"fn main() {}\nLet x = 1.5;\nother line",
        )
        .unwrap();

        let re = execute_builtin(
            lookup("grep").unwrap(),
            &json!({"pattern": "fn \\w+"}),
            &root,
        )
        .await;
        assert!(re.contains("code.rs:1:fn main"), "regex: {re}");

        // Literal: "1.5" as regex would match "1x5" too; literal must match exactly.
        let lit = execute_builtin(
            lookup("grep").unwrap(),
            &json!({"pattern": "1.5", "literal": true}),
            &root,
        )
        .await;
        assert!(lit.contains("code.rs:2:"), "literal: {lit}");

        let ci = execute_builtin(
            lookup("grep").unwrap(),
            &json!({"pattern": "let", "ignore_case": true}),
            &root,
        )
        .await;
        assert!(ci.contains("code.rs:2:"), "ignore_case: {ci}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn grep_invalid_pattern_errors() {
        let root = unique_root();
        std::fs::write(root.join("f.txt"), b"x").unwrap();
        let out = execute_builtin(lookup("grep").unwrap(), &json!({"pattern": "("}), &root).await;
        assert!(
            out.starts_with("ERROR: invalid pattern"),
            "unexpected: {out}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A command's output reaches the sink as it is produced, not just in the
    /// returned string -- this is what makes a long command visible while it runs.
    #[tokio::test]
    async fn bash_streams_output_to_the_sink() {
        let root = unique_root();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let sink = {
            let seen = seen.clone();
            std::sync::Arc::new(move |chunk: String| {
                seen.lock().unwrap().push_str(&chunk);
            }) as crate::tools::OutputSink
        };
        let store = crate::workspace::project_store(&root);
        let ctx = ToolContext::new(&root, &store, &[])
            .with_sandbox(false)
            .with_output_sink(sink);
        let out = super::execute_builtin(
            lookup("bash").unwrap(),
            &json!({"command": "printf 'one\ntwo\n'"}),
            &ctx,
        )
        .await
        .0;
        let streamed = seen.lock().unwrap().clone();
        assert!(streamed.contains("one"), "sink saw nothing: {streamed:?}");
        assert!(
            streamed.contains("two"),
            "sink missed a chunk: {streamed:?}"
        );
        // The return value still carries it, so the model's view is unchanged.
        assert!(out.contains("one") && out.contains("two"), "{out}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A sandboxed command runs when the workspace is spelled relatively, as it
    /// is under Jan's default `./data` data folder. The confined helper starts
    /// in the workspace, so a relative path handed to it named somewhere else,
    /// and every command failed in setup with "workspace does not exist" --
    /// found by the Windows managed-worktree scenario once a shell started.
    #[cfg(windows)]
    #[tokio::test]
    async fn a_sandboxed_command_runs_in_a_relatively_spelled_workspace() {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let rel = PathBuf::from("target").join(format!(
            "jan-relative-ws-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&rel).unwrap();
        let store = crate::workspace::project_store(&rel);
        let ctx = ToolContext::new(&rel, &store, &[]);
        // The target is spelled absolutely so this is about how the workspace
        // is handed to the sandbox, not about the shell's working directory.
        let target = anchored(&rel.join("made.txt"));
        let out = super::execute_builtin(
            lookup("bash").unwrap(),
            &json!({"command": format!("echo made > \"{}\"", target.display())}),
            &ctx,
        )
        .await
        .0;
        // No skip for "no shell could be started": on the old code that is
        // exactly how this failed -- the probe ran under the relative spelling
        // too -- so it has to fail the test, not excuse it.
        assert!(!out.contains("does not exist"), "{out}");
        assert!(rel.join("made.txt").is_file(), "the command did not run: {out}");
        let _ = std::fs::remove_dir_all(&rel);
        crate::tools::appcontainer::release(&anchored(&rel));
    }

    /// A relative path in a sandboxed command lands in the workspace, whatever
    /// shell was selected. Windows PowerShell in an AppContainer started at a
    /// drive root instead (`G:\` here), so `echo x > f.txt` wrote elsewhere.
    #[cfg(windows)]
    #[tokio::test]
    async fn a_sandboxed_command_starts_in_its_workspace() {
        let root = unique_root();
        let store = crate::workspace::project_store(&root);
        let ctx = ToolContext::new(&root, &store, &[]);
        let out = super::execute_builtin(
            lookup("bash").unwrap(),
            &json!({"command": "echo here > relative.txt"}),
            &ctx,
        )
        .await
        .0;
        assert!(
            root.join("relative.txt").is_file(),
            "a relative path did not land in the workspace: {out}"
        );
        let _ = std::fs::remove_dir_all(&root);
        crate::tools::appcontainer::release(&root);
    }

    /// A backgrounded command keeps streaming after the call has returned its
    /// `job_id`: the sink lives in the detached task, which is the whole reason
    /// waiting on a long job can show progress.
    #[tokio::test]
    async fn a_backgrounded_command_keeps_streaming() {
        let root = unique_root();
        let command = command_or_skip!(
            &root,
            Shape::SleepThenPrint {
                seconds: 1,
                text: "late",
            }
        );
        let seen = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let sink = {
            let seen = seen.clone();
            std::sync::Arc::new(move |chunk: String| {
                seen.lock().unwrap().push_str(&chunk);
            }) as crate::tools::OutputSink
        };
        let store = crate::workspace::project_store(&root);
        let ctx = ToolContext::new(&root, &store, &[])
            .with_sandbox(false)
            .with_output_sink(sink);
        // timeout 0 => backgrounds immediately, before the command prints.
        let out = super::execute_builtin(
            lookup("bash").unwrap(),
            &json!({ "command": command, "timeout": 0, "background": true }),
            &ctx,
        )
        .await
        .0;
        assert!(out.contains("job_id=bash-"), "should background: {out}");
        assert!(
            seen.lock().unwrap().is_empty(),
            "nothing printed yet at hand-off"
        );
        // The detached task is still running and still holds the sink.
        tokio::time::sleep(std::time::Duration::from_millis(900)).await;
        let streamed = seen.lock().unwrap().clone();
        assert!(
            streamed.contains("late"),
            "a backgrounded job must keep reporting: {streamed:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_cancelled_call_stops_before_it_runs_and_says_who_stopped_it() {
        // AH-023 through the real dispatch path: every built-in, not just bash.
        use crate::lifecycle::{Scope, StopReason, Token};
        let root = unique_root();
        std::fs::write(root.join("a.txt"), "hello").unwrap();

        let token = Token::new(Scope::new("s1", "r1", "c1"));
        token.stop(StopReason::Cancelled);

        let store = crate::workspace::project_store(&root);
        let ctx = ToolContext::new(&root, &store, &[]).with_cancel(token);
        let (out, _) =
            super::execute_builtin(lookup("read").unwrap(), &json!({ "path": "a.txt" }), &ctx)
                .await;

        assert!(out.starts_with("ERROR"), "{out}");
        assert!(out.contains("was cancelled"), "{out}");
        // Distinguishable from a deadline.
        assert!(!out.contains("exceeded its time limit"), "{out}");
        // The file's contents must not leak through a cancelled call.
        assert!(!out.contains("hello"), "{out}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn an_uncancelled_read_still_works() {
        // The wrapper must not change the ordinary path.
        let root = unique_root();
        std::fs::write(root.join("a.txt"), "hello").unwrap();
        let store = crate::workspace::project_store(&root);
        let ctx = ToolContext::new(&root, &store, &[]);
        let (out, _) =
            super::execute_builtin(lookup("read").unwrap(), &json!({ "path": "a.txt" }), &ctx)
                .await;
        assert!(out.contains("hello"), "{out}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn bash_exceeding_its_timeout_is_terminated_not_backgrounded() {
        // AH-020. This previously asserted the opposite: that a command past
        // its deadline was shelved and kept running. An unowned process that
        // outlives every limit placed on it is the defect, not the feature.
        let root = unique_root();
        let command = command_or_skip!(&root, Shape::Sleep { seconds: 5 });
        let out = execute_builtin(
            lookup("bash").unwrap(),
            &json!({ "command": command, "timeout": 0 }),
            &root,
        )
        .await;
        assert!(out.starts_with("ERROR"), "a timeout is an error: {out}");
        assert!(out.contains("timed out"), "{out}");
        assert!(out.contains("terminated"), "{out}");
        // Distinguishable from a user cancellation, and it says how to ask for
        // the old behaviour deliberately.
        assert!(out.contains("not a cancellation"), "{out}");
        assert!(out.contains("background"), "{out}");
        assert!(
            !out.contains("continuing in the background"),
            "must not shelve the command: {out}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_timeout_keeps_whatever_the_command_printed_first() {
        // Partial output survives the kill: the run still gets to see what the
        // command managed to say before its deadline, and the command is gone.
        //
        // The deadline fires the moment the output has been read, not after a
        // guessed second. With a one-second timeout, a sandboxed shell that
        // started slowly on a busy machine was killed before it had printed
        // anything -- the output read only `[exit 1]` -- and the test failed
        // without any output having been lost.
        let root = unique_root();
        let command = command_or_skip!(
            &root,
            Shape::PrintPidThenSleep {
                text: "partial",
                seconds: 60,
            }
        );
        let fire = test_deadline(&root);
        let streamed = std::sync::Arc::new(Mutex::new(String::new()));
        let sink: crate::tools::OutputSink = {
            let streamed = streamed.clone();
            let fire = fire.clone();
            std::sync::Arc::new(move |chunk: String| {
                let mut all = streamed.lock().unwrap();
                all.push_str(&chunk);
                if all.contains("partial") {
                    fire.notify_one();
                }
            })
        };
        let store = crate::workspace::project_store(&root);
        let ctx = ToolContext::new(&root, &store, &[]).with_output_sink(sink);
        // The real deadline is far away: only the injected one can fire. The
        // outer bound only turns "never printed" into a failure, not a hang.
        let out = tokio::time::timeout(
            std::time::Duration::from_secs(180),
            super::execute_builtin(
                lookup("bash").unwrap(),
                &json!({ "command": command, "timeout": 600 }),
                &ctx,
            ),
        )
        .await
        .unwrap_or_else(|_| panic!("the command never printed: {:?}", streamed.lock().unwrap()))
        .0;

        assert!(out.starts_with("ERROR"), "{out}");
        assert!(out.contains("timed out"), "{out}");
        assert!(
            out.contains("partial"),
            "output printed before the deadline must survive: {out}"
        );
        assert!(
            !out.contains("may not have terminated cleanly"),
            "the kill must be reported as clean: {out}"
        );

        // And the tree is gone: the shell and the child it started, neither
        // left running behind the call that owned them.
        let printed = streamed.lock().unwrap().clone();
        let id_of = |key: &str| -> u32 {
            printed
                .lines()
                .find_map(|line| line.trim().strip_prefix(key))
                .and_then(|pid| pid.trim().parse().ok())
                .unwrap_or_else(|| panic!("the command did not report {key}: {printed:?}"))
        };
        for (what, pid) in [("the shell", id_of("pid=")), ("its child", id_of("child="))] {
            let mut gone = false;
            for _ in 0..100 {
                if !process_alive(pid) {
                    gone = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            assert!(gone, "{what} (pid {pid}) outlived the timeout");
        }
        test_deadlines().lock().unwrap().remove(&root);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Whether `pid` still names a running process.
    #[cfg(windows)]
    fn process_alive(pid: u32) -> bool {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = unsafe { GetExitCodeProcess(handle, &mut code) } != 0;
        unsafe { CloseHandle(handle) };
        ok && code == 259
    }

    #[cfg(unix)]
    fn process_alive(pid: u32) -> bool {
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), None).is_ok()
    }

    #[tokio::test]
    async fn backgrounding_is_available_when_it_is_asked_for() {
        let root = unique_root();
        let command = command_or_skip!(&root, Shape::Sleep { seconds: 2 });
        let out = execute_builtin(
            lookup("bash").unwrap(),
            &json!({ "command": command, "timeout": 0, "background": true }),
            &root,
        )
        .await;
        assert!(!out.starts_with("ERROR"), "unexpected: {out}");
        assert!(out.contains("continuing in the background"), "{out}");
        assert!(out.contains("job_id=bash-"), "{out}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn bash_job_id_waits_for_and_collects_background_output() {
        let root = unique_root();
        let command = command_or_skip!(
            &root,
            Shape::SleepThenPrint {
                seconds: 1,
                text: "done",
            }
        );
        let started = execute_builtin(
            lookup("bash").unwrap(),
            &json!({ "command": command, "timeout": 0, "background": true }),
            &root,
        )
        .await;
        let job_id = started
            .split("job_id=")
            .nth(1)
            .unwrap()
            .split_whitespace()
            .next()
            .unwrap()
            .trim_end_matches(|c: char| !c.is_alphanumeric());

        let collected =
            execute_builtin(lookup("bash").unwrap(), &json!({"job_id": job_id}), &root).await;
        assert!(collected.contains("done"), "unexpected: {collected}");

        // The job is removed once collected.
        let again =
            execute_builtin(lookup("bash").unwrap(), &json!({"job_id": job_id}), &root).await;
        assert!(
            again.starts_with("ERROR: unknown or already-collected"),
            "unexpected: {again}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn bash_unknown_job_id_errors() {
        let root = unique_root();
        let out = execute_builtin(lookup("bash").unwrap(), &json!({"job_id": "nope"}), &root).await;
        assert!(
            out.starts_with("ERROR: unknown or already-collected"),
            "unexpected: {out}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn bash_command_takes_precedence_over_spurious_job_id() {
        let root = unique_root();
        let command = command_or_skip!(&root, Shape::Literal("hello"));
        for job_id in ["", " ", "x"] {
            let out = execute_builtin(
                lookup("bash").unwrap(),
                &json!({ "command": command, "job_id": job_id }),
                &root,
            )
            .await;
            assert!(out.contains("hello"), "job_id {job_id:?}: {out}");
            assert!(out.contains("[exit 0]"), "job_id {job_id:?}: {out}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn bash_missing_command_and_job_id_errors() {
        let root = unique_root();
        let out = execute_builtin(lookup("bash").unwrap(), &json!({}), &root).await;
        assert!(out.starts_with("ERROR: missing required argument"), "{out}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn bash_result_failed_detects_nonzero_and_signal_markers() {
        assert!(bash_result_failed("output\n[exit 1]"));
        assert!(bash_result_failed("output\n[exit 127]"));
        assert!(bash_result_failed("[terminated by signal]"));
        // Truncation note follows the marker on its own line: still detected.
        assert!(bash_result_failed(
            "output\n[exit 2]\n[output truncated at 10 of 99 bytes]"
        ));
        assert!(!bash_result_failed("output\n[exit 0]"));
        assert!(!bash_result_failed("plain output, no marker"));
    }

    #[tokio::test]
    async fn bash_nonzero_exit_is_not_error() {
        let root = unique_root();
        let out = execute_builtin(
            lookup("bash").unwrap(),
            &json!({"command": "echo hi; exit 3"}),
            &root,
        )
        .await;
        assert!(!out.starts_with("ERROR"), "unexpected: {out}");
        assert!(out.contains("hi"), "unexpected: {out}");
        assert!(out.contains("[exit 3]"), "unexpected: {out}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn bash_success_emits_exit_0_marker() {
        let root = unique_root();
        let out = execute_builtin(
            lookup("bash").unwrap(),
            &json!({"command": "echo done"}),
            &root,
        )
        .await;
        assert!(!out.starts_with("ERROR"), "unexpected: {out}");
        assert!(out.contains("done"), "unexpected: {out}");
        assert!(out.contains("[exit 0]"), "unexpected: {out}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn bash_exit_marker_is_on_its_own_line() {
        let root = unique_root();
        let command = command_or_skip!(&root, Shape::StderrNoNewline("to remote"));
        // stderr-only output with no trailing newline (mirrors `git push`).
        let out = execute_builtin(
            lookup("bash").unwrap(),
            &json!({ "command": command }),
            &root,
        )
        .await;
        assert!(
            out.contains("\n[exit 0]"),
            "marker not on its own line: {out}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn bash_output_past_old_64kb_cap_survives_intact() {
        let root = unique_root();
        let command = command_or_skip!(&root, Shape::PaddedLines { count: 2000 });
        // ~128KB of output: over the shared 64KB cap, under the bash cap.
        let out = execute_builtin(
            lookup("bash").unwrap(),
            &json!({ "command": command }),
            &root,
        )
        .await;
        assert!(!out.starts_with("ERROR"), "unexpected: {out}");
        assert!(
            !out.contains("[truncated"),
            "should not truncate: len={}",
            out.len()
        );
        assert!(out.len() > 64 * 1024, "expected >64KB, got {}", out.len());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn bash_cr_progress_is_collapsed_not_truncated() {
        let root = unique_root();
        let command = command_or_skip!(
            &root,
            Shape::StderrRedraw {
                count: 30000,
                prefix: "Receiving objects: ",
            }
        );
        // Mimics git progress: one logical line redrawn thousands of times with
        // \r (no \n). Raw bytes exceed the byte cap, but only the final redraw
        // is visible, so the model must see it intact with no truncation notice.
        let out = execute_builtin(
            lookup("bash").unwrap(),
            &json!({ "command": command }),
            &root,
        )
        .await;
        assert!(
            !out.contains("output truncated"),
            "spurious truncation: {out}"
        );
        assert!(
            out.contains("Receiving objects: 30000"),
            "final redraw lost: {out}"
        );
        assert!(out.contains("[exit 0]"), "unexpected: {out}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn bash_output_overflow_spills_to_readable_temp_file() {
        let root = unique_root();
        let command = command_or_skip!(&root, Shape::PaddedLines { count: 16000 });
        // ~1MB of output: over the bash cap, so it must spill to a temp file
        // and tell the agent how to read the rest.
        let out = execute_builtin(
            lookup("bash").unwrap(),
            &json!({ "command": command }),
            &root,
        )
        .await;
        assert!(
            out.contains("output truncated at"),
            "unexpected: end of {out}"
        );
        assert!(
            out.contains("Use the read tool"),
            "should guide the agent: {out}"
        );
        let path = out
            .rsplit("full output written to ")
            .next()
            .and_then(|s| s.split(". Use the read tool").next())
            .unwrap_or("");
        let full = execute_builtin(
            lookup("read").unwrap(),
            &json!({"path": path, "offset": 15999, "limit": 1}),
            &root,
        )
        .await;
        assert!(
            full.contains("015999") || full.contains("016000"),
            "tail readable: {full}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The same overflow with a session scratch set: the spill must land in the
    /// scratch and be advertised by the one name that works from both the fs
    /// tools and the shell, so the `read` the note asks for actually finds it.
    /// The no-scratch case above cannot catch this -- there `/tmp` is not remapped.
    #[tokio::test]
    async fn bash_spill_is_readable_when_a_scratch_is_set() {
        let root = unique_root();
        let command = command_or_skip!(&root, Shape::PaddedLines { count: 16000 });
        let scratch = unique_root();
        let store = crate::workspace::project_store(&root);
        let ctx = ToolContext::new(&root, &store, &[]).with_scratch_root(&scratch);
        let out = super::execute_builtin(
            lookup("bash").unwrap(),
            &json!({ "command": command }),
            &ctx,
        )
        .await
        .0;
        let path = out
            .rsplit("full output written to ")
            .next()
            .and_then(|s| s.split(". Use the read tool").next())
            .unwrap_or("");
        if cfg!(target_os = "linux") {
            assert!(
                path.starts_with("/tmp/"),
                "must be advertised as the /tmp name the shell also sees: {out}"
            );
        }
        let full = super::execute_builtin(
            lookup("read").unwrap(),
            &json!({"path": path, "offset": 15999, "limit": 1}),
            &ctx,
        )
        .await
        .0;
        assert!(
            full.contains("015999") || full.contains("016000"),
            "spill at {path} must be readable back: {full}"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&scratch);
    }

    /// With the sandbox off, `bash` runs bare instead of being wrapped or
    /// withheld. The point of the opt-out is that it works on a machine where
    /// no backend can be established, so this must not depend on one.
    #[cfg(unix)]
    #[tokio::test]
    async fn unsandboxed_bash_runs_without_a_backend() {
        let root = unique_root();
        let store = crate::workspace::project_store(&root);
        let ctx = ToolContext::new(&root, &store, &[]).with_sandbox(false);
        let out = super::execute_builtin(
            lookup("bash").unwrap(),
            &json!({"command": "echo unconfined"}),
            &ctx,
        )
        .await
        .0;
        assert!(
            out.contains("unconfined"),
            "unsandboxed bash did not run: {out}"
        );
        assert!(
            !out.contains("no OS sandbox could be established"),
            "withheld despite the opt-out: {out}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Dropping the sandbox drops the scratch with it, in either builder order.
    /// A scratch that outlived the sandbox would leave the fs tools rewriting
    /// `/tmp/...` into a directory the unconfined shell never looks at.
    #[test]
    fn unsandboxed_context_has_no_scratch() {
        let root = unique_root();
        let scratch = unique_root();
        let store = crate::workspace::project_store(&root);
        assert!(ToolContext::new(&root, &store, &[])
            .with_scratch_root(&scratch)
            .with_sandbox(false)
            .scratch_root
            .is_none());
        assert!(ToolContext::new(&root, &store, &[])
            .with_sandbox(false)
            .with_scratch_root(&scratch)
            .scratch_root
            .is_none());
        // The sandboxed default still binds it.
        assert_eq!(
            ToolContext::new(&root, &store, &[])
                .with_scratch_root(&scratch)
                .scratch_root,
            Some(scratch.as_path())
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[tokio::test]
    async fn bash_line_overflow_keeps_the_tail_not_the_head() {
        let root = unique_root();
        let command = command_or_skip!(&root, Shape::Lines { count: 12000 });
        // 12000 short lines: over the 10000-line cap but under the byte cap.
        // Tail truncation must keep the LAST lines (final result/errors) and
        // drop the earliest ones.
        let out = execute_builtin(
            lookup("bash").unwrap(),
            &json!({ "command": command }),
            &root,
        )
        .await;
        assert!(
            out.contains("output truncated at"),
            "should truncate: end of {out}"
        );
        assert!(
            out.contains("\nL12000\n"),
            "last line must survive: end of {out}"
        );
        assert!(!out.contains("\nL5\n"), "earliest lines must be dropped");
        assert!(out.contains("[exit 0]"), "exit marker must survive: {out}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn bash_strips_control_chars_but_keeps_text() {
        let root = unique_root();
        // NUL and bell around visible text plus an ANSI color escape, written in
        // the language of the shell that will run it. `printf` in PowerShell is
        // an unknown command, and this test used to pass there only because
        // PowerShell's error echoes the command line, which contains "red".
        let command = match sandbox_flavor(&root) {
            Some(proc::ShellFlavor::PowerShell) => {
                "Write-Output (\"a\" + [char]0 + \"b\" + [char]7 + [char]27 + \"[31mr\" + \"ed\" + [char]27 + \"[0m\")"
            }
            Some(proc::ShellFlavor::Cmd) | None => {
                eprintln!("skipped: no shell here can print raw control characters");
                return;
            }
            Some(proc::ShellFlavor::Posix) => "printf 'a\\000b\\007\\033[31mr''ed\\033[0m\\n'",
        };
        let out = execute_builtin(lookup("bash").unwrap(), &json!({"command": command}), &root).await;
        // "red" never appears in the command itself, so an error that echoes
        // the command cannot satisfy this.
        assert!(
            out.contains("red") && !out.contains("not recognized") && !out.contains("not found"),
            "text must survive sanitization: {out:?}"
        );
        assert!(!out.contains('\u{0}'), "NUL must be stripped");
        assert!(!out.contains('\u{7}'), "bell must be stripped");
        assert!(!out.contains('\u{1b}'), "escape must be stripped");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn bash_command_reading_stdin_does_not_hang() {
        let root = unique_root();
        let command = command_or_skip!(&root, Shape::ReadStdin);
        // stdin is /dev/null, so a command that reads it gets immediate EOF and
        // returns instead of blocking the agent loop forever (e.g. a `sudo`
        // password prompt). The failure/output comes back as a normal result.
        let out = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            execute_builtin(
                lookup("bash").unwrap(),
                &json!({ "command": command }),
                &root,
            ),
        )
        .await
        .expect("must not hang on stdin read");
        assert!(out.contains("[exit 0]"), "unexpected: {out}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn bash_missing_working_dir_errors() {
        let root = unique_root().join("does-not-exist");
        let out = execute_builtin(
            lookup("bash").unwrap(),
            &json!({"command": "echo hi"}),
            &root,
        )
        .await;
        assert!(
            out.starts_with("ERROR: working directory does not exist"),
            "unexpected: {out}"
        );
    }

    #[tokio::test]
    async fn memory_write_read_list_roundtrip() {
        let root = unique_root();
        let w = execute_builtin(
            lookup("memory_write").unwrap(),
            &json!({"name": "drift", "content": "553 behind"}),
            &root,
        )
        .await;
        assert!(w.starts_with("Wrote"), "unexpected: {w}");
        // Landed at the canonical workspace path.
        assert_eq!(
            std::fs::read_to_string(root.join(".jan/agent/memory/drift.md")).unwrap(),
            "553 behind"
        );

        let r = execute_builtin(
            lookup("memory_read").unwrap(),
            &json!({"name": "drift"}),
            &root,
        )
        .await;
        assert_eq!(r, "553 behind");

        let l = execute_builtin(lookup("memory_list").unwrap(), &json!({}), &root).await;
        assert_eq!(l, "drift");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// AH-121: `skill_list` and `skill_read` reach the user's own skills from
    /// any project, a project skill of the same name wins, and the enabled
    /// whitelist still applies.
    #[tokio::test]
    async fn skill_tools_reach_user_skills_and_the_project_shadows_them() {
        let base = std::env::temp_dir().join(format!(
            "jan_user_skill_tools_{}",
            std::time::SystemTime::UNIX_EPOCH.elapsed().unwrap().as_nanos()
        ));
        let root = base.join("proj");
        let store = crate::workspace::project_store(&root);
        let user = base.join("user-store");
        std::fs::create_dir_all(&root).unwrap();
        crate::skills::write(&user, "house-style", "---\ndescription: house rules\n---\nSay HOUSE.").unwrap();
        crate::skills::write(&user, "deploy", "---\ndescription: user deploy\n---\nUSER DEPLOY").unwrap();
        crate::skills::write(&store, "deploy", "---\ndescription: project deploy\n---\nPROJECT DEPLOY").unwrap();

        let enabled: Vec<String> = Vec::new();
        let ctx = ToolContext::new(&root, &store, &enabled).with_user_skills(Some(&user));
        let list = super::execute_builtin(lookup("skill_list").unwrap(), &json!({}), &ctx).await.0;
        assert!(list.contains("house-style — house rules"), "{list}");
        assert!(list.contains("deploy — project deploy") && !list.contains("user deploy"), "{list}");
        let read = |name: &str| json!({ "name": name });
        let body = super::execute_builtin(lookup("skill_read").unwrap(), &read("house-style"), &ctx).await.0;
        assert_eq!(body.trim(), "Say HOUSE.");
        let deploy = super::execute_builtin(lookup("skill_read").unwrap(), &read("deploy"), &ctx).await.0;
        assert_eq!(deploy.trim(), "PROJECT DEPLOY");

        // Without the user store, the project sees only its own.
        let bare = ToolContext::new(&root, &store, &enabled);
        let missing = super::execute_builtin(lookup("skill_read").unwrap(), &read("house-style"), &bare).await.0;
        assert!(missing.starts_with("ERROR"), "{missing}");

        // The whitelist governs user skills too.
        let only_deploy = vec!["deploy".to_string()];
        let narrow = ToolContext::new(&root, &store, &only_deploy).with_user_skills(Some(&user));
        let hidden = super::execute_builtin(lookup("skill_read").unwrap(), &read("house-style"), &narrow).await.0;
        assert!(hidden.starts_with("ERROR"), "{hidden}");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The attached-project layer and the user's own skills together: the
    /// catalogue filters (AH-040 unusable tools, AH-124 unmet requirements)
    /// apply to project and user entries alike, a dependency may be met by the
    /// project layer, and a name the project hides reaches neither the store
    /// nor the user layer.
    #[tokio::test]
    async fn skill_catalogue_filters_apply_to_project_and_user_layers() {
        use crate::permissions::{PermissionDefault, ToolPermissions};
        let sandbox = unique_root();
        let store = unique_root();
        let user = unique_root();
        let project = crate::workspace::project_store(&unique_root());
        let skill = |at: &std::path::Path, name: &str, content: &str| {
            crate::skills::write(at, name, content).unwrap();
        };
        skill(&project, "proj-shell", "---\ndescription: project shell\nallowed-tools: [bash]\n---\nPROJECT SHELL");
        skill(&project, "proj-dep", "---\ndescription: project dep\nrequires:\n  - absent >=1.0\n---\nPROJECT DEP");
        skill(&project, "proj-ok", "---\ndescription: project ok\nversion: 2.0.0\n---\nPROJECT OK");
        skill(&project, "off", "---\ndescription: project off\n---\nPROJECT OFF");
        std::fs::write(
            project.join("agent.toml"),
            "[skills]\nenabled = [\"proj-shell\", \"proj-dep\", \"proj-ok\"]\n",
        )
        .unwrap();
        skill(&store, "off", "---\ndescription: store off\n---\nSTORE OFF");
        skill(&user, "off", "---\ndescription: user off\n---\nUSER OFF");
        skill(&user, "user-shell", "---\ndescription: user shell\nallowed-tools: [bash]\n---\nUSER SHELL");
        skill(&user, "user-dep", "---\ndescription: user dep\nrequires:\n  - absent >=1.0\n---\nUSER DEP");
        skill(&user, "user-ok", "---\ndescription: user ok\nrequires:\n  - proj-ok >=2.0\n---\nUSER OK");

        let enabled: [String; 0] = [];
        let subject = crate::subject::Subject::MainAgent;
        let denied = ToolPermissions::new(PermissionDefault::Allow, &[], &["bash".into()], &[]);
        let ctx = ToolContext::new(&sandbox, &store, &enabled)
            .with_skill_project(Some(&project))
            .with_user_skills(Some(&user))
            .with_permissions(&denied, &subject);
        let run = |name: &'static str, args: serde_json::Value| {
            let ctx = ctx.clone();
            async move { super::execute_builtin(lookup(name).unwrap(), &args, &ctx).await.0 }
        };

        let list = run("skill_list", json!({})).await;
        assert!(list.contains("proj-ok (v2.0.0) — project ok"), "{list}");
        assert!(list.contains("user-ok — user ok"), "a dependency met by the project: {list}");
        for absent in ["proj-shell", "user-shell", "proj-dep", "user-dep", "off"] {
            assert!(!list.contains(absent), "{absent} offered: {list}");
        }

        let off = run("skill_read", json!({"name": "off"})).await;
        assert!(off.starts_with("ERROR"), "{off}");
        assert!(!off.contains("STORE OFF") && !off.contains("USER OFF"), "{off}");
        let shell = run("skill_read", json!({"name": "user-shell"})).await;
        assert!(shell.starts_with("ERROR [permission_denied]"), "{shell}");
        let dep = run("skill_read", json!({"name": "user-dep"})).await;
        assert!(dep.starts_with("ERROR [invalid_input]"), "{dep}");
        let ok = run("skill_read", json!({"name": "user-ok"})).await;
        assert_eq!(ok.trim(), "USER OK");
        for dir in [&sandbox, &store, &user] {
            let _ = std::fs::remove_dir_all(dir);
        }
        let _ = std::fs::remove_dir_all(project.parent().and_then(|p| p.parent()).unwrap());
    }

    /// AH-124: a skill whose dependency is not installed is refused by name,
    /// with what is missing in the refusal, and is not offered in the
    /// catalogue either -- an entry that always ends in a refusal is worse
    /// than no entry.
    #[tokio::test]
    async fn a_skill_whose_dependency_is_absent_is_refused_and_not_listed() {
        let root = unique_root();
        let skills = root.join(".jan/agent/skills");
        std::fs::create_dir_all(skills.join("release")).unwrap();
        std::fs::write(
            skills.join("release/SKILL.md"),
            "---\nname: release\ndescription: Cut a release\nrequires:\n  - deploy >=2.0\n---\n\ncut it",
        )
        .unwrap();

        let refused = execute_builtin(
            lookup("skill_read").unwrap(),
            &json!({"name": "release"}),
            &root,
        )
        .await;
        assert!(refused.starts_with("ERROR [invalid_input]"), "{refused}");
        assert!(refused.contains("'deploy'"), "{refused}");
        assert!(refused.contains("not installed"), "{refused}");
        assert!(!refused.contains("cut it"), "the body was handed over anyway: {refused}");

        let listed = execute_builtin(lookup("skill_list").unwrap(), &json!({}), &root).await;
        assert!(!listed.contains("release"), "unexpected list: {listed}");

        // Installed, at a version the requirement allows: loaded, and listed
        // with the version it declares.
        std::fs::create_dir_all(skills.join("deploy")).unwrap();
        std::fs::write(
            skills.join("deploy/SKILL.md"),
            "---\nname: deploy\ndescription: Ship it\nversion: 2.1.0\n---\n\nship it",
        )
        .unwrap();
        let body = execute_builtin(
            lookup("skill_read").unwrap(),
            &json!({"name": "release"}),
            &root,
        )
        .await;
        assert_eq!(body, "cut it");
        let listed = execute_builtin(lookup("skill_list").unwrap(), &json!({}), &root).await;
        assert!(listed.contains("deploy (v2.1.0)"), "unexpected list: {listed}");
        assert!(listed.contains("release"), "unexpected list: {listed}");

        // Downgraded below the bound: refused again, saying what is installed.
        std::fs::write(
            skills.join("deploy/SKILL.md"),
            "---\nname: deploy\ndescription: Ship it\nversion: 1.0.0\n---\n\nship it",
        )
        .unwrap();
        let refused = execute_builtin(
            lookup("skill_read").unwrap(),
            &json!({"name": "release"}),
            &root,
        )
        .await;
        assert!(refused.contains("is 1.0.0"), "{refused}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// AH-124: a skill that names a tool this run does not have is withheld,
    /// and the same skill is loaded where the tool exists.
    #[tokio::test]
    async fn a_skill_naming_a_tool_this_run_lacks_is_withheld() {
        let root = unique_root();
        let skills = root.join(".jan/agent/skills");
        std::fs::create_dir_all(skills.join("shipping")).unwrap();
        std::fs::write(
            skills.join("shipping/SKILL.md"),
            "---\nname: shipping\ndescription: Ship\nallowed-tools:\n  - deploy_tool\n---\n\nrun it",
        )
        .unwrap();
        let store = crate::workspace::project_store(&root);
        let none: Vec<String> = vec!["read".to_string()];
        let without = ToolContext::new(&root, &store, &[]).with_available_tools(&none);
        let refused = super::execute_builtin(
            lookup("skill_read").unwrap(),
            &json!({"name": "shipping"}),
            &without,
        )
        .await
        .0;
        assert!(refused.contains("deploy_tool"), "{refused}");

        let have = vec!["read".to_string(), "deploy_tool".to_string()];
        let with = ToolContext::new(&root, &store, &[]).with_available_tools(&have);
        let body = super::execute_builtin(
            lookup("skill_read").unwrap(),
            &json!({"name": "shipping"}),
            &with,
        )
        .await
        .0;
        assert_eq!(body, "run it");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// AH-149/AH-150: what the agent wrote goes through the project's own
    /// formatter, and the diff a person reviews is what the file now holds --
    /// not the version the next `cargo fmt` would rewrite.
    #[tokio::test]
    async fn an_edited_file_is_formatted_before_its_diff_is_shown() {
        let root = unique_root();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("Cargo.toml"),
            "[package]\nname = \"x\"\nedition = \"2021\"\n",
        )
        .unwrap();
        let store = crate::workspace::project_store(&root);
        let badly_laid_out = "pub fn main( ) {let  x  =  1;}\n";

        // Off: the file is left exactly as the model wrote it.
        let plain = ToolContext::new(&root, &store, &[]);
        let (_, diff, _) = super::execute_builtin_with_diff(
            lookup("write").unwrap(),
            &json!({"path": "a.rs", "content": badly_laid_out}),
            &plain,
        )
        .await;
        assert_eq!(std::fs::read_to_string(root.join("a.rs")).unwrap(), badly_laid_out);
        let diff = diff.expect("a diff");
        assert!(!diff.contains("formatted with"), "{diff}");

        // On: the formatter runs, the file is what it left, and the diff says
        // which formatter and on what evidence.
        std::fs::write(root.join("a.rs"), "pub fn main() {}\n").unwrap();
        let formatting = ToolContext::new(&root, &store, &[]).with_format_on_edit(true);
        let (_, diff, _) = super::execute_builtin_with_diff(
            lookup("write").unwrap(),
            &json!({"path": "a.rs", "content": badly_laid_out}),
            &formatting,
        )
        .await;
        let on_disk = std::fs::read_to_string(root.join("a.rs")).unwrap();
        assert!(on_disk.contains("let x = 1;"), "{on_disk}");
        let diff = diff.expect("a diff");
        assert!(diff.contains("formatted with rustfmt"), "{diff}");
        assert!(diff.contains("Cargo.toml (edition 2021)"), "{diff}");
        // The diff is the formatted text, not what the model wrote.
        assert!(diff.contains("let x = 1;"), "{diff}");
        assert!(!diff.contains("let  x  =  1;"), "{diff}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A formatter that refuses the file leaves the edit and its diff alone,
    /// and says so rather than staying silent about having tried.
    #[tokio::test]
    async fn a_formatter_that_refuses_leaves_the_diff_and_says_why() {
        let root = unique_root();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("Cargo.toml"),
            "[package]\nname = \"x\"\nedition = \"2021\"\n",
        )
        .unwrap();
        let store = crate::workspace::project_store(&root);
        let not_rust = "fn main( { this is not rust\n";
        let ctx = ToolContext::new(&root, &store, &[]).with_format_on_edit(true);
        let (_, diff, _) = super::execute_builtin_with_diff(
            lookup("write").unwrap(),
            &json!({"path": "a.rs", "content": not_rust}),
            &ctx,
        )
        .await;
        assert_eq!(std::fs::read_to_string(root.join("a.rs")).unwrap(), not_rust);
        let diff = diff.expect("a diff");
        assert!(diff.contains("rustfmt refused the file"), "{diff}");
        assert!(!diff.contains("formatted with"), "{diff}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A project that says nothing about how it is formatted has nothing run
    /// against it, however familiar the file extension looks.
    #[tokio::test]
    async fn a_project_with_no_declared_formatter_has_nothing_run() {
        let root = unique_root();
        std::fs::create_dir_all(&root).unwrap();
        let store = crate::workspace::project_store(&root);
        let content = "const   x=1\n";
        let ctx = ToolContext::new(&root, &store, &[]).with_format_on_edit(true);
        let (_, diff, _) = super::execute_builtin_with_diff(
            lookup("write").unwrap(),
            &json!({"path": "a.ts", "content": content}),
            &ctx,
        )
        .await;
        assert_eq!(std::fs::read_to_string(root.join("a.ts")).unwrap(), content);
        assert!(!diff.unwrap_or_default().contains("formatted"), "nothing should have run");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn skill_write_creates_folder_form_and_skill_read_returns_body() {
        let root = unique_root();
        let w = execute_builtin(
            lookup("skill_write").unwrap(),
            &json!({"name": "deploy.md", "content": "steps"}),
            &root,
        )
        .await;
        assert!(w.contains("deploy"), "unexpected: {w}");
        // New skills are written as the folder form `<name>/SKILL.md`.
        assert!(root.join(".jan/agent/skills/deploy/SKILL.md").exists());

        // skill_read returns the body on demand (progressive disclosure).
        let r = execute_builtin(
            lookup("skill_read").unwrap(),
            &json!({"name": "deploy"}),
            &root,
        )
        .await;
        assert_eq!(r, "steps");

        // skill_list surfaces the catalog line.
        let l = execute_builtin(lookup("skill_list").unwrap(), &json!({}), &root).await;
        assert!(l.contains("deploy"), "unexpected list: {l}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn built_in_jan_skill_is_available_without_project_skills() {
        let root = unique_root();

        let list = execute_builtin(lookup("skill_list").unwrap(), &json!({}), &root).await;
        assert!(
            list.lines()
                .any(|line| line == "jan" || line.starts_with("jan — ")),
            "unexpected list: {list}"
        );

        let body = execute_builtin(
            lookup("skill_read").unwrap(),
            &json!({"name": "jan"}),
            &root,
        )
        .await;
        assert!(!body.trim().is_empty(), "unexpected body: {body}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn skill_tools_hide_disabled_skills() {
        let root = unique_root();
        execute_builtin(
            lookup("skill_write").unwrap(),
            &json!({"name": "on", "content": "on body"}),
            &root,
        )
        .await;
        execute_builtin(
            lookup("skill_write").unwrap(),
            &json!({"name": "off", "content": "off body"}),
            &root,
        )
        .await;
        // Whitelist only "on". The whitelist is injected, so this no longer
        // needs an agent.toml round-trip to set up.
        let enabled = ["on".to_string()];
        let store = crate::workspace::project_store(&root);
        let ctx = ToolContext::new(&root, &store, &enabled);

        let list = super::execute_builtin(lookup("skill_list").unwrap(), &json!({}), &ctx)
            .await
            .0;
        assert!(list.contains("on"), "list: {list}");
        assert!(!list.contains("off body"), "disabled skill leaked: {list}");

        // Disabled skill is unreadable.
        let read_off =
            super::execute_builtin(lookup("skill_read").unwrap(), &json!({"name": "off"}), &ctx)
                .await
                .0;
        assert!(read_off.starts_with("ERROR"), "disabled read: {read_off}");

        // Enabled skill still readable.
        let read_on =
            super::execute_builtin(lookup("skill_read").unwrap(), &json!({"name": "on"}), &ctx)
                .await
                .0;
        assert_eq!(read_on, "on body");

        // A disabled skill is read-only for the model: writing to it is refused
        // and the on-disk content is untouched.
        let write_off = super::execute_builtin(
            lookup("skill_write").unwrap(),
            &json!({"name": "off", "content": "evil body"}),
            &ctx,
        )
        .await
        .0;
        assert!(
            write_off.starts_with("ERROR"),
            "disabled write: {write_off}"
        );
        let r =
            super::execute_builtin(lookup("skill_read").unwrap(), &json!({"name": "off"}), &ctx)
                .await
                .0;
        assert!(r.starts_with("ERROR"), "still disabled after write");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn skill_tools_hide_user_invoked_skills_from_model() {
        let root = unique_root();
        // A `disable-model-invocation: true` skill: only the human may fire it.
        execute_builtin(
            lookup("skill_write").unwrap(),
            &json!({"name": "secret",
                    "content": "---\ndescription: internal ritual\ndisable-model-invocation: true\n---\nsecret body"}),
            &root,
        )
        .await;
        execute_builtin(
            lookup("skill_write").unwrap(),
            &json!({"name": "plain", "content": "---\ndescription: open\n---\nplain body"}),
            &root,
        )
        .await;

        let list = execute_builtin(lookup("skill_list").unwrap(), &json!({}), &root).await;
        assert!(list.contains("plain"), "list: {list}");
        assert!(
            !list.contains("internal ritual"),
            "user-only skill leaked: {list}"
        );

        let read_secret = execute_builtin(
            lookup("skill_read").unwrap(),
            &json!({"name": "secret"}),
            &root,
        )
        .await;
        assert!(
            read_secret.starts_with("ERROR"),
            "user-only read: {read_secret}"
        );

        let read_plain = execute_builtin(
            lookup("skill_read").unwrap(),
            &json!({"name": "plain"}),
            &root,
        )
        .await;
        assert_eq!(read_plain, "plain body");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The desktop Cowork shape: filesystem tools confined to a sandbox, skill
    /// tools reading the permanent store plus the attached project's store.
    #[tokio::test]
    async fn skill_tools_offer_an_attached_projects_enabled_plugin_skills() {
        let sandbox = unique_root();
        let store = unique_root();
        let folder = unique_root();
        let project = crate::workspace::project_store(&folder);
        let plugin_skill = |plugin: &str, name: &str, body: &str| {
            let dir = project.join("plugins").join(plugin).join("skills").join(name);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("SKILL.md"), body).unwrap();
        };
        plugin_skill(
            "release",
            "prepare",
            "---\ndescription: Prepare a release\n---\nrun scripts/prep.sh",
        );
        plugin_skill("muted", "hush", "---\ndescription: muted\n---\nmuted body");
        std::fs::write(project.join("agent.toml"), "[plugins]\ndisabled = [\"muted\"]\n").unwrap();
        crate::skills::write(&store, "personal", "personal body").unwrap();

        let enabled: [String; 0] = [];
        let ctx = ToolContext::new(&sandbox, &store, &enabled).with_skill_project(Some(&project));
        let run = |name: &'static str, args: serde_json::Value| {
            let ctx = ctx.clone();
            async move { super::execute_builtin(lookup(name).unwrap(), &args, &ctx).await.0 }
        };

        let list = run("skill_list", json!({})).await;
        assert!(list.contains("release:prepare — Prepare a release"), "{list}");
        assert!(list.contains("personal"), "store skills stay offered: {list}");
        assert!(!list.contains("muted"), "disabled plugin leaked: {list}");

        let body = run("skill_read", json!({"name": "release:prepare"})).await;
        assert_eq!(body, "run scripts/prep.sh");
        // A disabled plugin's files are not readable through the skill tools.
        for name in ["muted:hush", "hush"] {
            let out = run("skill_read", json!({"name": name})).await;
            assert!(out.starts_with("ERROR"), "{name}: {out}");
            assert!(!out.contains("muted body"), "{name}: {out}");
        }

        // Plugin skills are read-only, and nothing lands in the plugin.
        let out = run("skill_write", json!({"name": "release:prepare", "content": "x"})).await;
        assert!(out.starts_with("ERROR") && out.contains("read-only"), "{out}");
        let out = run("skill_write", json!({"name": "prepare", "content": "x"})).await;
        assert!(out.starts_with("ERROR") && out.contains("read-only"), "{out}");
        assert_eq!(
            std::fs::read_to_string(project.join("plugins/release/skills/prepare/SKILL.md"))
                .unwrap(),
            "---\ndescription: Prepare a release\n---\nrun scripts/prep.sh"
        );
        // A new skill still goes to the writable store, not the project.
        let out = run("skill_write", json!({"name": "fresh", "content": "new"})).await;
        assert!(out.starts_with("Wrote"), "{out}");
        assert!(store.join("skills/fresh/SKILL.md").is_file());
        assert!(!project.join("skills/fresh").exists());

        // The project's own whitelist applies, read from its agent.toml.
        std::fs::write(
            project.join("agent.toml"),
            "[skills]\nenabled = [\"jan\"]\n[plugins]\ndisabled = [\"muted\"]\n",
        )
        .unwrap();
        let out = run("skill_read", json!({"name": "release:prepare"})).await;
        assert!(out.starts_with("ERROR"), "{out}");
        let list = run("skill_list", json!({})).await;
        assert!(!list.contains("release:prepare"), "{list}");

        for dir in [sandbox, store, folder] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[tokio::test]
    async fn workspace_name_rejects_traversal() {
        let root = unique_root();
        for bad in ["../escape", "sub/x", "..", ""] {
            let out = execute_builtin(
                lookup("memory_write").unwrap(),
                &json!({"name": bad, "content": "x"}),
                &root,
            )
            .await;
            assert!(
                out.starts_with("ERROR"),
                "name {bad:?} should be rejected: {out}"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }
    // ---- screenshot ---------------------------------------------------------

    /// Two headless Chromes racing for the same profile dir collide, so the
    /// tests that actually launch one are serialised.
    static CHROME_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[tokio::test]
    async fn screenshot_rejects_a_non_html_file() {
        let root = unique_root();
        std::fs::write(root.join("a.txt"), b"nope").unwrap();
        let (out, images) = screenshot(&json!({"path": "a.txt"}), &root, None, &[]).await;
        assert!(out.contains("only renders"), "{out}");
        assert!(images.is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn screenshot_rejects_a_missing_file() {
        let root = unique_root();
        let (out, images) = screenshot(&json!({"path": "gone.html"}), &root, None, &[]).await;
        assert!(out.contains("file not found"), "{out}");
        assert!(images.is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn screenshot_requires_a_path() {
        let root = unique_root();
        let (out, _) = screenshot(&json!({}), &root, None, &[]).await;
        assert!(out.contains("missing required argument"), "{out}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn screenshot_refuses_a_symlink_out_of_the_workspace() {
        let root = unique_root();
        let outside = unique_root();
        let secret = outside.join("secret.html");
        std::fs::write(&secret, b"<h1>secret</h1>").unwrap();
        let link = root.join("innocent.html");
        std::os::unix::fs::symlink(&secret, &link).unwrap();

        let (out, images) = screenshot(&json!({"path": "innocent.html"}), &root, None, &[]).await;
        assert!(out.contains("symlink"), "{out}");
        assert!(images.is_none());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// Renders for real when a browser is present, and returns an image part
    /// rather than a data URL buried in the text.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn screenshot_returns_an_image_part_when_chrome_is_present() {
        if chrome_binary().is_none() {
            return;
        }
        let _guard = CHROME_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = unique_root();
        std::fs::write(
            root.join("page.html"),
            b"<html><body style=\"background:#0af\"><h1>hi</h1></body></html>",
        )
        .unwrap();

        let (out, images) = screenshot(
            &json!({"path": "page.html", "width": 400, "height": 300}),
            &root,
            None,
            &[],
        )
        .await;
        assert!(!out.starts_with("ERROR"), "{out}");
        let images = images.expect("an image part");
        assert_eq!(images.len(), 1);
        assert!(images[0].data_url.starts_with("data:image/png;base64,"));
        assert_eq!(images[0].name, "page.html");
        // The base64 stays out of the model-facing text.
        assert!(!out.contains("base64"), "{out}");
        let _ = std::fs::remove_dir_all(&root);
    }

    // -- memory_propose --------------------------------------------------
    //
    // The typed proposal path. The model says a fact is worth remembering by
    // calling something; whether it is stored is decided by `memory::inferred`,
    // which the model cannot reach. These assert what actually lands on disk,
    // not what the reply says -- a tool that claims to have saved something is
    // the failure mode worth guarding.

    fn propose_ctx(root: &Path, store: &Path, temporary: bool) -> ToolContext<'static> {
        // Leaked deliberately: `ToolContext` borrows, and these live for the
        // test.
        let root: &'static Path = Box::leak(root.to_path_buf().into_boxed_path());
        let store: &'static Path = Box::leak(store.to_path_buf().into_boxed_path());
        ToolContext::new(root, store, &[]).in_session(Some("chat-a"), temporary)
    }

    fn allow_automatic(store: &Path) {
        std::fs::create_dir_all(store).expect("store");
        crate::memory::settings::save(
            store,
            &crate::memory::settings::Settings {
                automatically_save: true,
                ..Default::default()
            },
        )
        .expect("settings");
    }

    fn stored(store: &Path) -> Vec<String> {
        crate::memory::store::load(store, crate::memory::record::Scope::Session)
            .records
            .into_iter()
            .map(|r| r.content)
            .collect()
    }

    #[tokio::test]
    async fn memory_propose_asks_before_saving_by_default() {
        let root = unique_root();
        let store = root.join("store");
        let ctx = propose_ctx(&root, &store, false);
        let out = execute_text(
            lookup("memory_propose").unwrap(),
            &json!({"content": "The user prefers tabs over spaces."}),
            &ctx,
        )
        .await;
        assert!(out.contains("Not saved yet"), "{out}");
        assert!(
            out.contains("waiting for you"),
            "the reason must be specific: {out}"
        );
        // The question is stored so it survives the turn and a restart, but as
        // a proposal: `is_usable` admits `Active` only, so it reaches no prompt
        // while it waits for an answer.
        let records =
            crate::memory::store::load(&store, crate::memory::record::Scope::Session).records;
        assert_eq!(records.len(), 1);
        assert!(matches!(
            records[0].status,
            crate::memory::record::Status::Proposed { .. }
        ));
        assert!(
            !records[0].is_usable(records[0].created_at + 1),
            "an unanswered guess must never be injected"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn memory_propose_saves_once_the_user_allows_it() {
        let root = unique_root();
        let store = root.join("store");
        allow_automatic(&store);
        let ctx = propose_ctx(&root, &store, false);
        let out = execute_text(
            lookup("memory_propose").unwrap(),
            &json!({"content": "The user prefers tabs over spaces."}),
            &ctx,
        )
        .await;
        assert!(out.starts_with("Remembered"), "{out}");
        assert_eq!(stored(&store).len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The guard that matters most, and the one that was broken last time.
    #[tokio::test]
    async fn memory_propose_refuses_a_credential_even_when_allowed() {
        let root = unique_root();
        let store = root.join("store");
        allow_automatic(&store);
        let ctx = propose_ctx(&root, &store, false);
        for content in [
            "The API key is sk-live-abcdefghijklmnopqrstuvwxyz012345.",
            "Their token is ghp_9d7f6a5b4c3e2d1f0a9b8c7d6e5f4a3b2c1d0e.",
        ] {
            let out = execute_text(
                lookup("memory_propose").unwrap(),
                &json!({ "content": content }),
                &ctx,
            )
            .await;
            assert!(out.starts_with("ERROR: refused"), "{out}");
        }
        assert!(
            stored(&store).is_empty(),
            "a credential must never be stored"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn memory_propose_records_nothing_in_a_temporary_chat() {
        let root = unique_root();
        let store = root.join("store");
        allow_automatic(&store);
        let ctx = propose_ctx(&root, &store, true);
        let out = execute_text(
            lookup("memory_propose").unwrap(),
            &json!({"content": "The user prefers tabs over spaces."}),
            &ctx,
        )
        .await;
        assert!(out.contains("temporary"), "{out}");
        assert!(stored(&store).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A project memory lands in the store the readers open. It used to be
    /// written one directory above it, where nothing looked.
    #[tokio::test]
    async fn memory_propose_project_scope_is_saved_where_it_is_read_back() {
        let root = unique_root();
        let session_store = root.join("store");
        allow_automatic(&session_store);
        let ctx = propose_ctx(&root, &session_store, false);
        let out = execute_text(
            lookup("memory_propose").unwrap(),
            &json!({"content": "This project builds with yarn.", "scope": "project"}),
            &ctx,
        )
        .await;
        assert!(out.starts_with("Remembered") || out.contains("Not saved yet"), "{out}");
        let project = crate::workspace::project_store(&root);
        let records =
            crate::memory::store::load(&project, crate::memory::record::Scope::Project).records;
        assert_eq!(records.len(), 1, "the proposal was not written to the project store");
        assert_eq!(records[0].content, "This project builds with yarn.");
        assert!(
            !root.join(".jan").join("memory").exists(),
            "nothing may be written to the old, unread location"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The narrowest scope that is true, when the model does not say.
    #[tokio::test]
    async fn memory_propose_defaults_to_this_conversation_only() {
        let root = unique_root();
        let store = root.join("store");
        allow_automatic(&store);
        let ctx = propose_ctx(&root, &store, false);
        let out = execute_text(
            lookup("memory_propose").unwrap(),
            &json!({"content": "The user is debugging a flaky test."}),
            &ctx,
        )
        .await;
        assert!(out.contains("this conversation"), "{out}");
        // Nothing reached the wider scopes.
        assert!(
            crate::memory::store::load(&store, crate::memory::record::Scope::User)
                .records
                .is_empty()
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn memory_propose_needs_content() {
        let root = unique_root();
        let store = root.join("store");
        let ctx = propose_ctx(&root, &store, false);
        for args in [json!({}), json!({"content": "   "})] {
            let out = execute_text(lookup("memory_propose").unwrap(), &args, &ctx).await;
            assert!(out.starts_with("ERROR"), "{out}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The same fact twice confirms rather than multiplying: the id is derived
    /// from the content.
    #[tokio::test]
    async fn memory_propose_does_not_multiply_a_repeated_fact() {
        let root = unique_root();
        let store = root.join("store");
        allow_automatic(&store);
        let ctx = propose_ctx(&root, &store, false);
        let args = json!({"content": "The user prefers tabs over spaces."});
        let _ = execute_text(lookup("memory_propose").unwrap(), &args, &ctx).await;
        let _ = execute_text(lookup("memory_propose").unwrap(), &args, &ctx).await;
        assert_eq!(stored(&store).len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn memory_propose_is_advertised_with_a_usable_schema() {
        let schema = crate::tools::schema::builtin_tool_schemas()
            .into_iter()
            .find(|s| s["function"]["name"] == "memory_propose")
            .expect("memory_propose is advertised");
        let params = &schema["function"]["parameters"];
        assert_eq!(params["type"], "object");
        assert!(params["properties"]["content"].is_object());
        assert_eq!(params["required"][0], "content");
        // The model is told not to propose credentials, because the refusal
        // costs it a turn.
        let description = schema["function"]["description"].as_str().unwrap();
        assert!(description.contains("credentials"), "{description}");
    }
}
