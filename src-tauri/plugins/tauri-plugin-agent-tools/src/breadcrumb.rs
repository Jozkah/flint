//! A note for the crash report that a command is about to run.
//!
//! The app registers a sink at start (`core::crash_trace::breadcrumb`); until it
//! does, and in every other host of this crate, a note goes nowhere. The tool
//! commands record themselves here because a plugin's commands do not pass
//! through the app's own command handler, and they are the ones a model's tool
//! call runs through.

use std::sync::OnceLock;

static SINK: OnceLock<fn(&str)> = OnceLock::new();

/// Where notes go. Set once; a second call is ignored.
pub fn set_sink(sink: fn(&str)) {
    let _ = SINK.set(sink);
}

/// Note that `what` is about to run.
pub fn note(what: &str) {
    if let Some(sink) = SINK.get() {
        sink(what);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEEN: AtomicUsize = AtomicUsize::new(0);

    #[test]
    fn notes_reach_the_sink_once_one_is_set() {
        note("before any sink"); // goes nowhere, and must not panic
        set_sink(|what| {
            if what == "execute_tool read" {
                SEEN.fetch_add(1, Ordering::SeqCst);
            }
        });
        note("execute_tool read");
        assert_eq!(SEEN.load(Ordering::SeqCst), 1);
    }
}
