//! Renames and deletes that wait out a transient lock.
//!
//! On Windows, Defender, the search indexer and OneDrive open a file the
//! moment it is finished and hold it for seconds; a rename or delete in that
//! window fails with access denied (os error 5), a sharing violation (32) or a
//! lock violation (33). Elsewhere nothing behaves like that, so nothing is
//! retried. The policy and the classification are pure, so their cases are
//! tested on every platform.

use std::future::Future;
use std::io::ErrorKind;
use std::path::Path;
use std::time::{Duration, Instant};

/// `ERROR_ACCESS_DENIED`, `ERROR_SHARING_VIOLATION`, `ERROR_LOCK_VIOLATION`.
const TRANSIENT_LOCK_CODES: [i32; 3] = [5, 32, 33];

/// Whether a failed rename or delete is worth retrying.
pub fn is_transient_lock(raw_os_error: Option<i32>, kind: ErrorKind, on_windows: bool) -> bool {
    on_windows
        && (raw_os_error.is_some_and(|code| TRANSIENT_LOCK_CODES.contains(&code))
            || kind == ErrorKind::PermissionDenied)
}

pub fn is_transient_lock_error(error: &std::io::Error) -> bool {
    is_transient_lock(error.raw_os_error(), error.kind(), cfg!(windows))
}

/// How long and how often a locked rename or delete is retried.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LockRetry {
    /// No retry starts once its delay would end past this, counted from the
    /// first attempt.
    pub budget: Duration,
    pub first_delay: Duration,
    pub max_delay: Duration,
}

impl LockRetry {
    /// About ten seconds in all: 0.1, 0.2, 0.4, 0.8, 1.6, then 2 s apart.
    pub const DEFAULT: Self = Self {
        budget: Duration::from_secs(10),
        first_delay: Duration::from_millis(100),
        max_delay: Duration::from_secs(2),
    };

    /// The wait before retry `attempt` (0 for the first): doubling from
    /// `first_delay`, capped at `max_delay`.
    pub fn delay(&self, attempt: u32) -> Duration {
        self.first_delay
            .saturating_mul(1u32 << attempt.min(16))
            .min(self.max_delay)
    }

    /// The wait before retry `attempt`, or `None` once the budget is spent.
    fn next_wait(&self, started: Instant, attempt: u32) -> Option<Duration> {
        let delay = self.delay(attempt);
        (started.elapsed() + delay <= self.budget).then_some(delay)
    }
}

fn log_retry(what: &str, path: &Path, attempt: u32, delay: Duration, error: &std::io::Error) {
    log::warn!(
        "{what} {} failed ({error}); another process may be holding it. Retry {attempt} in {} ms",
        path.display(),
        delay.as_millis()
    );
}

/// Run `op` until it succeeds, fails with an error `is_transient` rejects, or
/// the policy's budget runs out. Returns the last error.
pub async fn retry_while_locked<T, F, Fut>(
    what: &str,
    path: &Path,
    policy: LockRetry,
    is_transient: impl Fn(&std::io::Error) -> bool,
    mut op: F,
) -> std::io::Result<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = std::io::Result<T>>,
{
    let started = Instant::now();
    let mut attempt = 0u32;
    loop {
        match op().await {
            Ok(value) => return Ok(value),
            Err(error) => {
                if !is_transient(&error) {
                    return Err(error);
                }
                let Some(delay) = policy.next_wait(started, attempt) else {
                    return Err(error);
                };
                attempt += 1;
                log_retry(what, path, attempt, delay, &error);
                tokio::time::sleep(delay).await;
            }
        }
    }
}

/// The blocking twin of [`retry_while_locked`], for callers off the runtime.
pub fn retry_while_locked_blocking<T>(
    what: &str,
    path: &Path,
    policy: LockRetry,
    is_transient: impl Fn(&std::io::Error) -> bool,
    mut op: impl FnMut() -> std::io::Result<T>,
) -> std::io::Result<T> {
    let started = Instant::now();
    let mut attempt = 0u32;
    loop {
        match op() {
            Ok(value) => return Ok(value),
            Err(error) => {
                if !is_transient(&error) {
                    return Err(error);
                }
                let Some(delay) = policy.next_wait(started, attempt) else {
                    return Err(error);
                };
                attempt += 1;
                log_retry(what, path, attempt, delay, &error);
                std::thread::sleep(delay);
            }
        }
    }
}

/// `tokio::fs::rename`, retried while another process holds either path.
pub async fn rename_retrying(from: &Path, to: &Path) -> std::io::Result<()> {
    retry_while_locked("Renaming", from, LockRetry::DEFAULT, is_transient_lock_error, || {
        tokio::fs::rename(from, to)
    })
    .await
}

/// `std::fs::rename`, retried while another process holds either path.
pub fn rename_retrying_blocking(from: &Path, to: &Path) -> std::io::Result<()> {
    retry_while_locked_blocking("Renaming", from, LockRetry::DEFAULT, is_transient_lock_error, || {
        std::fs::rename(from, to)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Error;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn only_windows_lock_and_permission_errors_are_transient() {
        assert!(is_transient_lock(Some(5), ErrorKind::PermissionDenied, true));
        assert!(is_transient_lock(Some(32), ErrorKind::Other, true));
        assert!(is_transient_lock(Some(33), ErrorKind::Other, true));
        assert!(is_transient_lock(None, ErrorKind::PermissionDenied, true));
        assert!(!is_transient_lock(Some(2), ErrorKind::NotFound, true));
        assert!(!is_transient_lock(Some(112), ErrorKind::Other, true));
        assert!(!is_transient_lock(Some(5), ErrorKind::PermissionDenied, false));
        assert!(!is_transient_lock(Some(32), ErrorKind::Other, false));
    }

    #[test]
    fn the_default_lock_retry_backs_off_for_about_ten_seconds() {
        let policy = LockRetry::DEFAULT;
        let delays: Vec<u64> = (0..8).map(|n| policy.delay(n).as_millis() as u64).collect();
        assert_eq!(delays, [100, 200, 400, 800, 1600, 2000, 2000, 2000]);
        let mut slept = Duration::ZERO;
        let mut attempt = 0;
        while slept + policy.delay(attempt) <= policy.budget {
            slept += policy.delay(attempt);
            attempt += 1;
        }
        assert!(slept >= Duration::from_secs(8), "slept {slept:?}");
        assert!(slept <= Duration::from_secs(10), "slept {slept:?}");
        assert_eq!(policy.delay(u32::MAX), policy.max_delay);
    }

    fn quick_policy() -> LockRetry {
        LockRetry {
            budget: Duration::from_millis(40),
            first_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(4),
        }
    }

    fn locked() -> Error {
        Error::other("held by another process")
    }

    #[tokio::test]
    async fn a_lock_that_is_released_is_waited_out() {
        let calls = AtomicUsize::new(0);
        let result = retry_while_locked("Renaming", Path::new("m.gguf.part"), quick_policy(), |_| true, || async {
            if calls.fetch_add(1, Ordering::SeqCst) < 2 {
                Err(locked())
            } else {
                Ok(7)
            }
        })
        .await;
        assert_eq!(result.unwrap(), 7);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn a_lock_that_outlasts_the_budget_returns_the_last_error() {
        let calls = AtomicUsize::new(0);
        let started = Instant::now();
        let result: std::io::Result<()> =
            retry_while_locked("Renaming", Path::new("m.gguf.part"), quick_policy(), |_| true, || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Err(locked())
            })
            .await;
        assert_eq!(result.unwrap_err().to_string(), "held by another process");
        assert!(calls.load(Ordering::SeqCst) > 3);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn a_permanent_error_is_not_retried() {
        let calls = AtomicUsize::new(0);
        let result: std::io::Result<()> =
            retry_while_locked("Renaming", Path::new("m.gguf.part"), quick_policy(), |_| false, || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Err(Error::from(ErrorKind::NotFound))
            })
            .await;
        assert_eq!(result.unwrap_err().kind(), ErrorKind::NotFound);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn the_blocking_retry_waits_out_a_lock_and_gives_up_on_a_permanent_error() {
        let calls = AtomicUsize::new(0);
        let ok = retry_while_locked_blocking("Renaming", Path::new("pack"), quick_policy(), |_| true, || {
            if calls.fetch_add(1, Ordering::SeqCst) < 2 {
                Err(locked())
            } else {
                Ok(())
            }
        });
        assert!(ok.is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 3);

        let calls = AtomicUsize::new(0);
        let err = retry_while_locked_blocking("Renaming", Path::new("pack"), quick_policy(), |_| false, || {
            calls.fetch_add(1, Ordering::SeqCst);
            Err::<(), _>(Error::from(ErrorKind::NotFound))
        });
        assert_eq!(err.unwrap_err().kind(), ErrorKind::NotFound);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn the_retrying_renames_behave_like_the_plain_ones() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("m.gguf.part");
        let done = dir.path().join("m.gguf");
        tokio::fs::write(&part, b"weights").await.unwrap();
        rename_retrying(&part, &done).await.unwrap();
        assert_eq!(tokio::fs::read(&done).await.unwrap(), b"weights");
        assert_eq!(rename_retrying(&part, &done).await.unwrap_err().kind(), ErrorKind::NotFound);

        let staged = dir.path().join("staging");
        let target = dir.path().join("pack");
        std::fs::create_dir(&staged).unwrap();
        rename_retrying_blocking(&staged, &target).unwrap();
        assert!(target.is_dir() && !staged.exists());
    }
}
