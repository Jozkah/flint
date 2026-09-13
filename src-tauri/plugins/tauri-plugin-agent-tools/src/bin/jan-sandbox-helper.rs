//! The confined-spawn helper as a program of its own.
//!
//! On Windows the AppContainer confinement is a token attribute passed to
//! `CreateProcessW`, which `tokio::process::Command` cannot set, so the shell is
//! started by a second process that can. The Jan app and the `jan` CLI re-exec
//! themselves for this (see [`tauri_plugin_agent_tools::tools::appcontainer`]),
//! which works because their `main` calls the helper entry point first.
//!
//! A test binary's `main` belongs to libtest, which rejects the helper's argv
//! and exits before any of this crate's code runs -- so every `bash` test on
//! Windows was exercising a failed re-exec rather than a sandboxed shell. This
//! binary exists so a test (and any embedder whose `main` is not ours) has a
//! real helper to point `JAN_SANDBOX_HELPER_EXE` at.
//!
//! It does exactly one thing, and refuses to do anything else: with a helper
//! argv it performs the confined spawn and exits with the child's status; with
//! anything else it exits non-zero without running a command. In particular it
//! is never a way to run an arbitrary program unconfined.

fn main() {
    // Returns only when the argv is not a helper request.
    tauri_plugin_agent_tools::run_sandbox_helper_if_requested();
    eprintln!(
        "jan-sandbox-helper: this program only runs Jan's confined-spawn requests, \
         and was given something else."
    );
    std::process::exit(2);
}
