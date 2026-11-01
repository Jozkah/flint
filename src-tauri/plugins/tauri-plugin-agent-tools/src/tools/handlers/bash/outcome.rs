//! What a `bash` call reports: the notes added to a finished command's
//! output, the background-job hand-off, and the timeout result.

use super::*;

/// Everything the output notes read, captured before the command moves into
/// its collecting task.
pub(super) struct OutputNotes {
    pub sandboxed: bool,
    pub policy: jail::Policy,
    pub command_text: String,
    pub shell_flavor: proc::ShellFlavor,
    pub shell_description: &'static str,
    pub cwd_display: String,
    pub in_worktree: bool,
    pub fallback_note: Option<String>,
    pub null_refusal: crate::unsandboxed_retry::RefusalSignal,
}

impl OutputNotes {
    /// Add the failure hints, shell banner and notes to a finished command's
    /// output. Appended inside the collecting task so a backgrounded job
    /// carries them too.
    pub(super) fn annotate(&self, mut out: String) -> String {
        let OutputNotes {
            sandboxed,
            policy,
            command_text,
            shell_flavor,
            shell_description,
            cwd_display,
            in_worktree,
            fallback_note,
            null_refusal,
        } = self;
        let (sandboxed, shell_flavor, shell_description, in_worktree) =
            (*sandboxed, *shell_flavor, *shell_description, *in_worktree);
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
            jail::unreachable_grant_note(policy, &out)
        } else {
            None
        };
        if bash_result_failed(&out) {
            let class = crate::tools::shell_diag::classify(command_text, &out, shell_flavor);
            // PowerShell runs from a drive mounted on where the shell started
            // (the workspace, or the managed worktree), and a script it starts
            // can land elsewhere. A path the command could not find is most
            // often a relative path aimed at the wrong place; say where
            // relative paths actually go.
            if shell_flavor == proc::ShellFlavor::PowerShell && cwd_note_applies(&class, &out) {
                out.insert_str(0, &cwd_note(cwd_display, in_worktree));
            }
            let hint = match class {
                crate::tools::shell_diag::FailureClass::FileAccessDenied
                | crate::tools::shell_diag::FailureClass::Network
                    if !sandboxed =>
                {
                    None
                }
                ref c => jail::failure_hint(policy, c, &out),
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
            let missing = if class == crate::tools::shell_diag::FailureClass::MissingCommand {
                crate::tools::host_tools::missing_program(&out)
            } else {
                None
            }
            .or_else(|| crate::tools::host_tools::python_launcher_missing(command_text, &out));
            if class == crate::tools::shell_diag::FailureClass::MissingCommand {
                if let Some(note) = crate::tools::host_tools::missing_path_note(
                    &out,
                    crate::tools::host_tools::current_profile().as_deref(),
                ) {
                    out.push_str(&note);
                }
            }
            if sandboxed {
                // An unquoted assignment value, not a missing program.
                let quoting = missing.as_deref().and_then(|name| {
                    crate::tools::host_tools::unquoted_assignment(command_text, name)
                });
                if let Some(note) = quoting {
                    out.push_str(&note);
                } else if let Some(name) = missing {
                    let host = std::env::var_os("PATH").unwrap_or_default();
                    let pathext =
                        std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
                    match crate::tools::host_tools::locate_on_host(&name, &host, &pathext) {
                        // The launcher itself exists when it reports 103/109;
                        // what is missing is a Python behind it.
                        Some(found) if name != "py" => {
                            let profile =
                                std::env::var_os("USERPROFILE").map(std::path::PathBuf::from);
                            out.push_str(&crate::tools::host_tools::unavailable_hint(
                                &name,
                                &found,
                                profile.as_deref(),
                                crate::tools::host_tools::container_can_execute,
                            ));
                        }
                        _ => out.push_str(&crate::tools::host_tools::not_installed_hint(&name)),
                    }
                }
                if !policy.allow_network
                    && crate::tools::host_tools::is_name_resolution_failure(&out)
                {
                    out.push_str(crate::tools::host_tools::NO_NETWORK_HINT);
                }
            }
            // Which shell ran it, on a failure only: that is when the model is
            // about to write the next command and most needs the syntax.
            if let Some(banner) =
                crate::tools::shell_diag::shell_banner(shell_flavor, shell_description)
            {
                out.insert_str(0, &banner);
            }
        }
        if let Some(note) = unreachable {
            out.push_str(&note);
        }
        if let Some(hint) = crate::tools::host_tools::go_flag_order_hint(&out) {
            out.push_str(hint);
        }
        if shell_flavor == proc::ShellFlavor::PowerShell && !bash_result_failed(&out) {
            if let Some((code, note)) = crate::tools::host_tools::masked_failure(&out) {
                crate::tools::host_tools::set_exit_marker(&mut out, code);
                out.push_str(&note);
            }
        }
        if let Some(note) = fallback_note {
            out.insert_str(0, note);
        } else if shell_description == "cmd" {
            out.insert_str(
                0,
                "[shell: cmd.exe - no bash is installed. Write commands in cmd syntax \
                 (e.g. `dir`, `type`, `set`, `mkdir`, `%VAR%` for variables), not \
                 POSIX/bash. Alternatively install git-bash and this tool will use it.]\n",
            );
        }
        out
    }
}

/// A command that is still running at its deadline and was asked to run in
/// the background: registered as a job, with the sentence the desktop reads
/// the job id from. Refused (and stopped) when every job slot this
/// conversation holds is still running.
#[allow(clippy::too_many_arguments)]
pub(super) fn register_background_job(
    ctx: &ToolContext<'_>,
    command: &str,
    pid: Option<u32>,
    rx: oneshot::Receiver<String>,
    tail: std::sync::Arc<Mutex<LiveTail>>,
    job_started: std::time::Instant,
    timeout_secs: u64,
) -> String {
    let owner = ctx.job_owner;
    if !make_room_for(owner) {
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
        let record = crate::job_record::JobRecord::started(&job_id, owner, command, identity);
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
    background_job_started_text(&job_id, timeout_secs)
}

/// Both forms end in the same fixed sentence, which is what the desktop
/// reads the job id from (`backgroundJobId`).
pub(crate) fn background_job_started_text(job_id: &str, timeout_secs: u64) -> String {
    let waited = if timeout_secs == 0 {
        "Command was started as a background job and".to_string()
    } else {
        format!("Command exceeded {timeout_secs}s and")
    };
    format!(
        "{waited} is continuing in the background \
         (job_id={job_id}). Call bash again with {{\"job_id\": \"{job_id}\"}} (no \
         command) to wait for and collect its output once it finishes, \
         {{\"job_id\": \"{job_id}\", \"action\": \"status\"}} to check on it without \
         waiting, or {{\"job_id\": \"{job_id}\", \"action\": \"cancel\"}} to stop it."
    )
}

/// AH-020: a foreground command past its deadline is terminated, with
/// whatever it printed before.
pub(super) async fn terminate_on_timeout(
    command: &str,
    pid: Option<u32>,
    rx: &mut oneshot::Receiver<String>,
    timeout_secs: u64,
    sandboxed: bool,
    shell_flavor: proc::ShellFlavor,
    shell_description: &'static str,
) -> String {
    let killed = match pid {
        Some(pid) => proc::kill_tree(pid),
        // No pid means the child never started; nothing is left running.
        None => proc::KillOutcome::Gone,
    };
    // Whatever the command managed to print is still worth having, and
    // the collector flushes it once the child is gone. Bounded, so a
    // process that ignores the kill cannot hold the call open.
    let partial = tokio::time::timeout(std::time::Duration::from_secs(5), rx)
        .await
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or_default();
    timeout_text(
        timeout_secs,
        killed.stopped(),
        crate::tools::node_runner::timeout_note(command, sandboxed, shell_flavor, shell_description),
        &partial,
    )
}

/// The timeout result: what happened, a warning when the stop was not clean,
/// the runner note, and the output before the deadline.
pub(crate) fn timeout_text(
    timeout_secs: u64,
    stopped: bool,
    runner_note: Option<String>,
    partial: &str,
) -> String {
    let mut out = format!(
        "ERROR: command timed out after {timeout_secs}s and was terminated. \
         This is a timeout, not a cancellation: the command was still running \
         when its deadline passed. Re-run it with a larger {{\"timeout\": N}}, \
         or with {{\"background\": true}} to let it continue and poll it by \
         job_id."
    );
    if !stopped {
        // Fail loudly rather than claim a clean stop we did not achieve.
        out.push_str("\n[warning: the process tree may not have terminated cleanly]");
    }
    if let Some(note) = runner_note {
        out.push_str(&note);
    }
    if !partial.trim().is_empty() {
        out.push_str("\n--- output before the timeout ---\n");
        out.push_str(partial);
    }
    out
}
