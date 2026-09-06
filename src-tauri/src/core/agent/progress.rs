//! Detecting a run that has stopped getting anywhere (`AH-029`, `AH-030`).
//!
//! Nothing watched for this. The only counterweight was a mutation-count nudge
//! that injected a reminder and never halted anything, so a model that settled
//! into asking for the same tool call over and over would keep doing it until
//! the user noticed. With turns unbounded by design, "until the user notices"
//! was the whole of the protection.
//!
//! The signal is deliberately narrow: a turn that asks for *exactly* the tool
//! calls the previous turn asked for. That is a loop, not slow progress. Two
//! things are explicitly not treated as being stuck:
//!
//! - A turn with no tool calls. The model produced text, which is either an
//!   answer or a question -- both progress.
//! - A turn whose calls differ at all, even slightly. Re-reading one file while
//!   walking a directory tree is normal work, and a watcher that flagged it
//!   would train users to ignore it.
//!
//! Escalation is graduated, because the cheap intervention usually works: say
//! something first, and only stop the run if the model keeps going anyway.

use jan_agent_harness::event::fingerprint;

/// Consecutive identical turns before the model is told it is repeating.
const NUDGE_AFTER: u32 = 2;

/// Consecutive identical turns before the run is stopped.
///
/// Two turns past the nudge: enough for the model to act on being told, and
/// short enough that a wedged run does not burn its whole budget first.
const STOP_AFTER: u32 = 4;

/// What the watcher makes of the turn it just saw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Progress {
    /// The run is doing new work.
    Fine,
    /// Repeating itself. Worth telling the model, once.
    Repeating { turns: u32 },
    /// Repeating itself past the point of usefulness. The run should stop.
    Stalled { turns: u32 },
}

/// Watches consecutive turns for repeated tool calls.
#[derive(Debug, Default)]
pub(crate) struct LoopWatch {
    /// Sorted fingerprints of the previous turn's tool calls.
    ///
    /// Sorted because the model may list the same calls in a different order,
    /// and that is the same request, not new work.
    previous: Option<Vec<String>>,
    repeats: u32,
    /// Whether this streak has already produced a nudge. One streak, one
    /// nudge: repeating the message every turn is how a warning becomes noise.
    nudged: bool,
}

impl LoopWatch {
    /// The fingerprint of one tool call, as this watcher compares them.
    pub(crate) fn fingerprint_of(name: &str, args: &serde_json::Value) -> String {
        fingerprint(name, args)
    }

    /// Folds in one turn's tool calls and says what to do about it.
    pub(crate) fn observe(&mut self, mut fingerprints: Vec<String>) -> Progress {
        if fingerprints.is_empty() {
            // Text, not tools: the model is answering or asking. Any streak ends.
            self.reset();
            return Progress::Fine;
        }

        fingerprints.sort();
        let repeated = self.previous.as_ref() == Some(&fingerprints);
        self.previous = Some(fingerprints);

        if !repeated {
            self.repeats = 0;
            self.nudged = false;
            return Progress::Fine;
        }

        self.repeats += 1;
        if self.repeats >= STOP_AFTER {
            return Progress::Stalled {
                turns: self.repeats + 1,
            };
        }
        if self.repeats >= NUDGE_AFTER && !self.nudged {
            self.nudged = true;
            return Progress::Repeating {
                turns: self.repeats + 1,
            };
        }
        Progress::Fine
    }

    fn reset(&mut self) {
        self.previous = None;
        self.repeats = 0;
        self.nudged = false;
    }
}

/// What the model is told when it is caught repeating itself.
///
/// Addressed to the model, in the system voice, and concrete about what to do:
/// a reminder that only says "you are repeating" tends to produce the same call
/// with an apology attached.
pub(crate) fn repeating_notice(turns: u32) -> String {
    format!(
        "[no progress] The last {turns} turns requested exactly the same tool calls with the \
         same arguments. Repeating them will not produce a different result. Change approach: \
         use what you already have, try a different tool or different arguments, or stop and \
         report what is blocking you."
    )
}

/// The terminal message for a run stopped because it was looping.
pub(crate) fn stalled_msg(turns: u32) -> String {
    format!(
        "ERROR [doom_loop]: run stopped after {turns} consecutive turns requesting identical \
         tool calls with no progress. The last answer the model gave is the most it produced."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(command: &str) -> String {
        LoopWatch::fingerprint_of("bash", &json!({ "command": command }))
    }

    #[test]
    fn new_work_every_turn_is_never_flagged() {
        let mut watch = LoopWatch::default();
        for n in 0..20 {
            assert_eq!(
                watch.observe(vec![call(&format!("step {n}"))]),
                Progress::Fine
            );
        }
    }

    #[test]
    fn repeating_the_same_call_nudges_then_stops() {
        let mut watch = LoopWatch::default();
        // First sighting is not a repeat.
        assert_eq!(watch.observe(vec![call("ls")]), Progress::Fine);
        assert_eq!(watch.observe(vec![call("ls")]), Progress::Fine);
        assert_eq!(watch.observe(vec![call("ls")]), Progress::Repeating { turns: 3 });
        assert_eq!(watch.observe(vec![call("ls")]), Progress::Fine);
        assert_eq!(watch.observe(vec![call("ls")]), Progress::Stalled { turns: 5 });
    }

    #[test]
    fn the_nudge_is_delivered_once_per_streak_not_every_turn() {
        let mut watch = LoopWatch::default();
        let mut nudges = 0;
        for _ in 0..4 {
            if matches!(watch.observe(vec![call("ls")]), Progress::Repeating { .. }) {
                nudges += 1;
            }
        }
        assert_eq!(nudges, 1, "one streak, one nudge");
    }

    #[test]
    fn a_turn_of_plain_text_breaks_the_streak() {
        let mut watch = LoopWatch::default();
        watch.observe(vec![call("ls")]);
        watch.observe(vec![call("ls")]);
        // The model answered instead of calling a tool: that is progress.
        assert_eq!(watch.observe(Vec::new()), Progress::Fine);
        // ...and the count starts over rather than resuming mid-streak.
        assert_eq!(watch.observe(vec![call("ls")]), Progress::Fine);
        assert_eq!(watch.observe(vec![call("ls")]), Progress::Fine);
        assert_eq!(watch.observe(vec![call("ls")]), Progress::Repeating { turns: 3 });
    }

    #[test]
    fn changing_the_arguments_at_all_breaks_the_streak() {
        let mut watch = LoopWatch::default();
        watch.observe(vec![call("ls")]);
        watch.observe(vec![call("ls")]);
        assert_eq!(watch.observe(vec![call("ls -la")]), Progress::Fine);
        assert_eq!(watch.observe(vec![call("ls -la")]), Progress::Fine);
        assert_eq!(watch.observe(vec![call("ls -la")]), Progress::Repeating { turns: 3 });
    }

    #[test]
    fn the_same_calls_in_a_different_order_are_the_same_request() {
        let mut watch = LoopWatch::default();
        watch.observe(vec![call("a"), call("b")]);
        watch.observe(vec![call("b"), call("a")]);
        assert_eq!(
            watch.observe(vec![call("b"), call("a")]),
            Progress::Repeating { turns: 3 }
        );
    }

    #[test]
    fn a_partly_repeated_batch_is_new_work() {
        let mut watch = LoopWatch::default();
        watch.observe(vec![call("a"), call("b")]);
        watch.observe(vec![call("a"), call("b")]);
        // Dropping one call is a different request, and plausibly progress.
        assert_eq!(watch.observe(vec![call("a")]), Progress::Fine);
    }

    #[test]
    fn a_stalled_run_reports_the_turns_it_wasted() {
        let mut watch = LoopWatch::default();
        for _ in 0..4 {
            watch.observe(vec![call("ls")]);
        }
        match watch.observe(vec![call("ls")]) {
            Progress::Stalled { turns } => {
                assert!(turns > STOP_AFTER);
                assert!(stalled_msg(turns).contains("doom_loop"));
                assert!(stalled_msg(turns).contains(&turns.to_string()));
            }
            other => panic!("expected a stall, got {other:?}"),
        }
    }

    #[test]
    fn the_notice_tells_the_model_what_to_do_instead() {
        let notice = repeating_notice(3);
        assert!(notice.contains("Change approach"));
        assert!(notice.contains("stop and report"));
    }
}
