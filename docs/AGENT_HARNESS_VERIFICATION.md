# Agent harness verification

How harness work is proven, and the standing record of what has actually been
executed. Owned by `lane-11-cross-platform-verification`.

## What "verified" requires

A registry item reaches `verified` only when all twelve acceptance rules hold:

1. Production implementation.
2. Real call-site wiring -- the code is reached from the agent run path.
3. Success path.
4. Refusal or error path.
5. Cancellation and race behaviour.
6. Persistence across restart, where applicable.
7. Unit tests.
8. Integration tests.
9. Route or UI tests, where applicable.
10. Security or mutation tests, wherever authority is involved.
11. Documentation.
12. Registry status updated.

A type, a button, a config parser or a mock does not satisfy rule 1, and an
unconsumed module does not satisfy rule 2.

## Execution rules

These exist because the failure mode of a long programme is a claim that was
never run.

- **Bounded commands only.** Every command has an explicit timeout. No command
  runs longer than ten minutes without visible progress.
- **Nothing long-running is hidden** behind a pipe or a background task.
- **No repeated retries of a stalled build or download.** A stall is recorded as
  a blocker, not spun on.
- **Platform claims require execution.** macOS, Windows, Linux and WebView
  behaviour is never reported as validated unless it ran on that platform. A
  cross-compile, a type-check or a code reading is not a platform validation.
- **Infrastructure failures are not results.** A GitHub Actions run with
  `runner_id: 0`, an empty runner name and no executed steps is a
  runner-allocation failure. It is ignored, verification continues locally, and
  the fact is recorded here rather than reported as a red build.
- **Blockers are documented, not worked around.** A suite that cannot run is
  recorded below with the reason.

## Command inventory

| Scope | Command | Bounded by |
| --- | --- | --- |
| Feature registry schema and drift | `node scripts/agent-harness/validate-registry.mjs` | seconds |
| Feature registry tests | `node --test "scripts/agent-harness/*.test.mjs"` | seconds |
| Harness crate tests | `cargo test --manifest-path src-tauri/harness/Cargo.toml` | seconds |
| Harness crate lint | `cargo clippy --manifest-path src-tauri/harness/Cargo.toml --all-targets -- -D warnings` | ~1 min cold |
| Tools plugin | `cargo check --manifest-path src-tauri/plugins/tauri-plugin-agent-tools/Cargo.toml --no-default-features` | ~1 min warm |
| App crate, CLI config | `cargo check --manifest-path src-tauri/Cargo.toml --no-default-features --features cli --all-targets` | CI |
| App crate, desktop config | `cargo check --manifest-path src-tauri/Cargo.toml --no-default-features --features test-tauri --all-targets` | CI |
| JavaScript suites | `yarn test:core`, `yarn test:web`, `yarn test:ext` | CI |

The two app-crate configurations are mutually exclusive feature sets of one
crate, so neither alone proves the other compiles. Both must pass before a phase
that touches `core/agent/` closes.

## Per-phase evidence

### Phase 0 -- Foundation

Executed on Linux (`x86_64`, rustc 1.94.1, Node 22) on the branch
`feat/cowork-background-tasks`, rebased onto `776fa06`.

| Command | Result |
| --- | --- |
| `cargo test --manifest-path src-tauri/harness/Cargo.toml` | 54 passed, 0 failed |
| `cargo clippy --manifest-path src-tauri/harness/Cargo.toml --all-targets -- -D warnings` | clean |
| `node --test "scripts/agent-harness/*.test.mjs"` | 26 passed, 0 failed |
| `node scripts/agent-harness/validate-registry.mjs` | 200 features, schema and drift clean |
| `cargo check --no-default-features` (tools plugin) | clean, 40s cold |

Two defects were found and fixed during this phase:

- Temporary directories in the fixture library collided when two were created in
  the same millisecond, and the create-time cleanup would then delete a live
  sibling's directory. Caught by its own test; fixed with a process-wide counter.
- The first draft of the foundation crate carried a `worktree` module defining a
  `jan/agent/` branch convention, while `core/agent/worktree.rs` on this branch
  already owns `jan/cowork/`. Two conventions would make worktree cleanup unable
  to tell an abandoned agent tree from a developer's own. The module was removed
  rather than reconciled; `AH-012` points at the shipped one.

The audit that produced the initial registry statuses ran against `adfd071`,
which was 282 commits stale. Statuses were re-derived against the current head
before this was committed; the re-audit is recorded with the Phase 0 report.

#### Not run in Phase 0, and why

| Not run | Reason |
| --- | --- |
| App crate `cargo check` in either configuration | Phase 0 adds no code to `src-tauri/src`. The harness crate is a standalone workspace with no dependants yet, so the app crate's build is unchanged. It is checked in CI on every push regardless. |
| JavaScript test suites (`yarn test:*`) | Phase 0 changes no workspace source. The registry tooling is dependency-free Node with its own suite, deliberately so that it runs before `yarn install`. |
| macOS, Windows and WebView validation | Not executed. No Phase 0 code is platform-specific; the first items needing it are the process jail and worktree work in Phases 2 and 5. |
| Golden-repository and security-corpus suites | Not built yet -- `AH-197` and `AH-198` are `missing` in the registry. |

### Phases 1-8

Recorded here as each phase closes, in the same shape: commands executed with
their results, then commands not executed with the reason.

## Platform matrix

Filled in as platform-specific work lands. Empty cells mean *not executed*, never
*assumed to pass*.

| Area | Linux | macOS | Windows | WebView |
| --- | --- | --- | --- | --- |
| Harness foundation crate (Phase 0) | passed | not run | not run | n/a |
| Process jail (`bubblewrap` / Seatbelt / AppContainer) | not run | not run | not run | n/a |
| Per-agent worktrees | not run | not run | not run | n/a |
| Desktop agent surfaces | not run | not run | not run | not run |
| Tool activity record and timeline (AH-050/AH-172) | not run | passed | not run | passed |

## Known blockers

- **The `Jan` lib test binary does not start on this Windows host.** Every
  `cargo test -p Jan --lib` run exits `0xc0000139`
  (`STATUS_ENTRYPOINT_NOT_FOUND`) before the harness prints a line, including
  tests untouched by any recent change. The main crate's unit tests therefore
  compile here but are not executed; anything that must be *run* on Windows goes
  through `cowork-smoke`, which drives the real application and does start.

## Tool activity record and timeline (AH-050 / AH-172)

| Evidence | Where | Covers |
| --- | --- | --- |
| 9 unit tests | `plugins/tauri-plugin-agent-tools/src/activity.rs` | one call stays one item; concurrent calls keep request order; refusal/cancellation/failure stay distinguishable; only a success is hideable; restart restores the timeline; a killed run's call becomes stale; cross-session reads refused; a truncated tail costs one event; no credential reaches the file |
| 11 unit tests | `web-app/src/lib/__tests__/toolActivity.test.ts` | classification and resource extraction; success, failure, cancellation and throw paths; a tool never waits on its audit line; a failed write never fails the tool |
| 7 unit tests | `web-app/src/lib/__tests__/coworkActivityTimeline.test.ts` | reconciliation: settles a stuck call, keeps unknown calls, restores lost ones in request order, marks refusals as errors |
| Real WebView scenario | `cowork-smoke --only tool-activity-timeline` | a scripted `ls` call is dispatched, recorded through `requested`/`running`/terminal, rendered as its own item, carries no credential, and survives a reload |

Run: `cargo test --lib activity::` and
`cargo run --example cowork-smoke --features cowork-smoke -- --only tool-activity-timeline`.


## Memory proposals: the approval card (AH-045-adjacent, memory path)

| Evidence | Where | Covers |
| --- | --- | --- |
| 8 unit tests | `plugins/tauri-plugin-agent-tools/src/memory/commands.rs` (`mod proposal_tests`) | a pending proposal is listed with the reason it is waiting; a conflicted one is never approvable and the backend refuses approving it; approving makes the memory usable; rejecting removes it rather than asking again; a credential is discarded *at approval time*, not stored; a proposal is not usable; resolving something that is not pending is refused; the tool persists the question it asked |
| 10 unit tests | `web-app/src/containers/__tests__/MemoryProposalCard.test.tsx` | what would be remembered and where; the backend's reason rather than "needs approval"; approve and discard round-trip through the backend; a conflicted proposal offers no approval; a refusal is shown rather than swallowed; one answer per double click; an empty list renders no chrome |
| Real WebView scenario | `cowork-smoke --only memory-proposal-approval` | propose over IPC; `Status::Proposed` on disk *before* anything is clicked; the card and its reason in the DOM; approve; the record is `active` on disk; re-entering the chat does not ask again; a contradiction renders with no Approve button |

Run: `cargo test -p tauri-plugin-agent-tools --lib -- --test-threads=4 proposal_tests`,
`yarn test:web` and
`cargo run --example cowork-smoke --features cowork-smoke -- --only memory-proposal-approval`.

The scenario asserts on the DOM **and** on the file deliberately: a card that
renders from renderer state while nothing is written, and a record written while
no card renders, are both failures a DOM-only or file-only check reports as a
pass.

## Subject-aware permission rules (AH-007)

| Evidence | Where | Covers |
| --- | --- | --- |
| 8 unit tests | `plugins/tauri-plugin-agent-tools/src/permissions.rs` (`mod subject_rules`) | a qualified rule does not bind another subject; a deny for one agent does not deny the others; an allow for one agent does not allow the others; a subagent allow cannot escape a blanket deny; an unqualified rule still covers everyone; every subject kind is matched; a rule about one subagent hides the tool from that subagent only, in execution *and* in advertising; an unqualified deny still binds every subject |
| Rule-grammar tests | `plugins/tauri-plugin-agent-tools/src/resource.rs` | `[subject/]tool[(pattern)]` parsing, including `agent:reviewer/write` |
| Dispatcher test | `src/core/agent/loop.rs` (`a_rule_naming_a_subagent_binds_that_subagent_and_nobody_else`) | the same call, the same policy, two subjects: the reviewer is refused and the main agent is not. **Compiled, not executed on this host** -- see Known blockers |

Run: `cargo test -p tauri-plugin-agent-tools --lib -- --test-threads=4 subject_rules`.

Negative tests were written before the matching, and fail if `covers_subject` is
made to return `true` unconditionally -- which is what the bug was.

## Context accounting and model capabilities (AH-073 / AH-088 / AH-195)

| Evidence | Where | Covers |
| --- | --- | --- |
| 14 unit tests | `web-app/src/lib/__tests__/modelCapabilities.test.ts` | every field name a server uses; Jan's nested settings shape; the reply cap never read as the window; discovery order; llama.cpp effective vs training window; bundled metadata last; unknown stays unknown |
| 6 unit tests | `web-app/src/lib/__tests__/coworkBudgetPlanner.test.ts` | reply reserve bounds; fits/tight/over; an undiscoverable window is not a refusal; the typed overflow error names both numbers |
| 7 unit tests | `plugins/tauri-plugin-agent-tools/src/usage.rs` | a count stays with its own dispatch; a provider count replaces an estimate and never the reverse; survives a restart; cross-session reads refused; an unscoped lookup refused; a truncated tail costs one record |
| 5 unit tests | `web-app/src/lib/__tests__/payloadUsage.test.ts` | binding to invocation and snapshot; nothing recorded when there is no invocation; nonsense figures dropped; a failed write never fails the run |
| Real WebView scenario | `cowork-smoke --only tool-activity-timeline` | every accounting record written by a real run names a dispatch, names its snapshot, and reports the provider as its source |


## Run reliability (AH-018 / AH-019 / AH-021 / AH-024 / AH-025 / AH-029 / AH-030)

| Evidence | Where | Covers |
| --- | --- | --- |
| 12 unit tests | `web-app/src/lib/__tests__/runRetry.test.ts` | classification of every failure kind; only transient and rate-limited retried; `Retry-After` in seconds and as a date; jitter spread and cap; attempts exhausted; a cancelled wait reported as cancelled |
| 9 unit tests | `web-app/src/lib/__tests__/runLoopGuard.test.ts` | repeated, equivalent and repeatedly-failing calls; edit/revert cycles distinguished from a file being built up; recursive delegation; the same verdict on the same history after a restart |
| 10 unit tests | `web-app/src/lib/__tests__/runDeadline.test.ts` | deadlines counting waiting; expiry across a closed app; a backwards clock jump; per-operation timeout vs user abort; no timer left behind; one terminal reason from many |
| 7 runner tests | `web-app/src/lib/__tests__/coworkRunner.test.ts` (`run guards`) | the guards exercised through the loop that enforces them: no model call after the deadline, a transient failure retried, a 401 not retried, a circling run stopped before the step cap, an abort not called a timeout, a silent stream reported as one |


## Session forking (AH-201)

| Evidence | Where | Covers |
| --- | --- | --- |
| 9 unit tests | `web-app/src/hooks/__tests__/useCoworkSessions.fork.test.ts` | the conversation copied to the named turn; the whole conversation by default; parent and divergence recorded; messages rebuilt with the fork's own ids; no folder, access, consent or budget inherited; unknown session and out-of-range turn refused; both sessions independently renamable and deletable; the fork is shown |
