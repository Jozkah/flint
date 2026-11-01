//! The `bash` tool: foreground and background runs, output capture and
//! spill files, and the shell-selection notes around them.

use super::*;

/// Run the pieces of a read-only command in order and join what they say.
/// Shell steps run in the sandbox as the same `bash` call; git steps run by
/// the host's git, confined to the folders the run may use.
pub(super) fn run_split_read_only<'a>(
    args: &'a serde_json::Value,
    ctx: &'a ToolContext<'_>,
    pieces: Vec<super::super::nul_programs::Piece>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = String> + Send + 'a>> {
    Box::pin(async move {
        use super::super::nul_programs::Piece;
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

mod outcome;
mod policy;
mod shell;

pub(super) use outcome::*;
pub(crate) use policy::{build_bash_policy, AnchoredRoots, BashPolicy};
use shell::*;

/// A `bash` call with no command: collect, inspect, cancel or list
/// backgrounded jobs.
pub(super) async fn bash_job_action(args: &serde_json::Value, ctx: &ToolContext<'_>) -> String {
    let owner = ctx.job_owner;
    let action = arg_str(args, "action").map(str::trim).unwrap_or("");
    let job_id = arg_str(args, "job_id").map(str::trim).filter(|id| !id.is_empty());
    match (action, job_id) {
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
    }
}

/// `(background, timeout_secs)` for a call.
///
/// Opt-in: a command that outlives its deadline is terminated unless the
/// caller explicitly asked for it to keep running and be polled by job_id.
/// A command the caller *asked* to run in the background is backgrounded
/// straight away rather than after an arbitrary wait. A timeout given with
/// it still means "wait this long first". The schema caps a foreground wait
/// at 120 s (the lifecycle watchdog stops it then anyway); a larger value is
/// clamped rather than trusted. 0 keeps its meaning of "no wait". Background
/// calls keep their own ceiling.
pub(super) fn bash_timeout(args: &serde_json::Value) -> (bool, u64) {
    let background = arg_bool(args, "background");
    let timeout_secs = arg_u64(args, "timeout").unwrap_or(if background {
        0
    } else {
        DEFAULT_BASH_TIMEOUT_SECS
    });
    let timeout_secs = if background {
        timeout_secs
    } else {
        timeout_secs.min(MAX_FOREGROUND_BASH_TIMEOUT_SECS)
    };
    (background, timeout_secs)
}

pub(super) async fn bash(args: &serde_json::Value, ctx: &ToolContext<'_>) -> String {
    let Some(command) = arg_str(args, "command").filter(|command| !command.trim().is_empty())
    else {
        return bash_job_action(args, ctx).await;
    };
    let (background, timeout_secs) = bash_timeout(args);

    let roots = AnchoredRoots::from_ctx(ctx);
    let root = roots.root.as_path();
    if !root.is_dir() {
        return format!(
            "ERROR: working directory does not exist: {}",
            root.display()
        );
    }
    // `policy` is built even for an unconfined shell: it is what
    // `denial_hint` reads, and an unconfined command can still hit a plain
    // filesystem permission error worth explaining.
    let BashPolicy {
        policy,
        start,
        in_worktree,
    } = build_bash_policy(ctx, &roots);
    let shell = if ctx.sandbox {
        select_sandboxed_shell(args, ctx, command, &policy).await
    } else {
        select_unsandboxed_shell(ctx, command, &policy)
    };
    let shell = match shell {
        Ok(shell) => shell,
        Err(text) => return text,
    };

    let sandbox_tmp = if ctx.sandbox {
        jail::scratch_env_path(jail::backend(), &policy)
    } else {
        None
    };
    let (child, shell, fallback_note) = match spawn_with_fallback(
        ctx.sandbox,
        &policy,
        shell,
        command,
        &start,
        sandbox_tmp.as_deref(),
    )
    .await
    {
        Ok(spawned) => spawned,
        Err(text) => return text,
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
    // The model writes POSIX commands by default, which `cmd` rejects. Surface
    // the resolved shell so it can adapt when the only shell on a Windows box
    // is cmd, instead of the tool silently presenting cmd as bash.
    let shell_description = shell.description;
    let shell_flavor = shell.flavor;
    let notes = OutputNotes {
        sandboxed,
        policy,
        command_text: command.to_string(),
        shell_flavor,
        shell_description,
        cwd_display: start.display().to_string(),
        in_worktree,
        fallback_note,
        null_refusal: ctx.null_refusal.clone(),
    };
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
        let out = notes.annotate(out);
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
            // for it -- see the `background` argument. A command the model
            // did not ask to background does not get to survive its deadline.
            if background {
                return register_background_job(ctx, command, pid, rx, tail, job_started, timeout_secs);
            }
            terminate_on_timeout(
                command,
                pid,
                &mut rx,
                timeout_secs,
                sandboxed,
                shell_flavor,
                shell_description,
            )
            .await
        }
    }
}

/// A job's state, for the model, without waiting and without collecting.
pub(super) fn bash_job_status_text(job_id: &str, owner: Option<&str>) -> String {
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
pub(super) fn end_job_record(
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
pub(super) fn bash_job_cancel_text(job_id: &str, owner: Option<&str>) -> String {
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
pub(super) fn bash_job_list_text(owner: Option<&str>) -> String {
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
pub(super) async fn deadline(root: &Path, timeout_secs: u64) {
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
pub(super) fn test_deadlines(
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
pub(super) struct CollectGuard {
    pub(super) job_id: String,
    pub(super) rx: Option<oneshot::Receiver<String>>,
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
pub(super) async fn await_bash_job(job_id: &str, owner: Option<&str>) -> String {
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
pub(super) async fn collect_and_format(
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
pub(super) const PIPE_GRACE_AFTER_EXIT: std::time::Duration = std::time::Duration::from_millis(1500);

/// Bounded, tail-preserving accumulator for a command's combined output.
/// Keeps only the last [`BASH_MAX_BYTES`] raw bytes in memory; once total
/// output exceeds that window it spills every byte to a temp file so nothing
/// is lost while memory stays bounded.
pub(super) struct BashCapture {
    pub(super) tail: std::collections::VecDeque<u8>,
    pub(super) total_bytes: usize,
    pub(super) total_newlines: usize,
    pub(super) spill: Option<std::io::BufWriter<std::fs::File>>,
    pub(super) spill_path: Option<PathBuf>,
    pub(super) scratch: Option<PathBuf>,
}

impl BashCapture {
    pub(super) fn new(scratch: Option<PathBuf>) -> Self {
        BashCapture {
            tail: std::collections::VecDeque::new(),
            total_bytes: 0,
            total_newlines: 0,
            spill: None,
            spill_path: None,
            scratch,
        }
    }

    pub(super) fn push(&mut self, chunk: &[u8]) {
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

    pub(super) fn finish(mut self, code: Option<i32>) -> String {
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
pub(super) fn cwd_note_applies(class: &super::super::shell_diag::FailureClass, out: &str) -> bool {
    if *class == super::super::shell_diag::FailureClass::NotFound {
        return true;
    }
    let lower = out.to_lowercase();
    lower.contains("does not exist")
        || (lower.contains("set-location") && lower.contains("access is denied"))
}

pub(super) fn cwd_note(cwd: &str, in_worktree: bool) -> String {
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
pub(super) fn hide_write_root_jans(mut policy: jail::Policy, write_roots: &[PathBuf]) -> jail::Policy {
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
pub(super) fn managed_worktree_start(write_roots: &[PathBuf], owned: Option<&Path>) -> Option<PathBuf> {
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

pub(super) fn bytecount_newlines(bytes: &[u8]) -> usize {
    bytes.iter().filter(|&&b| b == b'\n').count()
}

/// Drop control characters that would corrupt the model's view of the output
/// (NUL, bell, etc.), keeping only tab and newline. ANSI escape sequences are
/// removed whole, so colour codes leave no `[31m`-style residue behind.
/// Carriage returns are already resolved by [`collapse_carriage_returns`]
/// beforehand. The live output stream to the UI does not pass through here, so
/// the UI can still render colours.
pub(super) fn sanitize_control(s: &str) -> String {
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
pub(super) fn skip_csi(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) {
    for p in chars.by_ref() {
        if ('\u{40}'..='\u{7e}').contains(&p) {
            break;
        }
    }
}

/// Keep the last `max_lines` lines and last `max_bytes` bytes of `s` (trimming
/// at a UTF-8 boundary). Unlike [`cap_output`], this preserves the *end* of the
/// output so a command's final result and error lines survive truncation.
pub(super) fn tail_cap(s: &str, max_lines: usize, max_bytes: usize) -> String {
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
pub(super) fn spill_dir(scratch: Option<&Path>) -> Option<PathBuf> {
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

pub(super) fn new_temp_path(scratch: Option<&Path>) -> Option<PathBuf> {
    let n = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
    Some(spill_dir(scratch)?.join(format!("jan-bash-{}-{}.txt", std::process::id(), n)))
}

/// Open a spill file atomically with `O_EXCL` so we never truncate or write
/// through an existing symlink the shell planted: `create_new` fails if the
/// path already exists (as a file or a symlink). Combined with the validated
/// non-symlink parent from [`spill_dir`], the model-controlled spill bytes
/// cannot be redirected onto a host file.
pub(super) fn open_spill_file(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
}

/// Write `content` to a uniquely named temp file, returning its path on
/// success. Uses [`open_spill_file`] so the write never follows a symlink.
pub(super) fn write_temp_output(content: &str, scratch: Option<&Path>) -> Option<PathBuf> {
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
pub(super) fn remove_spill_file(path: &Path) {
    if let Some(parent) = path.parent() {
        match std::fs::symlink_metadata(parent) {
            Ok(meta) if !meta.file_type().is_symlink() && meta.is_dir() => {}
            _ => return,
        }
    }
    let _ = std::fs::remove_file(path);
}
