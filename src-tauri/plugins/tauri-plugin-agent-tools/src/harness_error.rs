//! The harness error taxonomy (AH-009).
//!
//! Failures travel as `Result<_, String>` in most of the harness, with their
//! class smuggled through prose that callers substring-match. That makes three
//! things impossible: deciding retryability from the error, deciding who should
//! see it, and testing either.
//!
//! [`HarnessError`] carries the classification on the value: what kind of
//! failure it is, whether retrying could help, and who it is addressed to. The
//! provider chain reads the retry decision from here rather than matching text
//! of its own (AH-193), and the headless CLI reads the audience to decide how
//! loudly to say it.
//!
//! First written on the `feat/agent-harness-phase-1` line, whose crate never
//! reached the main tree; restored here, in the plugin both surfaces already
//! depend on, with the upstream classifier added.

use std::fmt;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// What went wrong, coarsely enough to drive policy.
///
/// The distinctions here are the ones something downstream acts on. A rejected
/// credential and a refused permission are both "no", but one is the user's
/// configuration and the other is the gate doing its job, and a chain that
/// cannot tell them apart either retries a refusal or gives up on a typo.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// The user or the harness cancelled the work. Never an error to report as a failure.
    Cancelled,
    /// The work was cut off from outside: the process went away, the stream
    /// ended mid-flight, the host stopped. Not a decision anyone made.
    Interrupted,
    /// A deadline expired.
    Timeout,
    /// A token, step or wall-clock budget was exhausted.
    BudgetExhausted,
    /// The permission gate denied the call.
    PermissionDenied,
    /// The user was asked and said no.
    ApprovalRefused,
    /// The sandbox refused the call: outside the workspace, or a capability the
    /// confinement does not grant.
    SandboxDenied,
    /// The call was structurally forbidden, for example a write in plan mode,
    /// or an authority this subject does not hold.
    PolicyViolation,
    /// The named resource does not exist.
    NotFound,
    /// The tool is not available in this run: not advertised, not installed, or
    /// its server is not connected.
    ToolUnavailable,
    /// The caller supplied something malformed.
    InvalidInput,
    /// The request does not fit the model's context window.
    ContextOverflow,
    /// The provider rejected the credential.
    Authentication,
    /// The provider is rate limiting. Transient by definition.
    RateLimited,
    /// The provider answered, but not in a shape that can be read.
    InvalidResponse,
    /// The model provider failed.
    Upstream,
    /// The network or transport failed before a provider could answer.
    Transport,
    /// A tool ran and failed on its own terms.
    ToolFailed,
    /// A child run failed, was refused, or ended without a result.
    ChildFailed,
    /// The filesystem failed.
    Io,
    /// Data on disk or on the wire could not be understood.
    Serialization,
    /// State written by an older build cannot be read as it stands.
    MalformedState,
    /// Writing or reading an export failed, or the export was refused.
    Export,
    /// A replay could not be prepared or could not stand in for its source.
    Replay,
    /// The harness does not support what was asked for.
    Unsupported,
    /// A harness invariant broke. Always a bug.
    Internal,
}

impl ErrorKind {
    /// The stable tag used in model-visible text and in logs.
    ///
    /// Kept stable deliberately: transcripts and audit records outlive releases.
    pub fn tag(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
            Self::Timeout => "timeout",
            Self::BudgetExhausted => "budget_exhausted",
            Self::PermissionDenied => "permission_denied",
            Self::ApprovalRefused => "approval_refused",
            Self::SandboxDenied => "sandbox_denied",
            Self::PolicyViolation => "policy_violation",
            Self::NotFound => "not_found",
            Self::ToolUnavailable => "tool_unavailable",
            Self::InvalidInput => "invalid_input",
            Self::ContextOverflow => "context_overflow",
            Self::Authentication => "authentication",
            Self::RateLimited => "rate_limited",
            Self::InvalidResponse => "invalid_response",
            Self::Upstream => "upstream",
            Self::Transport => "transport",
            Self::ToolFailed => "tool_failed",
            Self::ChildFailed => "child_failed",
            Self::Io => "io",
            Self::Serialization => "serialization",
            Self::MalformedState => "malformed_state",
            Self::Export => "export",
            Self::Replay => "replay",
            Self::Unsupported => "unsupported",
            Self::Internal => "internal",
        }
    }

    /// The kind a tag names, or `None` for a tag this build does not know.
    pub fn from_tag(tag: &str) -> Option<Self> {
        const ALL: &[ErrorKind] = &[
            ErrorKind::Cancelled,
            ErrorKind::Interrupted,
            ErrorKind::Timeout,
            ErrorKind::BudgetExhausted,
            ErrorKind::PermissionDenied,
            ErrorKind::ApprovalRefused,
            ErrorKind::SandboxDenied,
            ErrorKind::PolicyViolation,
            ErrorKind::NotFound,
            ErrorKind::ToolUnavailable,
            ErrorKind::InvalidInput,
            ErrorKind::ContextOverflow,
            ErrorKind::Authentication,
            ErrorKind::RateLimited,
            ErrorKind::InvalidResponse,
            ErrorKind::Upstream,
            ErrorKind::Transport,
            ErrorKind::ToolFailed,
            ErrorKind::ChildFailed,
            ErrorKind::Io,
            ErrorKind::Serialization,
            ErrorKind::MalformedState,
            ErrorKind::Export,
            ErrorKind::Replay,
            ErrorKind::Unsupported,
            ErrorKind::Internal,
        ];
        ALL.iter().copied().find(|k| k.tag() == tag)
    }

    /// Every kind this build knows, for tests and for exhaustive rendering.
    pub fn all() -> &'static [ErrorKind] {
        const ALL: &[ErrorKind] = &[
            ErrorKind::Cancelled,
            ErrorKind::Interrupted,
            ErrorKind::Timeout,
            ErrorKind::BudgetExhausted,
            ErrorKind::PermissionDenied,
            ErrorKind::ApprovalRefused,
            ErrorKind::SandboxDenied,
            ErrorKind::PolicyViolation,
            ErrorKind::NotFound,
            ErrorKind::ToolUnavailable,
            ErrorKind::InvalidInput,
            ErrorKind::ContextOverflow,
            ErrorKind::Authentication,
            ErrorKind::RateLimited,
            ErrorKind::InvalidResponse,
            ErrorKind::Upstream,
            ErrorKind::Transport,
            ErrorKind::ToolFailed,
            ErrorKind::ChildFailed,
            ErrorKind::Io,
            ErrorKind::Serialization,
            ErrorKind::MalformedState,
            ErrorKind::Export,
            ErrorKind::Replay,
            ErrorKind::Unsupported,
            ErrorKind::Internal,
        ];
        ALL
    }

    /// Whether retrying the identical call could plausibly succeed.
    ///
    /// Deliberately conservative: a denial, a budget stop or bad input will not
    /// become valid on a second attempt, and retrying them wastes budget or, in
    /// the denial case, reads as an attempt to grind down a refusal.
    fn default_retry(self) -> Retry {
        match self {
            Self::Upstream | Self::Transport => Retry::After(Duration::from_millis(500)),
            // A rate limit says "later", and the provider usually says how much
            // later; this is the floor when it does not.
            Self::RateLimited => Retry::After(Duration::from_secs(5)),
            Self::Timeout | Self::Io | Self::Interrupted => Retry::Once,
            // A refusal, a budget, bad input or a bug will not become valid on
            // a second attempt -- and retrying a refusal reads as trying to
            // grind one down.
            Self::Cancelled
            | Self::BudgetExhausted
            | Self::PermissionDenied
            | Self::ApprovalRefused
            | Self::SandboxDenied
            | Self::PolicyViolation
            | Self::NotFound
            | Self::ToolUnavailable
            | Self::InvalidInput
            | Self::ContextOverflow
            | Self::Authentication
            | Self::InvalidResponse
            | Self::ToolFailed
            | Self::ChildFailed
            | Self::Serialization
            | Self::MalformedState
            | Self::Export
            | Self::Replay
            | Self::Unsupported
            | Self::Internal => Retry::Never,
        }
    }

    /// Who needs to see this.
    fn default_audience(self) -> Audience {
        match self {
            // The model can act on these: pick another path, shorten the
            // request, or stop asking for a tool it cannot have.
            Self::PermissionDenied
            | Self::ApprovalRefused
            | Self::SandboxDenied
            | Self::PolicyViolation
            | Self::NotFound
            | Self::ToolUnavailable
            | Self::InvalidInput
            | Self::ContextOverflow
            | Self::ToolFailed
            | Self::ChildFailed
            | Self::Unsupported
            | Self::Timeout => Audience::Model,
            // These end or interrupt the run; the human owns the decision, and
            // several of them are the user's own configuration.
            Self::Cancelled
            | Self::Interrupted
            | Self::BudgetExhausted
            | Self::Upstream
            | Self::Transport
            | Self::Authentication
            | Self::RateLimited
            | Self::Export
            | Self::Replay => Audience::User,
            // Bugs and corrupt state: log them, do not teach the model to route around them.
            Self::Io | Self::Serialization | Self::MalformedState | Self::InvalidResponse => {
                Audience::Internal
            }
            Self::Internal => Audience::Internal,
        }
    }
}

/// Where in a run a failure happened.
///
/// The kind says what went wrong; the stage says what was being attempted, so
/// the same kind can be told apart by the reader who needs to act on it -- an
/// I/O failure writing the journal is not an I/O failure reading a skill.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Stage {
    /// Resolving configuration, providers, project or tools before the run.
    Startup,
    /// Building the request: context, memory, prompt, compaction.
    Context,
    /// Sending a request to a provider.
    Dispatch,
    /// Reading a provider's reply.
    Stream,
    /// Deciding whether a call may run.
    Approval,
    /// Running a tool.
    Tool,
    /// A child run.
    Child,
    /// A background job.
    Job,
    /// Reading or writing the harness's own state.
    Persistence,
    /// Writing or reading an export.
    Export,
    /// Replaying a recorded run.
    Replay,
    /// Ending the run.
    Teardown,
    /// Not attributed. Legacy records read back as this.
    #[default]
    Unknown,
}

impl Stage {
    /// The stage a tag names; an unknown one reads as [`Stage::Unknown`]
    /// rather than failing, because the vocabulary outlives the build.
    pub fn from_tag(tag: &str) -> Self {
        const ALL: &[Stage] = &[
            Stage::Startup,
            Stage::Context,
            Stage::Dispatch,
            Stage::Stream,
            Stage::Approval,
            Stage::Tool,
            Stage::Child,
            Stage::Job,
            Stage::Persistence,
            Stage::Export,
            Stage::Replay,
            Stage::Teardown,
        ];
        ALL.iter().copied().find(|s| s.tag() == tag).unwrap_or(Stage::Unknown)
    }

    pub fn tag(self) -> &'static str {
        match self {
            Self::Startup => "startup",
            Self::Context => "context",
            Self::Dispatch => "dispatch",
            Self::Stream => "stream",
            Self::Approval => "approval",
            Self::Tool => "tool",
            Self::Child => "child",
            Self::Job => "job",
            Self::Persistence => "persistence",
            Self::Export => "export",
            Self::Replay => "replay",
            Self::Teardown => "teardown",
            Self::Unknown => "unknown",
        }
    }
}

/// What a serialized error is written as. A reader that meets a newer version
/// says so rather than guessing at a shape it does not know.
pub const ERROR_WIRE_VERSION: u16 = 1;

/// Longest a message is kept. A provider that echoes the whole request back in
/// its error body must not turn one failure into a copy of the prompt.
const MAX_MESSAGE_CHARS: usize = 600;

/// Remove what must never travel with a failure: credentials, authorization
/// headers, and anything shaped like a key.
///
/// Applied when the error is built, not when it is shown, so there is no path
/// -- a log, an export, a serialized cause -- where the raw text still exists.
/// Conservative by construction: it drops the value after a marker rather than
/// trying to recognise every key format in the world.
pub fn scrub(text: &str) -> String {
    // A marker names a credential; whatever follows it, up to the next
    // separator, is the credential.
    const MARKERS: &[&str] = &[
        "authorization:",
        "authorization\":",
        "x-api-key:",
        "x-api-key\":",
        "api_key\":",
        "api_key=",
        "api-key:",
        "apikey\":",
        "bearer ",
        "token\":",
        "token=",
        "password\":",
        "password=",
        "secret\":",
        "secret=",
    ];
    // Where a credential ends. A space is not one: `Authorization: Bearer x`
    // puts the value after a space, and stopping there would keep it.
    const SEPARATORS: &[char] = &['\n', '\r', ',', '"', '}', ')', '&', ';'];
    // Between a marker and its value: whitespace and the quote that opens it.
    const PADDING: &[char] = &[' ', '\t', '"', '\''];

    let chars: Vec<char> = text.chars().collect();
    let lower: Vec<char> = text.to_ascii_lowercase().chars().collect();
    let mut out = String::with_capacity(chars.len());
    let mut i = 0usize;
    'outer: while i < chars.len() {
        for marker in MARKERS {
            let m: Vec<char> = marker.chars().collect();
            if i + m.len() <= lower.len() && lower[i..i + m.len()] == m[..] {
                out.extend(chars[i..i + m.len()].iter());
                out.push_str("[redacted]");
                i += m.len();
                // Skip what separates the marker from its value, then the
                // value, then the quote that closed it.
                while i < chars.len() && PADDING.contains(&chars[i]) {
                    i += 1;
                }
                while i < chars.len() && !SEPARATORS.contains(&chars[i]) {
                    i += 1;
                }
                if i < chars.len() && chars[i] == '"' {
                    i += 1;
                }
                continue 'outer;
            }
        }
        // A bare key, wherever it appears: providers put them in prose.
        if i + 12 <= chars.len() && lower[i..].starts_with(&['s', 'k', '-']) {
            out.push_str("[redacted]");
            while i < chars.len() && !SEPARATORS.contains(&chars[i]) && chars[i] != ' ' {
                i += 1;
            }
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    if out.chars().count() > MAX_MESSAGE_CHARS {
        let kept: String = out.chars().take(MAX_MESSAGE_CHARS).collect();
        return format!("{kept} [...]");
    }
    out
}

/// Whether and how soon a failed operation may be retried.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Retry {
    /// Retrying cannot help.
    Never,
    /// One immediate retry is worth attempting.
    Once,
    /// Retry after at least this delay, subject to the caller's backoff policy.
    After(Duration),
}

impl Retry {
    /// Whether any retry is permitted.
    pub fn is_allowed(self) -> bool {
        !matches!(self, Self::Never)
    }
}

/// Who a failure is addressed to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Audience {
    /// Returned to the model as a tool result so it can adapt.
    Model,
    /// Surfaced to the human driving the run.
    User,
    /// Logged only.
    Internal,
}

/// A classified harness failure.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub struct HarnessError {
    kind: ErrorKind,
    stage: Stage,
    message: String,
    retry: Retry,
    audience: Audience,
    /// What caused this, if it was caused by something classified. Kept so a
    /// reader can see the chain without every layer having to re-word it.
    cause: Option<Box<HarnessError>>,
}

impl HarnessError {
    /// Builds an error with the classification its kind implies.
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            stage: Stage::Unknown,
            message: scrub(&message.into()),
            retry: kind.default_retry(),
            audience: kind.default_audience(),
            cause: None,
        }
    }

    /// Says where this happened.
    pub fn at(mut self, stage: Stage) -> Self {
        self.stage = stage;
        self
    }

    /// Records what caused this.
    pub fn caused_by(mut self, cause: HarnessError) -> Self {
        self.cause = Some(Box::new(cause));
        self
    }

    pub fn stage(&self) -> Stage {
        self.stage
    }

    pub fn cause(&self) -> Option<&HarnessError> {
        self.cause.as_deref()
    }

    /// This failure and everything under it, outermost first.
    pub fn chain(&self) -> Vec<&HarnessError> {
        let mut out = vec![self];
        let mut here = self;
        while let Some(next) = here.cause() {
            out.push(next);
            here = next;
        }
        out
    }

    /// The error as it goes on the wire or into a record: versioned, scrubbed,
    /// and carrying the whole chain.
    pub fn to_wire(&self) -> serde_json::Value {
        let mut value = serde_json::json!({
            "v": ERROR_WIRE_VERSION,
            "kind": self.kind.tag(),
            "stage": self.stage.tag(),
            "message": self.message,
            "retryable": self.retry.is_allowed(),
            "audience": match self.audience {
                Audience::Model => "model",
                Audience::User => "user",
                Audience::Internal => "internal",
            },
        });
        if let Retry::After(delay) = self.retry {
            value["retryAfterMs"] = serde_json::json!(delay.as_millis() as u64);
        }
        if let Some(cause) = self.cause() {
            value["cause"] = cause.to_wire();
        }
        value
    }

    /// Read back what [`to_wire`](Self::to_wire) wrote.
    ///
    /// A version this build does not know is refused rather than guessed at. A
    /// *kind* it does not know is not: the vocabulary grows, and a record from
    /// a newer build must still be readable as "something went wrong here".
    pub fn from_wire(value: &serde_json::Value) -> Result<Self, HarnessError> {
        let v = value.get("v").and_then(serde_json::Value::as_u64).unwrap_or(0);
        if v == 0 || v > u64::from(ERROR_WIRE_VERSION) {
            return Err(HarnessError::new(
                ErrorKind::MalformedState,
                format!("error record version {v} is not one this build reads"),
            ));
        }
        let tag = value.get("kind").and_then(serde_json::Value::as_str).unwrap_or_default();
        let kind = ErrorKind::from_tag(tag).unwrap_or(ErrorKind::Internal);
        let message = value
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("an unreadable failure")
            .to_string();
        let mut error = HarnessError::new(kind, message);
        if ErrorKind::from_tag(tag).is_none() && !tag.is_empty() {
            // Keep what it said it was, so a newer kind reads as itself rather
            // than as an internal bug.
            error.message = scrub(&format!("[{tag}] {}", error.message));
        }
        if let Some(stage) = value.get("stage").and_then(serde_json::Value::as_str) {
            error.stage = Stage::from_tag(stage);
        }
        if let Some(cause) = value.get("cause") {
            error.cause = Some(Box::new(HarnessError::from_wire(cause)?));
        }
        Ok(error)
    }

    /// Overrides retryability, for a call site that knows better than the kind.
    ///
    /// The common case is an upstream error whose provider sent `Retry-After`.
    pub fn with_retry(mut self, retry: Retry) -> Self {
        self.retry = retry;
        self
    }

    /// Overrides the audience.
    pub fn with_audience(mut self, audience: Audience) -> Self {
        self.audience = audience;
        self
    }

    pub fn kind(&self) -> ErrorKind {
        self.kind
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn retry(&self) -> Retry {
        self.retry
    }

    pub fn audience(&self) -> Audience {
        self.audience
    }

    /// The status a command ends with when this failure ends it.
    ///
    /// Follows `sysexits.h`, which is what a shell script reading an exit code
    /// expects, so a caller can tell "your key is wrong" from "the provider is
    /// down" from "I stopped it" without parsing the message. Stable: scripts
    /// outlive releases.
    ///
    /// * 130 -- stopped (the shell's convention for an interrupted command)
    /// * 64 `EX_USAGE` -- the request was wrong
    /// * 66 `EX_NOINPUT` -- something named does not exist
    /// * 69 `EX_UNAVAILABLE` -- the provider or a tool was not available
    /// * 70 `EX_SOFTWARE` -- the work failed on its own terms, or a bug
    /// * 74 `EX_IOERR` -- the filesystem
    /// * 75 `EX_TEMPFAIL` -- try again later
    /// * 76 `EX_PROTOCOL` -- the answer could not be read
    /// * 77 `EX_NOPERM` -- refused, denied, or a rejected credential
    pub fn exit_code(&self) -> i32 {
        match self.kind {
            ErrorKind::Cancelled => 130,
            ErrorKind::InvalidInput | ErrorKind::ContextOverflow | ErrorKind::Unsupported => 64,
            ErrorKind::NotFound => 66,
            ErrorKind::Upstream
            | ErrorKind::Transport
            | ErrorKind::ToolUnavailable
            | ErrorKind::RateLimited => 69,
            ErrorKind::ToolFailed
            | ErrorKind::ChildFailed
            | ErrorKind::Export
            | ErrorKind::Replay
            | ErrorKind::Internal => 70,
            ErrorKind::Io => 74,
            ErrorKind::Timeout | ErrorKind::Interrupted | ErrorKind::BudgetExhausted => 75,
            ErrorKind::InvalidResponse
            | ErrorKind::Serialization
            | ErrorKind::MalformedState => 76,
            ErrorKind::Authentication
            | ErrorKind::PermissionDenied
            | ErrorKind::ApprovalRefused
            | ErrorKind::SandboxDenied
            | ErrorKind::PolicyViolation => 77,
        }
    }

    /// Whether this is a cancellation rather than a failure.
    ///
    /// Callers use this to unwind quietly: a cancelled run has not gone wrong,
    /// and reporting it as a failure is how a cancel ends up looking like a bug.
    pub fn is_cancellation(&self) -> bool {
        self.kind == ErrorKind::Cancelled
    }

    /// The text handed back to the model as a tool result.
    ///
    /// The `ERROR [tag]:` shape matches what the existing loop already emits, so
    /// migrating a call site onto this type does not change what the model sees.
    pub fn model_message(&self) -> String {
        format!("ERROR [{}]: {}", self.kind.tag(), self.message)
    }

    pub fn cancelled(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Cancelled, message)
    }

    pub fn denied(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::PermissionDenied, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Internal, message)
    }

    /// A failure that came back as prose from a layer that does not classify
    /// its own errors yet. Kept readable rather than guessed at.
    pub fn legacy(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Internal, message).with_audience(Audience::User)
    }
}

/// A failure crosses a command boundary as its wire form: versioned, scrubbed,
/// carrying its kind, stage and cause, so the surface on the other side reads
/// the classification instead of the words (AH-009).
impl Serialize for HarnessError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_wire().serialize(serializer)
    }
}

impl fmt::Display for HarnessError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.kind.tag(), self.message)
    }
}

impl From<std::io::Error> for HarnessError {
    fn from(error: std::io::Error) -> Self {
        // An interrupted or aborted read is a cancellation, not an I/O fault;
        // classifying it as I/O would make every cancel look like a disk error.
        let kind = match error.kind() {
            std::io::ErrorKind::NotFound => ErrorKind::NotFound,
            std::io::ErrorKind::PermissionDenied => ErrorKind::PermissionDenied,
            std::io::ErrorKind::TimedOut => ErrorKind::Timeout,
            std::io::ErrorKind::Interrupted => ErrorKind::Cancelled,
            _ => ErrorKind::Io,
        };
        Self::new(kind, error.to_string())
    }
}

/// Prose from a layer that does not classify its own failures.
///
/// One place translates, so no call site further down decides what a failure
/// means by reading it. Everything downstream of this reads [`ErrorKind`].
/// The upstream layer is what produces prose today; an unrecognised message
/// becomes a provider failure that is never retried, which is the safe end of
/// every decision that follows.
impl From<String> for HarnessError {
    fn from(text: String) -> Self {
        classify_upstream(&text)
    }
}

impl From<&str> for HarnessError {
    fn from(text: &str) -> Self {
        classify_upstream(text)
    }
}

impl From<serde_json::Error> for HarnessError {
    fn from(error: serde_json::Error) -> Self {
        Self::new(ErrorKind::Serialization, error.to_string())
    }
}

/// Classify a provider failure from the text the upstream layer returns.
///
/// One place decides what a provider failure means, because the decisions that
/// follow -- retry, fail over to the next provider, tell the user, tell the
/// model -- have to agree. The order matters: anything the provider *answered*
/// is a decision of its own and is classified first, so an outage word inside a
/// refusal ("403 Forbidden (connection refused by policy)") cannot turn a
/// refusal into an outage.
pub fn classify_upstream(error: &str) -> HarnessError {
    classify_upstream_at(error, Stage::Dispatch)
}

/// [`classify_upstream`], saying where the failure happened.
pub fn classify_upstream_at(error: &str, stage: Stage) -> HarnessError {
    let text = error.to_ascii_lowercase();
    let has = |markers: &[&str]| markers.iter().any(|m| text.contains(m));
    let made = |kind: ErrorKind| HarnessError::new(kind, error).at(stage);

    if has(&["cancelled", "canceled", "aborted", "stopped by the user"]) {
        return made(ErrorKind::Cancelled);
    }
    // A credential the provider rejected is the user's configuration, not the
    // gate refusing a call and not an outage. Told apart from a permission
    // refusal because the two are fixed in different places.
    if has(&["401", "invalid api key", "invalid_api_key", "unauthorized", "authentication"]) {
        return made(ErrorKind::Authentication);
    }
    if has(&["403", "forbidden", "permission"]) {
        return made(ErrorKind::PermissionDenied);
    }
    if has(&["429", "rate limit", "rate_limit", "too many requests", "quota"]) {
        let mut limited = made(ErrorKind::RateLimited);
        if let Some(delay) = retry_after(&text) {
            limited = limited.with_retry(Retry::After(delay));
        }
        return limited;
    }
    if has(&["context-overflow", "context length", "context window", "too many tokens", "prompt is too long"]) {
        // The request does not fit. A different provider with the same window
        // would refuse it too, so this is the request, not an outage.
        return made(ErrorKind::ContextOverflow);
    }
    if has(&["unsupported", "not supported", "does not support"]) {
        return made(ErrorKind::Unsupported);
    }
    if has(&["400", "422", "invalid request", "malformed request"]) {
        return made(ErrorKind::InvalidInput);
    }
    // The provider answered, but not in a shape that can be read. Never worth
    // another provider's attempt: part of the reply may already be on screen.
    if has(&[
        "unexpected end of stream",
        "stream ended",
        "invalid chunk",
        "could not parse",
        "invalid json",
        "malformed response",
    ]) {
        return made(ErrorKind::InvalidResponse);
    }
    if has(&["timed out", "timeout"]) {
        return made(ErrorKind::Timeout);
    }
    if has(&[
        "error sending request",
        "connection refused",
        "connection reset",
        "connect error",
        "dns error",
        "failed to lookup",
        "no route to host",
        "network is unreachable",
    ]) {
        return made(ErrorKind::Transport);
    }
    if has(&["500", "502", "503", "504", "server error", "bad gateway", "service unavailable"]) {
        return made(ErrorKind::Upstream);
    }
    // Unrecognised: treated as the provider's own failure rather than as a
    // transport fault, because a fault we cannot name must not silently earn a
    // second provider's attempt.
    made(ErrorKind::Upstream).with_retry(Retry::Never)
}

/// The delay a provider asked for, from a `retry-after` header echoed into the
/// error text. Seconds only: the HTTP-date form is not worth guessing at.
fn retry_after(lowered: &str) -> Option<std::time::Duration> {
    let at = lowered.find("retry-after")?;
    let rest = &lowered[at + "retry-after".len()..];
    let digits: String = rest
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(char::is_ascii_digit)
        .collect();
    let seconds: u64 = digits.parse().ok()?;
    (seconds > 0 && seconds <= 3600).then(|| Duration::from_secs(seconds))
}

/// Whether a failed request may be tried on a *different* provider (AH-193).
///
/// Only a failure that says the request never reached a model and produced
/// nothing: a transport fault, a deadline, a rate limit, or a gateway that
/// answered for one. Everything else stays where it happened --
///
/// * a rejected credential or a refusal is the configuration, and a second
///   provider would not make the first one right;
/// * a request that does not fit a window does not fit another one either;
/// * a reply that arrived malformed may already have put text on the screen,
///   so sending the same request again could duplicate it;
/// * a failure nobody classified must not quietly earn a second attempt.
pub fn may_try_another_provider(error: &str) -> bool {
    may_try_another(&classify_upstream(error))
}

/// [`may_try_another_provider`], for a failure that is already classified.
pub fn may_try_another(classified: &HarnessError) -> bool {
    match classified.kind() {
        ErrorKind::Transport | ErrorKind::Timeout | ErrorKind::RateLimited => true,
        ErrorKind::Upstream => classified.retry().is_allowed(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every kind this build knows can be written down and read back, and no
    /// two of them share a tag. The tags outlive the build that wrote them.
    #[test]
    fn every_kind_round_trips_through_its_tag() {
        for kind in ErrorKind::all() {
            assert_eq!(ErrorKind::from_tag(kind.tag()), Some(*kind), "{kind:?}");
        }
        assert_eq!(ErrorKind::all().len(), 26, "a kind was added without a tag or a test");
        assert_eq!(ErrorKind::from_tag("something_new"), None);
    }

    /// A failure is written down versioned, with its stage and its cause, and
    /// reads back as itself. A record from a newer build is refused rather than
    /// guessed at; a *kind* from a newer build is kept readable, because the
    /// vocabulary grows and an old reader must still see what happened.
    #[test]
    fn a_failure_survives_being_written_down() {
        let error = HarnessError::new(ErrorKind::ChildFailed, "the child stopped")
            .at(Stage::Child)
            .caused_by(
                HarnessError::new(ErrorKind::RateLimited, "429 Too Many Requests")
                    .at(Stage::Dispatch)
                    .with_retry(Retry::After(Duration::from_secs(30))),
            );
        let wire = error.to_wire();
        assert_eq!(wire["v"], ERROR_WIRE_VERSION);
        assert_eq!(wire["kind"], "child_failed");
        assert_eq!(wire["stage"], "child");
        assert_eq!(wire["cause"]["kind"], "rate_limited");
        assert_eq!(wire["cause"]["retryAfterMs"], 30_000);

        let back = HarnessError::from_wire(&wire).expect("reads back");
        assert_eq!(back.kind(), ErrorKind::ChildFailed);
        assert_eq!(back.stage(), Stage::Child);
        assert_eq!(back.chain().len(), 2, "the cause was lost");
        assert_eq!(back.cause().unwrap().kind(), ErrorKind::RateLimited);

        // A newer envelope version is a typed refusal.
        let newer = serde_json::json!({ "v": 99, "kind": "upstream", "message": "x" });
        assert_eq!(
            HarnessError::from_wire(&newer).unwrap_err().kind(),
            ErrorKind::MalformedState
        );
        // A newer *kind* stays readable and says what it called itself.
        let unknown = serde_json::json!({ "v": 1, "kind": "quantum_flux", "message": "odd" });
        let read = HarnessError::from_wire(&unknown).expect("an unknown kind still reads");
        assert!(read.message().contains("quantum_flux"), "{}", read.message());
        // And a stage this build does not know is unknown, not an error.
        let odd_stage = serde_json::json!({ "v": 1, "kind": "io", "message": "x", "stage": "moon" });
        assert_eq!(HarnessError::from_wire(&odd_stage).unwrap().stage(), Stage::Unknown);
    }

    /// A failure must be safe to keep. Whatever a provider echoes back -- an
    /// authorization header, a key in prose, a query string -- the error that
    /// carries it does not, and it is gone before the value exists rather than
    /// only when it is displayed.
    #[test]
    fn a_failure_never_carries_a_credential() {
        let hostile = "401 from https://api.example.com/v1?api_key=sk-live-9f8a7b6c5d4e3f2a1b0c \
            (sent Authorization: Bearer sk-live-9f8a7b6c5d4e, x-api-key: abcd1234efgh5678) \
            body={\"api_key\": \"sk-live-zzzz1111yyyy2222\", \"password\": \"hunter2\"}";
        let error = classify_upstream(hostile);
        for secret in [
            "sk-live-9f8a7b6c5d4e3f2a1b0c",
            "sk-live-9f8a7b6c5d4e",
            "abcd1234efgh5678",
            "sk-live-zzzz1111yyyy2222",
            "hunter2",
        ] {
            assert!(!error.message().contains(secret), "{secret} survived: {}", error.message());
            assert!(
                !error.to_wire().to_string().contains(secret),
                "{secret} survived serialization"
            );
            assert!(!error.model_message().contains(secret), "{secret} reached the model");
        }
        // What is left still says what happened.
        assert_eq!(error.kind(), ErrorKind::Authentication);
        assert!(error.message().contains("401"), "{}", error.message());

        // A provider that echoes the whole prompt back does not turn one
        // failure into a copy of it.
        let huge = HarnessError::new(ErrorKind::Upstream, "x".repeat(5_000));
        assert!(huge.message().chars().count() <= MAX_MESSAGE_CHARS + 6);
    }

    /// Adversarial: a provider cannot talk the chain into a second attempt by
    /// describing its refusal in outage words, and cannot talk it out of one by
    /// putting a refusal word in an outage. The decision is the kind, and the
    /// kind is decided answered-first.
    #[test]
    fn misleading_error_text_cannot_move_the_fallback_decision() {
        for refusal in [
            "403 Forbidden: connection refused by policy",
            "401 Unauthorized -- upstream timed out waiting for your key",
            "400 Bad Request: the gateway is unavailable for this model",
            "This model's maximum context length is 8192 tokens (connection reset)",
            "unsupported tool schema; error sending request was logged",
            "the run was cancelled -- 503 Service Unavailable",
            "unexpected end of stream after 200 OK",
            "an unclassifiable disturbance",
        ] {
            assert!(!may_try_another_provider(refusal), "{refusal:?} earned another provider");
        }
        for outage in [
            "error sending request for url (http://host/v1/chat/completions)",
            "dns error: failed to lookup address information",
            "upstream returned 503 Service Unavailable",
            "the request timed out",
            "429 Too Many Requests, retry-after: 12",
        ] {
            assert!(may_try_another_provider(outage), "{outage:?} was stranded");
        }
        // A rate limit says how long to wait when the provider does.
        let limited = classify_upstream("429 Too Many Requests, retry-after: 12");
        assert_eq!(limited.retry(), Retry::After(Duration::from_secs(12)));
        // ... and falls back to its own floor when it does not.
        assert_eq!(
            classify_upstream("rate limit exceeded").retry(),
            Retry::After(Duration::from_secs(5))
        );
    }

    /// Every kind ends a command with a status a script can act on, and a
    /// stop is never reported as a failure of the work.
    #[test]
    fn every_kind_has_an_exit_status() {
        for kind in ErrorKind::all() {
            let code = HarnessError::new(*kind, "x").exit_code();
            assert!((64..=130).contains(&code), "{kind:?} exits {code}");
        }
        assert_eq!(HarnessError::cancelled("escape").exit_code(), 130);
        assert_eq!(classify_upstream("401 Unauthorized").exit_code(), 77);
        assert_eq!(classify_upstream("error sending request").exit_code(), 69);
        assert_eq!(
            classify_upstream("This model's maximum context length is 8192 tokens").exit_code(),
            64
        );
    }

    /// A refusal and a cancellation are not failures, and nothing downstream
    /// may render them as one.
    #[test]
    fn a_refusal_and_a_stop_are_not_failures() {
        let stopped = HarnessError::cancelled("the user pressed escape");
        assert!(stopped.is_cancellation());
        assert!(!stopped.retry().is_allowed());
        let refused = HarnessError::new(ErrorKind::ApprovalRefused, "the user said no");
        assert!(!refused.is_cancellation(), "a refusal is not a stop");
        assert!(!refused.retry().is_allowed(), "a refusal must not be ground down");
        assert_eq!(refused.audience(), Audience::Model, "the model should pick another path");
        // An interruption is neither: nobody decided it.
        let cut = HarnessError::new(ErrorKind::Interrupted, "the host went away");
        assert!(!cut.is_cancellation());
        assert_eq!(cut.retry(), Retry::Once);
    }

    /// AH-193 reads its decision from here, so the two cannot drift.
    #[test]
    fn only_a_provider_that_never_answered_earns_another_one() {
        for unreachable in [
            "Upstream request failed: error sending request for url (http://host/v1/chat/completions)",
            "connection refused",
            "dns error: failed to lookup address information",
            "upstream returned 503 Service Unavailable",
            "the request timed out",
        ] {
            assert!(may_try_another_provider(unreachable), "{unreachable:?}");
        }
        for answered in [
            "401 Unauthorized: invalid api key",
            "403 Forbidden",
            "This model's maximum context length is 8192 tokens",
            "the run was cancelled by the user",
            "400 Bad Request: unsupported tool schema",
            "403 Forbidden (connection refused by policy)",
            "something nobody has seen before",
        ] {
            assert!(!may_try_another_provider(answered), "{answered:?}");
        }
    }

    /// The classification drives what the surfaces do with a failure.
    #[test]
    fn a_provider_failure_says_what_it_is_and_who_should_see_it() {
        // A rejected credential is the user's configuration, not the gate
        // refusing a call: told apart because they are fixed in different
        // places, and neither is retried.
        let denied = classify_upstream("401 Unauthorized");
        assert_eq!(denied.kind(), ErrorKind::Authentication);
        assert!(!denied.retry().is_allowed(), "a rejected key is not retried");
        assert_eq!(denied.audience(), Audience::User);
        assert_eq!(classify_upstream("403 Forbidden").kind(), ErrorKind::PermissionDenied);

        let outage = classify_upstream("502 Bad Gateway");
        assert_eq!(outage.kind(), ErrorKind::Upstream);
        assert!(outage.retry().is_allowed());
        assert_eq!(outage.audience(), Audience::User);

        let stopped = classify_upstream("the run was cancelled");
        assert!(stopped.is_cancellation());
        assert!(!stopped.retry().is_allowed());

        let too_big = classify_upstream("This model's maximum context length is 8192 tokens");
        assert_eq!(too_big.kind(), ErrorKind::ContextOverflow);
        assert_eq!(too_big.audience(), Audience::Model, "the model can shorten it");

        // The tag travels with the message the model is given.
        assert!(denied.model_message().starts_with("ERROR [authentication]:"));
    }

    #[test]
    fn tags_are_unique_across_kinds() {
        let kinds = [
            ErrorKind::Cancelled,
            ErrorKind::Timeout,
            ErrorKind::BudgetExhausted,
            ErrorKind::PermissionDenied,
            ErrorKind::PolicyViolation,
            ErrorKind::NotFound,
            ErrorKind::InvalidInput,
            ErrorKind::Upstream,
            ErrorKind::Transport,
            ErrorKind::Io,
            ErrorKind::Serialization,
            ErrorKind::Unsupported,
            ErrorKind::Internal,
        ];
        let tags: std::collections::HashSet<_> = kinds.iter().map(|k| k.tag()).collect();
        assert_eq!(tags.len(), kinds.len());
    }

    #[test]
    fn denials_and_budget_stops_are_never_retried() {
        for kind in [
            ErrorKind::PermissionDenied,
            ErrorKind::PolicyViolation,
            ErrorKind::BudgetExhausted,
            ErrorKind::Cancelled,
            ErrorKind::InvalidInput,
        ] {
            assert_eq!(
                HarnessError::new(kind, "no").retry(),
                Retry::Never,
                "{kind:?} should not be retryable"
            );
        }
    }

    #[test]
    fn transient_upstream_failures_are_retried_with_a_delay() {
        let error = HarnessError::new(ErrorKind::Upstream, "503");
        assert!(matches!(error.retry(), Retry::After(_)));
        assert!(error.retry().is_allowed());
    }

    #[test]
    fn a_provider_delay_overrides_the_default() {
        let error = HarnessError::new(ErrorKind::Upstream, "429")
            .with_retry(Retry::After(Duration::from_secs(30)));
        assert_eq!(error.retry(), Retry::After(Duration::from_secs(30)));
    }

    #[test]
    fn model_facing_errors_keep_the_existing_wire_shape() {
        let error = HarnessError::denied("write to /etc/hosts");
        assert_eq!(error.model_message(), "ERROR [permission_denied]: write to /etc/hosts");
        assert_eq!(error.audience(), Audience::Model);
    }

    #[test]
    fn internal_failures_are_not_taught_to_the_model() {
        for kind in [ErrorKind::Internal, ErrorKind::Io, ErrorKind::Serialization] {
            assert_eq!(HarnessError::new(kind, "x").audience(), Audience::Internal);
        }
    }

    #[test]
    fn cancellation_is_distinguishable_from_failure() {
        assert!(HarnessError::cancelled("user pressed escape").is_cancellation());
        assert!(!HarnessError::internal("bug").is_cancellation());
    }

    #[test]
    fn io_errors_are_classified_rather_than_flattened() {
        use std::io::{Error, ErrorKind as Io};
        let cases = [
            (Io::NotFound, ErrorKind::NotFound),
            (Io::PermissionDenied, ErrorKind::PermissionDenied),
            (Io::TimedOut, ErrorKind::Timeout),
            (Io::Interrupted, ErrorKind::Cancelled),
            (Io::Other, ErrorKind::Io),
        ];
        for (io_kind, expected) in cases {
            let error: HarnessError = Error::new(io_kind, "boom").into();
            assert_eq!(error.kind(), expected, "{io_kind:?}");
        }
    }

    #[test]
    fn malformed_json_becomes_a_serialization_error() {
        let error: HarnessError = serde_json::from_str::<u32>("not json").unwrap_err().into();
        assert_eq!(error.kind(), ErrorKind::Serialization);
    }
}
