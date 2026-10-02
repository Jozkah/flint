//! Bounded steps for everything that waits on the webview.
//!
//! The webview lives on the app's main thread. When the Flint window is
//! minimized or hidden that thread may not answer for a long time, and a plain
//! call into the webview (`url()`, `eval_with_callback`, `with_webview`) then
//! parks the caller with it: a tool call that never returns, and a lease and a
//! "loading" flag that are never released. Every such call goes through
//! `run_step`, which gives it a budget and lets the tool answer with a clear
//! error instead.
//!
//! `run_step` is generic over the closure, so tests inject steps that never
//! answer.

use std::time::Duration;

/// Longest one step may take.
pub const STEP_BUDGET: Duration = Duration::from_secs(8);
/// Longest a window-state query may take.
pub const WINDOW_BUDGET: Duration = Duration::from_secs(2);
/// Longest a whole tool call may take, whatever its steps do.
pub const CALL_BUDGET: Duration = Duration::from_secs(75);

/// The error text every layer uses for "the webview did not answer". The tool
/// call turns it into the full message (which says whether the window is
/// minimized) in one place.
pub const PANE_UNRESPONSIVE: &str = "The browser pane did not respond.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StepError {
    Timeout,
    Failed(String),
}

/// Run a blocking call on its own thread and wait at most `budget` for it. A
/// call that never returns is abandoned: its thread stays parked, the caller
/// goes on.
pub async fn run_step<T: Send + 'static>(budget: Duration, f: impl FnOnce() -> T + Send + 'static) -> Result<T, StepError> {
    match tokio::time::timeout(budget, tokio::task::spawn_blocking(f)).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(StepError::Failed(format!("a browser pane step failed: {e}"))),
        Err(_) => Err(StepError::Timeout),
    }
}

/// What is known about the app window that holds the pane.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WindowState {
    pub minimized: Option<bool>,
    pub visible: Option<bool>,
}

impl WindowState {
    /// The window is known to be minimized or hidden: the pane cannot answer.
    pub fn unavailable(&self) -> bool {
        self.minimized == Some(true) || self.visible == Some(false)
    }

    /// The message a tool call ends with when the pane does not answer.
    pub fn message(&self) -> String {
        let why = if self.minimized == Some(true) {
            "The Flint window is minimized, so the browser pane cannot respond."
        } else if self.visible == Some(false) {
            "The Flint window is hidden, so the browser pane cannot respond."
        } else {
            "The browser pane did not respond. It may be hidden or minimized."
        };
        format!("{why} Restore the Flint window and try again.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[tokio::test]
    async fn a_step_that_never_answers_times_out_and_the_caller_goes_on() {
        let t0 = Instant::now();
        // A fake webview call that parks far longer than the budget.
        let r = run_step(Duration::from_millis(150), || {
            std::thread::sleep(Duration::from_secs(2));
            1
        })
        .await;
        assert_eq!(r, Err(StepError::Timeout));
        assert!(t0.elapsed() < Duration::from_secs(5), "the caller must not wait for the parked step");
    }

    #[tokio::test]
    async fn a_step_that_answers_returns_its_value() {
        assert_eq!(run_step(Duration::from_secs(5), || 7).await, Ok(7));
    }

    #[tokio::test]
    async fn a_step_that_panics_is_an_error_not_a_hang() {
        let r = run_step(Duration::from_secs(5), || -> u8 { panic!("webview call blew up") }).await;
        assert!(matches!(r, Err(StepError::Failed(_))));
    }

    #[test]
    fn the_message_names_a_minimized_or_hidden_window() {
        let minimized = WindowState { minimized: Some(true), visible: Some(true) }.message();
        assert!(minimized.contains("minimized"), "{minimized}");
        assert!(minimized.contains("Restore the Flint window"), "{minimized}");
        let hidden = WindowState { minimized: Some(false), visible: Some(false) }.message();
        assert!(hidden.contains("hidden"), "{hidden}");
        // Unknown state: both are possibilities, and the advice is the same.
        let unknown = WindowState::default().message();
        assert!(unknown.contains("hidden or minimized"), "{unknown}");
        assert!(unknown.contains("did not respond"), "{unknown}");
        assert!(unknown.contains("try again"), "{unknown}");
        // A window that is up and visible gets the generic one.
        let up = WindowState { minimized: Some(false), visible: Some(true) }.message();
        assert!(up.contains("did not respond"), "{up}");
    }

    #[test]
    fn only_a_known_minimized_or_hidden_window_blocks_a_call() {
        assert!(WindowState { minimized: Some(true), visible: None }.unavailable());
        assert!(WindowState { minimized: None, visible: Some(false) }.unavailable());
        assert!(!WindowState::default().unavailable(), "an unanswered query must not block calls");
        assert!(!WindowState { minimized: Some(false), visible: Some(true) }.unavailable());
    }
}
