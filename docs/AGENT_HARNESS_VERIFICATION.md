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
| Tool activity record and timeline (AH-050/AH-172) | not run | passed | passed (mock provider) | passed |

## Known blockers

- **Correction (2026-09-10): the `Jan` lib tests do run on Windows.** An
  earlier entry here said `cargo test -p Jan --lib` could not start on this host
  (`0xc0000139`). That was a misdiagnosis of a *feature combination*, not the
  host. Under `--features cowork-smoke` the unit-test harness imports
  `TaskDialogIndirect` with no Common-Controls v6 manifest and dies at load --
  exactly the limitation `src-tauri/build.rs` documents, since cargo has no
  selector for the lib test target. Run the way CI runs it,
  `cargo test --lib --no-default-features --features test-tauri`, the suite
  starts and 786 tests passed before the run was stopped (see the next entry).
- **A test that hung the suite, fixed.** `a_rule_naming_a_subagent_binds_that_subagent_and_nobody_else`
  left the main agent's exec prompt unanswered and waited forever; under
  `--test-threads=1` (CI) that stops the whole job. It now answers the prompt
  with Deny, bounds both halves with a timeout, and asserts which refusal came
  back.

## Tool activity record and timeline (AH-050 / AH-172)

| Evidence | Where | Covers |
| --- | --- | --- |
| 9 unit tests | `plugins/tauri-plugin-agent-tools/src/activity.rs` | one call stays one item; concurrent calls keep request order; refusal/cancellation/failure stay distinguishable; only a success is hideable; restart restores the timeline; a killed run's call becomes stale; cross-session reads refused; a truncated tail costs one event; no credential reaches the file |
| 11 unit tests | `web-app/src/lib/__tests__/toolActivity.test.ts` | classification and resource extraction; success, failure, cancellation and throw paths; a tool never waits on its audit line; a failed write never fails the tool |
| 7 unit tests | `web-app/src/lib/__tests__/coworkActivityTimeline.test.ts` | reconciliation: settles a stuck call, keeps unknown calls, restores lost ones in request order, marks refusals as errors |
| Real WebView scenario | `cowork-smoke --only tool-activity-timeline` | a scripted `ls` (succeeds) and `read` of a missing file (fails) are dispatched, recorded with the right terminal phases, rendered as their own items and survive a reload; with "Hide completed tool activity" on, the notice appears, the failure stays visible and the success is hidden; no provider key in `tool-activity`, `prompts`, `payload-usage` or `permissions` audit files. **Passed on Windows 2026-09-10** against the smoke mock provider; the real-model lane (`v100:8555`) was unreachable from this host |
| 2 unit tests | `web-app/src/lib/__tests__/coworkRunner.test.ts` (`an invalid tool call`) | a `tool-input-error` is kept as a failed call, never dispatched, answered to the model, and recorded requested → refused |
| 1 unit test | `web-app/src/lib/__tests__/agentTools.test.ts` | the tool-schema cache never serves one folder's (or one readiness state's) tool list to another |

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

## Staged patches: preview, selection, no clobbering (AH-146 / AH-147 / AH-148)

| Evidence | Where | Covers |
| --- | --- | --- |
| 12 unit tests | `plugins/tauri-plugin-agent-tools/src/patch.rs` | separate changes are separate hunks; selecting every hunk is the proposal and none is the base; a rejected hunk leaves base lines untouched; an unknown hunk is refused; insertions and deletions are hunks; a new file is one hunk against nothing; a missing final newline survives; **a changed, created or deleted base is refused**, and the refusal says nothing was written |
| 3 integration tests | `plugins/tauri-plugin-agent-tools/src/tools/handlers.rs` | a file written by someone else after staging is caught before the approved change lands; an edit is staged by the same code that applies it (the written file equals the staged proposal); nothing is staged for a no-op or an invalid edit |

Run: `cargo test -p tauri-plugin-agent-tools --lib -- --test-threads=4 patch::`
and `... handlers::tests::a_file_changed_after_staging`.

The approval flow in `core/agent/loop.rs` stages the change when the prompt is
shown and re-stamps the file before acting on the answer. That wiring is
compile-checked on default, `cowork-smoke` and `cli`; the lib tests run under
`--no-default-features --features test-tauri`.

AH-147 is `in-progress`: `StagedPatch::select` is built and tested, but no
decision can yet carry a hunk selection and the TUI has no per-hunk controls.

## Prompt snapshots bound to their turn (AH-078)

| Evidence | Where | Covers |
| --- | --- | --- |
| Real WebView scenario | `cowork-smoke --only prompt-snapshot-panel` | a dispatch is recorded and its payload viewer renders under the message it produced |
| **Mutation check in the WebView** | same scenario, positional fallback disabled | the panel still renders, so the per-turn reference is what carries it -- not the old positional match |

Run: `cargo run --example cowork-smoke --features cowork-smoke -- --only prompt-snapshot-panel`.

The mutation check is the evidence that matters here. `prompt-snapshot-panel`
passed under positional matching too, so a green scenario proves only that
*something* rendered. Disabling the fallback is what distinguishes the two.

Six earlier designs passed vitest and failed in the app. The reason, found by
instrumenting the live turn lane rather than by trying a seventh: at dispatch
the lane holds the user turn and nothing else, so a write from the snapshot sink
onto "the last assistant turn" had no row to find. Unit tests hand the mutation
an array that already contains one; the app never does.

## Per-command exec grants (AH-037)

| Evidence | Where | Covers |
| --- | --- | --- |
| 4 unit tests | `plugins/tauri-plugin-agent-tools/src/tools/gate.rs` | approving `git status` covers `git status` (any spacing) and **not** `git push`, `git push --force`, `git status --porcelain` or `rm -rf /`; approving a compound covers that compound and not its parts, in either direction; `&&`, `\|`, `;` and `$(...)` composed from approved parts still prompt; an opaque command matches only its exact grant |

Run: `cargo test -p tauri-plugin-agent-tools --lib -- --test-threads=4 gate::`.

Two of those tests previously asserted the opposite -- that a grant covered the
base command, and that approving a compound granted every base inside it. They
were rewritten to the narrowed behaviour with comments recording what they used
to claim, rather than deleted.

**Desktop was checked, not assumed.** `bash` is in `AGENT_TOOL_NAMES`, so it is
auto-allowed in the renderer and gated in Rust; the renderer's per-thread
approval is keyed on tool name and never covers it. The grant this item is about
lives on the CLI/Cowork path.

## Per-MCP-server permissions (AH-041)

| Evidence | Where | Covers |
| --- | --- | --- |
| 11 unit tests | `plugins/tauri-plugin-agent-tools/src/mcp_trust.rs` | nothing trusted until granted; a trusted server may call its tools; **trusting one server does not trust another publishing the same tool name**; a ticket authorizes exactly one call, and not a second; a ticket does not travel to another server or another tool; an invented ticket authorizes nothing; a ticket is never written to disk; trust survives a restart; revoking takes effect; granting twice records one entry; an unreadable trust file trusts nothing |
| 1 route test | `web-app/src/routes/threads/__tests__/$threadId.test.tsx` | an MCP call carries a ticket the backend issued, for the resolved server |
| 1 hook test | `web-app/src/hooks/__tests__/useToolApprovalRequests.test.ts` | "always allow this server" is recorded with the backend, not only in renderer state |

Run: `cargo test -p tauri-plugin-agent-tools --lib -- --test-threads=4 mcp_trust`
and `yarn test:web`.

The gate is in `call_tool`, checked **against the server the tool was resolved
on** rather than the `server_name` the request carried -- a request that names no
server is answered by whichever connected server publishes a matching tool name,
and a tool name is chosen by the server publishing it, so it identifies nobody.
The check runs before the arguments are sent: a refusal that has already sent
them has refused nothing.

**Scope, stated plainly.** This moves the persisted trust decision into the
backend and makes every call carry an explicit, backend-issued authorization. It
is not a defence against the renderer itself -- the renderer is the thing that
asks the user, and it can mint a ticket whenever it likes. What it stops is a
server becoming trusted without a recorded decision, a tool name standing in for
a server identity, and an "allow once" answer quietly becoming permanent.

## Secret redaction in transcripts (AH-045)

| Evidence | Where | Covers |
| --- | --- | --- |
| 16 unit tests | `plugins/tauri-plugin-agent-tools/src/secrets.rs` | a credential in prose, in an `Authorization` header, and as a JWT; several on one line; the assignment shape; a private-key header; **ordinary output is returned byte-identical** |
| 10 unit tests | `web-app/src/lib/__tests__/redactToolOutput.test.ts` | the renderer asks the backend rather than matching locally; nested content parts are reached; one round trip per result; non-strings untouched; withheld when the backend fails, when it returns a non-string, and when the parts cannot be matched back up |
| 1 route test | `web-app/src/routes/threads/__tests__/$threadId.test.tsx` (`never persists a credential a tool printed`) | a credential an MCP tool printed does not reach the message store |

Run: `cargo test -p tauri-plugin-agent-tools --lib -- --test-threads=4 secrets::`
and `yarn test:web`.

The route test was mutation-checked: replacing `redactDeep(part.output)` with
`part.output` fails it. It mocks only the IPC hop, not `redactToolOutput`
itself, so it fails if the route stops routing output through the redactor.

Two design points worth keeping:

- **One implementation.** The matching rules stay in Rust, shared with the audit
  log, the activity record and the prompt snapshot. A TypeScript copy would be a
  second, quietly weaker redactor wearing the same name.
- **No fallback to the original.** When redaction cannot be confirmed the text is
  withheld, not stored raw. A fallback that persists the input on error persists
  exactly what this exists to remove, on the one branch nobody exercises by hand.

## Subject-aware permission rules (AH-007)

| Evidence | Where | Covers |
| --- | --- | --- |
| 8 unit tests | `plugins/tauri-plugin-agent-tools/src/permissions.rs` (`mod subject_rules`) | a qualified rule does not bind another subject; a deny for one agent does not deny the others; an allow for one agent does not allow the others; a subagent allow cannot escape a blanket deny; an unqualified rule still covers everyone; every subject kind is matched; a rule about one subagent hides the tool from that subagent only, in execution *and* in advertising; an unqualified deny still binds every subject |
| Rule-grammar tests | `plugins/tauri-plugin-agent-tools/src/resource.rs` | `[subject/]tool[(pattern)]` parsing, including `agent:reviewer/write` |
| Dispatcher test | `src/core/agent/loop.rs` (`a_rule_naming_a_subagent_binds_that_subagent_and_nobody_else`) | the same call, the same policy, two subjects: the reviewer is refused by policy; the main agent reaches the exec prompt instead. Runs under `--features test-tauri` |

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
| 3 unit tests | `web-app/src/lib/__tests__/providerFetch.test.ts` | every model dispatch carries its own `invocationId`; two dispatches never share one; discovery requests are not named |
| Real WebView scenario | `cowork-smoke --only tool-activity-timeline` | every accounting record written by a real run names a dispatch, names its snapshot, and reports the provider as its source |

**Correction (2026-09-10).** The scenario row above was listed before it had
ever passed with accounting: no dispatch was given an invocation id, so
`recordPayloadUsage` dropped every record and the scenario failed at exactly
this check. Fixed in `providerFetch`; the scenario now passes on Windows.


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
