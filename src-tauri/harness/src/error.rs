//! The harness error taxonomy (AHD-004).
//!
//! The orchestration loop is `Result<_, String>` end to end today, with error
//! classes smuggled through prose prefixes such as `"ERROR [ask_cancelled]: ..."`
//! that callers substring-match. That makes three things impossible: deciding
//! retryability from the error, deciding who should see it, and testing either.
//!
//! [`HarnessError`] carries the classification on the value. Retry policy
//! (`AH-024`, `AH-025`) reads [`HarnessError::retry`] instead of re-deriving it
//! per call site, and surfaces read [`HarnessError::audience`] instead of
//! guessing whether a failure belongs in the transcript.

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

#[cfg(test)]
mod tests {
    use super::*;

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
