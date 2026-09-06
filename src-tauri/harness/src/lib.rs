//! Foundation models for the Jan coding-agent harness.
//!
//! This crate holds the things every harness lane has to agree on before it can
//! build anything that is correlated, audited or replayed:
//!
//! - [`identity`] -- one run id that ties a thread, session, agent and event together.
//! - [`error`] -- a typed error taxonomy that decides retryability and audience.
//! - [`event`] -- the canonical event stream every surface renders from.
//! - [`envelope`] -- the versioned, forward-compatible wire format for those events.
//! - [`state`] -- the versioned on-disk schema and its atomic writer.
//! - [`fixtures`] -- builders so harness tests do not hand-roll any of the above.
//!
//! It intentionally depends on nothing from `tauri` or the application crate:
//! the desktop app, the headless CLI and the test suites all link it.
//!
//! See `docs/AGENT_HARNESS_ARCHITECTURE.md` for the decisions this crate
//! implements (AHD-002 through AHD-004 and AHD-010).

pub mod envelope;
pub mod error;
pub mod event;
pub mod fixtures;
pub mod identity;
pub mod state;

pub use envelope::{Envelope, ENVELOPE_VERSION};
pub use error::{Audience, ErrorKind, HarnessError, Retry};
pub use event::{EventPayload, HarnessEvent, ToolOutcome};
pub use identity::{AgentId, RunId, RunIdentity, SessionId, ThreadId};
pub use state::{RunRecord, RunStatus, StateStore, STATE_SCHEMA_VERSION};
