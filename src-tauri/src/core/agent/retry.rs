//! The one retry policy the harness retries under (AH-024).
//!
//! Retryability is *not* decided here: it is read off
//! [`jan_agent_harness::HarnessError`], whose [`Retry`] classification already
//! says whether a failure can plausibly succeed on a second attempt. This module
//! owns only the timing -- how long to wait, how many times, and when to stop --
//! so that upstream calls, tool calls and anything else added later back off the
//! same way instead of each growing its own loop.
//!
//! Three bounds keep a retry from turning into a hang: a cap on attempts, a cap
//! on *cumulative* delay (a hostile `Retry-After` cannot stretch a run), and
//! cancellation, which abandons an in-flight backoff instead of sleeping it out.

use std::time::Duration;

use jan_agent_harness::error::{HarnessError, Retry};
use tokio_util::sync::CancellationToken;

/// Waits out a delay, so tests can assert on a schedule without spending it.
#[async_trait::async_trait]
pub(crate) trait Sleeper: Sync {
    async fn sleep(&self, duration: Duration);
}

/// The real timer.
pub(crate) struct TokioSleeper;

#[async_trait::async_trait]
impl Sleeper for TokioSleeper {
    async fn sleep(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }
}

/// Anything that can say "stop waiting".
///
/// A trait rather than a concrete `CancellationToken` so the retry ladder is
/// testable without a runtime, and so a caller with no cancellation story is
/// not forced to invent one.
pub(crate) trait Cancel: Sync {
    fn is_cancelled(&self) -> bool;
    /// Resolves when cancellation arrives. A caller with nothing to wait on
    /// returns a future that never completes.
    fn cancelled(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>>;
}

/// For callers that genuinely cannot be cancelled.
pub(crate) struct NeverCancelled;

impl Cancel for NeverCancelled {
    fn is_cancelled(&self) -> bool {
        false
    }
    fn cancelled(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(std::future::pending())
    }
}

impl Cancel for CancellationToken {
    fn is_cancelled(&self) -> bool {
        CancellationToken::is_cancelled(self)
    }
    fn cancelled(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(CancellationToken::cancelled(self))
    }
}

/// Why the ladder stopped without a success.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GiveUp {
    /// The taxonomy says another attempt cannot help.
    NotRetryable,
    /// The attempt cap was reached.
    AttemptsExhausted,
    /// Another backoff would spend more than the run can afford to wait.
    DelayBudgetExhausted,
}

/// What to do after one failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Decision {
    Retry { delay: Duration },
    GiveUp(GiveUp),
}

/// How a backoff ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Waited {
    /// The delay elapsed.
    Elapsed,
    /// Cancellation arrived first; the remaining delay was abandoned.
    Cancelled,
}

/// The timing half of retrying. Retryability itself is the taxonomy's answer.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct RetryPolicy {
    /// Total attempts, including the first. `1` disables retrying.
    pub max_attempts: u32,
    pub base_delay: Duration,
    pub multiplier: u32,
    /// Ceiling for any single backoff.
    pub max_delay: Duration,
    /// Ceiling for the sum of every backoff in one ladder.
    pub delay_budget: Duration,
    /// Fraction of a delay that may be shaved off at random, in `0.0..=1.0`.
    ///
    /// Jitter only ever *shortens*. Lengthening would let a policy quietly
    /// exceed its own `max_delay`, and the ceiling is the thing callers reason
    /// about.
    pub jitter: f64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 4,
            base_delay: Duration::from_millis(500),
            multiplier: 2,
            max_delay: Duration::from_secs(30),
            delay_budget: Duration::from_secs(120),
            jitter: 0.25,
        }
    }
}

impl RetryPolicy {
    /// The undithered delay before attempt `attempt + 1`.
    ///
    /// Saturating throughout: a large attempt number must clamp to `max_delay`,
    /// never wrap around into an instant retry.
    pub fn backoff(&self, attempt: u32) -> Duration {
        let factor = (self.multiplier as u64).saturating_pow(attempt.min(32));
        let millis = (self.base_delay.as_millis() as u64).saturating_mul(factor);
        Duration::from_millis(millis).min(self.max_delay)
    }

    /// [`backoff`] with `factor` of the jitter band removed, where `factor` is
    /// `0.0` (keep the whole delay) to `1.0` (shave the whole band).
    pub fn jittered(&self, attempt: u32, factor: f64) -> Duration {
        let full = self.backoff(attempt);
        let keep = 1.0 - self.jitter.clamp(0.0, 1.0) * factor.clamp(0.0, 1.0);
        full.mul_f64(keep)
    }

    /// Whether to try again after `error`, having already spent `spent` waiting.
    pub fn decide(&self, error: &HarnessError, attempt: u32, spent: Duration) -> Decision {
        let requested = match error.retry() {
            Retry::Never => return Decision::GiveUp(GiveUp::NotRetryable),
            // One more attempt, immediately: a timeout has already done the
            // waiting, so backing off again just doubles the user's wait.
            Retry::Once => {
                return if attempt == 0 {
                    Decision::Retry { delay: Duration::ZERO }
                } else {
                    Decision::GiveUp(GiveUp::AttemptsExhausted)
                };
            }
            Retry::After(requested) => requested,
        };

        if attempt + 1 >= self.max_attempts {
            return Decision::GiveUp(GiveUp::AttemptsExhausted);
        }

        // A provider asking us to wait longer is obeyed; one asking for less is
        // not, or a server under load could talk us into hammering it.
        let delay = self.jittered(attempt, rand::random::<f64>()).max(requested);

        if spent.saturating_add(delay) > self.delay_budget {
            return Decision::GiveUp(GiveUp::DelayBudgetExhausted);
        }
        Decision::Retry { delay }
    }

    /// Sleeps for `delay` unless cancellation arrives first.
    pub async fn wait(
        &self,
        delay: Duration,
        sleeper: &dyn Sleeper,
        cancel: &dyn Cancel,
    ) -> Waited {
        // Checked before starting: a run already cancelled must not begin a
        // sleep at all, or a cancel issued during the previous attempt still
        // costs the user the full backoff.
        if cancel.is_cancelled() {
            return Waited::Cancelled;
        }
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Waited::Cancelled,
            _ = sleeper.sleep(delay) => Waited::Elapsed,
        }
    }
}

/// Runs `attempt` under `policy` until it succeeds, is refused, or runs out.
///
/// The closure receives the zero-based attempt number so a caller can log or
/// vary by attempt. The error returned is the last real failure, not a synthetic
/// "gave up" -- the caller needs to know *what* failed, and a wrapper would bury
/// it.
pub(crate) async fn execute<T, F, Fut>(
    policy: &RetryPolicy,
    sleeper: &dyn Sleeper,
    cancel: &dyn Cancel,
    mut attempt_fn: F,
) -> Result<T, HarnessError>
where
    F: FnMut(u32) -> Fut,
    Fut: std::future::Future<Output = Result<T, HarnessError>>,
{
    let mut spent = Duration::ZERO;
    let mut attempt = 0u32;
    loop {
        if cancel.is_cancelled() {
            return Err(HarnessError::cancelled("the run was cancelled"));
        }
        let error = match attempt_fn(attempt).await {
            Ok(value) => return Ok(value),
            Err(error) => error,
        };
        let delay = match policy.decide(&error, attempt, spent) {
            Decision::GiveUp(_) => return Err(error),
            Decision::Retry { delay } => delay,
        };
        if policy.wait(delay, sleeper, cancel).await == Waited::Cancelled {
            return Err(HarnessError::cancelled("the run was cancelled during a retry backoff"));
        }
        spent = spent.saturating_add(delay);
        attempt += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jan_agent_harness::error::ErrorKind;
    use std::cell::Cell;
    use std::sync::Mutex;
    use std::time::Instant;

    /// A sleeper that records what it was asked to wait for and returns at once,
    /// so policy tests assert on the schedule without spending it.
    #[derive(Default)]
    struct RecordingSleeper {
        slept: Mutex<Vec<Duration>>,
    }

    impl RecordingSleeper {
        fn slept(&self) -> Vec<Duration> {
            self.slept.lock().expect("sleep log").clone()
        }

        fn total(&self) -> Duration {
            self.slept().iter().sum()
        }
    }

    #[async_trait::async_trait]
    impl Sleeper for RecordingSleeper {
        async fn sleep(&self, duration: Duration) {
            self.slept.lock().expect("sleep log").push(duration);
        }
    }

    /// Zero jitter and a roomy budget: the delays a test reads back are then the
    /// policy's arithmetic and nothing else.
    fn deterministic(max_attempts: u32) -> RetryPolicy {
        RetryPolicy {
            max_attempts,
            base_delay: Duration::from_secs(1),
            multiplier: 2,
            max_delay: Duration::from_secs(8),
            delay_budget: Duration::from_secs(3600),
            jitter: 0.0,
        }
    }

    fn upstream(message: &str) -> HarnessError {
        HarnessError::new(ErrorKind::Upstream, message)
    }

    #[tokio::test]
    async fn a_successful_call_is_not_retried_or_delayed() {
        let sleeper = RecordingSleeper::default();
        let calls = Cell::new(0u32);

        let value = execute(&deterministic(5), &sleeper, &NeverCancelled, |_| {
            calls.set(calls.get() + 1);
            async { Ok::<_, HarnessError>("answer") }
        })
        .await
        .expect("the first attempt succeeds");

        assert_eq!(value, "answer");
        assert_eq!(calls.get(), 1);
        assert!(sleeper.slept().is_empty(), "no backoff on a clean call");
    }

    #[tokio::test]
    async fn a_transient_failure_is_retried_until_it_succeeds() {
        let sleeper = RecordingSleeper::default();
        let calls = Cell::new(0u32);

        let value = execute(&deterministic(5), &sleeper, &NeverCancelled, |attempt| {
            calls.set(calls.get() + 1);
            async move {
                if attempt < 2 {
                    Err(upstream("503"))
                } else {
                    Ok("answer")
                }
            }
        })
        .await
        .expect("the third attempt succeeds");

        assert_eq!(value, "answer");
        assert_eq!(calls.get(), 3);
        assert_eq!(sleeper.slept().len(), 2, "one backoff per retry");
    }

    #[tokio::test]
    async fn a_non_retryable_error_is_not_retried() {
        let sleeper = RecordingSleeper::default();
        let calls = Cell::new(0u32);

        let error = execute(&deterministic(5), &sleeper, &NeverCancelled, |_| {
            calls.set(calls.get() + 1);
            async { Err::<(), _>(HarnessError::denied("write to /etc/hosts")) }
        })
        .await
        .expect_err("a refusal is final");

        assert_eq!(error.kind(), ErrorKind::PermissionDenied);
        assert_eq!(calls.get(), 1, "a denial is not ground down by retrying");
        assert!(sleeper.slept().is_empty());
    }

    #[tokio::test]
    async fn a_cancellation_is_never_retried() {
        let sleeper = RecordingSleeper::default();
        let calls = Cell::new(0u32);

        let error = execute(&deterministic(5), &sleeper, &NeverCancelled, |_| {
            calls.set(calls.get() + 1);
            async { Err::<(), _>(HarnessError::cancelled("user pressed escape")) }
        })
        .await
        .expect_err("a cancelled call stays cancelled");

        assert!(error.is_cancellation());
        assert_eq!(calls.get(), 1);
    }

    #[tokio::test]
    async fn an_immediate_retry_error_gets_exactly_one_more_attempt() {
        let sleeper = RecordingSleeper::default();
        let calls = Cell::new(0u32);

        // `Retry::Once` (a timeout) means one more try, not the full ladder.
        let _ = execute(&deterministic(10), &sleeper, &NeverCancelled, |_| {
            calls.set(calls.get() + 1);
            async { Err::<(), _>(HarnessError::new(ErrorKind::Timeout, "deadline")) }
        })
        .await
        .expect_err("still failing");

        assert_eq!(calls.get(), 2);
        assert_eq!(
            sleeper.slept(),
            vec![Duration::ZERO],
            "immediate, not backed off"
        );
    }

    #[tokio::test]
    async fn attempts_are_capped_by_the_policy() {
        let sleeper = RecordingSleeper::default();
        let calls = Cell::new(0u32);

        let error = execute(&deterministic(4), &sleeper, &NeverCancelled, |_| {
            calls.set(calls.get() + 1);
            async { Err::<(), _>(upstream("503")) }
        })
        .await
        .expect_err("permanently down");

        assert_eq!(calls.get(), 4, "four attempts, not five");
        assert_eq!(
            error.kind(),
            ErrorKind::Upstream,
            "the last failure survives"
        );
    }

    #[tokio::test]
    async fn cumulative_backoff_never_exceeds_the_delay_budget() {
        let sleeper = RecordingSleeper::default();
        let calls = Cell::new(0u32);
        let policy = RetryPolicy {
            delay_budget: Duration::from_secs(3),
            ..deterministic(1_000)
        };

        let _ = execute(&policy, &sleeper, &NeverCancelled, |_| {
            calls.set(calls.get() + 1);
            async { Err::<(), _>(upstream("503")) }
        })
        .await
        .expect_err("permanently down");

        assert!(
            sleeper.total() <= policy.delay_budget,
            "waited {:?}, budget {:?}",
            sleeper.total(),
            policy.delay_budget
        );
        assert!(
            calls.get() < policy.max_attempts,
            "the budget stopped it, not the attempt cap"
        );
    }

    #[test]
    fn backoff_grows_exponentially_then_holds_at_the_ceiling() {
        let policy = RetryPolicy {
            base_delay: Duration::from_millis(250),
            multiplier: 2,
            max_delay: Duration::from_secs(8),
            ..deterministic(10)
        };
        assert_eq!(policy.backoff(0), Duration::from_millis(250));
        assert_eq!(policy.backoff(1), Duration::from_millis(500));
        assert_eq!(policy.backoff(2), Duration::from_secs(1));
        assert_eq!(policy.backoff(5), Duration::from_secs(8));
        assert_eq!(
            policy.backoff(64),
            Duration::from_secs(8),
            "capped, not overflowing"
        );
    }

    #[test]
    fn jitter_shortens_a_delay_without_ever_lengthening_it() {
        let policy = RetryPolicy {
            base_delay: Duration::from_millis(100),
            multiplier: 2,
            max_delay: Duration::from_secs(10),
            jitter: 0.5,
            ..deterministic(10)
        };
        // backoff(2) is 400ms; half of it is up for grabs.
        assert_eq!(policy.jittered(2, 0.0), Duration::from_millis(400));
        assert_eq!(policy.jittered(2, 0.5), Duration::from_millis(300));
        assert_eq!(policy.jittered(2, 1.0), Duration::from_millis(200));
    }

    #[test]
    fn random_jitter_stays_within_the_configured_band() {
        // A base above the taxonomy's own 500ms floor, so the floor cannot mask
        // the jitter under test.
        let policy = RetryPolicy {
            base_delay: Duration::from_secs(4),
            jitter: 0.5,
            ..deterministic(10)
        };
        let mut seen = std::collections::HashSet::new();
        for _ in 0..64 {
            let Decision::Retry { delay } = policy.decide(&upstream("503"), 0, Duration::ZERO)
            else {
                panic!("an upstream failure is retryable");
            };
            assert!(
                (Duration::from_secs(2)..=Duration::from_secs(4)).contains(&delay),
                "{delay:?} outside the jitter band"
            );
            seen.insert(delay);
        }
        assert!(seen.len() > 1, "jitter must actually spread the retries");
    }

    #[test]
    fn a_provider_requested_delay_is_honoured_as_a_floor() {
        let policy = deterministic(10);
        let error = upstream("429").with_retry(Retry::After(Duration::from_secs(30)));
        let Decision::Retry { delay } = policy.decide(&error, 0, Duration::ZERO) else {
            panic!("429 is retryable");
        };
        assert_eq!(
            delay,
            Duration::from_secs(30),
            "a provider asking for longer than our ceiling gets it"
        );
    }

    #[test]
    fn a_provider_asking_for_less_does_not_speed_us_up() {
        let policy = deterministic(10);
        let error = upstream("429").with_retry(Retry::After(Duration::from_millis(1)));
        let Decision::Retry { delay } = policy.decide(&error, 3, Duration::ZERO) else {
            panic!("429 is retryable");
        };
        assert_eq!(
            delay,
            Duration::from_secs(8),
            "our own backoff still applies"
        );
    }

    #[test]
    fn an_exhausted_delay_budget_stops_the_ladder() {
        let policy = deterministic(10);
        assert!(matches!(
            policy.decide(&upstream("503"), 0, policy.delay_budget),
            Decision::GiveUp(GiveUp::DelayBudgetExhausted)
        ));
    }

    #[tokio::test]
    async fn an_already_cancelled_run_never_sleeps() {
        let sleeper = RecordingSleeper::default();
        let cancel = CancellationToken::new();
        cancel.cancel();

        let waited = deterministic(10)
            .wait(Duration::from_secs(3600), &sleeper, &cancel)
            .await;

        assert_eq!(waited, Waited::Cancelled);
        assert!(sleeper.slept().is_empty(), "the sleep was never started");
    }

    /// The race that matters: cancellation arrives *while* a long backoff is in
    /// flight. Waiting it out is what makes a cancel look like a hang.
    #[tokio::test]
    async fn cancelling_during_a_backoff_returns_promptly() {
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            trigger.cancel();
        });

        let started = Instant::now();
        let waited = deterministic(10)
            .wait(Duration::from_secs(3600), &TokioSleeper, &cancel)
            .await;

        assert_eq!(waited, Waited::Cancelled);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "abandoned the backoff after {:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn a_run_cancelled_mid_backoff_reports_cancellation_not_failure() {
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            trigger.cancel();
        });

        let error = execute(&deterministic(10), &TokioSleeper, &cancel, |_| async {
            Err::<(), _>(upstream("503"))
        })
        .await
        .expect_err("cancelled before it could succeed");

        assert!(error.is_cancellation(), "got {error}");
    }

    /// End to end on the real timer: several attempts, real (millisecond) sleeps,
    /// finishing on the shared driver rather than a test double.
    #[tokio::test]
    async fn the_real_sleeper_carries_a_retry_through_to_success() {
        let calls = Cell::new(0u32);
        let value = execute(
            &deterministic(5),
            &TokioSleeper,
            &NeverCancelled,
            |attempt| {
                calls.set(calls.get() + 1);
                async move {
                    if attempt < 2 {
                        Err(upstream("503").with_retry(Retry::After(Duration::from_millis(1))))
                    } else {
                        Ok(attempt)
                    }
                }
            },
        )
        .await
        .expect("the third attempt succeeds");

        assert_eq!(value, 2);
        assert_eq!(calls.get(), 3);
    }
}
