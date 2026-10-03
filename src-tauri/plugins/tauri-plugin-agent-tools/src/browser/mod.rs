//! Driving a throwaway, confined, Chromium-based browser over DevTools.
//!
//! One launcher serves two consumers: the app's scripted "Verify in browser"
//! run (`core::browser_verify`) and the agent's interactive `browser` tool
//! (`session`). Confinement is decided here once:
//!
//! - `confine`: which origins may load (loopback only), the dead-proxy launch
//!   arguments, URL display rules.
//! - `cdp`: the DevTools client.
//! - `launch`: starting the browser with a temporary profile, opening a tab,
//!   and tearing both down.
//! - `events`: the shared DevTools event loop that answers every paused request
//!   against the policy and reports what the page does.
//! - `fence`: page text reaches the model only inside an untrusted block.
//! - `outline`: the model-facing page snapshot (refs, caps).
//! - `session`: the long-lived per-run session the `browser` tool drives.

pub mod cdp;
pub mod confine;
pub mod events;
pub mod fence;
pub mod keys;
pub mod launch;
pub mod outline;
pub mod session;

#[cfg(test)]
mod session_tests;
