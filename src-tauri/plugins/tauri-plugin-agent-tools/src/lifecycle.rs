//! Stopping work, and knowing why it stopped.
//!
//! Teardown used to be drop-and-abort: a future was dropped, and whatever it
//! had spawned was left to a process-group kill at shutdown. Nothing could ask
//! "has this been cancelled?" mid-flight, nothing could stop one run without
//! stopping the process, and a `bash` call that outlived its timeout was
//! *backgrounded* — it kept running, unowned, after the call that started it
//! had returned.
//!
//! This module is the one primitive underneath both AH-020 (timeouts) and
//! AH-023 (cancellation). They share the machinery deliberately and stay
//! distinguishable deliberately: a [`Token`] records *why* it stopped, because
//! "the model's command took too long" and "the user pressed stop" are
//! different things to a person reading the transcript, and only one of them is
//! the model's problem to work around.
//!
//! Three properties the tests hold it to:
//!
//! * **Scoped.** Cancelling a run stops that run. A token is owned by exactly
//!   one call, in one run, in one session, and stopping a scope never reaches
//!   outside it.
//! * **Late work loses.** Once a token is stopped, a result that arrives
//!   afterwards is discarded rather than overwriting the terminal state. A
//!   command that finishes during the kill must not report success.
//! * **Nothing is left behind.** A stopped scope has no live child process, and
//!   no registered pid, when it returns.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// Why an operation ended before it finished.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    /// The operation outlived the time allowed for it.
    Timeout,
    /// Someone asked for it to stop — the user, or an enclosing scope.
    Cancelled,
}

impl StopReason {
    pub fn as_str(self) -> &'static str {
        match self {
            StopReason::Timeout => "timeout",
            StopReason::Cancelled => "cancelled",
        }
    }

    /// The audit outcome this reason produces, so AH-049 records the right
    /// thing without every caller re-deciding.
    pub fn audit_outcome(self) -> crate::audit::Outcome {
        match self {
            // A timeout is not a permission event; it is recorded as the
            // cancellation of the work it stopped, with the reason naming it.
            StopReason::Timeout | StopReason::Cancelled => crate::audit::Outcome::Cancelled,
        }
    }
}

const RUNNING: u8 = 0;
const STOPPED_TIMEOUT: u8 = 1;
const STOPPED_CANCELLED: u8 = 2;

/// Who owns a piece of work. Cancellation is always scoped by one of these.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default)]
pub struct Scope {
    pub session: String,
    pub run: String,
    pub call: String,
}

impl Scope {
    pub fn new(
        session: impl Into<String>,
        run: impl Into<String>,
        call: impl Into<String>,
    ) -> Self {
        Self {
            session: session.into(),
            run: run.into(),
            call: call.into(),
        }
    }

    /// Whether `self` is inside `other` — used to decide what a scoped stop
    /// reaches. An empty field in `other` means "any", so a run scope covers
    /// every call in it and a session scope covers every run.
    pub fn within(&self, other: &Scope) -> bool {
        let matches = |mine: &str, theirs: &str| theirs.is_empty() || mine == theirs;
        matches(&self.session, &other.session)
            && matches(&self.run, &other.run)
            && matches(&self.call, &other.call)
    }
}

#[derive(Debug)]
struct Inner {
    state: AtomicU8,
    scope: Scope,
    /// Child processes this token owns, so stopping it can reap them.
    pids: Mutex<Vec<u32>>,
}

/// A handle to one piece of cancellable work.
///
/// Cloning shares the state: the dispatcher, the handler and the process
/// watcher all hold the same token.
#[derive(Debug, Clone)]
pub struct Token(Arc<Inner>);

impl Token {
    pub fn new(scope: Scope) -> Self {
        Token(Arc::new(Inner {
            state: AtomicU8::new(RUNNING),
            scope,
            pids: Mutex::new(Vec::new()),
        }))
    }

    /// A token that is never stopped, for callers with no scope of their own.
    pub fn detached() -> Self {
        Token::new(Scope::default())
    }

    pub fn scope(&self) -> &Scope {
        &self.0.scope
    }

    /// Why this stopped, or `None` while it is still running.
    pub fn stopped(&self) -> Option<StopReason> {
        match self.0.state.load(Ordering::SeqCst) {
            STOPPED_TIMEOUT => Some(StopReason::Timeout),
            STOPPED_CANCELLED => Some(StopReason::Cancelled),
            _ => None,
        }
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped().is_some()
    }

    /// Stop this work, recording why. The first reason wins: a user cancelling
    /// a command that was already timing out should not have the record
    /// rewritten underneath them.
    ///
    /// Returns whether this call was the one that stopped it.
    pub fn stop(&self, reason: StopReason) -> bool {
        let want = match reason {
            StopReason::Timeout => STOPPED_TIMEOUT,
            StopReason::Cancelled => STOPPED_CANCELLED,
        };
        let won = self
            .0
            .state
            .compare_exchange(RUNNING, want, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok();
        if won {
            self.reap();
        }
        won
    }

    /// Adopt a child process, so stopping this token kills it.
    ///
    /// If the token is already stopped the process is killed immediately: the
    /// race where a command is spawned just after a cancellation would
    /// otherwise leave it running with nobody holding its handle.
    pub fn adopt(&self, pid: u32) {
        if self.is_stopped() {
            let _ = crate::tools::proc::kill_tree(pid);
            return;
        }
        self.0.pids.lock().unwrap().push(pid);
    }

    /// Release a child that exited on its own.
    pub fn release(&self, pid: u32) {
        self.0.pids.lock().unwrap().retain(|p| *p != pid);
    }

    /// Kill every child this token still owns.
    fn reap(&self) {
        let pids: Vec<u32> = std::mem::take(&mut *self.0.pids.lock().unwrap());
        for pid in pids {
            let _ = crate::tools::proc::kill_tree(pid);
        }
    }

    /// How many children this token still owns. A stopped token with children
    /// left is a cleanup failure, which AH-051 has to fail closed on.
    pub fn live_children(&self) -> usize {
        self.0.pids.lock().unwrap().len()
    }

    /// Turn a completed result into the terminal one, rejecting late success.
    ///
    /// The point of the whole module: a command that finishes while it is being
    /// killed must not report success, and a run that was cancelled must not
    /// show the answer that arrived afterwards.
    pub fn settle<T>(&self, value: T) -> Result<T, StopReason> {
        match self.stopped() {
            Some(reason) => Err(reason),
            None => Ok(value),
        }
    }
}

/// Every live token, so a scope can be stopped without threading handles
/// through every call.
fn registry() -> &'static Mutex<HashMap<u64, Token>> {
    static REGISTRY: OnceLock<Mutex<HashMap<u64, Token>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_id() -> u64 {
    use std::sync::atomic::AtomicU64;
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// A token registered for the lifetime of the guard.
///
/// Dropping it deregisters, so a finished call leaves nothing in the registry
/// for a later scope-wide stop to trip over.
#[derive(Debug)]
pub struct Registered {
    id: u64,
    token: Token,
}

impl Registered {
    pub fn token(&self) -> &Token {
        &self.token
    }
}

impl Drop for Registered {
    fn drop(&mut self) {
        registry().lock().unwrap().remove(&self.id);
    }
}

/// Register a token so `stop_scope` can reach it.
pub fn register(token: Token) -> Registered {
    let id = next_id();
    registry().lock().unwrap().insert(id, token.clone());
    Registered { id, token }
}

/// Stop every live token inside `scope`, returning how many were stopped.
///
/// An empty field means "any", so `Scope::new("s1", "", "")` stops a session
/// and `Scope::default()` stops everything — which is what AH-051's application
/// scope is.
pub fn stop_scope(scope: &Scope, reason: StopReason) -> usize {
    let tokens: Vec<Token> = registry()
        .lock()
        .unwrap()
        .values()
        .filter(|t| t.scope().within(scope))
        .cloned()
        .collect();
    tokens.iter().filter(|t| t.stop(reason)).count()
}

/// Children still alive inside `scope` after a stop. Non-zero means cleanup
/// did not finish, and AH-051 reports rather than claiming success.
pub fn live_children_in(scope: &Scope) -> usize {
    registry()
        .lock()
        .unwrap()
        .values()
        .filter(|t| t.scope().within(scope))
        .map(|t| t.live_children())
        .sum()
}

tokio::task_local! {
    /// The token for the work running on this task.
    ///
    /// Set once where a run begins; everything it awaits inherits it. This
    /// exists for the layers that are too far from the dispatcher to be handed
    /// a token by hand -- the provider retry loop is several calls below the
    /// invoker and threading a parameter down would touch every layer between
    /// without any of them using it.
    ///
    /// Scope-precise despite being ambient: the token carries its own scope, so
    /// reading it here cannot let one run cancel another.
    static CURRENT: Token;
}

/// The token for the current task, if it is running inside a run.
pub fn current() -> Option<Token> {
    CURRENT.try_with(Token::clone).ok()
}

/// Run `future` with `token` as the ambient token.
pub async fn with_current<F, T>(token: Token, future: F) -> T
where
    F: std::future::Future<Output = T>,
{
    CURRENT.scope(token, future).await
}

/// Sleep, unless the ambient token stops first.
///
/// Returns the reason if the wait was cut short. Used for retry backoff, where
/// a run cancelled during a two-minute wait should stop then, not two minutes
/// later.
pub async fn sleep_unless_stopped(delay: Duration) -> Option<StopReason> {
    let Some(token) = current() else {
        tokio::time::sleep(delay).await;
        return None;
    };
    if let Some(reason) = token.stopped() {
        return Some(reason);
    }
    tokio::select! {
        biased;
        _ = tokio::time::sleep(delay) => None,
        _ = wait_until_stopped(&token) => token.stopped(),
    }
}

/// How long a tool may run before it is stopped.
///
/// One table rather than a constant buried in the bash handler, so "how long
/// does a tool get?" has a single answer that can be configured and audited.
#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
    pub default_secs: u64,
    pub bash_secs: u64,
    pub net_secs: u64,
    pub filesystem_secs: u64,
    pub mcp_secs: u64,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            // Filesystem work is local and either finishes quickly or is stuck.
            filesystem_secs: 30,
            // `bash` enforces its model-facing command deadline itself (at most
            // 120s). This is the outer emergency bound, so it must leave room
            // for sandbox startup plus process-tree termination/output drain.
            bash_secs: 150,
            // A network round trip that has not answered in a minute will not.
            net_secs: 60,
            // MCP servers do real work, but not unbounded work.
            mcp_secs: 120,
            default_secs: 60,
        }
    }
}

impl Timeouts {
    /// The limit for one tool, by name. Unknown tools get the default rather
    /// than no limit: an unbounded tool is how a run hangs forever.
    pub fn for_tool(&self, tool: &str) -> Duration {
        let secs = match tool {
            // A clone is a long network operation, like a shell command.
            "bash" | "git_clone" | "git" => self.bash_secs,
            "web_search" | "web_fetch" => self.net_secs,
            "read" | "ls" | "find" | "grep" | "write" | "edit" => self.filesystem_secs,
            name if name.starts_with("mcp") || name.contains('.') => self.mcp_secs,
            _ => self.default_secs,
        };
        Duration::from_secs(secs)
    }

    /// Override one tool's limit, as a per-tool configuration would.
    pub fn with_tool_override(mut self, tool: &str, secs: u64) -> Self {
        match tool {
            "bash" => self.bash_secs = secs,
            "web_search" | "web_fetch" => self.net_secs = secs,
            "read" | "ls" | "find" | "grep" | "write" | "edit" => self.filesystem_secs = secs,
            _ => self.default_secs = secs,
        }
        self
    }
}

/// Run `future` under a token and a deadline.
///
/// The deadline starts here, when execution starts — not while a call was
/// waiting for someone to approve it, which is time the user spent, not the
/// tool. On expiry the token is stopped with [`StopReason::Timeout`], which
/// reaps the children it owns, and the caller gets the reason rather than a
/// bare `None`.
pub async fn run_with_deadline<F, T>(
    token: &Token,
    limit: Duration,
    future: F,
) -> Result<T, StopReason>
where
    F: std::future::Future<Output = T>,
{
    // Already stopped before we began: cancel-before-execution.
    if let Some(reason) = token.stopped() {
        return Err(reason);
    }
    tokio::select! {
        biased;
        value = future => token.settle(value),
        _ = tokio::time::sleep(limit) => {
            token.stop(StopReason::Timeout);
            Err(StopReason::Timeout)
        }
        _ = wait_until_stopped(token) => {
            Err(token.stopped().unwrap_or(StopReason::Cancelled))
        }
    }
}

/// Resolve once the token stops.
///
/// Polled rather than notified: the token is shared across threads that are not
/// all async, and a poll at this interval is imperceptible next to the work
/// being cancelled.
async fn wait_until_stopped(token: &Token) {
    loop {
        if token.is_stopped() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(session: &str, run: &str, call: &str) -> Scope {
        Scope::new(session, run, call)
    }

    // ---- timeout and cancellation stay distinguishable (AH-020 / AH-023) --

    #[tokio::test(start_paused = true)]
    async fn a_slow_operation_times_out_and_says_so() {
        // Paused clock: the deadline is deterministic, not a real 5s wait.
        let token = Token::new(scope("s1", "r1", "c1"));
        let outcome: Result<&str, StopReason> =
            run_with_deadline(&token, Duration::from_secs(5), async {
                tokio::time::sleep(Duration::from_secs(60)).await;
                "finished"
            })
            .await;
        assert_eq!(outcome, Err(StopReason::Timeout));
        assert_eq!(token.stopped(), Some(StopReason::Timeout));
        // Not conflated with a user pressing stop.
        assert_ne!(token.stopped(), Some(StopReason::Cancelled));
    }

    #[tokio::test(start_paused = true)]
    async fn work_that_finishes_in_time_is_returned() {
        let token = Token::new(scope("s1", "r1", "c1"));
        let outcome = run_with_deadline(&token, Duration::from_secs(30), async {
            tokio::time::sleep(Duration::from_secs(1)).await;
            "finished"
        })
        .await;
        assert_eq!(outcome, Ok("finished"));
        assert!(!token.is_stopped());
    }

    #[tokio::test(start_paused = true)]
    async fn cancelling_mid_flight_stops_the_work_and_names_the_user() {
        let token = Token::new(scope("s1", "r1", "c1"));
        let watcher = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            watcher.stop(StopReason::Cancelled);
        });
        let outcome: Result<&str, StopReason> =
            run_with_deadline(&token, Duration::from_secs(3600), async {
                tokio::time::sleep(Duration::from_secs(3600)).await;
                "finished"
            })
            .await;
        assert_eq!(outcome, Err(StopReason::Cancelled));
    }

    #[tokio::test]
    async fn cancelling_before_execution_never_starts_the_work() {
        let token = Token::new(scope("s1", "r1", "c1"));
        token.stop(StopReason::Cancelled);

        let ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = ran.clone();
        let outcome: Result<(), StopReason> =
            run_with_deadline(&token, Duration::from_secs(30), async move {
                flag.store(true, Ordering::SeqCst);
            })
            .await;

        assert_eq!(outcome, Err(StopReason::Cancelled));
        assert!(
            !ran.load(Ordering::SeqCst),
            "a cancelled call must not begin executing"
        );
    }

    #[test]
    fn the_first_reason_wins() {
        // A user cancelling something that was already timing out must not
        // rewrite the record of why it stopped.
        let token = Token::new(scope("s1", "r1", "c1"));
        assert!(token.stop(StopReason::Timeout));
        assert!(!token.stop(StopReason::Cancelled));
        assert_eq!(token.stopped(), Some(StopReason::Timeout));
    }

    // ---- late completion loses ------------------------------------------

    #[test]
    fn a_result_that_arrives_after_the_stop_is_rejected() {
        let token = Token::new(scope("s1", "r1", "c1"));
        assert_eq!(token.settle("ok"), Ok("ok"));
        token.stop(StopReason::Cancelled);
        // The command finished during the kill. It does not get to report
        // success.
        assert_eq!(token.settle("ok"), Err(StopReason::Cancelled));
    }

    #[tokio::test(start_paused = true)]
    async fn a_timed_out_operation_that_completes_late_still_reports_the_timeout() {
        let token = Token::new(scope("s1", "r1", "c1"));
        let outcome: Result<&str, StopReason> =
            run_with_deadline(&token, Duration::from_secs(1), async {
                tokio::time::sleep(Duration::from_secs(2)).await;
                "late success"
            })
            .await;
        assert_eq!(outcome, Err(StopReason::Timeout));
        // ...and settling the late value afterwards is refused too.
        assert_eq!(token.settle("late success"), Err(StopReason::Timeout));
    }

    // ---- scoping (no collateral damage) ----------------------------------

    #[test]
    fn a_scope_contains_what_it_should_and_nothing_else() {
        let call = scope("s1", "r1", "c1");
        assert!(call.within(&scope("s1", "r1", "c1")), "itself");
        assert!(call.within(&scope("s1", "r1", "")), "its run");
        assert!(call.within(&scope("s1", "", "")), "its session");
        assert!(call.within(&Scope::default()), "the application");

        assert!(!call.within(&scope("s1", "r2", "")), "a sibling run");
        assert!(!call.within(&scope("s2", "", "")), "another session");
        assert!(!call.within(&scope("s1", "r1", "c2")), "a sibling call");
    }

    #[test]
    fn stopping_a_run_leaves_other_runs_alone() {
        let mine = register(Token::new(scope("s1", "r1", "c1")));
        let sibling = register(Token::new(scope("s1", "r2", "c1")));
        let other_session = register(Token::new(scope("s2", "r1", "c1")));

        let stopped = stop_scope(&scope("s1", "r1", ""), StopReason::Cancelled);

        assert_eq!(stopped, 1);
        assert!(mine.token().is_stopped());
        assert!(!sibling.token().is_stopped(), "a sibling run must survive");
        assert!(
            !other_session.token().is_stopped(),
            "another session must survive"
        );
    }

    #[test]
    fn stopping_a_session_reaches_every_run_inside_it() {
        let a = register(Token::new(scope("s9", "r1", "c1")));
        let b = register(Token::new(scope("s9", "r2", "c1")));
        let elsewhere = register(Token::new(scope("s8", "r1", "c1")));

        assert_eq!(stop_scope(&scope("s9", "", ""), StopReason::Cancelled), 2);
        assert!(a.token().is_stopped());
        assert!(b.token().is_stopped());
        assert!(!elsewhere.token().is_stopped());
    }

    #[test]
    fn a_finished_call_leaves_nothing_registered() {
        let token = Token::new(scope("s7", "r1", "c1"));
        {
            let _registered = register(token.clone());
            assert_eq!(stop_scope(&scope("s7", "", ""), StopReason::Cancelled), 1);
        }
        // The guard is dropped: a later scope-wide stop finds nothing.
        let fresh = Token::new(scope("s7", "r1", "c2"));
        let _r = register(fresh.clone());
        assert_eq!(stop_scope(&scope("s7", "", ""), StopReason::Cancelled), 1);
    }

    // ---- child processes -------------------------------------------------

    #[test]
    fn a_stopped_token_owns_no_children() {
        let token = Token::new(scope("s1", "r1", "c1"));
        // A pid that is certainly not ours; kill_tree tolerates it.
        token.adopt(u32::MAX);
        assert_eq!(token.live_children(), 1);
        token.stop(StopReason::Cancelled);
        assert_eq!(
            token.live_children(),
            0,
            "stopping must reap what it owns, or AH-051 cannot fail closed"
        );
    }

    #[test]
    fn a_child_spawned_after_cancellation_is_killed_immediately() {
        // The race: cancel lands between spawn and adopt.
        let token = Token::new(scope("s1", "r1", "c1"));
        token.stop(StopReason::Cancelled);
        token.adopt(u32::MAX);
        assert_eq!(
            token.live_children(),
            0,
            "a late child must not outlive the cancellation"
        );
    }

    #[test]
    fn a_child_that_exits_on_its_own_is_released() {
        let token = Token::new(scope("s1", "r1", "c1"));
        token.adopt(4242);
        token.release(4242);
        assert_eq!(token.live_children(), 0);
    }

    // ---- timeout configuration (AH-020) ----------------------------------

    #[test]
    fn every_tool_has_a_limit_including_ones_we_have_not_met() {
        let t = Timeouts::default();
        assert_eq!(t.for_tool("bash"), Duration::from_secs(150));
        assert_eq!(t.for_tool("read"), Duration::from_secs(30));
        assert_eq!(t.for_tool("web_fetch"), Duration::from_secs(60));
        assert_eq!(t.for_tool("some.mcp.tool"), Duration::from_secs(120));
        // The one that matters: an unknown tool is bounded, not unbounded.
        assert_eq!(
            t.for_tool("a_tool_added_next_year"),
            Duration::from_secs(60)
        );
    }

    #[test]
    fn a_per_tool_override_applies_to_that_tool_only() {
        let t = Timeouts::default().with_tool_override("bash", 5);
        assert_eq!(t.for_tool("bash"), Duration::from_secs(5));
        assert_eq!(t.for_tool("read"), Duration::from_secs(30));
    }

    // ---- emergency stop (AH-051) ----------------------------------------

    fn kill_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "jan-kill-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn an_emergency_stop_reports_what_it_actually_stopped() {
        let a = register(Token::new(scope("kill-s", "r1", "c1")));
        let b = register(Token::new(scope("kill-s", "r2", "c1")));
        let elsewhere = register(Token::new(scope("other-s", "r1", "c1")));

        let report = emergency_stop(&scope("kill-s", "", ""));

        assert_eq!(report.stopped, 2);
        assert_eq!(report.already_stopped, 0);
        assert_eq!(report.live_children, 0);
        assert!(report.complete);
        assert!(a.token().is_stopped() && b.token().is_stopped());
        assert!(
            !elsewhere.token().is_stopped(),
            "an emergency stop must never reach another session"
        );
        assert!(report.summary().contains("nothing left running"));
    }

    #[test]
    fn a_second_press_is_reported_as_already_stopped_not_as_new_work() {
        let a = register(Token::new(scope("kill-twice", "r1", "c1")));
        let first = emergency_stop(&scope("kill-twice", "", ""));
        assert_eq!(first.stopped, 1);

        let second = emergency_stop(&scope("kill-twice", "", ""));
        assert_eq!(second.stopped, 0);
        assert_eq!(second.already_stopped, 1);
        assert!(second.complete);
        assert!(a.token().is_stopped());
    }

    #[test]
    fn an_incomplete_stop_says_so_rather_than_claiming_success() {
        // A token whose child survives the kill: the report must fail closed.
        let token = Token::new(scope("kill-stuck", "r1", "c1"));
        let held = register(token.clone());
        // Stop it first, then adopt -- `adopt` on a stopped token kills
        // immediately, so re-inserting behind its back is how the test
        // simulates a child that would not die.
        token.stop(StopReason::Cancelled);
        token.0.pids.lock().unwrap().push(u32::MAX);

        let report = emergency_stop(&scope("kill-stuck", "", ""));
        assert_eq!(report.live_children, 1);
        assert!(!report.complete, "cleanup did not finish");
        assert!(
            report.summary().contains("still running"),
            "{}",
            report.summary()
        );
        drop(held);
    }

    #[test]
    fn the_application_scope_stops_everything_and_nothing_else_exists_to_miss() {
        let a = register(Token::new(scope("app-a", "r1", "c1")));
        let b = register(Token::new(scope("app-b", "r9", "c9")));
        let report = emergency_stop(&Scope::default());
        assert!(report.stopped >= 2);
        assert!(a.token().is_stopped() && b.token().is_stopped());
        assert!(report.summary().contains("all work"));
    }

    #[test]
    fn a_killed_scope_is_still_killed_after_a_restart() {
        let dir = kill_dir("restart");
        let killed = register(Token::new(scope("dead-s", "dead-r", "c1")));
        let report = emergency_stop(&scope("dead-s", "dead-r", ""));
        record_killed(&dir, &report);
        drop(killed);

        // A fresh process reads the file and refuses to resume the run.
        assert!(was_killed(&dir, &scope("dead-s", "dead-r", "c1")));
        assert!(was_killed(&dir, &scope("dead-s", "dead-r", "c2")));
        // ...and does not refuse anything else.
        assert!(!was_killed(&dir, &scope("dead-s", "live-r", "c1")));
        assert!(!was_killed(&dir, &scope("live-s", "dead-r", "c1")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn killing_a_session_covers_the_runs_inside_it_after_a_restart() {
        let dir = kill_dir("session");
        let report = emergency_stop(&scope("whole-s", "", ""));
        record_killed(&dir, &report);
        assert!(was_killed(&dir, &scope("whole-s", "any-run", "any-call")));
        assert!(!was_killed(&dir, &scope("other-s", "any-run", "")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_truncated_kill_log_does_not_lose_the_earlier_kills() {
        let dir = kill_dir("truncated");
        let report = emergency_stop(&scope("trunc-s", "trunc-r", ""));
        record_killed(&dir, &report);
        let path = dir.join("audit").join(KILLED_SCOPES_LOG);
        let mut body = std::fs::read_to_string(&path).unwrap();
        body.push_str("{\"at\":\"2026-01-01T00:00:0");
        std::fs::write(&path, body).unwrap();

        assert!(
            was_killed(&dir, &scope("trunc-s", "trunc-r", "c1")),
            "a truncated tail must not lose the recorded kill"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_kill_log_means_nothing_was_killed() {
        let dir = kill_dir("absent");
        assert!(!was_killed(&dir, &scope("s", "r", "c")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn both_stop_reasons_record_as_cancelled_with_the_reason_kept_separately() {
        assert_eq!(
            StopReason::Timeout.audit_outcome(),
            crate::audit::Outcome::Cancelled
        );
        assert_eq!(StopReason::Timeout.as_str(), "timeout");
        assert_eq!(StopReason::Cancelled.as_str(), "cancelled");
    }
}

// ---------------------------------------------------------------------------
// Emergency stop (AH-051)
// ---------------------------------------------------------------------------

/// What an emergency stop achieved, and what it could not.
///
/// Deliberately reports failure rather than smoothing it over: a stop that
/// leaves a process running has not stopped anything, and telling the user it
/// succeeded is worse than telling them it did not.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct StopReport {
    /// Tokens this call moved from running to stopped.
    pub stopped: usize,
    /// Tokens already stopped when it ran. Not a failure; a second press.
    pub already_stopped: usize,
    /// Child processes still owned after the sweep. Non-zero means the stop is
    /// incomplete and the caller must say so.
    pub live_children: usize,
    /// Whether cleanup finished. False whenever `live_children` is non-zero.
    pub complete: bool,
    /// The scope this applied to, echoed back so a report is self-describing.
    pub session: String,
    pub run: String,
    pub call: String,
}

impl StopReport {
    /// The sentence to show. Names what is unresolved rather than implying a
    /// clean stop.
    pub fn summary(&self) -> String {
        let where_ = match (self.session.as_str(), self.run.as_str(), self.call.as_str()) {
            ("", "", "") => "all work".to_string(),
            (s, "", "") => format!("session {s}"),
            (_, r, "") => format!("run {r}"),
            (_, _, c) => format!("call {c}"),
        };
        if self.complete {
            format!(
                "Stopped {where_}: {} stopped, {} already stopped, nothing left running.",
                self.stopped, self.already_stopped
            )
        } else {
            format!(
                "Stopped {where_}: {} stopped, but {} child process(es) are still running. \
                 Cleanup did not finish.",
                self.stopped, self.live_children
            )
        }
    }
}

/// Stop everything in `scope` and report honestly what remains.
///
/// Built on [`stop_scope`] rather than beside it: there is one cancellation
/// system, and the emergency stop is that system applied to a wider scope. It
/// grants no authority of its own — stopping work never needs permission that
/// starting it did not.
pub fn emergency_stop(scope: &Scope) -> StopReport {
    let before: Vec<Token> = registry()
        .lock()
        .unwrap()
        .values()
        .filter(|t| t.scope().within(scope))
        .cloned()
        .collect();
    let already_stopped = before.iter().filter(|t| t.is_stopped()).count();

    let stopped = stop_scope(scope, StopReason::Cancelled);

    // Measured after the sweep: `stop` reaps as it goes, so anything still
    // here resisted the kill.
    let live_children = live_children_in(scope);

    StopReport {
        stopped,
        already_stopped,
        live_children,
        complete: live_children == 0,
        session: scope.session.clone(),
        run: scope.run.clone(),
        call: scope.call.clone(),
    }
}

/// Scopes stopped by an emergency stop, so a restart does not resume them.
///
/// Kept next to the audit log because it is the same kind of fact: something
/// the user did that later behaviour has to respect. Append-only and
/// truncation-tolerant for the same reasons.
pub const KILLED_SCOPES_LOG: &str = "killed-scopes.jsonl";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct KilledScope {
    pub at: String,
    pub session: String,
    pub run: String,
    pub call: String,
    /// Whether cleanup finished when it was killed.
    pub complete: bool,
}

fn killed_path(data_folder: &std::path::Path) -> std::path::PathBuf {
    data_folder.join("audit").join(KILLED_SCOPES_LOG)
}

/// Record that a scope was killed. Best effort, like the audit log: failing to
/// record must not change what was stopped.
pub fn record_killed(data_folder: &std::path::Path, report: &StopReport) {
    let entry = KilledScope {
        at: crate::audit::now(),
        session: report.session.clone(),
        run: report.run.clone(),
        call: report.call.clone(),
        complete: report.complete,
    };
    let path = killed_path(data_folder);
    let write = || -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut line = serde_json::to_string(&entry).map_err(|e| e.to_string())?;
        line.push('\n');
        use std::io::Write as _;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        file.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        file.flush().map_err(|e| e.to_string())
    };
    if let Err(e) = write() {
        eprintln!("emergency stop: could not record the killed scope: {e}");
    }
}

/// Whether this scope was killed in an earlier session.
///
/// Consulted before resuming work so a restart cannot bring back something the
/// user stopped. A scope is killed if any recorded kill *contains* it: killing
/// a session covers every run in it, including ones recorded only by run id.
pub fn was_killed(data_folder: &std::path::Path, scope: &Scope) -> bool {
    use std::io::BufRead as _;
    let Ok(file) = std::fs::File::open(killed_path(data_folder)) else {
        return false;
    };
    std::io::BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<KilledScope>(&l).ok())
        .any(|killed| {
            scope.within(&Scope::new(
                killed.session.clone(),
                killed.run.clone(),
                killed.call.clone(),
            ))
        })
}

#[cfg(test)]
mod ambient_tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn a_backoff_ends_when_the_run_is_cancelled() {
        // AH-023: a run stopped during a two-minute wait stops then, not two
        // minutes later.
        let token = Token::new(Scope::new("s1", "r1", ""));
        let watcher = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            watcher.stop(StopReason::Cancelled);
        });

        let reason = with_current(token, async {
            sleep_unless_stopped(Duration::from_secs(120)).await
        })
        .await;
        assert_eq!(reason, Some(StopReason::Cancelled));
    }

    #[tokio::test(start_paused = true)]
    async fn an_uninterrupted_backoff_waits_the_whole_delay() {
        let token = Token::new(Scope::new("s1", "r1", ""));
        let reason = with_current(token, async {
            sleep_unless_stopped(Duration::from_secs(5)).await
        })
        .await;
        assert_eq!(reason, None, "nothing stopped it, so it slept");
    }

    #[tokio::test(start_paused = true)]
    async fn a_backoff_outside_a_run_still_sleeps() {
        // No ambient token (the CLI, a test, a background task): unchanged.
        assert_eq!(sleep_unless_stopped(Duration::from_secs(1)).await, None);
        assert!(current().is_none());
    }

    #[tokio::test]
    async fn the_ambient_token_is_the_running_task_s_own() {
        let mine = Token::new(Scope::new("s-mine", "r-mine", ""));
        let seen = with_current(mine.clone(), async { current().unwrap() }).await;
        assert_eq!(seen.scope(), mine.scope());
        // ...and does not leak outside the scope.
        assert!(current().is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn one_runs_stop_does_not_end_another_runs_backoff() {
        let mine = register(Token::new(Scope::new("s-iso", "r-mine", "")));
        let theirs = Scope::new("s-iso", "r-theirs", "");
        let _other = register(Token::new(theirs.clone()));

        // Stop the other run entirely.
        stop_scope(&theirs, StopReason::Cancelled);

        let reason = with_current(mine.token().clone(), async {
            sleep_unless_stopped(Duration::from_secs(2)).await
        })
        .await;
        assert_eq!(reason, None, "another run's stop must not end this backoff");
    }
}