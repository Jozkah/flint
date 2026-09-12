//! The identifiers the harness stores things under, validated. AH-008.
//!
//! Session, run, invocation, job, agent and snapshot ids arrive from five
//! places -- the renderer over IPC, the CLI's flags, a resumed thread on disk,
//! an imported bundle, and a provider's own reply -- and end up naming files,
//! keys in a record, and the rows a person is shown. Until now each was an
//! ordinary `String` that every layer re-checked, or did not.
//!
//! What a validated id is for, concretely:
//!
//! * **Nothing crosses into storage unparsed.** An id with a path separator, a
//!   control character, a `..`, or no length at all is refused at the boundary
//!   with a typed error (AH-009) rather than sanitised into something else and
//!   written.
//! * **A provider's id is not a Jan id.** Two different requests can carry the
//!   same `chatcmpl-...`; adopting one as an invocation would make two requests
//!   one. Provider strings stay in payloads, never in these types.
//! * **Parentage is checked, not believed.** A child run must name a parent in
//!   the same session, and nothing may claim to be its own parent.
//! * **A display name is not an identity.** These types hold ids; labels live
//!   beside them and are never parsed back into one.
//!
//! The spellings themselves are the ones Phases 1-4 already write, because
//! records on disk outlive a refactor: a session is whatever the surface calls
//! its conversation (a uuid on the desktop, a thread id on the CLI), a run is
//! `<session>#run-<minted>` or `run-<minted>`, an invocation is `<run>#<n>` or
//! the renderer's `inv-<minted>`.

use serde::{Deserialize, Serialize};

use crate::harness_error::{ErrorKind, HarnessError, Stage};

/// Longest an id may be. Long enough for a uuid session plus a run and a step,
/// short enough that a record's keys stay readable and bounded.
pub const MAX_ID_CHARS: usize = 200;

/// What an id names. Kept on the error so a refusal says which one was wrong.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum IdKind {
    Session,
    Run,
    Invocation,
    Job,
    Agent,
    Snapshot,
}

impl IdKind {
    pub fn tag(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Run => "run",
            Self::Invocation => "invocation",
            Self::Job => "job",
            Self::Agent => "agent",
            Self::Snapshot => "snapshot",
        }
    }
}

/// Why an id was refused. Named rather than described, so a caller can act on
/// it and a test can be sure which rule fired.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    Empty,
    TooLong,
    ControlCharacter,
    PathSeparator,
    ParentDirectory,
    Whitespace,
    NotInSession,
    SelfParent,
}

impl Refusal {
    fn reason(self) -> &'static str {
        match self {
            Self::Empty => "it is empty",
            Self::TooLong => "it is longer than an id may be",
            Self::ControlCharacter => "it contains a control character",
            Self::PathSeparator => "it contains a path separator",
            Self::ParentDirectory => "it contains `..`",
            Self::Whitespace => "it begins or ends with whitespace",
            Self::NotInSession => "it does not belong to that session",
            Self::SelfParent => "it names itself as its own parent",
        }
    }
}

fn refuse(kind: IdKind, raw: &str, refusal: Refusal) -> HarnessError {
    // The id itself is shown, bounded: a refusal a caller cannot connect to
    // the value it sent is a refusal nobody can fix.
    let shown: String = raw.chars().take(60).collect();
    HarnessError::new(
        ErrorKind::InvalidInput,
        format!(
            "{shown:?} is not a {} id: {}",
            kind.tag(),
            refusal.reason()
        ),
    )
    .at(Stage::Context)
}

/// The rules every id keeps, whatever it names.
fn check(kind: IdKind, raw: &str) -> Result<(), (Refusal, HarnessError)> {
    let fail = |r: Refusal| Err((r, refuse(kind, raw, r)));
    if raw.is_empty() {
        return fail(Refusal::Empty);
    }
    if raw.chars().count() > MAX_ID_CHARS {
        return fail(Refusal::TooLong);
    }
    if raw.trim() != raw {
        return fail(Refusal::Whitespace);
    }
    if raw.chars().any(char::is_control) {
        return fail(Refusal::ControlCharacter);
    }
    // A path separator is the one that turns a key into a place on disk.
    if raw.contains('/') || raw.contains('\\') {
        return fail(Refusal::PathSeparator);
    }
    if raw.contains("..") {
        return fail(Refusal::ParentDirectory);
    }
    Ok(())
}

macro_rules! id_type {
    ($name:ident, $kind:expr, $doc:literal) => {
        #[doc = $doc]
        #[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub const KIND: IdKind = $kind;

            /// Adopt an id that arrived from somewhere else, refusing anything
            /// that could not be stored under safely.
            pub fn parse(raw: impl Into<String>) -> Result<Self, HarnessError> {
                let raw = raw.into();
                check($kind, &raw).map_err(|(_, e)| e)?;
                Ok(Self(raw))
            }

            /// Why it was refused, for a test that needs to be sure which rule
            /// fired rather than that some rule did.
            #[cfg(test)]
            fn refusal(raw: &str) -> Option<Refusal> {
                check($kind, raw).err().map(|(r, _)| r)
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub fn into_string(self) -> String {
                self.0
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

id_type!(
    SessionId,
    IdKind::Session,
    "One conversation, as its surface names it. The key everything else is stored under."
);
id_type!(
    RunId,
    IdKind::Run,
    "One turn, or one child run. Unique across processes (see `run_id_for_cancellation`)."
);
id_type!(
    InvocationId,
    IdKind::Invocation,
    "One provider request inside a run."
);
id_type!(JobId, IdKind::Job, "One background job.");
id_type!(
    AgentId,
    IdKind::Agent,
    "Who acted: the subject spelling (`agent`, `agent:<name>`, `role:<name>`)."
);
id_type!(SnapshotId, IdKind::Snapshot, "One recorded prompt snapshot.");

impl RunId {
    /// Whether this run belongs to that session.
    ///
    /// A run is `<session>#run-...` when it has one, so the relationship is in
    /// the id and does not have to be believed. A session-less run belongs to
    /// no session and says so.
    pub fn belongs_to(&self, session: &SessionId) -> bool {
        self.0
            .strip_prefix(session.as_str())
            .is_some_and(|rest| rest.starts_with("#run-"))
    }

    /// Check a claimed parent before it is recorded (AH-008).
    ///
    /// A child must name a parent of the same session, and nothing may be its
    /// own parent -- a self-parenting run makes a tree that never terminates
    /// and an ancestry that cannot be read.
    pub fn check_parent(&self, parent: &RunId, session: &SessionId) -> Result<(), HarnessError> {
        if self == parent {
            return Err(refuse(IdKind::Run, self.as_str(), Refusal::SelfParent));
        }
        if !parent.belongs_to(session) {
            return Err(refuse(IdKind::Run, parent.as_str(), Refusal::NotInSession));
        }
        Ok(())
    }
}

impl InvocationId {
    /// Whether this request belongs to that run.
    ///
    /// The renderer's own `inv-...` ids carry no run in them, so they are not
    /// claimed by any run here: absence of proof, not proof of absence.
    pub fn belongs_to(&self, run: &RunId) -> bool {
        self.0
            .strip_prefix(run.as_str())
            .is_some_and(|rest| rest.starts_with('#'))
    }
}

/// Read an id that a record written before this module may hold.
///
/// Legacy records are read, never trusted for policy: an id that would be
/// refused today comes back as `None` rather than as a value something might
/// store under or compare against. The record's other fields stay readable.
pub fn legacy(kind: IdKind, raw: &str) -> Option<String> {
    check(kind, raw).ok().map(|()| raw.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shapes Phases 1-4 already write keep working, because records on
    /// disk outlive a refactor.
    #[test]
    fn the_ids_the_harness_already_writes_are_valid() {
        for raw in [
            "0dc1bfc2-731b-46f4-acda-bb6306d3b181",
            "smoke-job-record",
            "jan-run",
        ] {
            SessionId::parse(raw).unwrap_or_else(|e| panic!("{raw}: {}", e.message()));
        }
        let session = SessionId::parse("8c874013-e5ff-4005-beb5-86ea2ec185e7").unwrap();
        let run = RunId::parse("8c874013-e5ff-4005-beb5-86ea2ec185e7#run-mtyjmvb71").unwrap();
        assert!(run.belongs_to(&session));
        let invocation =
            InvocationId::parse("8c874013-e5ff-4005-beb5-86ea2ec185e7#run-mtyjmvb71#1").unwrap();
        assert!(invocation.belongs_to(&run));
        // The renderer's own spellings.
        assert!(RunId::parse("chat:8c874013-mtyk1l8l-1").is_ok());
        let loose = InvocationId::parse("inv-mtyk6zz6-km2i0ido").unwrap();
        assert!(!loose.belongs_to(&run), "an id with no run in it claims none");
        JobId::parse("bash-a4708-0").unwrap();
        AgentId::parse("agent:scribe").unwrap();
        SnapshotId::parse("snap-18d49acc0115232c8294-1").unwrap();
    }

    /// Security: an id that could become a place on disk, or could not be
    /// stored under at all, is refused by the rule that catches it.
    #[test]
    fn an_id_that_could_escape_its_record_is_refused() {
        let cases: &[(&str, Refusal)] = &[
            ("", Refusal::Empty),
            ("  ", Refusal::Whitespace),
            (" leading", Refusal::Whitespace),
            ("trailing ", Refusal::Whitespace),
            ("../../etc/passwd", Refusal::PathSeparator),
            ("..", Refusal::ParentDirectory),
            ("a..b", Refusal::ParentDirectory),
            ("dir/sub", Refusal::PathSeparator),
            ("dir\\sub", Refusal::PathSeparator),
            ("line\nbreak", Refusal::ControlCharacter),
            ("nul\0byte", Refusal::ControlCharacter),
            ("bell\u{7}", Refusal::ControlCharacter),
        ];
        for (raw, expected) in cases {
            assert_eq!(SessionId::refusal(raw), Some(*expected), "{raw:?}");
            let error = SessionId::parse(*raw).expect_err("must refuse");
            assert_eq!(error.kind(), ErrorKind::InvalidInput, "{raw:?}");
            assert!(error.message().contains("session id"), "{}", error.message());
        }
        // Too long, and the boundary just under it.
        let long = "x".repeat(MAX_ID_CHARS + 1);
        assert_eq!(SessionId::refusal(&long), Some(Refusal::TooLong));
        assert!(SessionId::parse("x".repeat(MAX_ID_CHARS)).is_ok());
        // The refusal names what was being parsed.
        assert!(RunId::parse("a/b").unwrap_err().message().contains("run id"));
        assert!(JobId::parse("a/b").unwrap_err().message().contains("job id"));
    }

    /// Parentage is checked. A forged parent -- another session's run, or the
    /// run itself -- is refused before it can be recorded.
    #[test]
    fn a_forged_parent_is_refused() {
        let mine = SessionId::parse("session-a").unwrap();
        let theirs = SessionId::parse("session-b").unwrap();
        let parent = RunId::parse("session-a#run-1").unwrap();
        let child = RunId::parse("session-a#run-2").unwrap();
        assert!(child.check_parent(&parent, &mine).is_ok());

        // Its own parent.
        let error = parent.check_parent(&parent, &mine).expect_err("must refuse");
        assert!(error.message().contains("its own parent"), "{}", error.message());

        // Another session's run as a parent.
        let foreign = RunId::parse("session-b#run-9").unwrap();
        let error = child.check_parent(&foreign, &mine).expect_err("must refuse");
        assert!(
            error.message().contains("does not belong to that session"),
            "{}",
            error.message()
        );
        // ... and it is not this session's run either way round.
        assert!(!foreign.belongs_to(&mine));
        assert!(foreign.belongs_to(&theirs));
        // A prefix that merely starts the same is not the same session.
        let lookalike = RunId::parse("session-aa#run-3").unwrap();
        assert!(!lookalike.belongs_to(&mine), "a prefix was read as a session");
    }

    /// A provider's own id is not an identity here: it is data in a payload,
    /// and two requests may carry the same one.
    #[test]
    fn a_legacy_record_is_readable_but_never_trusted_as_an_id() {
        // Readable.
        assert_eq!(legacy(IdKind::Run, "old-run-1").as_deref(), Some("old-run-1"));
        // Not adopted: an id that would be refused today is None, so nothing
        // stores under it or compares against it.
        for hostile in ["../escape", "with\nnewline", ""] {
            assert_eq!(legacy(IdKind::Session, hostile), None, "{hostile:?}");
        }
    }
}
