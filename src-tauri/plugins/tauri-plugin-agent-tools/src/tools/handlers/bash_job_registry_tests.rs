use super::*;
use serde_json::json;

fn park(job_id: &str, command: &str) -> tokio::sync::oneshot::Sender<String> {
    park_with_pid(job_id, command, None)
}

fn park_with_pid(
    job_id: &str,
    command: &str,
    pid: Option<u32>,
) -> tokio::sync::oneshot::Sender<String> {
    let (tx, rx) = oneshot::channel::<String>();
    bash_jobs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
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
    let _ = bash_jobs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove("bash-kill-refused");
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
            .unwrap_or_else(|e| e.into_inner())
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
    let _ = bash_jobs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove("bash-kill-nopid");
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
    let _ = bash_jobs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove("bash-kill-twice");
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
    assert_eq!(
        await_bash_job("bash-listing-running", None).await,
        "done at last"
    );
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
    assert!(!list_bash_jobs(None)
        .iter()
        .any(|j| j.job_id == "bash-outlives"));
}

#[test]
fn grep_context_clamped() {
    assert_eq!(clamp_grep_context(None), 0);
    assert_eq!(clamp_grep_context(Some(3)), 3);
    assert_eq!(clamp_grep_context(Some(u64::MAX)), GREP_MAX_CONTEXT);
}

#[test]
fn host_powershell_git_reset_hard_held() {
    let args = json!({ "script": "git reset --hard HEAD" });
    assert_eq!(powershell_guard_text(&args), Some("git reset --hard HEAD"));
    let legacy = json!({ "command": "git clean -fdx" });
    assert_eq!(powershell_guard_text(&legacy), Some("git clean -fdx"));
}

#[test]
fn screenshot_sandbox_failure_is_recognised() {
    assert!(screenshot_failed_on_sandbox(
        "screenshot not produced: x (chrome: No usable sandbox! | more)"
    ));
    assert!(!screenshot_failed_on_sandbox(
        "screenshot not produced: x (chrome: gpu error)"
    ));
    assert!(!screenshot_failed_on_sandbox(
        "failed to launch Chrome: sandbox"
    ));
}

#[tokio::test]
async fn await_bash_job_cancel_keeps_job_collectable() {
    let tx = park("bash-cancel-collect", "sleep 9");
    let cancelled = tokio::time::timeout(
        std::time::Duration::from_millis(30),
        await_bash_job("bash-cancel-collect", None),
    )
    .await;
    assert!(cancelled.is_err(), "collection should still be waiting");
    tx.send("done".to_string()).unwrap();
    assert_eq!(await_bash_job("bash-cancel-collect", None).await, "done");
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
    bash_jobs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_mut(job_id)
        .unwrap()
        .owner = Some(owner.to_string());
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
    assert!(list_bash_jobs(None)
        .iter()
        .all(|j| j.job_id != "bash-owned-a"));
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
        .unwrap_or_else(|e| e.into_inner())
        .get("bash-status")
        .unwrap()
        .tail
        .lock()
        .unwrap_or_else(|e| e.into_inner())
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
        .unwrap_or_else(|e| e.into_inner())
        .get("bash-redact")
        .unwrap()
        .tail
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push("using PGPASSWORD=hunter2hunter2\n");
    let listed = list_bash_jobs(Some("s-redact"));
    let job = listed.iter().find(|j| j.job_id == "bash-redact").unwrap();
    assert!(!job.command.contains("sk-live"), "{}", job.command);
    let status = bash_job_status_text("bash-redact", Some("s-redact"));
    assert!(!status.contains("hunter2"), "{status}");
    assert!(!status.contains("sk-live"), "{status}");
    let _ = bash_jobs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove("bash-redact");
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
    assert_eq!(
        kill_bash_job("bash-stopped", None).outcome,
        BashJobKillOutcome::Killed
    );
    assert!(
        inspect_bash_job("bash-stopped", None)
            .unwrap()
            .stopped_by_request
    );
    let _ = bash_jobs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove("bash-stopped");
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
        bash_jobs()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(&id)
            .unwrap()
            .started_at_ms = 1_000 + n as u64;
    }
    assert!(!make_room_for(Some(owner)), "every job is running: no room");
    // Another conversation is unaffected by this one's limit.
    assert!(make_room_for(Some("s-other")));

    senders
        .remove(3)
        .send("done\n[exit 0]".to_string())
        .unwrap();
    assert!(make_room_for(Some(owner)));
    assert!(
        inspect_bash_job("bash-bound-3", Some(owner)).is_none(),
        "the finished job made room"
    );
    for n in 0..MAX_JOBS_PER_OWNER {
        let _ = bash_jobs()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&format!("bash-bound-{n}"));
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
    assert_eq!(
        exit_code_of("[exit 1]\nmore\n[exit 7]\n[output truncated at 1 of 2 bytes]"),
        Some(7)
    );
    assert_eq!(exit_code_of("[terminated by signal]"), None);
}
