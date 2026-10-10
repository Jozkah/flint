//! Idle auto-unload policy.
//!
//! Kept as plain data in, plain data out so the rules can be tested with an
//! injected clock and no sleeping. The registry owns the state (the last time
//! each model was touched) and the HTTP layer owns the sweep timer; this module
//! only answers "which models have been idle long enough".

use std::sync::Arc;
use std::time::{Duration, Instant};

/// Milliseconds on a monotonic clock. A function rather than a trait so a test
/// can hand the registry a counter it advances by hand.
pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

/// The clock the worker runs on: milliseconds since this call, monotonic, so a
/// wall-clock adjustment cannot unload a model early or keep it forever.
pub fn system_clock() -> Clock {
    let origin = Instant::now();
    Arc::new(move || origin.elapsed().as_millis() as u64)
}

/// A clock a test advances by hand.
#[cfg(test)]
pub fn manual_clock() -> (Clock, Arc<std::sync::atomic::AtomicU64>) {
    use std::sync::atomic::{AtomicU64, Ordering};
    let now = Arc::new(AtomicU64::new(0));
    let handle = Arc::clone(&now);
    (Arc::new(move || handle.load(Ordering::Relaxed)), now)
}

/// The timeout for a setting expressed in minutes. 0 means never unload.
pub fn timeout_from_minutes(minutes: u64) -> Option<Duration> {
    (minutes > 0).then(|| Duration::from_secs(minutes.saturating_mul(60)))
}

/// What the policy needs to know about one resident model.
pub struct Candidate<'a> {
    pub id: &'a str,
    /// Requests currently using the model. Completions and embeddings both
    /// count, and a streaming reply counts until its last chunk is delivered.
    pub inflight: usize,
    /// Clock reading when the model was last acquired or released.
    pub last_active_ms: u64,
    /// Embedding models stay resident: RAG calls them mid-turn, and a reload
    /// there would stall the very request that is waiting on the vectors.
    pub pinned: bool,
}

/// Ids of the models that have been idle for at least `timeout`.
///
/// A model is never listed while it has a request in flight, however old its
/// timestamp, and `None` (the off setting) lists nothing.
pub fn expired<'a>(
    candidates: impl Iterator<Item = Candidate<'a>>,
    now_ms: u64,
    timeout: Option<Duration>,
) -> Vec<String> {
    let Some(timeout) = timeout else {
        return Vec::new();
    };
    let limit = timeout.as_millis() as u64;
    let mut ids: Vec<String> = candidates
        .filter(|c| c.inflight == 0 && !c.pinned)
        .filter(|c| now_ms.saturating_sub(c.last_active_ms) >= limit)
        .map(|c| c.id.to_string())
        .collect();
    ids.sort();
    ids
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    const FIVE_MIN: Option<Duration> = Some(Duration::from_secs(300));

    fn c(id: &str, inflight: usize, last_active_ms: u64, pinned: bool) -> Candidate<'_> {
        Candidate {
            id,
            inflight,
            last_active_ms,
            pinned,
        }
    }

    #[test]
    fn an_idle_model_past_the_timeout_is_listed() {
        let out = expired([c("a", 0, 0, false)].into_iter(), 300_000, FIVE_MIN);
        assert_eq!(out, vec!["a".to_string()]);
    }

    #[test]
    fn a_model_inside_the_timeout_is_kept() {
        let out = expired([c("a", 0, 0, false)].into_iter(), 299_999, FIVE_MIN);
        assert!(out.is_empty());
    }

    #[test]
    fn activity_resets_the_timer() {
        let (clock, now) = manual_clock();
        // Touched at t=200s: not due at t=400s, due at t=500s.
        now.store(200_000, Ordering::Relaxed);
        let last = clock();
        now.store(400_000, Ordering::Relaxed);
        assert!(expired([c("a", 0, last, false)].into_iter(), clock(), FIVE_MIN).is_empty());
        now.store(500_000, Ordering::Relaxed);
        assert_eq!(
            expired([c("a", 0, last, false)].into_iter(), clock(), FIVE_MIN),
            vec!["a".to_string()]
        );
    }

    #[test]
    fn a_request_in_flight_blocks_the_unload() {
        let out = expired([c("a", 1, 0, false)].into_iter(), u64::MAX, FIVE_MIN);
        assert!(out.is_empty());
    }

    #[test]
    fn off_never_unloads() {
        let out = expired([c("a", 0, 0, false)].into_iter(), u64::MAX, None);
        assert!(out.is_empty());
        assert_eq!(timeout_from_minutes(0), None);
        assert_eq!(timeout_from_minutes(5), FIVE_MIN);
    }

    #[test]
    fn a_pinned_model_is_never_listed() {
        let out = expired([c("embed", 0, 0, true)].into_iter(), u64::MAX, FIVE_MIN);
        assert!(out.is_empty());
    }

    #[test]
    fn a_clock_that_went_backwards_does_not_underflow() {
        let out = expired([c("a", 0, 500, false)].into_iter(), 100, FIVE_MIN);
        assert!(out.is_empty());
    }
}
