# Agent tools hardening: approval ownership and sandbox resource limits

Status: design note. Two audit items (O02-024, P2B-016) need changes larger than
a bug fix. This note records the chosen approach so the work can be picked up in
steps; nothing here changes behaviour on its own.

## 1. Rust-owned approval and data folder (O02-024)

### Problem

Most `plugin:agent-tools|*` commands take `dataFolder` and, for gated actions,
an approval value from the webview. Every webview covered by the `default`
capability (`main`, `chat-window-*`) can call them. A compromised or confused
webview could point a command at another folder or present an approval the user
never gave.

### Chosen approach

1. **Data folder from app state.** Commands resolve the data folder with
   `get_jan_data_folder_path(app)` and ignore the `dataFolder` argument. The
   argument stays in the signature for one release (accepted, unused) so the
   guest-js API and older callers keep working, then is removed.
2. **One-shot approval tokens minted in Rust.** A gated command does not accept
   "approved: true" from the webview. Rust shows (or asks the webview to show)
   the prompt, records the decision, and issues a random single-use token bound
   to `(command, canonical arguments, session)`. The executing command consumes
   the token; a missing, reused or mismatched token is refused.
3. **Narrower capability for pop-out chat windows.** Split `chat-window-*` out
   of `default` into its own capability once the set of commands a chat window
   actually invokes is enumerated (the web command inventory script can produce
   that list). Until then the windows keep the full set, because they render the
   same app and trimming blindly breaks features.

### Order

Step 1 first (mechanical, testable per command), then 2 (needs the prompt
plumbing), then 3. Each step lands with an integration test: a forged
`dataFolder` is ignored; a forged approval string is rejected.

### Not done yet

No code change in this round: every step touches many commands and the approval
flow, which is a redesign, not a safe local fix.

## 2. Resource limits for sandboxed commands (P2B-016)

### Problem

The Windows AppContainer job object and the Linux bwrap launch cap time but not
process count or memory, so a fork bomb or a runaway allocation inside the
sandbox can exhaust the host.

### Chosen approach

- **Windows:** add `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` (256) and
  `JOB_OBJECT_LIMIT_JOB_MEMORY` (half of physical RAM, never below 2 GiB) to the
  job's extended limit information, next to the existing kill-on-close flag.
- **Linux:** set `RLIMIT_NPROC` (relative to the user's current process count
  plus 256) and `RLIMIT_AS` (same memory budget) in the child before `exec` of
  bwrap, via `pre_exec`.
- Limits are constants in one place, overridable by a setting only if a real
  build needs more.

### Verification needed before landing

Both changes alter what ordinary builds may do (large `cargo`/`node` builds can
run many processes and use a lot of memory), and the AppContainer tests do not
run on every development machine. They land only with a manual fork-bomb check
on Windows and Linux plus a large real build inside the sandbox, so no code
change in this round.
