# janhq/jan#8893 (fixes #8887) — agent TUI keeps late tool results with their group

- Upstream PR: https://github.com/janhq/jan/pull/8893 (merged 2026-09-09, by thinhlpg)
- Upstream issue: https://github.com/janhq/jan/issues/8887
- Priority: P2 (agent TUI timeline integrity)
- Status in this fork: **adapted** by cherry-pick with provenance (`-x`)

## Review

Two commits, one file (`src-tauri/src/core/cli/tui.rs`), +202 lines:

- `2d400f0` routes a tool result that arrives after its group has scrolled past a
  timeline boundary back to the group that owns it.
- `756d8ff` verifies streamed batch-result ownership.

The only network-looking code is in a test: a local socket server on a random
port feeding SSE chunks to `stream_chat_completions`, bounded by a 10 s timeout.
No dependency, build, filesystem or permission change. Both commits apply to the
fork's TUI as a series.

## Why take it

The fork ships the same agent TUI. Out-of-order streamed events (reasoning
before a tool call, late tool results) otherwise leave results detached from
their calls in the transcript.

## Verification

Run under `--features cli`, where `tui.rs` is compiled; see the ledger record
for the result of this batch.
