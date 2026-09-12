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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// The user or the harness cancelled the work. Never an error to report as a failure.
    Cancelled,
    /// A deadline expired.
    Timeout,
    /// A token, step or wall-clock budget was exhausted.
    BudgetExhausted,
    /// The permission gate denied the call.
    PermissionDenied,
    /// The call was structurally forbidden, for example a write in plan mode.
    PolicyViolation,
    /// The named resource does not exist.
    NotFound,
    /// The caller supplied something malformed.
    InvalidInput,
    /// The model provider failed.
    Upstream,
    /// The network or transport failed before a provider could answer.
    Transport,
    /// The filesystem failed.
    Io,
    /// Data on disk or on the wire could not be understood.
    Serialization,
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
            Self::Timeout => "timeout",
            Self::BudgetExhausted => "budget_exhausted",
            Self::PermissionDenied => "permission_denied",
            Self::PolicyViolation => "policy_violation",
            Self::NotFound => "not_found",
            Self::InvalidInput => "invalid_input",
            Self::Upstream => "upstream",
            Self::Transport => "transport",
            Self::Io => "io",
            Self::Serialization => "serialization",
            Self::Unsupported => "unsupported",
            Self::Internal => "internal",
        }
    }

    /// Whether retrying the identical call could plausibly succeed.
    ///
    /// Deliberately conservative: a denial, a budget stop or bad input will not
    /// become valid on a second attempt, and retrying them wastes budget or, in
    /// the denial case, reads as an attempt to grind down a refusal.
    fn default_retry(self) -> Retry {
        match self {
            Self::Upstream | Self::Transport => Retry::After(Duration::from_millis(500)),
            Self::Timeout | Self::Io => Retry::Once,
            Self::Cancelled
            | Self::BudgetExhausted
            | Self::PermissionDenied
            | Self::PolicyViolation
            | Self::NotFound
            | Self::InvalidInput
            | Self::Serialization
            | Self::Unsupported
            | Self::Internal => Retry::Never,
        }
    }

    /// Who needs to see this.
    fn default_audience(self) -> Audience {
        match self {
            // The model can act on these: pick another path, or stop.
            Self::PermissionDenied
            | Self::PolicyViolation
            | Self::NotFound
            | Self::InvalidInput
            | Self::Unsupported
            | Self::Timeout => Audience::Model,
            // These end or interrupt the run; the human owns the decision.
            Self::Cancelled | Self::BudgetExhausted | Self::Upstream | Self::Transport => Audience::User,
            // Bugs and corrupt state: log them, do not teach the model to route around them.
            Self::Io | Self::Serialization | Self::Internal => Audience::Internal,
        }
    }
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
    message: String,
    retry: Retry,
    audience: Audience,
}

impl HarnessError {
    /// Builds an error with the classification its kind implies.
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            retry: kind.default_retry(),
            audience: kind.default_audience(),
        }
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
    let text = error.to_ascii_lowercase();
    let has = |markers: &[&str]| markers.iter().any(|m| text.contains(m));

    if has(&["cancelled", "canceled", "aborted", "stopped by the user"]) {
        return HarnessError::new(ErrorKind::Cancelled, error);
    }
    if has(&["401", "403", "invalid api key", "unauthorized", "permission"]) {
        return HarnessError::new(ErrorKind::PermissionDenied, error);
    }
    if has(&["context length", "context window", "too many tokens"]) {
        // The model cannot take this request; a different provider with the
        // same window would refuse it too, so this is input, not an outage.
        return HarnessError::new(ErrorKind::InvalidInput, error);
    }
    if has(&["unsupported", "not supported"]) {
        return HarnessError::new(ErrorKind::Unsupported, error);
    }
    if has(&["400", "422", "invalid request", "malformed"]) {
        return HarnessError::new(ErrorKind::InvalidInput, error);
    }
    if has(&["timed out", "timeout"]) {
        return HarnessError::new(ErrorKind::Timeout, error);
    }
    if has(&[
        "error sending request",
        "connection refused",
        "connection reset",
        "connect error",
        "dns error",
        "failed to lookup",
        "no route to host",
    ]) {
        return HarnessError::new(ErrorKind::Transport, error);
    }
    if has(&["500", "502", "503", "504", "server error", "bad gateway"]) {
        return HarnessError::new(ErrorKind::Upstream, error);
    }
    // Unrecognised: treated as the provider's own failure rather than as a
    // transport fault, because a fault we cannot name must not silently earn a
    // second provider's attempt.
    HarnessError::new(ErrorKind::Upstream, error).with_retry(Retry::Never)
}

/// Whether a failed request may be tried on a *different* provider (AH-193).
///
/// Only a failure that says the request never reached a model: a transport
/// fault, or a gateway that answered for one. Anything else -- a refusal, bad
/// input, a cancellation, an unrecognised failure -- stays where it happened.
pub fn may_try_another_provider(error: &str) -> bool {
    matches!(
        classify_upstream(error).kind(),
        ErrorKind::Transport | ErrorKind::Timeout
    ) || (classify_upstream(error).kind() == ErrorKind::Upstream
        && classify_upstream(error).retry().is_allowed())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let denied = classify_upstream("401 Unauthorized");
        assert_eq!(denied.kind(), ErrorKind::PermissionDenied);
        assert!(!denied.retry().is_allowed(), "a rejected key is not retried");
        assert_eq!(denied.audience(), Audience::Model);

        let outage = classify_upstream("502 Bad Gateway");
        assert_eq!(outage.kind(), ErrorKind::Upstream);
        assert!(outage.retry().is_allowed());
        assert_eq!(outage.audience(), Audience::User);

        let stopped = classify_upstream("the run was cancelled");
        assert!(stopped.is_cancellation());
        assert!(!stopped.retry().is_allowed());

        let too_big = classify_upstream("This model's maximum context length is 8192 tokens");
        assert_eq!(too_big.kind(), ErrorKind::InvalidInput);
        assert_eq!(too_big.audience(), Audience::Model, "the model can shorten it");

        // The tag travels with the message the model is given.
        assert!(denied.model_message().starts_with("ERROR [permission_denied]:"));
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
