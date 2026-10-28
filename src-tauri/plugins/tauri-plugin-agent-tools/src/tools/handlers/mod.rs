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
use crate::tools::nofollow;
use crate::tools::proc;
use crate::tools::sandbox::{
    canonicalize_lenient, escapes_write_roots, in_scratch, is_hidden_jan_path_in, lexical_normalize,
    refuse_windows_name, resolve_path, scratch_display_path, symlink_escapes_any_root, symlink_escapes_root,
};
use crate::tools::{BuiltinTool, ImageContentPart, ToolContext};

const MAX_BYTES: usize = 64 * 1024;
const MAX_LINES: usize = 2000;
/// Cap on a `read` image payload returned as an `image_url` content part.
/// Mirrors the TUI's `MAX_IMAGE_BYTES` so an oversized raster (or a large
/// text file whose name ends in an image extension) cannot flood the model
/// context as a base64 blob.
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
/// bash output caps, matching the `read` tool. Overflow is not lost: it spills
/// to a temp file the `read` tool can page through, so the cap is tuned for
/// context economy (~16k tokens worst case) rather than for fitting everything.
const BASH_MAX_BYTES: usize = MAX_BYTES;
/// Most of a command's output kept in its spill file.
const BASH_SPILL_MAX_BYTES: usize = 256 * 1024 * 1024;
const BASH_MAX_LINES: usize = MAX_LINES;
const GREP_MAX_LINE: usize = 500;
const LS_DEFAULT_LIMIT: usize = 500;
const FIND_DEFAULT_LIMIT: usize = 1000;
const GREP_DEFAULT_LIMIT: usize = 300;
/// Hard ceiling on grep matches returned to the model, whatever `limit` asks.
const GREP_MAX_RESULTS: usize = 300;
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
    let mut jobs = bash_jobs().lock().unwrap_or_else(|e| e.into_inner());
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
    let mut jobs = bash_jobs().lock().unwrap_or_else(|e| e.into_inner());
    let job = jobs.get_mut(job_id)?;
    if job.owner.as_deref() != owner {
        return None;
    }
    Some(job.status(job_id))
}

/// A job's recent output, redacted, for a status check. Never consumes the
/// result the collector is waiting for.
fn peek_tail(job_id: &str, owner: Option<&str>) -> Option<(String, usize)> {
    let jobs = bash_jobs().lock().unwrap_or_else(|e| e.into_inner());
    let job = jobs.get(job_id)?;
    if job.owner.as_deref() != owner {
        return None;
    }
    let tail = job.tail.lock().ok()?;
    Some((crate::audit::redact(&tail.text), tail.dropped))
}

/// A running job's output after absolute byte offset `offset` (offsets count
/// from the start of the job's output, including what the bounded tail has
/// since dropped), with the new offset. The text is redacted. Read only:
/// nothing here consumes the result a collector is waiting for.
pub fn bash_job_output_since(job_id: &str, owner: Option<&str>, offset: u64) -> Option<(String, u64)> {
    let jobs = bash_jobs().lock().unwrap_or_else(|e| e.into_inner());
    let job = jobs.get(job_id)?;
    if job.owner.as_deref() != owner {
        return None;
    }
    let tail = job.tail.lock().ok()?;
    let total = (tail.dropped + tail.text.len()) as u64;
    let start = offset.saturating_sub(tail.dropped as u64).min(tail.text.len() as u64) as usize;
    let mut from = start;
    while !tail.text.is_char_boundary(from) {
        from += 1;
    }
    Some((crate::audit::redact(&tail.text[from..]), total))
}

/// Make room for one more job under `owner`. Drops the oldest *finished*
/// uncollected job when the owner is at its limit; returns false when every
/// job it holds is still running, so the caller refuses rather than grows.
fn make_room_for(owner: Option<&str>) -> bool {
    let mut jobs = bash_jobs().lock().unwrap_or_else(|e| e.into_inner());
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
    let mut jobs = bash_jobs().lock().unwrap_or_else(|e| e.into_inner());
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

/// The text the shared-folder guard must read for `host_powershell`: its
/// argument is `script`; `command` is accepted too for a model that guesses.
fn powershell_guard_text(args: &serde_json::Value) -> Option<&str> {
    arg_str(args, "script").or_else(|| arg_str(args, "command"))
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
    let mut hook_input = crate::hooks::HookInput {
        tool_name: tool.name.to_string(),
        tool_input: args.clone(),
        tool_response: None,
        session_id: ctx.session_id.map(str::to_string),
        run_id: ctx.run_id.map(str::to_string),
        last_assistant_message: None,
    };
    let before = crate::hooks::run_with_input(
        &hooks,
        crate::hooks::Event::PreTool,
        Some(tool.name),
        &hook_ctx,
        &hook_input,
    )
    .await;
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

    // Shared-folder coordination: a branch moved under this session since its
    // last step is said once, on this call's result.
    let branch_moved = crate::shared_folder::tools::before_tool(ctx);

    let work = async {
        match tool.name {
            "read" => read_or_list(args, ctx).await,
            "screenshot" => screenshot(args, project_root, scratch, ctx.read_roots).await,
            "browser" => crate::tools::browser_tool::run(args, ctx).await,
            "computer" => crate::tools::computer::run(args).await,
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

    crate::shared_folder::tools::after_tool(ctx);
    if let Some(notice) = branch_moved {
        content.push_str("\n\n");
        content.push_str(&notice);
    }

    // A post-tool hook cannot undo what the tool did, so it never blocks. What
    // it can do is say something went wrong, where the model and the person
    // reading the transcript will both see it.
    hook_input.tool_response = Some(content.clone());
    let after = crate::hooks::run_with_input(
        &hooks,
        crate::hooks::Event::PostTool,
        Some(tool.name),
        &hook_ctx,
        &hook_input,
    )
    .await;
    for warning in &after.warnings {
        content.push_str(&format!("\n\n[post-tool hook] {}", warning.message));
    }
    for warning in &before.warnings {
        content.push_str(&format!("\n\n[pre-tool hook] {}", warning.message));
    }
    // A project whose hooks are off because its folder is not trusted says so,
    // once per run, where the model and the person reading will both see it:
    // a policy that silently does not apply is worse than one that is refused.
    if hooks.is_empty() {
        if let Some(note) = crate::hooks::untrusted_note(project_root) {
            let run = ctx.session_id.or(ctx.run_id).unwrap_or("-");
            if crate::folder_trust::first_notice(run, project_root) {
                content.push_str(&format!("\n\n{note}"));
            }
        }
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
        "read" => read_or_list(args, ctx).await.0,
        "ls" => {
            let out = ls(args, project_root, scratch, ctx.sandbox, ctx.read_roots, ctx.write_roots).await;
            with_project_hint(crate::invisible::clean(out), ctx, args)
        }
        "write" | "edit" => {
            let verb = if tool.name == "write" { "overwrite" } else { "edit" };
            // Another live session on this folder is editing the file: hold.
            // Advisory; see the shared-folder coordination design.
            if let Some(target) = tracked_path(args, ctx) {
                let shown = arg_str(args, "path").unwrap_or_default();
                if let Some(held) = crate::shared_folder::tools::write_gate(ctx, &target, shown) {
                    return held;
                }
            }
            if let Some(refusal) = stale_edit_refusal(verb, args, ctx).await {
                return refusal;
            }
            let out = if tool.name == "write" {
                write(args, project_root, scratch, ctx.confine_writes, ctx.write_roots).await
            } else {
                edit(args, project_root, scratch, ctx.confine_writes, ctx.write_roots).await
            };
            if !out.starts_with("ERROR") {
                if let Some((path, hash)) = record_seen(args, ctx).await {
                    crate::shared_folder::tools::record_write(ctx, &path, &hash);
                }
            }
            out
        }
        "bash" => {
            // A tree-changing git command while another live session shares
            // this folder is held, same as the `git` tool.
            if let Some(command) = arg_str(args, "command") {
                if let Some(held) =
                    crate::shared_folder::tools::guard_command(ctx, command, ctx.project_root)
                {
                    return held;
                }
            }
            bash(args, ctx).await
        }
        "find" => {
            let out = find(args, project_root, scratch, ctx.sandbox, ctx.read_roots, ctx.write_roots).await;
            with_project_hint(crate::invisible::clean(out), ctx, args)
        }
        "grep" => {
            let out = grep(args, project_root, scratch, ctx.sandbox, ctx.read_roots, ctx.write_roots).await;
            with_project_hint(crate::invisible::clean(out), ctx, args)
        }
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
        "skill_list" => skill_list(args, ctx),
        "skill_read" => skill_read(args, ctx),
        "skill_write" => skill_write(args, ctx),
        // Native web tools: compiled into the agent core, not an MCP server.
        "web_search" => crate::invisible::clean(crate::tools::web::web_search(args).await),
        "web_fetch" => {
            crate::invisible::clean(crate::tools::web::web_fetch(args, ctx.read_roots).await)
        }
        "git_inspect" => crate::tools::git_native::git_inspect(args, ctx.read_roots).await,
        "windows_events" => crate::tools::win_events::windows_events(args).await,
        "host_query" => crate::tools::host_read::host_query(args).await,
        "host_action" => crate::tools::host_action::host_action(args).await,
        "host_build" => crate::tools::host_build::run(args, ctx).await,
        "clipboard" => crate::tools::clipboard::clipboard(args).await,
        "ocr" => crate::tools::ocr::run(args, project_root, scratch, ctx.read_roots).await,
        "computer" => crate::tools::computer::run(args).await.0,
        "open_path" => crate::tools::open_path::run(args, ctx).await,
        "host_powershell" => {
            if let Some(command) = powershell_guard_text(args) {
                if let Some(held) =
                    crate::shared_folder::tools::guard_command(ctx, command, ctx.project_root)
                {
                    return held;
                }
            }
            crate::tools::host_powershell::run(args, ctx).await
        }
        "host_package" => crate::tools::host_package::host_package(args).await,
        "host_wsl" => {
            if let Some(command) = arg_str(args, "command") {
                if let Some(held) =
                    crate::shared_folder::tools::guard_command(ctx, command, ctx.project_root)
                {
                    return held;
                }
            }
            crate::tools::host_wsl::run(args, ctx).await
        }
        "host_ssh" => crate::tools::host_ssh::run(args).await,
        "notify_user" => crate::tools::notify_user::notify_user(args).await,
        "local_http" => crate::tools::local_http::local_http(args).await,
        "docker" => crate::tools::docker_tool::docker(args, project_root).await,
        "git_clone" => crate::tools::git_native::git_clone(args, ctx).await,
        "git" => crate::tools::git_tool::run(args, ctx).await,
        // The interactive confined browser; its screenshot image travels only
        // through `execute_builtin`, so this text-only path drops it.
        "browser" => crate::tools::browser_tool::run(args, ctx).await.0,
        // Cross-session messaging. Refuses unless the dispatcher bound this
        // call to a session and a mailbox (desktop, session scope only).
        "list_sessions" | "send_message" | "read_messages" | "wait_for_reply" | "stop_session" => {
            crate::session_mailbox::run_tool(tool.name, args, ctx).await
        }
        "request_access" => request_access_without_prompt(args, ctx),
        "list_plugins" => crate::access::result_json(
            "unavailable",
            serde_json::json!({
                "message": "Plugin state is read by the Flint desktop app; this surface \
                            cannot see it. Ask the user, or check the Plugins panel.",
            }),
        ),
        "open_in_browser" => crate::access::result_json(
            "unavailable",
            serde_json::json!({
                "message": "The browser is opened by the Flint desktop app; this surface                             cannot open one. Give the user the address instead.",
            }),
        ),
        "image_gen" | "image_edit" | "image_view" => crate::access::result_json(
            "unavailable",
            serde_json::json!({
                "message": "Images are made by the image engine in the Flint desktop app;                             this surface has no access to it. Tell the user what you                             wanted to generate.",
            }),
        ),
        // Reaching this arm means the call came from a surface with no browser
        // pane (the CLI, a durable job, an MCP peer). It is refused plainly and
        // never forwarded: a headless run must not drive, or silently skip, a
        // browser that is not there.
        name if crate::tools::is_browser_tool(name) => crate::tools::browser_unavailable_result(),
        other => format!("ERROR: unknown built-in tool '{other}'"),
    }
}

/// `request_access` reached the tool core, which has no way to ask anyone:
/// the desktop answers it with a prompt before it gets here, so this is a
/// headless surface. The path is still vetted, so a request that could never
/// be granted says why rather than "nobody can answer".
fn request_access_without_prompt(args: &serde_json::Value, ctx: &ToolContext<'_>) -> String {
    let path = arg_str(args, "path").unwrap_or("");
    let env = crate::access::Env::host(ctx.mask_root, Some(ctx.project_root));
    let prepared = crate::access::AccessMode::parse(arg_str(args, "access_mode"))
        .and_then(|mode| crate::access::prepare(path, mode, &env));
    match prepared {
        Err(refusal) => crate::access::refusal_result(&refusal),
        Ok(p) => crate::access::result_json(
            "unavailable",
            serde_json::json!({
                "path": p.display,
                "message": "Nothing was granted: this surface keeps no standing folder grants. \
                            A read or write on a path outside the workspace is put to the \
                            user when you make that call, if someone is attached.",
                "next": "Retry the call you need on that path; the user is asked then. If \
                         it is refused because no one is attached, say so in your reply, or \
                         ask the user to paste or attach what you need.",
            }),
        ),
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
        let replace_all = e.get("replace_all").and_then(|v| v.as_bool()).unwrap_or(false);
        if old_string.is_empty() {
            return Err(format!("ERROR: {shown}: edit {}: old_string must not be empty", i + 1));
        }
        let count = content.matches(old_string).count();
        if count == 0 {
            // No exact hit: fall back to tolerant matching (line endings,
            // typographic characters, indentation, near-identical text).
            // replace_all stays exact-only apart from line endings.
            if replace_all {
                let eol_old = super::fuzzy_edit::in_file_ending(&content, old_string);
                if eol_old != old_string && content.contains(&eol_old) {
                    let eol_new = super::fuzzy_edit::in_file_ending(&content, new_string);
                    content = content.replace(&eol_old, &eol_new);
                    continue;
                }
                return Err(format!("ERROR: {shown}: edit {}: old_string not found", i + 1));
            }
            match super::fuzzy_edit::resolve(&content, old_string, new_string) {
                Ok(r) => {
                    content.replace_range(r.range, &r.replacement);
                    continue;
                }
                Err(e) => return Err(format!("ERROR: {shown}: edit {}: {e}", i + 1)),
            }
        }
        if replace_all {
            // Rename-style replacement: every occurrence, no uniqueness guard.
            content = content.replace(old_string, new_string);
        } else {
            if count > 1 {
                return Err(format!(
                    "ERROR: {shown}: edit {}: old_string not unique ({count} matches)",
                    i + 1
                ));
            }
            content = content.replacen(old_string, new_string, 1);
        }
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

/// The credential scan's findings in the change a `write`/`edit` would make,
/// each with the file it is in. `diff` is the display diff `preview_diff` drew.
pub fn secret_findings_in(diff: &str, args: &serde_json::Value) -> Vec<crate::secrets::SecretFinding> {
    let mut findings = crate::secrets::scan_diff(diff);
    for f in findings.iter_mut() {
        if f.file.is_empty() {
            f.file = arg_str(args, "path").unwrap_or("the file").to_string();
        }
    }
    findings
}

/// One finding as a person reads it: where, which rule, the masked match. Never
/// the value.
pub fn describe_secret_finding(f: &crate::secrets::SecretFinding) -> String {
    format!("{}:{} rule \"{}\" matched `{}`", f.file, f.line, f.kind.as_str(), f.hint)
}

/// What the credential scan would find if this call ran now. Empty for any tool
/// but `write`/`edit`, and for a change that adds nothing suspicious. Reads the
/// file the call would change, writes nothing.
pub async fn secret_findings(
    tool: &BuiltinTool,
    args: &serde_json::Value,
    ctx: &ToolContext<'_>,
) -> Vec<crate::secrets::SecretFinding> {
    if !matches!(tool.name, "write" | "edit") {
        return Vec::new();
    }
    match preview_diff(tool, args, ctx).await {
        Some(diff) => secret_findings_in(&diff, args),
        None => Vec::new(),
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
                let findings = if ctx.credential_override {
                    Vec::new()
                } else {
                    secret_findings_in(preview, args)
                };
                if !findings.is_empty() {
                    let where_ = findings
                        .iter()
                        .map(describe_secret_finding)
                        .collect::<Vec<_>>()
                        .join("; ");
                    return (
                        format!(
                            "ERROR: this change was not written: it adds what looks like a real credential: {where_}. \
                             Nothing was changed. Only the matched line is the problem; every other line is fine. \
                             If the value is a real secret, use a placeholder and read it from the environment. \
                             If it is not (a test fixture, an example), tell the user which line it is and why: \
                             where the user can be asked they are asked before this refusal, otherwise they can \
                             allow it by switching to Bypass permissions or add that line themselves. \
                             Do not reword the code to get past this check."
                        ),
                        None,
                        None,
                    );
                }
            }

            let (content, images) = execute_builtin(tool, args, ctx).await;
            if content.starts_with("ERROR") || crate::shared_folder::is_hold(&content) {
                return (content, None, None);
            }
            // AH-149: the project's own formatter has the last word on layout,
            // and the diff a person reviews should be what the file now holds
            // -- not a version the next `cargo fmt` will rewrite.
            let diff = format_after_edit(args, ctx, before.as_deref(), diff).await;
            // The formatter may have rewritten the file: what the model saw
            // last is what is there now, so its next edit is not "stale".
            record_seen(args, ctx).await;
            let content = append_syntax_warning(content, args, ctx).await;
            (content, diff, images)
        }
        // Tools that can hand the model an image. `screenshot` and `browser`
        // were missing here, so their pictures were dropped on this path.
        "read" | "screenshot" | "browser" | "computer" => {
            let (content, images) = execute_builtin(tool, args, ctx).await;
            (content, None, images)
        }
        _ => (execute_builtin(tool, args, ctx).await.0, None, None),
    }
}

/// Append a one-line warning to the result of a `write`/`edit` when the file
/// is a `.json`/`.toml`/`.yaml` document that no longer parses. Never fails the
/// call: any problem reading the file just means no warning.
async fn append_syntax_warning(
    content: String,
    args: &serde_json::Value,
    ctx: &ToolContext<'_>,
) -> String {
    if !ctx.check_syntax {
        return content;
    }
    let Some(path) = arg_str(args, "path") else {
        return content;
    };
    let file = resolve_path(ctx.project_root, ctx.scratch_root, path);
    if !super::syntax_check::is_checked(&file) {
        return content;
    }
    match tokio::fs::metadata(&file).await {
        Ok(m) if m.len() as usize <= super::syntax_check::MAX_CHECK_BYTES => {}
        _ => return content,
    }
    let Ok(text) = tokio::fs::read_to_string(&file).await else {
        return content;
    };
    match super::syntax_check::check(&file, &text) {
        Some(warning) => format!("{}\n{warning}", content.trim_end()),
        None => content,
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
        let replace_all = e.get("replace_all").and_then(|v| v.as_bool()).unwrap_or(false);
        match working.find(old) {
            Some(pos) => {
                let (old_block, new_block, start) = expand_hunk(&working, pos, old, new);
                out.push_str(&render_hunk_diff(&old_block, &new_block, start));
                // Keep `working` consistent for later edits in the same call: a
                // replace_all edit rewrites every occurrence, not just the first.
                if replace_all {
                    working = working.replace(old, new);
                } else {
                    working.replace_range(pos..pos + old.len(), new);
                }
            }
            // `edit()` will reject this call, but the arguments are still worth
            // showing; there is no file position to number them against.
            None => match (replace_all, super::fuzzy_edit::resolve(&working, old, new)) {
                (false, Ok(r)) => {
                    let found = working[r.range.clone()].to_string();
                    let (ob, nb, start) = expand_hunk(&working, r.range.start, &found, &r.replacement);
                    out.push_str(&render_hunk_diff(&ob, &nb, start));
                    working.replace_range(r.range, &r.replacement);
                }
                _ => out.push_str(&render_hunk_diff(old, new, 1)),
            },
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

/// Preview for a write, headed by created/overwrote. A new file is shown
/// whole as `+` lines; an overwrite is diffed against what it replaced, so
/// the change counts the summary derives from `+`/`-` lines are real rather
/// than "every line added, none removed". Display-only; the TUI collapses
/// long output.
fn render_write_diff(prior: Option<&str>, content: &str) -> String {
    let Some(prior) = prior else {
        let mut out = String::from("@@ created file @@\n");
        for (i, line) in content.lines().enumerate() {
            out.push_str(&format!("+ {:>4} | {line}\n", i + 1));
        }
        return out.trim_end().to_string();
    };
    let mut out = String::from("@@ overwrote file @@\n");
    out.push_str(&render_hunk_diff(prior, content, 1));
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
/// A skill description cut to its first line and 120 characters, for a list.
fn skill_summary(description: &str) -> String {
    const MAX: usize = 120;
    let first = description.trim().lines().next().unwrap_or("").trim();
    if first.chars().count() <= MAX {
        return first.to_string();
    }
    let cut: String = first.chars().take(MAX - 3).collect();
    format!("{}...", cut.trim_end())
}

fn skill_list(args: &serde_json::Value, ctx: &ToolContext<'_>) -> String {
    // Case-insensitive, over the name and the summary shown: what the model
    // searches is what it can see.
    let query = arg_str(args, "query").map(|q| q.trim().to_lowercase()).filter(|q| !q.is_empty());
    let offered = skills::catalog_for_model_with_user(
        ctx.skill_project,
        ctx.store_root,
        ctx.user_skills_root,
        ctx.enabled_skills,
    );
    let lines = offered
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
                Ok(raw) => {
                    let parsed = skills::parse(&raw);
                    // `paths:` skill: offered only where the project has a match.
                    skills::paths_match(ctx.project_root, &parsed.paths)
                        && skill_requirements_unmet(ctx, &meta.name, &parsed).is_empty()
                }
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
            let summary = skill_summary(&m.description);
            if summary.is_empty() {
                name
            } else {
                format!("{name} — {summary}")
            }
        })
        .filter(|line| query.as_ref().is_none_or(|q| line.to_lowercase().contains(q.as_str())))
        .collect::<Vec<_>>();
    match (&query, lines.is_empty()) {
        (Some(q), true) => format!("No skill matches `{q}`. Call `skill_list` without a query to see every skill."),
        _ => lines.join("\n"),
    }
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
    if !skills::paths_match(ctx.project_root, &parsed.paths) {
        return format!(
            "ERROR: skill '{name}' applies only to files matching {}, and this project has none",
            parsed.paths.join(", ")
        );
    }
    // `context: fork`: the skill runs in a subagent so its instructions and
    // working notes stay out of this conversation. `inline: true` is what the
    // subagent passes to read the body itself.
    if parsed.fork && arg_str(args, "file").is_none() && !arg_bool(args, "inline") {
        return format!(
            "The skill '{name}' runs in its own context. Call `dispatch_subagent` with              subagent_name \"skill-{name}\", a `description` that states the user's task and says              \"first call skill_read with name '{name}' and inline true, then carry it out\",              and `allowed_tools` including skill_read plus the tools the task needs. Report              only its answer back."
        );
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
    let entry = skills::locate_for_model_with_user(
        ctx.skill_project,
        ctx.store_root,
        ctx.user_skills_root,
        ctx.enabled_skills,
        name,
    );
    // A bundled file (`themes/x.md`, `scripts/run.py`) is read from inside the
    // skill's own folder, which the file tools cannot be pointed at by a
    // relative path: those resolve against the workspace.
    if let Some(file) = arg_str(args, "file") {
        return match entry {
            Some(entry) => skills::read_bundled(&entry, file, &|path| {
                match (ctx.permissions, ctx.subject) {
                    (Some(permissions), Some(subject)) => permissions
                        .denies_call(
                            "read",
                            &[crate::resource::Resource::Path(path.to_path_buf())],
                            subject,
                        )
                        .is_some(),
                    _ => false,
                }
            }),
            None => format!("ERROR: skill '{name}' has no bundled files"),
        };
    }
    let mut body = parsed.body;
    if let Some(listing) = entry.as_ref().and_then(|e| skills::bundle_listing(e, name)) {
        body.push_str(&listing);
    }
    body
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

async fn read_or_list(
    args: &serde_json::Value,
    ctx: &ToolContext<'_>,
) -> (String, Option<Vec<ImageContentPart>>) {
    if let Some(path) = arg_str(args, "path") {
        let target = resolve_path(ctx.project_root, ctx.scratch_root, path);
        if target.is_dir() {
            let listing = ls(
                args,
                ctx.project_root,
                ctx.scratch_root,
                ctx.sandbox,
                ctx.read_roots,
                ctx.write_roots,
            )
            .await;
            if listing.starts_with("ERROR:") {
                return (listing, None);
            }
            return (format!("{path} is a directory. Contents:\n{listing}"), None);
        }
    }
    let mut out = read(args, ctx.project_root, ctx.scratch_root, ctx.read_roots).await;
    if is_missing_path_error(&out.0) {
        out.0 = with_project_hint(out.0, ctx, args);
    }
    // A text file that opens with "ERROR" is still a successful read, but it is
    // indistinguishable here; the model re-reads in that rare case.
    if !out.0.starts_with("ERROR") {
        if let Some((path, _)) = record_seen(args, ctx).await {
            crate::shared_folder::tools::note_read(ctx, &path);
        }
    }
    out
}

/// Whether a file tool's error says the path does not exist.
fn is_missing_path_error(out: &str) -> bool {
    if !out.starts_with("ERROR") {
        return false;
    }
    let lower = out.to_ascii_lowercase();
    lower.contains("not found")
        || lower.contains("os error 2)")
        || lower.contains("os error 3)")
        || lower.contains("cannot find the")
        || lower.contains("no such file")
}

/// The first place under `base` (itself, then its subfolders to a small depth)
/// where the relative `raw` names something that exists.
///
/// A repository often sits one level below the folder a session is rooted in
/// (`pokemon_scans/pokemon-card-app`), or a worktree the model made sits under
/// the worktree it was given, so `lib/db.ts` misses while `pokemon-card-app/lib/db.ts`
/// is right there. Bounded, and it skips the folders no project file lives in.
fn find_relative_match(base: &Path, raw: &str) -> Option<PathBuf> {
    const MAX_DEPTH: usize = 3;
    const MAX_DIRS: usize = 400;
    let mut level = vec![base.to_path_buf()];
    let mut visited = 0usize;
    for depth in 0..=MAX_DEPTH {
        let mut next = Vec::new();
        for dir in &level {
            let candidate = dir.join(raw);
            if candidate.exists() {
                return Some(candidate);
            }
            if depth == MAX_DEPTH {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(dir) else { continue };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if matches!(name.as_str(), ".git" | "node_modules" | "target" | ".next" | "dist") {
                    continue;
                }
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    visited += 1;
                    if visited > MAX_DIRS {
                        return None;
                    }
                    next.push(entry.path());
                }
            }
        }
        level = next;
    }
    None
}

/// Where a model that used a project-relative path should have looked.
///
/// Relative paths resolve against the sandbox workspace, which on the desktop
/// is scratch space inside Flint's data folder (or, in a managed worktree, the
/// worktree root). A model reading `lib/db.ts` in an attached project missed,
/// was told only that relative paths resolve in that workspace, concluded the
/// workspace was a symlink, and asked `request_access` for it (refused: it
/// overlaps the data folder). The hint names the real file when one matches,
/// and otherwise the attached folder.
fn project_path_hint(ctx: &ToolContext<'_>, args: &serde_json::Value) -> Option<String> {
    let raw = arg_str(args, "path")?;
    if Path::new(raw).is_absolute() {
        return rebased_path_hint(ctx, raw);
    }
    let root = ctx.project_root;
    let scratch = ctx.scratch_root;
    let folders: Vec<&PathBuf> = ctx
        .write_roots
        .iter()
        .chain(ctx.read_roots.iter())
        .filter(|f| f.as_path() != root && Some(f.as_path()) != scratch)
        .collect();
    let found = folders
        .iter()
        .filter_map(|f| find_relative_match(f, raw))
        .chain(find_relative_match(root, raw))
        .next();
    if let Some(found) = found {
        return Some(format!(
            "A file with that relative path exists at {}. Use this absolute path.",
            crate::tools::sandbox::plain_display(&found)
        ));
    }
    let first = folders.first()?;
    Some(format!(
        "Your workspace is scratch space, not the project. The attached project folder is {}; \
         use absolute paths for files in it (a relative path never resolves there).",
        crate::tools::sandbox::plain_display(first)
    ))
}

/// A session that works in a worktree rebases a relative path onto it before
/// the tool runs, so `lib/db.ts` arrives as `<worktree>/lib/db.ts`, echoed back
/// in the error as a long `\\\\?\\` path the model never typed. When the app sits
/// one folder below the worktree root, the file is at
/// `<worktree>/pokemon-card-app/lib/db.ts`; say so.
fn rebased_path_hint(ctx: &ToolContext<'_>, raw: &str) -> Option<String> {
    use crate::tools::sandbox::plain;
    let wanted = plain(Path::new(raw));
    let bases = ctx
        .write_roots
        .iter()
        .chain(ctx.read_roots.iter())
        .map(PathBuf::as_path)
        .chain(std::iter::once(ctx.project_root));
    for base in bases {
        let base = plain(base);
        let Ok(rest) = wanted.strip_prefix(&base) else { continue };
        if rest.as_os_str().is_empty() || base.join(rest).exists() {
            continue;
        }
        if let Some(found) = find_relative_match(&base, &rest.to_string_lossy()) {
            return Some(format!(
                "That file is not at the top of {}, but exists at {}. Use this absolute path.",
                base.display(),
                plain(&found).display()
            ));
        }
    }
    None
}

/// `out` with the project-path hint appended when a relative path missed.
fn with_project_hint(out: String, ctx: &ToolContext<'_>, args: &serde_json::Value) -> String {
    if !is_missing_path_error(&out) {
        return out;
    }
    match project_path_hint(ctx, args) {
        Some(hint) => format!("{out} {hint}"),
        None => out,
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
    let allow_large = arg_bool(args, "allow_large");
    let target = resolve_path(root, scratch, path);
    // Fail closed: a component swapped to a symlink after the gate validated
    // the path must not redirect the open out of the workspace.
    if symlink_escapes_any_root(root, scratch, read_roots, &target) {
        return (
            format!(
                "ERROR: refused to read through a symlink out of the workspace: {path}{}",
                resolved_target(&target)
            ),
            None,
        );
    }
    // Windows reports a directory opened as a file as "Access is denied.
    // (os error 5)", which reads as a permission problem.
    if target.is_dir() {
        return (format!("ERROR: {path} is a directory; use ls."), None);
    }

    // Looked at before it is read (Jozkah/jan#250): a multi-GB file would be
    // allocated whole just to be cut to 64 KB, and a FIFO would block the read
    // forever.
    // A missing file is said plainly, with where relative paths resolve --
    // the raw "os error 2" sent the model hunting through other directories.
    if !target.exists() {
        return (
            format!(
                "ERROR: File not found: {path}. Relative paths resolve against your \
                 workspace ({}).",
                root.display()
            ),
            None,
        );
    }
    if let Err(e) = readable_file_with(&target, allow_large).await {
        return (format!("ERROR: {path}: {e}"), None);
    }
    let bytes = match tokio::fs::read(&target).await {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return (
                format!(
                    "ERROR: File not found: {path}. Relative paths resolve against your \
                     workspace ({}).",
                    root.display()
                ),
                None,
            )
        }
        Err(e) => return (format!("ERROR: {e}"), None),
    };
    let total_bytes = bytes.len();

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
        Err(_) => {
            return (
                format!("ERROR: Binary file ({total_bytes} bytes); read only returns text."),
                None,
            )
        }
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

    let out = cap_output(
        &selected,
        MAX_LINES,
        MAX_BYTES,
        "\n[truncated: use offset/limit to read more]",
    );
    // File text that happens to start with "ERROR" reads like a handler
    // failure to `classify_tool`; say that this one succeeded (Jozkah/jan#62).
    if out.trim_start().starts_with("ERROR") {
        let _ = READ_SUCCESS.try_with(|slot| *slot.borrow_mut() = Some(out.clone()));
    }
    (out, None)
}

tokio::task_local! {
    /// The text a successful `read` returned, when it starts with "ERROR" and
    /// so could be mistaken for a failure. Set only inside
    /// [`with_read_success`].
    static READ_SUCCESS: std::cell::RefCell<Option<String>>;
}

/// Run `work` (a tool call) and also return the output of any `read` in it
/// that succeeded with text starting with "ERROR". Content that starts with
/// that text is file content, not a handler error, and the caller must not
/// classify it as a failure (Jozkah/jan#62).
pub async fn with_read_success<F: std::future::Future>(work: F) -> (F::Output, Option<String>) {
    READ_SUCCESS
        .scope(std::cell::RefCell::new(None), async {
            let out = work.await;
            let success = READ_SUCCESS.with(|slot| slot.borrow_mut().take());
            (out, success)
        })
        .await
}

/// What each session last saw of each file: a SHA-256 of its bytes, recorded
/// when `read` succeeds and when `write`/`edit` lands. `write` over an existing
/// file and `edit` consult it, so a change made behind the model's back (the
/// user, a formatter, another process) is not silently overwritten by a stale
/// copy of the file the model is still holding.
///
/// Keyed by session (falling back to the run) and then by the resolved path.
/// A call with neither id is not tracked and not checked: nothing could tell
/// one caller's reads from another's. Bounded per session; hitting the bound
/// forgets that session's records, which only asks the model to read again.
const MAX_TRACKED_FILES: usize = 4096;

type ReadHashes = Mutex<HashMap<String, HashMap<PathBuf, [u8; 32]>>>;

fn read_hashes() -> &'static ReadHashes {
    static HASHES: OnceLock<ReadHashes> = OnceLock::new();
    HASHES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn content_hash(bytes: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).into()
}

fn stale_key(ctx: &ToolContext<'_>) -> Option<String> {
    ctx.session_id.or(ctx.run_id).map(str::to_string)
}

/// The path a call's `path` argument lands on, as the handlers open it.
fn tracked_path(args: &serde_json::Value, ctx: &ToolContext<'_>) -> Option<PathBuf> {
    let path = arg_str(args, "path")?;
    resolved_for_open(&resolve_path(ctx.project_root, ctx.scratch_root, path)).ok()
}

/// Remember the bytes now on disk at the call's path as what this session has
/// seen. A file that cannot be read is forgotten instead.
async fn record_seen(
    args: &serde_json::Value,
    ctx: &ToolContext<'_>,
) -> Option<(PathBuf, [u8; 32])> {
    let (Some(key), Some(path)) = (stale_key(ctx), tracked_path(args, ctx)) else {
        return None;
    };
    let hash = tokio::fs::read(&path).await.ok().map(|b| content_hash(&b));
    let mut all = read_hashes().lock().unwrap_or_else(|e| e.into_inner());
    let seen = all.entry(key).or_default();
    match hash {
        Some(h) => {
            if seen.len() >= MAX_TRACKED_FILES && !seen.contains_key(&path) {
                seen.clear();
            }
            seen.insert(path.clone(), h);
            Some((path, h))
        }
        None => {
            seen.remove(&path);
            None
        }
    }
}

/// An error when `write` (over an existing file) or `edit` would act on a file
/// this session has not read, or that changed since it did. `None` when the
/// call may go ahead: a file that does not exist yet, an untracked caller, or a
/// file still byte-identical to what was last read or written.
async fn stale_edit_refusal(
    verb: &str,
    args: &serde_json::Value,
    ctx: &ToolContext<'_>,
) -> Option<String> {
    let key = stale_key(ctx)?;
    let path = tracked_path(args, ctx)?;
    let now = content_hash(&tokio::fs::read(&path).await.ok()?);
    let shown = arg_str(args, "path").unwrap_or_default();
    let seen = read_hashes()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&key)
        .and_then(|files| files.get(&path).copied());
    match seen {
        Some(h) if h == now => None,
        Some(_) => Some(format!(
            "ERROR: {shown}: file has been modified since it was read. Read it again, then {verb} it."
        )),
        None => Some(format!(
            "ERROR: {shown}: this file exists but has not been read in this session. Read it first, then {verb} it."
        )),
    }
}

/// " (it resolves to X)" for a symlink refusal, so the model can see where the
/// link leads instead of guessing. Empty when the target cannot be resolved.
fn resolved_target(target: &Path) -> String {
    match std::fs::canonicalize(target) {
        Ok(real) => {
            let shown = real.to_string_lossy();
            let shown = shown.strip_prefix(r"\\?\").unwrap_or(&shown).to_string();
            format!(" (it resolves to {shown})")
        }
        Err(_) => String::new(),
    }
}

async fn ls(
    args: &serde_json::Value,
    root: &Path,
    scratch: Option<&Path>,
    hide_jan: bool,
    read_roots: &[PathBuf],
    write_roots: &[PathBuf],
) -> String {
    let path = arg_str(args, "path").unwrap_or(".");
    let limit = arg_u64(args, "limit")
        .map(|v| v as usize)
        .unwrap_or(LS_DEFAULT_LIMIT);
    let target = resolve_path(root, scratch, path);
    // Names are content too: a symlinked directory would list a host directory.
    if symlink_escapes_any_root(root, scratch, read_roots, &target) {
        return format!(
            "ERROR: refused to list through a symlink out of the workspace: {path}{}",
            resolved_target(&target)
        );
    }
    // Windows says "The directory name is invalid. (os error 267)" for a file.
    if target.is_file() {
        let is_git = target.file_name().is_some_and(|n| n.eq_ignore_ascii_case(".git"));
        return if is_git {
            format!(
                "ERROR: {path} is a file, not a directory (a git worktree's .git is a pointer \
                 file; read it)."
            )
        } else {
            format!("ERROR: {path} is a file, not a directory; use read.")
        };
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
                if hide_jan
                    && is_hidden_jan_path_in(root, write_roots, &entry.path().to_string_lossy())
                {
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
    // Said, not left blank: an empty result read as a call that returned
    // nothing, and the model listed the same folder again with a shell.
    if names.is_empty() {
        return format!("(empty directory: {})", target.display());
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
    if let Some((name, why)) = refuse_windows_name(path) {
        return format!("ERROR: refused to write '{name}' in {path}: the name {why}");
    }
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
        return format!(
            "ERROR: refused to write through a symlink out of the workspace: {path}{}",
            resolved_target(&target)
        );
    }
    let open_at = match resolved_for_open(&target) {
        Ok(p) => p,
        Err(e) => return format!("ERROR: refused to write {path}: {e}"),
    };
    // Existence decides created/overwrote; a non-UTF8 file still exists, so it
    // must not be a UTF-8 decode that answers that question. Read through the
    // same no-follow walk as the write, so a swapped link is refused here too.
    let prior = match read_no_follow(&open_at).await {
        Ok(prior) => Some(prior),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) if nofollow::is_link_refused(&e) => return swapped_link("write", path),
        Err(_) => Some(Vec::new()),
    };
    let existed = prior.is_some();
    let unchanged = prior.is_some_and(|prior| prior == content.as_bytes());
    let bytes = content.len();
    match write_no_follow(&open_at, content).await {
        Err(e) if nofollow::is_link_refused(&e) => swapped_link("write", path),
        Ok(()) if unchanged => format!("No change: {shown} already had these {bytes} bytes"),
        Ok(()) if existed => format!("Overwrote {shown} ({bytes} bytes)"),
        Ok(()) => {
            let mut out = format!("Created {shown} ({bytes} bytes)");
            if let Some(real) = shadowed_real_file(path, &target, write_roots) {
                out.push_str(&format!(
                    "\n[note: this is a new copy in the session workspace, not {}. That file \
                     exists and you may edit it: change it there with `edit` instead of \
                     rewriting files here. The user can bring a sandbox file across with \
                     Review changes > Apply to folder.]",
                    real.display()
                ));
            }
            out
        }
        Err(e) => format!("ERROR: {shown}: {e}"),
    }
}

/// The real file a relative write into the workspace duplicates: `path` under
/// a granted folder, or under it with the folder's own name dropped
/// (`KewScraper/go.mod` for the granted `…/KewScraper`). A session copied a
/// project by hand this way after a shell copy failed, rewriting whole files
/// from memory while it could have edited the originals.
fn shadowed_real_file(path: &str, written: &Path, write_roots: &[PathBuf]) -> Option<PathBuf> {
    let rel = Path::new(path);
    if rel.is_absolute() {
        return None;
    }
    let mut parts = rel.components();
    let first = parts.next()?.as_os_str().to_os_string();
    let rest: PathBuf = parts.collect();
    write_roots.iter().find_map(|root| {
        let direct = root.join(rel);
        let named = (root.file_name() == Some(first.as_os_str()) && !rest.as_os_str().is_empty())
            .then(|| root.join(&rest));
        [Some(direct), named]
            .into_iter()
            .flatten()
            .find(|candidate| candidate.is_file() && candidate.as_path() != written)
    })
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
    if let Some((name, why)) = refuse_windows_name(path) {
        return format!("ERROR: refused to edit '{name}' in {path}: the name {why}");
    }
    let target = resolve_path(root, scratch, path);
    if confine && escapes_write_roots(root, scratch, write_roots, path).unwrap_or(true) {
        return format!("ERROR: refused to edit outside the agent workspace: {path}");
    }
    let shown = display_path(root, scratch, &target);
    // Re-validate before the final read+write pair so a swapped symlink cannot
    // redirect either the read or the later write.
    if symlink_escapes_root(root, scratch, &target) {
        return format!(
            "ERROR: refused to edit through a symlink out of the workspace: {path}{}",
            resolved_target(&target)
        );
    }
    let open_at = match resolved_for_open(&target) {
        Ok(p) => p,
        Err(e) => return format!("ERROR: refused to edit {path}: {e}"),
    };
    let content = match read_no_follow(&open_at).await {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(c) => c,
            Err(_) => return format!("ERROR: {shown}: stream did not contain valid UTF-8"),
        },
        Err(e) if nofollow::is_link_refused(&e) => return swapped_link("edit", path),
        Err(e) => return format!("ERROR: {shown}: {e}"),
    };
    let content = match apply_edits(&content, edits, &shown) {
        Ok(content) => content,
        Err(message) => return message,
    };

    match write_no_follow(&open_at, &content).await {
        Ok(()) => format!("Applied {} edit(s) to {shown}", edits.len()),
        Err(e) if nofollow::is_link_refused(&e) => swapped_link("edit", path),
        Err(e) => format!("ERROR: {shown}: {e}"),
    }
}

/// The file a write to `target` really lands in, every symlink on the way
/// followed -- the same resolution the containment checks just judged. The
/// handlers open this rather than `target`, so the open does not resolve the
/// path a second time on its own (Jozkah/jan#192).
fn resolved_for_open(target: &Path) -> Result<PathBuf, String> {
    canonicalize_lenient(target)
}

/// Replace `path` with `content` through a sibling temp file and a rename
/// (Jozkah/jan#39), so a crash or kill mid-write leaves the user's file with
/// its old content or the full new content, never truncated, and the file's
/// permission bits survive the replacement. `path` is already resolved and
/// holds no links; the replace walks it without following one, so a link
/// swapped into a parent or the leaf after the checks is refused rather than
/// followed (Jozkah/jan#192, janhq/jan#9424).
async fn write_no_follow(path: &Path, content: &str) -> std::io::Result<()> {
    let path = path.to_path_buf();
    let bytes = content.as_bytes().to_vec();
    tokio::task::spawn_blocking(move || nofollow::write_atomic(&path, &bytes))
        .await
        .map_err(std::io::Error::other)?
}

/// Read the resolved `path` without following a link along it.
async fn read_no_follow(path: &Path) -> std::io::Result<Vec<u8>> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || nofollow::read(&path))
        .await
        .map_err(std::io::Error::other)?
}

/// The answer when a link appeared in the path after it was checked.
fn swapped_link(verb: &str, path: &str) -> String {
    format!(
        "ERROR: refused to {verb} {path}: a part of the path became a symbolic link after it          was checked"
    )
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

/// Run the pieces of a read-only command in order and join what they say.
/// Shell steps run in the sandbox as the same `bash` call; git steps run by
/// the host's git, confined to the folders the run may use.
fn run_split_read_only<'a>(
    args: &'a serde_json::Value,
    ctx: &'a ToolContext<'_>,
    pieces: Vec<super::nul_programs::Piece>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = String> + Send + 'a>> {
    Box::pin(async move {
        use super::nul_programs::Piece;
        let roots = crate::tools::git_tool::Roots::from_ctx(ctx);
        let mut out: Vec<String> = Vec::new();
        for piece in pieces {
            let text = match piece {
                Piece::Shell(step) => {
                    let mut a = args.clone();
                    if let Some(obj) = a.as_object_mut() {
                        obj.insert("command".into(), serde_json::Value::String(step));
                    }
                    bash(&a, ctx).await
                }
                Piece::Git(argv) => {
                    let plan = match crate::tools::git_tool::plan("git", &argv) {
                        Ok(p) => p,
                        Err(e) => return format!("ERROR: git: {e}"),
                    };
                    let cwd = match crate::tools::git_tool::resolve_cwd(None, &plan, &roots) {
                        Ok(c) => c,
                        Err(e) => return format!("ERROR: git: {e}"),
                    };
                    if let Err(e) = crate::tools::git_tool::check_repo_config(&cwd).await {
                        return format!("ERROR: git: {e}");
                    }
                    if let Err(e) = crate::tools::git_tool::check_diff_in_work_tree(&plan, &cwd).await {
                        return format!("ERROR: git: {e}");
                    }
                    crate::tools::git_tool::execute(&plan, &cwd).await
                }
            };
            out.push(text);
        }
        out.join("\n")
    })
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
    if let Some(fs) = ctx.fs {
        policy = policy.with_fs_config(fs.clone());
    }
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
    let mut start = root.to_path_buf();
    if !write_abs.is_empty()
        && jail::can_confine_write_roots(jail::backend(), &write_abs, owned.as_deref())
    {
        policy = policy.with_write_roots(write_abs.clone());
        if ctx.sandbox {
            policy = hide_write_root_jans(policy, &write_abs);
            // From the host, before the shell sees the hidden `.jan`: a
            // tracked file there must not look deleted to the sandboxed git.
            for wr in &write_abs {
                if let Err(e) = crate::tools::git_native::skip_worktree_jan(wr) {
                    eprintln!("could not mark {}/.jan skip-worktree: {e}", wr.display());
                }
            }
        }
        // #322: a run whose destination is a managed worktree starts its shell
        // there, so `npm test` or `.\check.ps1` mean the project. See
        // [`managed_worktree_start`] for when; the file tools follow through
        // [`rebase_relative_paths`].
        if let Some(wt) = managed_worktree_start(&write_abs, owned.as_deref()) {
            policy = policy.with_start_dir(&wt);
            start = policy.start_dir().to_path_buf();
        }
    }
    if ctx.sandbox && policy.write_roots.is_empty() && !write_abs.is_empty() {
        // Granted to the file tools, out of the shell's reach: named in
        // failure notes only.
        policy = policy.with_unreachable_grants(write_abs.clone());
    }
    if ctx.sandbox && jail::backend() == jail::Backend::AppContainer {
        // The helper skips a read-only folder it will never grant (a drive
        // root, the profile, a system folder): named in failure notes, so the
        // model is not told to build from a folder its shell cannot open.
        let refused: Vec<PathBuf> = read_abs
            .iter()
            .filter(|r| {
                !policy.write_roots.contains(r)
                    && crate::tools::appcontainer::grant_refusal(r).is_some()
            })
            .cloned()
            .collect();
        if !refused.is_empty() {
            policy = policy.with_unreachable_read_grants(refused);
        }
    }
    // An unconfined shell for an edit folder the sandbox cannot reach starts in
    // that folder, so relative paths and `Set-Location` mean the project.
    if !ctx.sandbox {
        if let Some(dir) = ctx.direct_shell_start.as_deref().map(anchored) {
            if dir.is_dir() {
                policy = policy.with_start_dir(&dir);
                start = dir;
            }
        }
    }
    let in_worktree = start.as_path() != root;
    // With the sandbox off the shell is spawned bare, the way the user's own
    // terminal would: no wrapper, no policy, the real `$HOME` and `/tmp`. Only
    // a surface that opted in gets here (the CLI's `--sandbox`/`sandbox`
    // setting); the desktop never does, so `bash` there is still confined or
    // withheld. `policy` is still built either way -- it is what
    // `denial_hint` reads, and an unconfined command can still hit a plain
    // filesystem permission error worth explaining.
    let shell = if ctx.sandbox {
        // A program that opens NUL itself cannot run in a sandbox this
        // machine's null device refuses. Not run only to fail (and perhaps
        // half-run a chain): answered with the null-device refusal up front,
        // so the surface asks the user to run it outside the sandbox now.
        if jail::null_device_refuses_sandbox() {
            if let Some(program) =
                super::nul_programs::opens_null_device(command, ctx.nul_programs)
            {
                // Pure reading (`git status`, `git log`) needs no outside run:
                // the git steps go to the host's git, the rest stays here.
                if let Some(pieces) =
                    super::nul_programs::split_for_host_git(command, ctx.nul_programs)
                {
                    return run_split_read_only(args, ctx, pieces).await;
                }
                ctx.null_refusal.set();
                return super::nul_programs::not_run_refusal(&program);
            }
        }
        // Which shell can be confined is decided by probing, not by assuming.
        // A shell that starts fine on its own can still fail inside the
        // sandbox: on Windows, Git Bash is built on the MSYS2 runtime, which
        // cannot initialise inside an AppContainer however it was installed.
        // No confinement available means no shell either: running unsandboxed
        // would give the command the whole machine, which is never what the
        // caller asked for.
        // Probing launches the sandbox helper (and, the first time, sets up
        // the container and its folder ACLs): seconds of blocking work that
        // must not hold an async runtime thread.
        let probe_policy = policy.clone();
        let probed = tokio::task::spawn_blocking(move || jail::select_shell(&probe_policy))
            .await
            .unwrap_or_else(|e| Err(format!("the shell probe failed: {e}")));
        let mut selected = match probed {
            Ok(selected) => selected,
            Err(detail) => {
                return format!(
                    "ERROR: bash is unavailable because no shell could be started in a                      sandbox on this system. Use the read/ls/find/grep tools instead.
{detail}"
                )
            }
        };
        // cmd's `2>nul` in PowerShell writes to a file named `nul`, which the
        // container refuses as `\\.\nul`. Refused before running: the fix is
        // mechanical, and running it would half-execute a `;` chain.
        if selected.report.cfg.flavor == proc::ShellFlavor::PowerShell {
            let redirects = super::shell_diag::cmd_nul_redirects(command);
            if !redirects.is_empty() {
                return super::shell_diag::cmd_nul_refusal(&redirects);
            }
        }
        // A command written for bash is refused rather than handed to PowerShell
        // or cmd, which would not fail cleanly: `cmd` given `foo $(bar)` runs
        // something, just not what was asked for.
        if selected.report.cfg.flavor != proc::ShellFlavor::Posix {
            if let Some(construct) = proc::requires_posix_shell_for(command, selected.report.cfg.flavor) {
                let mut refusal = proc::posix_unavailable_error(
                    construct,
                    &selected.report.cfg,
                    selected
                        .posix_rejected
                        .as_deref()
                        .unwrap_or("no POSIX shell could be started in the sandbox"),
                );
                if let Some(hint) = proc::heredoc_script_hint(command) {
                    refusal.push('\n');
                    refusal.push_str(&hint);
                }
                return refusal;
            }
        }
        // `&&`/`||` reach Windows PowerShell 5.1 as a parse error, not a clean
        // failure. A chaining command that would land on it is not refused
        // outright: it is re-selected onto a shell that keeps `&&`/`||`
        // short-circuit semantics and exit codes -- `cmd.exe` on a Windows host
        // with no bash or `pwsh`, which is always present and, unlike Windows
        // PowerShell 5.1, chains. Safe here because a POSIX-only command was
        // already refused above, so nothing `cmd` would misread reaches this
        // point. Only when no usable shell can chain is the actionable refusal
        // the last resort. Capability is read from the unwrapped program name,
        // which tells Windows PowerShell (no chaining) from `pwsh` 7+.
        if proc::requires_and_or_chaining(command).is_some()
            && !proc::supports_and_or_chaining(&selected.report.cfg)
        {
            let probe_policy = policy.clone();
            let capable = tokio::task::spawn_blocking(move || {
                jail::select_chaining_capable(&probe_policy)
            })
            .await
            .ok()
            .flatten();
            match capable {
                Some(capable) => selected = capable,
                None => {
                    // Unreachable in practice on Windows -- `cmd.exe` is always a
                    // candidate -- but if even it cannot be confined, refuse
                    // clearly rather than run a shell that cannot parse the command.
                    let operator = proc::requires_and_or_chaining(command).unwrap_or("&&");
                    return proc::chaining_unavailable_error(operator, &selected.report.cfg);
                }
            }
        }
        selected.wrapped
    } else {
        // An approved null-device rerun keeps the shell the sandbox chose, so
        // the command means what the model wrote it to mean (see
        // `ToolContext::sandbox_shell_parity`). Everything else unconfined
        // gets the host's preferred shell.
        let parity = ctx.sandbox_shell_parity && (jail::backend().enforces() || cfg!(windows));
        let sandbox_choice = if parity {
            jail::select_shell(&policy)
                .ok()
                .map(|s| s.report.cfg)
                // On Windows the model writes PowerShell for the sandbox. If
                // the sandbox cannot say which shell it would use, the rerun
                // still must not fall to Git Bash, where `Set-Location` and
                // `Push-Location` do not exist.
                .or_else(|| {
                    if cfg!(windows) {
                        proc::candidates()
                            .into_iter()
                            .find(|c| c.flavor != proc::ShellFlavor::Posix)
                    } else {
                        None
                    }
                })
        } else {
            None
        };
        match unsandboxed_shell(
            command,
            sandbox_choice,
            || {
                if parity {
                    jail::select_chaining_capable(&policy).map(|s| s.report.cfg)
                } else {
                    None
                }
            },
            proc::shell().clone(),
            proc::candidates,
        ) {
            Ok(cfg) => cfg,
            Err(refusal) => return refusal,
        }
    };

    let sandbox_tmp = if ctx.sandbox {
        jail::scratch_env_path(jail::backend(), &policy)
    } else {
        None
    };
    let mut shell = shell;
    // #9044: a POSIX shell can pass its sandbox probe and still fail to start
    // for the real command. A native shell is retried in the same container
    // before giving up, and the model is told which shell it got.
    let mut fallback_note: Option<String> = None;
    let child = match proc::spawn(&shell, command, &start, sandbox_tmp.as_deref()).await {
        Ok(c) => c,
        Err(e) if ctx.sandbox && shell.flavor == proc::ShellFlavor::Posix => {
            match jail::select_native_fallback(&policy, command) {
                Some(native) => {
                    match proc::spawn(&native, command, &start, sandbox_tmp.as_deref()).await {
                        Ok(c) => {
                            fallback_note =
                                Some(native_fallback_note(&e.to_string(), native.description));
                            shell = native;
                            c
                        }
                        Err(e2) => {
                            return format!(
                                "ERROR: failed to run command: {e}; the {} fallback could not start either: {e2}",
                                native.description
                            )
                        }
                    }
                }
                None => return format!("ERROR: failed to run command: {e}"),
            }
        }
        Err(e) => return format!("ERROR: failed to run command: {e}"),
    };
    let pid = child.id();
    // Owned by the call's cancellation token, so a Stop (or an outer timeout)
    // that drops this future reaches the shell's whole process tree instead of
    // leaving it running with nobody holding it.
    let owner_token = ctx.cancel.clone();
    if let (Some(token), Some(pid)) = (owner_token.as_ref(), pid) {
        token.adopt(pid);
    }
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
    let null_refusal = ctx.null_refusal.clone();
    // The model writes POSIX commands by default, which `cmd` rejects. Surface
    // the resolved shell so it can adapt when the only shell on a Windows box
    // is cmd, instead of the tool silently presenting cmd as bash.
    let shell_description = shell.description;
    let shell_flavor = shell.flavor;
    let command_text = command.to_string();
    let cwd_display = start.display().to_string();
    tokio::spawn(async move {
        let mut out = collect_and_format(child, spill_scratch, sink).await;
        // The retry tag is the harness's: a command that prints it must not
        // pass for the sandbox's own refusal.
        if let std::borrow::Cow::Owned(clean) = crate::unsandboxed_retry::strip_forged_tag(&out) {
            out = clean;
        }
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
        // Classified first: a denial the shell caused (PowerShell given cmd's
        // `2>nul`) must not be reported as the sandbox's doing.
        if shell_flavor == proc::ShellFlavor::PowerShell {
            out = proc::strip_prologue(&out);
        }
        // Before the failure notes, and whatever the exit code: a command that
        // ends in a successful statement still hit the wall.
        let unreachable = if sandboxed {
            jail::unreachable_grant_note(&policy, &out)
        } else {
            None
        };
        if bash_result_failed(&out) {
            let class = super::shell_diag::classify(&command_text, &out, shell_flavor);
            // PowerShell runs from a drive mounted on where the shell started
            // (the workspace, or the managed worktree), and a script it starts
            // can land elsewhere. A path the command could not find is most
            // often a relative path aimed at the wrong place; say where
            // relative paths actually go.
            if shell_flavor == proc::ShellFlavor::PowerShell && cwd_note_applies(&class, &out) {
                out.insert_str(0, &cwd_note(&cwd_display, in_worktree));
            }
            let hint = match class {
                super::shell_diag::FailureClass::FileAccessDenied
                | super::shell_diag::FailureClass::Network
                    if !sandboxed =>
                {
                    None
                }
                ref c => jail::failure_hint(&policy, c, &out),
            };
            if let Some(hint) = hint {
                if sandboxed && hint.contains(jail::NULL_DEVICE_RETRY_TAG) {
                    null_refusal.set();
                }
                out.push_str(&hint);
            }
            // A program the sandbox cannot find may still be installed on the
            // host, just not runnable from inside. Say where and why, so the
            // model reports it rather than hunting for another copy to run.
            // Not on the host either: say so just as firmly, or the model
            // searches the profile, downloads an installer, or retries.
            // The `py` launcher's own "no Python" exit codes are the same case.
            let missing = if class == super::shell_diag::FailureClass::MissingCommand {
                super::host_tools::missing_program(&out)
            } else {
                None
            }
            .or_else(|| super::host_tools::python_launcher_missing(&command_text, &out));
            if class == super::shell_diag::FailureClass::MissingCommand {
                if let Some(note) = super::host_tools::missing_path_note(
                    &out,
                    super::host_tools::current_profile().as_deref(),
                ) {
                    out.push_str(&note);
                }
            }
            if sandboxed {
                // An unquoted assignment value, not a missing program.
                let quoting = missing
                    .as_deref()
                    .and_then(|name| super::host_tools::unquoted_assignment(&command_text, name));
                if let Some(note) = quoting {
                    out.push_str(&note);
                } else if let Some(name) = missing {
                    let host = std::env::var_os("PATH").unwrap_or_default();
                    let pathext =
                        std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
                    match super::host_tools::locate_on_host(&name, &host, &pathext) {
                        // The launcher itself exists when it reports 103/109;
                        // what is missing is a Python behind it.
                        Some(found) if name != "py" => {
                            let profile =
                                std::env::var_os("USERPROFILE").map(std::path::PathBuf::from);
                            out.push_str(&super::host_tools::unavailable_hint(
                                &name,
                                &found,
                                profile.as_deref(),
                                super::host_tools::container_can_execute,
                            ));
                        }
                        _ => out.push_str(&super::host_tools::not_installed_hint(&name)),
                    }
                }
                if !policy.allow_network && super::host_tools::is_name_resolution_failure(&out) {
                    out.push_str(super::host_tools::NO_NETWORK_HINT);
                }
            }
            // Which shell ran it, on a failure only: that is when the model is
            // about to write the next command and most needs the syntax.
            if let Some(banner) = super::shell_diag::shell_banner(shell_flavor, shell_description)
            {
                out.insert_str(0, &banner);
            }
        }
        if let Some(note) = unreachable {
            out.push_str(&note);
        }
        if let Some(hint) = super::host_tools::go_flag_order_hint(&out) {
            out.push_str(hint);
        }
        if shell_flavor == proc::ShellFlavor::PowerShell && !bash_result_failed(&out) {
            if let Some((code, note)) = super::host_tools::masked_failure(&out) {
                super::host_tools::set_exit_marker(&mut out, code);
                out.push_str(&note);
            }
        }
        if let Some(note) = &fallback_note {
            out.insert_str(0, note);
        } else if shell_description == "cmd" {
            out.insert_str(
                0,
                "[shell: cmd.exe - no bash is installed. Write commands in cmd syntax \
                 (e.g. `dir`, `type`, `set`, `mkdir`, `%VAR%` for variables), not \
                 POSIX/bash. Alternatively install git-bash and this tool will use it.]\n",
            );
        }
        if let Some(pid) = pid {
            proc::unregister(pid);
            if let Some(token) = owner_token.as_ref() {
                token.release(pid);
            }
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
                bash_jobs().lock().unwrap_or_else(|e| e.into_inner()).insert(
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
            if let Some(note) =
                super::node_runner::timeout_note(command, sandboxed, shell_flavor, shell_description)
            {
                out.push_str(&note);
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
        let injected = test_deadlines().lock().unwrap_or_else(|e| e.into_inner()).get(root).cloned();
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
        .unwrap_or_else(|e| e.into_inner())
        .insert(root.to_path_buf(), fire.clone());
    fire
}

/// Held while a collector awaits a job's receiver. If the collecting call is
/// cancelled (its future dropped) the receiver goes back into the job and
/// `collecting` is cleared, so the job can be collected again instead of
/// being left unreachable.
struct CollectGuard {
    job_id: String,
    rx: Option<oneshot::Receiver<String>>,
}

impl Drop for CollectGuard {
    fn drop(&mut self) {
        let Some(rx) = self.rx.take() else { return };
        if let Ok(mut jobs) = bash_jobs().lock() {
            if let Some(job) = jobs.get_mut(&self.job_id) {
                job.rx = Some(rx);
                job.collecting = false;
            }
        }
    }
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
        let mut jobs = bash_jobs().lock().unwrap_or_else(|e| e.into_inner());
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
        Collect::Awaiting(rx) => {
            let mut guard = CollectGuard {
                job_id: job_id.to_string(),
                rx: Some(rx),
            };
            let got = match guard.rx.as_mut() {
                Some(rx) => rx.await.ok(),
                None => None,
            };
            // Finished (either way): nothing to hand back on drop.
            guard.rx = None;
            got.unwrap_or_else(|| {
                "ERROR: background command ended without producing output".to_string()
            })
        }
        Collect::Drained => "ERROR: background command ended without producing output".to_string(),
        Collect::Unknown => {
            return format!("ERROR: unknown or already-collected job_id '{job_id}'")
        }
    };
    bash_jobs().lock().unwrap_or_else(|e| e.into_inner()).remove(job_id);
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
    // The shell's own exit is watched alongside its pipes. Reading to EOF first
    // meant a background grandchild (`server &`, a dev server, a pager) that
    // inherited the pipe kept the call open after the shell had finished,
    // until the deadline killed it and called a finished command a timeout.
    let pid = child.id();
    let mut exited: Option<std::io::Result<std::process::ExitStatus>> = None;
    let mut grace_ends: Option<tokio::time::Instant> = None;
    let mut orphaned = false;
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
            status = child.wait(), if exited.is_none() => {
                exited = Some(status);
                grace_ends = Some(tokio::time::Instant::now() + PIPE_GRACE_AFTER_EXIT);
            },
            _ = tokio::time::sleep_until(grace_ends.unwrap_or_else(tokio::time::Instant::now)),
                if grace_ends.is_some() => {
                orphaned = true;
                break;
            },
        }
    }
    if orphaned {
        // Something the command started is still holding its output open.
        // It is stopped, so it does not outlive the call that started it
        // (`background: true` is how a command asks to keep running).
        // On Windows the still-held `child` handle pins the pid, so it cannot
        // name a stranger; the root is gone and its descendants are swept.
        if let Some(pid) = pid {
            let _ = proc::kill_tree(pid);
        }
        cap.push(
            b"\n[note: the command exited, but a process it started kept its output open, so \
              waiting for more output was cut short. Use {\"background\": true} for a command \
              that is meant to keep running.]\n",
        );
    }
    // Whatever is left was never completed: emit it lossily rather than losing it.
    if !carry.is_empty() {
        if let Some(sink) = sink.as_ref() {
            sink(String::from_utf8_lossy(&carry).into_owned());
        }
    }
    let status = match exited {
        Some(status) => status,
        None => child.wait().await,
    };
    match status {
        Ok(status) => cap.finish(status.code()),
        Err(e) => format!("ERROR: failed to run command: {e}"),
    }
}

/// How long a command's output pipes are read after the shell itself has
/// exited. Long enough for the last buffered bytes to arrive; short enough
/// that a grandchild holding the pipe does not hold the tool call.
const PIPE_GRACE_AFTER_EXIT: std::time::Duration = std::time::Duration::from_millis(1500);

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
        // The spill file keeps the first BASH_SPILL_MAX_BYTES: a command that
        // prints forever must not fill the disk.
        if let Some(w) = self.spill.as_mut() {
            let room = BASH_SPILL_MAX_BYTES.saturating_sub(self.total_bytes);
            let _ = w.write_all(&chunk[..chunk.len().min(room)]);
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
/// Whether a failed PowerShell command's output is a path the shell could not
/// reach from where it runs: not found / does not exist, or `Set-Location`
/// refused ("Access is denied") on a directory outside the mounted workspace.
fn cwd_note_applies(class: &super::shell_diag::FailureClass, out: &str) -> bool {
    if *class == super::shell_diag::FailureClass::NotFound {
        return true;
    }
    let lower = out.to_lowercase();
    lower.contains("does not exist")
        || (lower.contains("set-location") && lower.contains("access is denied"))
}

fn cwd_note(cwd: &str, in_worktree: bool) -> String {
    if in_worktree {
        format!(
            "[cwd: {cwd} (the session worktree). Relative paths resolve there, in \
             commands and in the file tools alike.]\n"
        )
    } else {
        format!(
            "[cwd: {cwd}. The project is not the working directory; use absolute paths.]\n"
        )
    }
}

/// Hide each write root's own `.jan` from the shell. The shell may write
/// there, and a managed worktree or a repository edited in place carries the
/// project's agent policy, hooks and skills under `.jan/agent`; it is hidden
/// the same way the workspace's is (Jozkah/jan#124). Only for a sandboxed
/// shell, like the workspace hide.
fn hide_write_root_jans(mut policy: jail::Policy, write_roots: &[PathBuf]) -> jail::Policy {
    for root in write_roots {
        policy = policy.with_hide_root(&root.join(crate::tools::sandbox::JAN_DIR));
    }
    policy
}

/// The line a command run on the #9044 native-shell fallback starts with: bash
/// is installed, so "no bash is installed" would be false, and the model needs
/// the syntax it is writing for now.
pub(crate) fn native_fallback_note(spawn_error: &str, shell: &str) -> String {
    format!(
        "[shell: {shell} - bash is installed but could not start inside the sandbox \
         ({spawn_error}), so this ran in {shell} in the same sandbox. Write commands in \
         {shell} syntax, not POSIX/bash.]\n"
    )
}

/// The shell an unconfined `bash` call runs in.
///
/// `sandbox_choice` is the shell the sandbox picked for the same command,
/// given only for an approved null-device rerun: the model wrote the command
/// for that shell, so the rerun must not switch to `host` (the host's
/// preferred shell, Git Bash on Windows). A chaining command (`&&`/`||`) that
/// the chosen shell cannot parse moves to `sandbox_chaining` for a rerun --
/// what the sandbox itself would have used -- and otherwise to the first host
/// candidate that chains. `Err` is the refusal when nothing can chain.
pub(crate) fn unsandboxed_shell(
    command: &str,
    sandbox_choice: Option<proc::ShellConfig>,
    sandbox_chaining: impl FnOnce() -> Option<proc::ShellConfig>,
    host: proc::ShellConfig,
    host_candidates: impl FnOnce() -> Vec<proc::ShellConfig>,
) -> Result<proc::ShellConfig, String> {
    let rerun = sandbox_choice.is_some();
    let bare = sandbox_choice.unwrap_or(host);
    let Some(operator) = proc::requires_and_or_chaining(command) else {
        return Ok(bare);
    };
    if proc::supports_and_or_chaining(&bare) {
        return Ok(bare);
    }
    let capable = if rerun { sandbox_chaining() } else { None }
        .or_else(|| host_candidates().into_iter().find(proc::supports_and_or_chaining));
    capable.ok_or_else(|| proc::chaining_unavailable_error(operator, &bare))
}

/// The folder an unconfined `bash` should start in, when the run has edit
/// access to a folder the sandbox shell cannot reach.
///
/// On Windows an AppContainer checks every parent of a folder it opens, so a
/// project under `Desktop/Coding` fails `Set-Location` ("Access is denied")
/// and Node's `realpath` ("EPERM lstat 'C:\'") however it is granted; only
/// Jan-owned worktrees are confined. `None` when the shell is confined to the
/// roots (or there is no edit access), which keeps the sandbox.
pub fn direct_edit_shell_start(write_roots: &[PathBuf], data_folder: &Path) -> Option<PathBuf> {
    if !cfg!(windows) || jail::backend() != jail::Backend::AppContainer || write_roots.is_empty() {
        return None;
    }
    let write_abs: Vec<PathBuf> = write_roots.iter().map(|p| anchored(p)).collect();
    let owned = crate::workspace::worktrees_dir(&anchored(data_folder));
    if jail::can_confine_write_roots(jail::backend(), &write_abs, Some(&owned)) {
        return None;
    }
    write_abs.into_iter().find(|p| p.is_dir())
}

/// The folder a run's shell starts in when it is not the workspace: the
/// managed worktree the run writes to, under exactly the conditions `bash`
/// moves there (see [`managed_worktree_start`]). `None` for every other run.
pub fn working_folder(write_roots: &[PathBuf], data_folder: &Path) -> Option<PathBuf> {
    let write_abs: Vec<PathBuf> = write_roots.iter().map(|p| anchored(p)).collect();
    let owned = crate::workspace::worktrees_dir(&anchored(data_folder));
    if write_abs.is_empty()
        || !jail::can_confine_write_roots(jail::backend(), &write_abs, Some(&owned))
    {
        return None;
    }
    managed_worktree_start(&write_abs, Some(&owned))
}

/// Rewrite a file tool's relative `path` argument against `base`, the folder
/// the shell works in, so the file tools and `bash` agree on what a relative
/// path means: `write check.py` then `python check.py` name one file.
/// Absolute paths (and `/tmp/...`, which the scratch remaps) are left alone.
/// A listing tool called with no path lists `base`, as `ls` in the shell would.
pub fn rebase_relative_paths(tool: &str, args: &mut serde_json::Value, base: &Path) {
    if !matches!(
        tool,
        "read" | "write" | "edit" | "ls" | "find" | "grep" | "screenshot" | "ocr"
    ) {
        return;
    }
    let Some(obj) = args.as_object_mut() else {
        return;
    };
    let rebased = match obj.get("path") {
        Some(serde_json::Value::String(raw))
            if !raw.trim().is_empty()
                && !raw.starts_with('/')
                && !Path::new(raw).is_absolute() =>
        {
            lexical_normalize(&base.join(raw))
        }
        None if matches!(tool, "ls" | "find" | "grep") => base.to_path_buf(),
        _ => return,
    };
    obj.insert(
        "path".to_string(),
        serde_json::Value::String(rebased.to_string_lossy().into_owned()),
    );
}

/// Where `bash` starts when the run writes to a Jan-managed worktree (#322).
///
/// Only when the first granted write root is a directory inside Jan's owned
/// worktrees dir: that is the Managed worktree destination, and the one
/// case where the shell is already confined to the worktree it would start in
/// (the AppContainer ACE, the bwrap bind or the Seatbelt rule for that write
/// root). Review-only runs have no write root and direct-edit runs a root that
/// is not Jan's; both keep starting in the sandbox workspace.
///
/// The file tools follow: the desktop dispatcher rewrites their relative
/// paths against the same folder before the gate sees them
/// ([`working_folder`], [`rebase_relative_paths`]), so the two never
/// disagree about what a relative path means.
fn managed_worktree_start(write_roots: &[PathBuf], owned: Option<&Path>) -> Option<PathBuf> {
    // The primary destination is the first root; the session's extra attached
    // folders (and any `request_access` write grant) come after it and do not
    // move the shell.
    let only = write_roots.first()?;
    let owned = owned?.canonicalize().ok()?;
    let real = only.canonicalize().ok()?;
    (real.is_dir() && real.starts_with(&owned) && real != owned).then(|| only.clone())
}

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
/// (NUL, bell, etc.), keeping only tab and newline. ANSI escape sequences are
/// removed whole, so colour codes leave no `[31m`-style residue behind.
/// Carriage returns are already resolved by [`collapse_carriage_returns`]
/// beforehand. The live output stream to the UI does not pass through here, so
/// the UI can still render colours.
fn sanitize_control(s: &str) -> String {
    if !s.chars().any(|c| c.is_control() && c != '\t' && c != '\n') {
        return s.to_string();
    }
    strip_ansi(s)
        .chars()
        .filter(|&c| !c.is_control() || c == '\t' || c == '\n')
        .collect()
}

/// Remove ANSI escape sequences: CSI (`ESC [ ... final`), OSC (`ESC ] ...`
/// ended by BEL or `ESC \`), and two-character `ESC x` escapes. A C1 CSI
/// (`U+009B`) is treated like `ESC [`.
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.next() {
                Some('[') => skip_csi(&mut chars),
                Some(']') => {
                    // OSC: skip to BEL or ST.
                    while let Some(o) = chars.next() {
                        if o == '\u{7}' {
                            break;
                        }
                        if o == '\u{1b}' {
                            if chars.peek() == Some(&'\\') {
                                chars.next();
                            }
                            break;
                        }
                    }
                }
                // Character-set designation: ESC ( B and friends.
                Some('(' | ')' | '*' | '+') => {
                    chars.next();
                }
                _ => {}
            },
            '\u{9b}' => skip_csi(&mut chars),
            _ => out.push(c),
        }
    }
    out
}

/// Consume a CSI's parameter and intermediate bytes and its final byte.
fn skip_csi(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) {
    for p in chars.by_ref() {
        if ('\u{40}'..='\u{7e}').contains(&p) {
            break;
        }
    }
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

mod screenshot;
#[allow(unused_imports)]
use screenshot::*;
pub use screenshot::render_html_png;
pub use screenshot::render_html_png_noted;

async fn find(
    args: &serde_json::Value,
    root: &Path,
    scratch: Option<&Path>,
    hide_jan: bool,
    read_roots: &[PathBuf],
    write_roots: &[PathBuf],
) -> String {
    let pattern = arg_str(args, "pattern").map(String::from);
    let path = arg_str(args, "path").unwrap_or(".").to_string();
    // Clamped like the sibling tools' limits (Jozkah/jan#251): a model-chosen
    // million would otherwise walk the whole tree into one result.
    let limit = arg_u64(args, "limit")
        .map(|v| v as usize)
        .unwrap_or(FIND_DEFAULT_LIMIT)
        .clamp(1, FIND_DEFAULT_LIMIT * 10);
    let base = resolve_path(root, scratch, &path);
    if symlink_escapes_any_root(root, scratch, read_roots, &base) {
        return format!("ERROR: refused to search through a symlink out of the workspace: {path}");
    }
    let root_owned = root.to_path_buf();
    let write_owned = write_roots.to_vec();

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
            if hide_jan
                && is_hidden_jan_path_in(&root_owned, &write_owned, &entry.path().to_string_lossy())
            {
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
            // The same byte cap `ls` and `grep` apply: long paths times the
            // match limit can still be megabytes of tool result.
            cap_output(&matches.join("\n"), usize::MAX, MAX_BYTES, "\n[truncated: 64KB limit]")
        }
    })
    .await;
    res.unwrap_or_else(|e| format!("ERROR: {e}"))
}

#[cfg(test)]
mod find_cap_tests;

/// Most lines of context one match may pull in on each side.
const GREP_MAX_CONTEXT: usize = 20;

/// Longest a grep walk may run before it stops and says so.
const GREP_WALL_BUDGET: std::time::Duration = std::time::Duration::from_secs(20);

fn clamp_grep_context(requested: Option<u64>) -> usize {
    requested.map_or(0, |v| v.min(GREP_MAX_CONTEXT as u64) as usize)
}

/// Tells the blocking grep walk to stop once the awaiting call is dropped
/// (cancelled), instead of reading the rest of the tree for nobody.
struct CancelOnDrop(std::sync::Arc<std::sync::atomic::AtomicBool>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

async fn grep(
    args: &serde_json::Value,
    root: &Path,
    scratch: Option<&Path>,
    hide_jan: bool,
    read_roots: &[PathBuf],
    write_roots: &[PathBuf],
) -> String {
    let pattern = arg_str(args, "pattern").map(String::from);
    let path = arg_str(args, "path").unwrap_or(".").to_string();
    let glob_filter = arg_str(args, "glob").map(String::from);
    let ignore_case = arg_bool(args, "ignore_case");
    let literal = arg_bool(args, "literal");
    let context = clamp_grep_context(arg_u64(args, "context"));
    let limit = arg_u64(args, "limit")
        .map(|v| v as usize)
        .unwrap_or(GREP_DEFAULT_LIMIT)
        .clamp(1, GREP_MAX_RESULTS);
    let base = resolve_path(root, scratch, &path);
    if symlink_escapes_any_root(root, scratch, read_roots, &base) {
        return format!("ERROR: refused to search through a symlink out of the workspace: {path}");
    }
    let root_owned = root.to_path_buf();
    let write_owned = write_roots.to_vec();
    let scratch_owned = scratch.map(Path::to_path_buf);
    // Owned for the blocking walk closure, which outlives this frame.
    let roots_owned = read_roots.to_vec();

    let Some(pattern) = pattern else {
        return "ERROR: missing required argument 'pattern'".to_string();
    };
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let _cancel_on_drop = CancelOnDrop(cancel.clone());
    let started = std::time::Instant::now();
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
        // Grouped per file, in walk order: (relative path, [(line no, is match, text)]).
        #[allow(clippy::type_complexity)]
        let mut groups: Vec<(String, Vec<(usize, bool, String)>)> = Vec::new();
        let mut count = 0usize;
        let mut truncated = false;
        let mut skipped_secrets = 0usize;
        let mut skipped_large = 0usize;
        let mut stopped = false;

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
            // Not loaded whole unless it is a regular file of a readable size
            // (Jozkah/jan#250): skipped, not an error, so the rest is searched.
            let fits = std::fs::metadata(file)
                .is_ok_and(|m| m.is_file() && m.len() <= READ_MAX_BYTES);
            if !fits {
                skipped_large += 1;
                return true;
            }
            let content = match std::fs::read_to_string(file) {
                Ok(c) => c,
                Err(_) => return true,
            };
            let rel = rel_to(rel_base, file);
            let lines: Vec<&str> = content.lines().collect();
            let mut entries: Vec<(usize, bool, String)> = Vec::new();
            let mut keep_going = true;
            for (i, line) in lines.iter().enumerate() {
                if !re.is_match(line) {
                    continue;
                }
                if count >= limit {
                    // One match past the cap is enough to report "N+".
                    truncated = true;
                    keep_going = false;
                    break;
                }
                let start = i.saturating_sub(context);
                let end = (i + context + 1).min(lines.len());
                for (j, item) in lines.iter().enumerate().take(end).skip(start) {
                    let line_no = j + 1;
                    // Overlapping context windows: never repeat a line, but
                    // promote an already-emitted context line that matches.
                    if let Some(prev) = entries.iter_mut().find(|e| e.0 == line_no) {
                        prev.1 |= j == i;
                        continue;
                    }
                    entries.push((line_no, j == i, truncate_line(item)));
                }
                count += 1;
            }
            if !entries.is_empty() {
                groups.push((rel, entries));
            }
            keep_going
        };

        if is_file {
            let rel_base = base.parent().unwrap_or(&base);
            search_file(&base, rel_base);
        } else {
            for entry in WalkBuilder::new(&base)
                .hidden(false)
                .require_git(false)
                // Git's own database is never project content.
                .filter_entry(|e| e.file_name() != ".git")
                .build()
                .flatten()
            {
                if cancel.load(std::sync::atomic::Ordering::Relaxed)
                    || started.elapsed() > GREP_WALL_BUDGET
                {
                    stopped = true;
                    break;
                }
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
                if hide_jan
                    && is_hidden_jan_path_in(
                        &root_owned,
                        &write_owned,
                        &entry.path().to_string_lossy(),
                    )
                {
                    continue;
                }
                // AH-044 for the files a walk finds (Jozkah/jan#239): the gate
                // only saw the directory, so a credential file is skipped here,
                // judged by its own name and, through a link, by its target's.
                if walked_secret(entry.path()) {
                    skipped_secrets += 1;
                    continue;
                }
                if !search_file(entry.path(), &base) {
                    break;
                }
            }
        }

        let mut skipped_note = if skipped_secrets > 0 {
            format!(
                "\n\n[Skipped {skipped_secrets} credential file(s) (.env, keys, tokens); read one by name with a rule that allows it]"
            )
        } else {
            String::new()
        };
        if skipped_large > 0 {
            skipped_note.push_str(&format!(
                "\n\n[Skipped {skipped_large} file(s) over {} MiB or not regular files; search those with bash (rg)]",
                READ_MAX_BYTES / (1024 * 1024)
            ));
        }
        if stopped {
            skipped_note.push_str("\n\n[search stopped early (time budget or cancelled); narrow the path or glob to search the rest]");
        }
        if groups.is_empty() {
            format!("No matches.{skipped_note}")
        } else {
            let mut body = format_grep_groups(&groups);
            if truncated {
                body.push_str(&format!(
                    "\n\n[Showing first {count} of {count}+ matches; narrow the pattern, path or glob to see the rest]"
                ));
            }
            body.push_str(&skipped_note);
            cap_output(&body, usize::MAX, MAX_BYTES, "\n[truncated: 64KB limit]")
        }
    })
    .await;
    res.unwrap_or_else(|e| format!("ERROR: {e}"))
}

/// The largest file `read` or `grep` loads. Above the 20 MiB image limit, far
/// above what fits the 64 KB output; bigger files are for `bash` (`head`,
/// `rg`), which stream.
const READ_MAX_BYTES: u64 = 32 * 1024 * 1024;

/// What `read` accepts when the model passes `allow_large: true`: 8x the normal
/// limit. A hard ceiling, not an opt-out; past it the file is for `bash`.
const READ_MAX_BYTES_ALLOW_LARGE: u64 = READ_MAX_BYTES * 8;

/// Whether `path` is a regular file small enough to load whole
/// (Jozkah/jan#250), at the size limit `read`'s `allow_large` argument selects.
/// A FIFO, device or other special file is refused: reading one blocks or never
/// ends. The refusal names the argument so the model knows the way out without
/// reaching for the shell.
async fn readable_file_with(path: &Path, allow_large: bool) -> Result<(), String> {
    let meta = tokio::fs::metadata(path).await.map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a regular file".to_string());
    }
    const MIB: u64 = 1024 * 1024;
    if allow_large {
        if meta.len() > READ_MAX_BYTES_ALLOW_LARGE {
            return Err(format!(
                "{} MiB is over even the allow_large ceiling ({} MiB); use bash with head, tail or rg",
                meta.len() / MIB,
                READ_MAX_BYTES_ALLOW_LARGE / MIB
            ));
        }
    } else if meta.len() > READ_MAX_BYTES {
        return Err(format!(
            "{} MiB is too large to read here (limit {} MiB); pass allow_large: true to read up to {} MiB, or use bash with head, tail or rg",
            meta.len() / MIB,
            READ_MAX_BYTES / MIB,
            READ_MAX_BYTES_ALLOW_LARGE / MIB
        ));
    }
    Ok(())
}

/// Whether a file a directory walk reached is a credential file by the AH-044
/// name rules, by its own name or, if it is a link, by its target's name.
fn walked_secret(path: &Path) -> bool {
    let named = |p: &Path| {
        p.file_name()
            .is_some_and(|n| crate::project_browse::is_sensitive_name(&n.to_string_lossy()))
    };
    named(path) || path.canonicalize().is_ok_and(|real| named(&real))
}

/// Model-facing grep output: a header line per file (its relative path), then
/// its lines as `  N: text` for matches and `  N- text` for context, with a
/// blank line between files. Gaps inside one file are marked by `  --`.
#[allow(clippy::type_complexity)]
fn format_grep_groups(groups: &[(String, Vec<(usize, bool, String)>)]) -> String {
    let mut out = String::new();
    for (gi, (file, entries)) in groups.iter().enumerate() {
        if gi > 0 {
            out.push_str("\n\n");
        }
        out.push_str(file);
        let mut prev: Option<usize> = None;
        for (line_no, is_match, text) in entries {
            if prev.is_some_and(|p| *line_no > p + 1) {
                out.push_str("\n  --");
            }
            let sep = if *is_match { ':' } else { '-' };
            out.push_str(&format!("\n  {line_no}{sep} {text}"));
            prev = Some(*line_no);
        }
    }
    out
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
mod bash_job_registry_tests;

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
                // Text in them that imitates the harness is neutralized, and
                // the message says so in one line.
                let (subject, in_subject) = crate::control_tags::neutralize(&message.subject);
                let (body, in_body) = crate::control_tags::neutralize(&message.body);
                let screened = in_subject + in_body;
                out.push_str(&format!(
                    "From run {} at {}{}\n{}{}\n\n",
                    message.from,
                    message.at,
                    if subject.is_empty() {
                        String::new()
                    } else {
                        format!(" -- {subject}")
                    },
                    body,
                    if screened == 0 {
                        String::new()
                    } else {
                        format!("\n{}", crate::control_tags::note(screened))
                    }
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
            // Read-only here; `create::commit` writes the id down only if the
            // memory is actually saved (#312).
            project_id: Some(crate::memory::identity::project_id_read_only(ctx.project_root))
                .as_deref(),
            session_id: ctx.session_id,
            temporary: ctx.temporary,
            now,
            automatically_save: inferred::automatic_saving_enabled(ctx.store_root),
        },
    );

    // The web app files a proposal card under `provenance.session_id`
    // (`memory_proposals_list`), which `create::propose` leaves empty: without
    // this the card of an agent-proposed memory never showed in its chat.
    let source_session = ctx.session_id.map(str::to_string);
    let decision = match decision {
        Decision::Save(mut proposal) => {
            proposal.record.provenance.session_id = source_session;
            Decision::Save(proposal)
        }
        Decision::Pending { mut proposal, reason } => {
            proposal.record.provenance.session_id = source_session;
            Decision::Pending { proposal, reason }
        }
        refused => refused,
    };

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
mod tests;

/// A model that used a project-relative path (`lib/db.ts`) in a session whose
/// workspace is scratch space, or whose worktree root sits above the app.
#[cfg(test)]
mod project_path_hint_tests;
