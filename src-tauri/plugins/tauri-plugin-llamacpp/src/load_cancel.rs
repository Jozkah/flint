//! Cancelling a model load that is in progress.
//!
//! The engine worker loads a model on a blocking call that has no abort hook,
//! and the load holds the registry lock for its whole duration, so a load
//! cannot be interrupted from outside without ending the process. Cancelling
//! is therefore two things: the app stops waiting at once (this module's
//! tracker), and the worker is dealt with according to what else it holds
//! (`plan_cancel`).

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::watch;

struct Entry {
    id: u64,
    cancel: watch::Sender<bool>,
}

#[derive(Default)]
struct Inner {
    next_id: u64,
    loads: HashMap<String, Entry>,
}

/// The loads this app is currently waiting on, by model id.
#[derive(Clone, Default)]
pub struct LoadTracker {
    inner: Arc<Mutex<Inner>>,
}

/// Held for the duration of one load wait. Dropping it ends the registration,
/// unless a newer load of the same model has replaced it.
pub struct LoadGuard {
    tracker: LoadTracker,
    model_id: String,
    id: u64,
    cancelled: watch::Receiver<bool>,
}

impl LoadTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a load of `model_id`.
    pub fn begin(&self, model_id: &str) -> LoadGuard {
        let (tx, rx) = watch::channel(false);
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.next_id += 1;
        let id = inner.next_id;
        inner
            .loads
            .insert(model_id.to_string(), Entry { id, cancel: tx });
        LoadGuard {
            tracker: self.clone(),
            model_id: model_id.to_string(),
            id,
            cancelled: rx,
        }
    }

    /// Signals the load of `model_id` to stop. False when none is in flight.
    pub fn cancel(&self, model_id: &str) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match inner.loads.get(model_id) {
            Some(entry) => {
                let _ = entry.cancel.send(true);
                true
            }
            None => false,
        }
    }

    /// Whether a load of `model_id` is being waited on.
    pub fn is_loading(&self, model_id: &str) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.loads.contains_key(model_id)
    }
}

impl LoadGuard {
    /// Resolves once this load has been cancelled; never resolves otherwise.
    pub async fn cancelled(&self) {
        let mut rx = self.cancelled.clone();
        loop {
            if *rx.borrow_and_update() {
                return;
            }
            if rx.changed().await.is_err() {
                // The entry was replaced or removed without a cancel.
                std::future::pending::<()>().await;
            }
        }
    }
}

impl Drop for LoadGuard {
    fn drop(&mut self) {
        let mut inner = self
            .tracker
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if inner.loads.get(&self.model_id).map(|e| e.id) == Some(self.id) {
            inner.loads.remove(&self.model_id);
        }
    }
}

/// What a cancel does to the worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelPlan {
    /// No load of this model was in flight; nothing to do.
    Nothing,
    /// Stop waiting, and unload the model once the worker finishes loading it,
    /// because other models are resident and ending the worker would evict
    /// them.
    AbandonThenUnload,
    /// Stop the worker, which is what actually ends the load and frees its
    /// memory. The next load starts a fresh one.
    StopWorker,
}

pub fn plan_cancel(load_in_flight: bool, keep_worker: bool) -> CancelPlan {
    match (load_in_flight, keep_worker) {
        (false, _) => CancelPlan::Nothing,
        (true, true) => CancelPlan::AbandonThenUnload,
        (true, false) => CancelPlan::StopWorker,
    }
}

/// Calls `probe` every `interval` until it answers true, or `timeout` passes.
/// Returns whether it answered true.
pub async fn poll_until<F, Fut>(mut probe: F, interval: Duration, timeout: Duration) -> bool
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    let start = tokio::time::Instant::now();
    loop {
        if probe().await {
            return true;
        }
        if start.elapsed() >= timeout {
            return false;
        }
        tokio::time::sleep(interval).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn cancel_wakes_the_waiting_load() {
        let t = LoadTracker::new();
        let guard = t.begin("m");
        assert!(t.is_loading("m"));
        assert!(t.cancel("m"));
        tokio::time::timeout(Duration::from_secs(1), guard.cancelled())
            .await
            .expect("a cancelled load must resolve");
    }

    #[tokio::test]
    async fn an_uncancelled_load_never_resolves() {
        let t = LoadTracker::new();
        let guard = t.begin("m");
        assert!(tokio::time::timeout(Duration::from_millis(30), guard.cancelled())
            .await
            .is_err());
    }

    #[test]
    fn cancel_reports_whether_a_load_was_in_flight() {
        let t = LoadTracker::new();
        assert!(!t.cancel("m"));
        let guard = t.begin("m");
        assert!(t.cancel("m"));
        drop(guard);
        assert!(!t.is_loading("m"));
        assert!(!t.cancel("m"));
    }

    #[test]
    fn a_stale_guard_does_not_unregister_a_newer_load() {
        let t = LoadTracker::new();
        let first = t.begin("m");
        let second = t.begin("m");
        drop(first);
        assert!(t.is_loading("m"), "the second load is still being waited on");
        drop(second);
        assert!(!t.is_loading("m"));
    }

    #[test]
    fn loads_of_other_models_are_independent() {
        let t = LoadTracker::new();
        let _a = t.begin("a");
        let b = t.begin("b");
        assert!(t.cancel("a"));
        assert!(!*b.cancelled.borrow());
    }

    #[test]
    fn plan_depends_on_what_else_the_worker_holds() {
        assert_eq!(plan_cancel(false, false), CancelPlan::Nothing);
        assert_eq!(plan_cancel(false, true), CancelPlan::Nothing);
        assert_eq!(plan_cancel(true, true), CancelPlan::AbandonThenUnload);
        assert_eq!(plan_cancel(true, false), CancelPlan::StopWorker);
    }

    #[tokio::test]
    async fn poll_until_stops_at_the_first_true() {
        let calls = AtomicUsize::new(0);
        let ok = poll_until(
            || {
                let n = calls.fetch_add(1, Ordering::SeqCst) + 1;
                async move { n >= 3 }
            },
            Duration::from_millis(1),
            Duration::from_secs(5),
        )
        .await;
        assert!(ok);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn poll_until_gives_up_at_the_timeout() {
        let ok = poll_until(
            || async { false },
            Duration::from_millis(2),
            Duration::from_millis(20),
        )
        .await;
        assert!(!ok);
    }
}
