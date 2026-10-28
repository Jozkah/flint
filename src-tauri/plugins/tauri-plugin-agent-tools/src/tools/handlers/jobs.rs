//! Background bash jobs: the registry, their live output tail and the
//! owner limits. The tool-facing text for them lives with `bash`.

use super::*;

/// Counter for unique bash background job ids.
pub(super) static BASH_JOB_COUNTER: AtomicUsize = AtomicUsize::new(0);
/// Background jobs one owner may hold at once. Past this the oldest finished,
/// uncollected job is dropped; with none finished, a new command is refused a
/// place in the background rather than growing the registry without bound.
pub(super) const MAX_JOBS_PER_OWNER: usize = 32;
/// How much of a running job's recent output a status check can show.
pub(super) const JOB_TAIL_BYTES: usize = 8 * 1024;

/// A per-process prefix for job ids.
///
/// The counter restarts at zero every launch while the records that name job
/// ids are persisted, so `bash-0` alone would name a different command after
/// every restart. The prefix makes an id from a previous run never match one
/// minted now.
pub(super) fn job_id_prefix() -> &'static str {
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

pub(super) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The most recent output of a running job, bounded, for status checks.
#[derive(Default)]
pub(super) struct LiveTail {
    pub(super) text: String,
    /// Bytes dropped from the front to stay within the bound.
    pub(super) dropped: usize,
}

impl LiveTail {
    pub(super) fn push(&mut self, chunk: &str) {
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
pub(super) fn exit_code_of(output: &str) -> Option<i32> {
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
    pub(super) rx: Option<oneshot::Receiver<String>>,
    /// The finished output, when a peek got there before the collector did.
    ///
    /// `oneshot::Receiver::try_recv` *consumes* the value on success, so a
    /// status check cannot simply discard what it observes — that would steal
    /// the result the agent is waiting to collect. It is parked here instead
    /// and handed over by [`await_bash_job`].
    pub(super) output: Option<String>,
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
    pub(super) collecting: bool,
    /// The conversation that started the command. Listing, inspecting,
    /// collecting and stopping are all confined to it, so one session cannot
    /// read or kill another's work. `None` is a surface with no conversation
    /// (a one-shot CLI run), and only another `None` caller matches it.
    pub(super) owner: Option<String>,
    /// Wall-clock start and end, for a surface that shows when it ran.
    pub(super) started_at_ms: u64,
    pub(super) finished_at_ms: Option<u64>,
    /// Stopped on request rather than by exiting.
    pub(super) stopped_by_request: bool,
    /// Recent output, fed by the same stream the live view reads.
    pub(super) tail: std::sync::Arc<Mutex<LiveTail>>,
}

impl BashJob {
    /// Has the command finished? Non-destructive from the caller's point of
    /// view: anything received is retained for collection.
    pub(super) fn poll_finished(&mut self) -> bool {
        let finished = self.poll_finished_inner();
        if finished && self.finished_at_ms.is_none() {
            self.finished_at_ms = Some(now_ms());
        }
        finished
    }

    pub(super) fn poll_finished_inner(&mut self) -> bool {
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
    pub(super) fn status(&mut self, job_id: &str) -> BashJobStatus {
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
pub(super) fn bash_jobs() -> &'static Mutex<HashMap<String, BashJob>> {
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
pub(super) fn peek_tail(job_id: &str, owner: Option<&str>) -> Option<(String, usize)> {
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
pub(super) fn make_room_for(owner: Option<&str>) -> bool {
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
                    Some(pid) => match super::super::proc::kill_tree(pid) {
                        // Signalled, or already gone: either way it is stopped,
                        // which also covers the command exiting between the
                        // poll above and the signal. Its output stays
                        // collectable because the entry is kept.
                        outcome if outcome.stopped() => {
                            job.pid = None;
                            job.stopped_by_request = true;
                            super::super::proc::unregister(pid);
                            (BashJobKillOutcome::Killed, None)
                        }
                        super::super::proc::KillOutcome::Failed(reason) => {
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
