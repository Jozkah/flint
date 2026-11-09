//! Agent-status emission for terminal integrations (Orca, #8819).
//!
//! Two evidence layers are produced, both written straight to the PTY (raw
//! stdout) rather than through the ratatui frame buffer, so status reaches
//! the host terminal even when no terminal view is rendered:
//!
//! 1. **OSC 9999 agent-status protocol** - `\x1b]9999;{json}\x07` with a JSON
//!    payload carrying `agentType` and `state` (`working` | `blocked` |
//!    `waiting` | `done`).
//! 2. **Terminal titles (OSC 2)** - a spinner glyph + `Jan` while working,
//!    `Jan - action required` while blocked/waiting, and `Jan ready` when idle.
//!
//! 3. **Terminal bell (BEL)** - rung when the session starts needing the
//!    user, per the `bell` preference ([`BellMode`]).
//!
//! Orca 1.4.191 accepts Jan's OSC 9999 status, but its `tui-idle` wait does not
//! consume that protocol or recognize Jan's settled titles. Jan icons and
//! title-based idle recognition require Orca-side support.

use std::io::{self, Write};

/// `agentType` value reported to status consumers.
const AGENT_TYPE: &str = "jan";
/// OSC 9999 introducer; the payload is terminated by BEL (or ST, not used here).
const OSC_9999_PREFIX: &str = "\x1b]9999;";
/// OSC 2 sets the window title.
const OSC_TITLE_PREFIX: &str = "\x1b]2;";
/// XTWINOPS: save the window title on the terminal's title stack, and restore
/// it. Terminals without the stack ignore both.
const TITLE_PUSH: &str = "\x1b[22;2t";
const TITLE_POP: &str = "\x1b[23;2t";

/// Agent states understood by the OSC 9999 protocol.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentStatusState {
    /// A turn is in progress.
    Working,
    /// A permission prompt needs a decision.
    Blocked,
    /// The agent asked a question and awaits the user's answer.
    Waiting,
    /// No turn is running; the session is idle.
    Done,
}

impl AgentStatusState {
    /// Wire representation of the state.
    pub fn as_str(self) -> &'static str {
        match self {
            AgentStatusState::Working => "working",
            AgentStatusState::Blocked => "blocked",
            AgentStatusState::Waiting => "waiting",
            AgentStatusState::Done => "done",
        }
    }
}

/// The `bell` preference in `~/.jan/config.toml`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BellMode {
    /// Never ring.
    Off,
    /// Ring when a permission prompt or an `ask` question needs the user.
    #[default]
    Attention,
    /// Also ring when a turn finishes.
    Always,
}

impl BellMode {
    /// Accepted values, in `/settings` order.
    pub const OPTIONS: &'static [&'static str] = &["off", "attention", "always"];

    /// Parse the config value. Unset or unknown reads as the default, so a typo
    /// never silences a prompt the user meant to hear.
    pub fn parse(value: Option<&str>) -> Self {
        match value.map(str::trim) {
            Some("off") => BellMode::Off,
            Some("always") => BellMode::Always,
            _ => BellMode::Attention,
        }
    }

    /// The mode currently configured, read fresh so `/settings` applies at once.
    fn configured() -> Self {
        Self::parse(crate::core::agent::global_config::bell_setting().as_deref())
    }

    /// Whether an emitted transition from `prev` to `next` rings. A new `ask`
    /// question while one is already showing is a new transition (its prompt
    /// changed) and rings again. `done` rings only straight out of `working`:
    /// the startup `done` and the `done` after the user answers a prompt both
    /// mean the user is already looking.
    fn rings(self, prev: Option<AgentStatusState>, next: AgentStatusState) -> bool {
        use AgentStatusState as S;
        match (self, next) {
            (BellMode::Off, _) => false,
            (_, S::Blocked | S::Waiting) => true,
            (BellMode::Always, S::Done) => prev == Some(S::Working),
            _ => false,
        }
    }
}

/// Braille frames used to animate the working title.
const SPINNER_FRAMES: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/// Title shown while a turn is running (spinner frame + agent name).
fn working_title(frame: usize) -> String {
    format!("{} Jan", SPINNER_FRAMES[frame % SPINNER_FRAMES.len()])
}

/// Title shown when waiting for input or idle.
fn settled_title(state: AgentStatusState) -> &'static str {
    match state {
        AgentStatusState::Blocked | AgentStatusState::Waiting => "Jan - action required",
        AgentStatusState::Working | AgentStatusState::Done => "Jan ready",
    }
}

/// Build the OSC 9999 escape sequence for a state transition.
///
/// The payload is a single-line JSON object; BEL terminates the sequence.
/// `prompt` is the optional activity preview Orca renders on its cards; it is
/// truncated to 160 Unicode scalar values before JSON escaping.
pub fn agent_status_sequence(state: AgentStatusState, prompt: Option<&str>) -> String {
    // JSON escaping covers C0 only. DEL and the C1 range (U+0085, U+009C as a
    // string terminator on some terminals) pass through it, and bidi overrides
    // would reorder what the host shows, so none of them are sent.
    let prompt = prompt
        .map(|p| {
            p.chars()
                .filter(|c| {
                    (!c.is_control() || matches!(*c, '\t' | '\n' | '\r')) && !matches!(*c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
                })
                .take(160)
                .collect::<String>()
        })
        .unwrap_or_default();
    if prompt.is_empty() {
        // Omit an empty preview.
        format!(
            "{OSC_9999_PREFIX}{{\"agentType\":\"{AGENT_TYPE}\",\"state\":\"{}\"}}\x07",
            state.as_str()
        )
    } else {
        // Escape terminal controls as JSON so prompt text cannot end the OSC.
        let prompt = serde_json::to_string(&prompt).expect("string serialization cannot fail");
        format!(
            "{OSC_9999_PREFIX}{{\"agentType\":\"{AGENT_TYPE}\",\"state\":\"{}\",\"prompt\":{prompt}}}\x07",
            state.as_str()
        )
    }
}

/// Build the OSC 2 window-title sequence for a state.
///
/// `spinner_frame` selects the animated indicator used while working; it is
/// ignored for terminal states.
pub fn title_sequence(state: AgentStatusState, spinner_frame: usize) -> String {
    let title = match state {
        AgentStatusState::Working => working_title(spinner_frame),
        _ => settled_title(state).to_string(),
    };
    format!("{OSC_TITLE_PREFIX}{title}\x07")
}

/// Tracks the last reported state and writes transitions to the PTY.
///
/// Every state change is emitted exactly once (deduped), as an OSC 9999
/// payload plus an OSC 2 title. Writes happen directly on stdout, outside the
/// ratatui frame, so hidden/background sessions are tracked too. Until
/// [`AgentStatusReporter::enable`] is called the reporter is inert: no bytes
/// reach stdout, which keeps test-driven state machines quiet.
#[derive(Debug, Default)]
pub struct AgentStatusReporter {
    enabled: bool,
    last_state: Option<AgentStatusState>,
    last_prompt: Option<String>,
    spinner_frame: usize,
    /// When the title frame last advanced, to hold the spinner to a few
    /// writes a second however fast the render tick runs.
    last_animated: Option<std::time::Instant>,
}

/// The shortest gap between two title frames (about 4 per second).
const TITLE_FRAME_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);

impl AgentStatusReporter {
    /// Create a disabled reporter (emits nothing until enabled).
    pub fn new() -> Self {
        Self::default()
    }

    /// Start emitting to stdout. Called by the real TUI once the terminal is
    /// set up; unit tests construct `App` through paths that leave it off.
    pub fn enable(&mut self) {
        if !self.enabled {
            // Saved first, so leaving can hand the user back their own title
            // instead of a stale "Jan ready".
            write_raw(TITLE_PUSH);
        }
        self.enabled = true;
    }

    /// Stop emitting and restore the title saved by [`Self::enable`]. Where
    /// the title stack is unsupported, the title is cleared instead of left
    /// on the last status.
    pub fn disable(&mut self) {
        if self.enabled {
            write_raw(&restore_title_sequence());
        }
        self.enabled = false;
    }

    /// Compute the sequences for a state transition.
    ///
    /// Returns `None` when the state is unchanged and the prompt preview is
    /// identical (transitions are deduped), otherwise the `(status, title)`
    /// sequences to write, with a trailing BEL on the title when the mode
    /// `bell` returns rings. `bell` runs only for an emitted transition, so a
    /// deduped call never reads the config.
    fn transition(
        &mut self,
        state: AgentStatusState,
        prompt: Option<&str>,
        bell: impl FnOnce() -> BellMode,
    ) -> Option<(String, String)> {
        if self.last_state == Some(state) && self.last_prompt.as_deref() == prompt {
            return None;
        }
        let ring = bell().rings(self.last_state, state);
        self.last_state = Some(state);
        self.last_prompt = prompt.map(str::to_string);
        self.spinner_frame = 0;
        self.last_animated = None;
        let mut title = title_sequence(state, self.spinner_frame);
        if ring {
            title.push('\x07');
        }
        Some((agent_status_sequence(state, prompt), title))
    }

    /// Report a state transition, writing OSC 9999, the title and any bell to
    /// stdout.
    pub fn set_state(&mut self, state: AgentStatusState, prompt: Option<&str>) {
        self.emit(state, prompt, true);
    }

    /// [`Self::set_state`] without the bell, for a transition the user just
    /// caused (Esc or Ctrl-C cancelling a turn): they are already looking.
    pub fn set_state_quietly(&mut self, state: AgentStatusState, prompt: Option<&str>) {
        self.emit(state, prompt, false);
    }

    fn emit(&mut self, state: AgentStatusState, prompt: Option<&str>, may_ring: bool) {
        // Disabled reporters never write, so skip the config read for them.
        let enabled = self.enabled;
        let bell = || {
            if enabled && may_ring {
                BellMode::configured()
            } else {
                BellMode::Off
            }
        };
        let Some((status, title)) = self.transition(state, prompt, bell) else {
            return;
        };
        if self.enabled {
            write_raw(&status);
            write_raw(&title);
        }
    }

    /// Advance the animated working title by one frame.
    ///
    /// No-op unless currently `working`. Call from the render tick; the deduped
    /// OSC 9999 payload is not re-sent. The frame advances even when disabled
    /// (so test state machines track it); only the stdout write is gated.
    pub fn animate(&mut self) {
        if self.last_state != Some(AgentStatusState::Working) {
            return;
        }
        if self.last_animated.is_some_and(|at| at.elapsed() < TITLE_FRAME_INTERVAL) {
            return;
        }
        self.last_animated = Some(std::time::Instant::now());
        self.spinner_frame = (self.spinner_frame + 1) % SPINNER_FRAMES.len();
        if self.enabled {
            write_raw(&title_sequence(
                AgentStatusState::Working,
                self.spinner_frame,
            ));
        }
    }
}

/// Sequence written on leaving: an empty title (the fallback a terminal
/// without a title stack keeps), then the pop that restores the saved one.
fn restore_title_sequence() -> String {
    format!("{OSC_TITLE_PREFIX}\x07{TITLE_POP}")
}

/// Write a raw escape sequence to stdout and flush, ignoring errors the way
/// the clipboard OSC 52 write does: a failed PTY write must never take down
/// the TUI.
fn write_raw(sequence: &str) {
    let mut out = io::stdout();
    let _ = out.write_all(sequence.as_bytes());
    let _ = out.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Extract the JSON payload from an OSC 9999 sequence, i.e. the bytes
    /// between the fixed introducer and the trailing BEL terminator.
    fn extract_payload(seq: &str) -> &str {
        seq.strip_prefix(OSC_9999_PREFIX)
            .and_then(|p| p.strip_suffix('\x07'))
            .expect("sequence must be framed by the OSC 9999 prefix and a trailing BEL")
    }

    #[test]
    fn leaving_clears_then_restores_the_saved_title() {
        assert_eq!(restore_title_sequence(), "\x1b]2;\x07\x1b[23;2t");
        assert_eq!(TITLE_PUSH, "\x1b[22;2t");
    }

    /// Decode the extracted OSC 9999 payload as JSON.
    fn parse_payload(seq: &str) -> serde_json::Value {
        serde_json::from_str(extract_payload(seq)).expect("payload must be valid JSON")
    }

    #[test]
    fn prompt_preview_drops_every_control_and_bidi_character() {
        let seq = agent_status_sequence(
            AgentStatusState::Working,
            Some("a\u{7f}b\u{85}c\u{9c}d\u{202e}e"),
        );
        assert_eq!(parse_payload(&seq)["prompt"], "abcde");
    }

    #[test]
    fn payload_carries_agent_type_and_state() {
        assert_eq!(
            agent_status_sequence(AgentStatusState::Working, None),
            "\x1b]9999;{\"agentType\":\"jan\",\"state\":\"working\"}\x07"
        );
        assert_eq!(
            agent_status_sequence(AgentStatusState::Done, None),
            "\x1b]9999;{\"agentType\":\"jan\",\"state\":\"done\"}\x07"
        );
        assert_eq!(
            agent_status_sequence(AgentStatusState::Blocked, None),
            "\x1b]9999;{\"agentType\":\"jan\",\"state\":\"blocked\"}\x07"
        );
        assert_eq!(
            agent_status_sequence(AgentStatusState::Waiting, None),
            "\x1b]9999;{\"agentType\":\"jan\",\"state\":\"waiting\"}\x07"
        );
    }

    #[test]
    fn prompt_roundtrips_as_valid_json_payload() {
        // The prompt must survive decode exactly: quotes, backslashes,
        // tabs, newlines and carriage returns roundtrip; other controls are dropped.
        let prompt = "tab\there\nnewline\rCR \"double\" \\backslash bel esc";
        let seq = agent_status_sequence(AgentStatusState::Working, Some(prompt));
        let payload = parse_payload(&seq);
        assert_eq!(
            payload["prompt"],
            serde_json::Value::String(prompt.to_string())
        );
        assert_eq!(payload["agentType"], "jan");
        assert_eq!(payload["state"], "working");
    }

    #[test]
    fn prompt_has_only_outer_framing_control_escapes() {
        // ESC and BEL must appear only as the OSC 9999 framing delimiters, never
        // inside the payload from an embedded control char.
        let prompt = "raw \u{7}\u{1b} control chars";
        let seq = agent_status_sequence(AgentStatusState::Working, Some(prompt));
        let body = extract_payload(&seq);
        assert!(!body.contains('\x1b') && !body.contains('\x07'));
        // The controls are dropped rather than escaped.
        assert_eq!(
            parse_payload(&seq)["prompt"],
            serde_json::Value::String("raw  control chars".to_string())
        );
    }

    #[test]
    fn prompt_truncation_holds_a_char_bound() {
        // A 160-char cap must never split a Unicode scalar; the truncated
        // prompt plus the escaped form must still decode to a valid string.
        let long: String = "a".repeat(400);
        let seq = agent_status_sequence(AgentStatusState::Working, Some(&long));
        let decoded = parse_payload(&seq)["prompt"]
            .as_str()
            .expect("prompt should be a JSON string")
            .to_string();
        assert_eq!(decoded.chars().count(), 160);

        // CJK/emoji scalars count as one char each and stay intact.
        let cjk: String = "漢".repeat(200);
        let seq = agent_status_sequence(AgentStatusState::Working, Some(&cjk));
        let decoded = parse_payload(&seq)["prompt"]
            .as_str()
            .expect("prompt should be a JSON string")
            .to_string();
        assert_eq!(decoded, "漢".repeat(160));

        let emoji: String = "🧑‍💻".repeat(200);
        let seq = agent_status_sequence(AgentStatusState::Working, Some(&emoji));
        let decoded = parse_payload(&seq)["prompt"]
            .as_str()
            .expect("prompt should be a JSON string")
            .to_string();
        assert!(decoded.chars().count() <= 160);
    }

    #[test]
    fn titles_describe_agent_state() {
        // Working: animated indicator + "Jan".
        assert!(title_sequence(AgentStatusState::Working, 0).contains(" Jan\x07"));
        assert_eq!(
            title_sequence(AgentStatusState::Working, 0),
            "\x1b]2;⠋ Jan\x07"
        );
        // Both kinds of input wait require user attention.
        assert_eq!(
            title_sequence(AgentStatusState::Blocked, 3),
            "\x1b]2;Jan - action required\x07"
        );
        assert_eq!(
            title_sequence(AgentStatusState::Waiting, 3),
            "\x1b]2;Jan - action required\x07"
        );
        // Idle: ready for another message.
        assert_eq!(
            title_sequence(AgentStatusState::Done, 3),
            "\x1b]2;Jan ready\x07"
        );
    }

    #[test]
    fn transitions_dedupe_and_reset_spinner() {
        let off = || BellMode::Off;
        let mut reporter = AgentStatusReporter::new();
        assert!(reporter.transition(AgentStatusState::Done, None, off).is_some());
        // Same state again: nothing to emit.
        assert!(reporter.transition(AgentStatusState::Done, None, off).is_none());
        assert!(reporter
            .transition(AgentStatusState::Working, None, off)
            .is_some());
        // Spinner frame survives across animate() calls and resets on
        // transitions.
        reporter.animate();
        assert_eq!(
            title_sequence(AgentStatusState::Working, reporter.spinner_frame),
            "\x1b]2;⠙ Jan\x07"
        );
        assert!(reporter.transition(AgentStatusState::Done, None, off).is_some());
        assert_eq!(reporter.spinner_frame, 0);
    }

    #[test]
    fn bell_mode_parses_and_defaults_to_attention() {
        assert_eq!(BellMode::parse(None), BellMode::Attention);
        assert_eq!(BellMode::parse(Some("off")), BellMode::Off);
        assert_eq!(BellMode::parse(Some("always")), BellMode::Always);
        assert_eq!(BellMode::parse(Some("attention")), BellMode::Attention);
        assert_eq!(BellMode::parse(Some("loud")), BellMode::Attention, "typo");
    }

    /// Drive one reporter through `states` under `bell`, returning which
    /// emitted transitions ended in a BEL after the title.
    fn rings(bell: BellMode, states: &[(AgentStatusState, Option<&str>)]) -> Vec<bool> {
        let mut reporter = AgentStatusReporter::new();
        states
            .iter()
            .filter_map(|(state, prompt)| reporter.transition(*state, *prompt, || bell))
            .map(|(_, title)| title.ends_with("\x07\x07"))
            .collect()
    }

    #[test]
    fn bell_rings_only_on_the_transitions_its_mode_names() {
        use AgentStatusState as S;
        let session = [
            (S::Done, None),          // startup
            (S::Working, None),       // turn starts
            (S::Blocked, None),       // permission prompt
            (S::Working, None),       // approved
            (S::Waiting, Some("a?")), // ask
            (S::Waiting, Some("b?")), // a second question
            (S::Working, None),       // answered
            (S::Done, None),          // turn ends
        ];
        let attention = [false, false, true, false, true, true, false, false];
        let always = [false, false, true, false, true, true, false, true];
        assert_eq!(rings(BellMode::Attention, &session), attention);
        assert_eq!(rings(BellMode::Always, &session), always);
        assert_eq!(rings(BellMode::Off, &session), [false; 8]);
        // An answered prompt that ends the turn leaves the user already
        // looking: `done` out of `blocked` stays quiet even under always.
        assert_eq!(
            rings(BellMode::Always, &[(S::Blocked, None), (S::Done, None)]),
            [true, false]
        );
    }

    #[test]
    fn a_deduped_transition_never_reads_the_bell_mode() {
        let mut reporter = AgentStatusReporter::new();
        let mut reads = 0;
        for _ in 0..3 {
            reporter.transition(AgentStatusState::Working, None, || {
                reads += 1;
                BellMode::Always
            });
        }
        assert_eq!(reads, 1, "only the emitted transition asks for the mode");
    }
}
