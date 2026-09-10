# janhq/jan#8785 — make the Unix sandbox limits platform-aware

- Upstream PR: https://github.com/janhq/jan/pull/8785 (open, by Raghav-B)
- Priority: P2 (agent tool commands fail at `fork()` on busy Linux hosts)
- Status in this fork: **adapted**; Unix runtime verification pending

## Applies to us

`confine_limits` in
`src-tauri/plugins/tauri-plugin-agent-tools/src/tools/proc.rs` sets the same
values as upstream's base: `RLIMIT_NPROC = 4096`, `RLIMIT_NOFILE = 1024`,
`RLIMIT_FSIZE = 1 GiB`. `NPROC` is accounted per Unix user, not per shell tree,
so unrelated processes on a busy workstation can exhaust it and make an
ordinary tool command fail at `fork()`.

## Change

The PR's diff did not apply (context drift in `proc.rs`), so its intent was
reapplied by hand:

- Linux: `RLIMIT_NPROC` 4096 → 8192 (a finite fork-bomb ceiling remains).
- macOS: no `RLIMIT_NPROC`; the OS per-user ceiling (`kern.maxprocperuid`)
  already applies and an unprivileged child cannot raise it.
- Unix: `RLIMIT_NOFILE` 1024 → 2048. `RLIMIT_FSIZE` unchanged.
- The existing NOFILE test is updated to expect 2048.

## Verification

The change is `#[cfg(unix)]`. On this Windows host it is neither compiled nor
executed, and the Windows build of the plugin is unaffected
(`cargo test` for `tauri-plugin-agent-tools`, bash tests in isolation:
37 passed). **Runtime verification on Linux and macOS is outstanding.**

A full plugin run here showed five bash tests failing on a missing
`%TEMP%\jan-agent-thread-one` scratch directory; they pass in isolation and are
the same order-dependent failures recorded before this change.
