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
| Process jail (`bubblewrap` / Seatbelt / AppContainer) | not run | not run | unit tests passed; no sandboxed shell starts on this host | n/a |
| Per-agent worktrees | not run | not run | passed (managed worktree through the UI, mock provider) | passed |
| Desktop agent surfaces | not run | not run | not run | not run |
| Tool activity record and timeline (AH-050/AH-172) | not run | passed | passed (mock provider) | passed |
| Provider cache-aware token usage (AH-211) | not run | not run | passed | passed (Windows) |

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

## Proposed changes from a worktree: stored, bound, applied by hunk (AH-146 / AH-147 / AH-148 / AH-109)

| Evidence | Where | Covers |
| --- | --- | --- |
| 22 unit tests | `plugins/tauri-plugin-agent-tools/src/proposal.rs` | stored before approval with the destination untouched; approve all; approve one of two hunks; insertions at top, middle and end; one insertion of two taken alone; an unrelated destination edit preserved; an overlapping edit is a conflict naming the hunk, nothing written, proposal kept with the conflict in its history; a hunk the destination already holds is not a conflict; changed patch hash or base-state hash refused; a record edited on disk after it was shown refused; cross-agent and cross-project approvals refused; unknown and duplicate hunk/file selections refused; an applied or rejected proposal cannot be applied; a credential-shaped file never applied; a binary file decided whole and landed byte for byte; a file created or deleted underneath refused; a failed write rolls back files already written; paths outside the project and `.jan` refused; two spellings of one path refused; the audit links creation and application and holds no content |
| 2 integration tests | `src-tauri/src/core/agent/proposals.rs` | a real `git worktree` becomes exactly the files it changed (edit, delete, add, commit on its branch), Jan state excluded, the source checkout untouched; an untouched worktree proposes nothing |
| 9 unit tests | `web-app/src/containers/__tests__/CoworkProposalReview.test.tsx` | the approval is ids and hashes only; a partly chosen file is sent by hunk id; a credential-shaped file cannot be selected; a conflict renders against its hunk and nothing is reported applied; creation refusal shown; reject sends the stored scope; another worktree's proposal is not shown |
| Real WebView scenario | `cowork-smoke --only proposal-review-apply` | over real IPC into the real backend: a real worktree is made, its changes proposed and stored before approval with the folder untouched; a changed patch hash and a different agent are refused with nothing written; one hunk of two lands exactly and an unselected file stays out; a second proposal overlapping an edit made in the folder is refused with the hunk named and nothing written; a rejected proposal cannot then be applied; the audit holds created/applied/conflict/refused/rejected and no file content. **Passed on Windows 2026-09-10** |
| Real WebView scenario, through the UI | `cowork-smoke --only managed-worktree-review` | attach a folder, choose **Managed worktree** and **Ask before changes** in the composer's menus (on Windows: the AppContainer grant on the Jan-owned worktree); the model writes a file in the worktree; **the approval prompt shows the diff of that write before Allow Once is clicked**; the attached folder is untouched; Changes → Review changes lists the file; one hunk of two is unticked and applied, and the folder holds exactly the ticked hunk. **Passed on Windows 2026-09-10.** The run's `bash` half is reported, not passed: no sandboxed shell starts on this host (every probe times out), so `bash` is withheld and the shell's write to the worktree is not exercised here |

Run: `cargo test -p tauri-plugin-agent-tools --lib -- --test-threads=4 proposal::`,
`cargo test --lib --no-default-features --features test-tauri core::agent::proposals`,
`yarn test` and
`cargo run --example cowork-smoke --features cowork-smoke -- --only proposal-review-apply`.

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


## Provider cache-aware token usage (AH-211)

Provider-reported usage only; AH-073's estimate is a separate record and is not
exercised here.

| Evidence | Where | Covers |
| --- | --- | --- |
| 19 unit tests | `web-app/src/lib/__tests__/tokenUsage.test.ts` | OpenAI `cached_tokens`; Anthropic read and creation without double counting; llama.cpp usage including a measured zero; `cache_n` fallback; no cache data stays absent despite the SDK's zero default; Responses and Gemini; clamping with the reported value kept; step combination; legacy records; Cowork mapping |
| 8 provider tests | `web-app/src/lib/__tests__/tokenUsage.providers.test.ts` | the real `@ai-sdk/openai-compatible`, llama.cpp and `@ai-sdk/anthropic` models over replayed wire bodies (llama-server and vLLM bodies captured from real servers), folded the way the transport stores them; cumulative streaming kept final, not summed; malformed counts clamped |
| 5 unit tests | `web-app/src/lib/__tests__/tokenUsage.cowork.test.ts` | the runner's step fold; run outcome is the last step, not a sum; Cowork session breakdown and subagent usage survive a rehydrate from storage; a pre-existing session loads without invented fields |
| 2 subagent tests | `web-app/src/lib/__tests__/coworkSubagent.test.ts` | a child's breakdown reaches its task record; a child with no cache data carries no cache fields |
| 4 hook tests | `web-app/src/hooks/__tests__/useTokensCount.test.ts` | Chat reload from a persisted message; a legacy message; live `cache_n`; Cowork source usage |
| 7 render tests | `web-app/src/components/__tests__/TokenCounter.test.tsx` (`cache breakdown`) | rows with and without cache data, "Not reported" rather than 0, a measured zero, cache write, the derived-count explanation, clamping notice, compact badge unchanged |
| Rust unit tests | `core/server/converters.rs`, `core/agent/events.rs`, `core/threads/tests.rs`, `plugins/tauri-plugin-agent-tools/src/usage.rs` | Anthropic, Responses and Gemini cache counts in chat/completions shape; cumulative `message_delta` replaces rather than adds; absent counts omitted; `messages.jsonl` round trip; payload records old and new |
| Real WebView scenarios | `cowork-smoke --only token-usage-cache`, then `token-usage-cache-cowork`, then `token-usage-cache-after-restart`, each its own process on the same `COWORK_SMOKE_DATA_DIR` | against a real llama-server reached through the fixture's transparent relay: two turns in Chat and in Cowork, the follow-up served from the provider's cache, the popover's Input/Cached/Uncached/Output/Total equal to what the provider reported for that request; then a second process shows the same breakdown from disk without contacting the provider |

Run the scenario with a real OpenAI-compatible server that reports
`prompt_tokens_details.cached_tokens`:

```
set COWORK_SMOKE_CACHE_UPSTREAM=http://<host>:<port>/v1
set COWORK_SMOKE_CACHE_MODEL=<model id>
set COWORK_SMOKE_KEEP=<empty folder, kept across the runs>
set COWORK_SMOKE_PORT=18711
cargo run --example cowork-smoke --features cowork-smoke -- --only token-usage-cache
cargo run --example cowork-smoke --features cowork-smoke -- --only token-usage-cache-cowork
cargo run --example cowork-smoke --features cowork-smoke -- --only token-usage-cache-after-restart
```

Each surface runs in its own process, and the restart check is a later one on
the same `COWORK_SMOKE_KEEP` profile (data folder, working directory and
WebView profile all kept). `COWORK_SMOKE_PORT` moves the fixture off 8080.
These scenarios are never retried: a retry would hide exactly the kind of
nondeterminism they exist to catch.

Last run, 2026-09-11, merged onto `fork/main` 9ab30620e, Windows WebView2,
llama-server `qwen3.8-27b`, all three passing on the first attempt:

| Check | Input | Cached | Uncached (derived) | Output | Total (derived) |
| --- | --- | --- | --- | --- | --- |
| Chat follow-up | 2,825 | 2,802 | 23 | 39 | 2,864 |
| Cowork follow-up | 5,542 | 5,505 | 37 | 17 | 5,559 |
| After restart (new process, no provider request) | same | same | same | same | same |

Raw field mapping for that provider: `usage.prompt_tokens` to Input,
`usage.prompt_tokens_details.cached_tokens` to Cached input,
`usage.completion_tokens` to Output; `timings.cache_n` agreed with
`cached_tokens` and was not needed.

The first-attempt failure seen in the earlier restart run (passed on retry,
before retries were disabled here) was a race in the harness: the popover is
portalled, and the previous surface's one was still in the document when the
next surface's counter was opened, so Chat's numbers were read while Cowork's
were asserted. The counter and breakdown now carry `data-usage-scope` (the
thread or session id), the harness reads only the matching breakdown, and a
render test switches the source between two sessions and asserts the scope and
values follow it.


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

## Command palette and rebindable shortcuts (AH-206 / AH-207)

| Evidence | Where | Covers |
| --- | --- | --- |
| 5 unit tests | `web-app/src/lib/__tests__/commandPalette.test.ts` | section order with nothing typed and threads capped; typo-tolerant title ranking; keyword matches; every thread searchable; no `fetch` |
| 4 unit tests | `web-app/src/containers/__tests__/CommandPalette.test.tsx` | actions, navigation, conversations and settings listed; Enter runs the best match and closes; arrow keys move the selection; an empty result says so |
| 12 unit tests | `web-app/src/hooks/__tests__/useKeybindings.test.ts` | default until set; a free chord binds; a taken chord refused naming its command; zoom aliases count as taken; a rebound command frees its old chord; zoom not rebindable; only overrides persisted; rehydration restores them and never restores "recording"; reset; a bare key or lone modifier is not a binding |
| Real WebView scenario | `cowork-smoke --only command-palette-keybindings` | Ctrl+Shift+P opens the palette on `/`; "system monitor" ranks first and Enter navigates; in Settings → Shortcuts, Ctrl+N is refused naming New Chat and does not open a chat; Ctrl+Alt+Y is accepted and written to `settings.json`; the new chord opens the palette and the old one no longer does; Reset restores the default. **Passed on Windows 2026-09-10** |

| **Real application restart** | `cowork-smoke --only restart-persist-1`, then `--only restart-persist-2` in a new process with `COWORK_SMOKE_KEEP=<dir>` | phase one rebinds the palette to Ctrl+Alt+Y through Settings → Shortcuts and the process exits; phase two starts the app again on the same data folder: Ctrl+Shift+P no longer opens the palette, Ctrl+Alt+Y does, and Reset restores the default. **Passed on Windows 2026-09-10** |

The restart pair reuses one workspace, so it proves what is read back from
disk by a fresh process, not what a live store remembers. macOS modifier
conventions (`usePlatformMetaKey` as Cmd) are unit-tested, not run on a Mac.

## Hidden utility agents (AH-208)

| Evidence | Where | Covers |
| --- | --- | --- |
| 5 unit tests | `web-app/src/lib/__tests__/utilityAgents.test.ts` | the model is called with no tools and `toolChoice: 'none'`; a success is recorded with counts and without the prompt or the output; a failure is recorded and re-thrown without its message; a cancellation is recorded as cancelled; a failed record never fails the call |
| 3 unit tests | `plugins/tauri-plugin-agent-tools/src/utility.rs` | every invocation recorded and found by session; a lookup must name a session; a field carrying content is refused whole (not filtered down to its letters) and "tools offered" can never be recorded true |
| existing suites | `thread-title-summarizer.test.ts`, `context-manager.test.ts` | titling and compaction still behave as before through the wrapper |
| Real WebView scenario | `cowork-smoke --only utility-agent-title` | a real chat round trip on `/` triggers the automatic title; a `title` record for that conversation lands in `audit/utility-agents.jsonl` with `succeeded` and `toolsOffered:false`, and neither the user's message, the model's reply nor the provider key appears in it. **Passed on Windows 2026-09-10** |

## Portable session export and import (AH-203)

| Evidence | Where | Covers |
| --- | --- | --- |
| 5 unit tests | `src-tauri/src/core/agent/session_bundle.rs` | folder, access, consent and messages are never exported; credentials in named fields **and in prose** are redacted before anything is written; an unknown schema version is refused naming it; non-exports, missing ids and missing turns are refused; a valid export round-trips |
| 8 unit tests | `web-app/src/lib/__tests__/sessionBundle.test.ts` | versioned and self-describing; carries turns, questions and the change summary, and no authority; only this session's tool activity; import creates an unbound session with the same turns, order and tool states; a pending question comes back stale under the new id; file activity re-keyed; a second import of the same export refused naming the session it became; an unknown schema version creates nothing |
| Real WebView scenario | `cowork-smoke --only session-export-import` | a Cowork run with a tool call and `Authorization: Bearer ...` typed into the prompt exports through the session menu with the save dialog scripted; the file is schema 1, carries the turns, and holds neither the credential, the provider key nor the attached folder; importing it shows the conversation in a new session; a second import is refused; a copy claiming schema version 9 is refused by name. **Passed on Windows 2026-09-10** |

## Windows confinement for a Jan-owned worktree (AH-146 / AH-147 / AH-148 / AH-109 prerequisite)

| Evidence | Where | Covers |
| --- | --- | --- |
| 3 unit tests | `plugins/tauri-plugin-agent-tools/src/tools/jail.rs` | AppContainer confines a shell to write roots only when every root is strictly inside Jan's worktree folder (the user's own folder, the worktree folder itself and a sibling are refused); a probe that hangs is killed within its timeout and its process is gone (checked with `OpenProcess`/`GetExitCodeProcess`, not `taskkill`); a probe that finishes is waited for |
| 2 unit tests | `plugins/tauri-plugin-agent-tools/src/tools/appcontainer.rs` | the helper's argv round-trips its `--write-root=` items; an unmarked argument before `--` is refused |
| 1 unit test | `plugins/tauri-plugin-agent-tools/src/grants.rs` | on Windows only a Jan-owned worktree can be authorized; the user's folder is refused naming Managed worktree |
| 2 unit tests | `src-tauri/src/core/agent/worktree.rs` | a relative worktrees root (the default `./data`) resolves once, against the working directory, never inside the repository; `absolute` resolves `..` without touching the disk |
| 2 unit tests | `web-app/src/containers/__tests__/CoworkAccessSelector.test.tsx`, `useDirectEditGrants.test.ts` | each write mode asks its own capability: Windows offers Managed worktree while Edit this folder stays blocked |
| Real WebView scenario | `cowork-smoke --only managed-worktree-review` | see the proposal section above. **Passed on Windows 2026-09-10** |

Mutation-checked: removing the probe's kill makes the hang test fail.

## Undo and redo by turn (AH-202)

| Evidence | Where | Covers |
| --- | --- | --- |
| 11 unit tests | `plugins/tauri-plugin-agent-tools/src/undo.rs` | undo restores what a turn changed and redo puts it back; several writes in one turn undo to the state before the turn; a file changed since refuses the whole undo, names it and changes nothing; a later turn on the same file blocks undoing the earlier one; a path outside the roots the session may write now is refused; a change recorded by a relative path can still be undone (mutation-checked); undoing twice and redoing without an undo are refused; the position survives a restart and is per session; a change that ends where it started is not recorded; a tampered stored copy refuses and writes nothing; a failed write rolls back the files already restored |
| 1 integration test | `plugins/tauri-plugin-agent-tools/src/commands.rs` | through `execute_tool`/`undo_turn`/`redo_turn`: a write for a run is journaled, undone, redone, and refused once the user edits the file; a write with no run is not journaled |
| 7 unit tests | `web-app/src/containers/__tests__/CoworkTurnUndo.test.tsx` | newest first with undo or redo by state; the session grant is sent; a refusal is announced with `role=alert` and changes nothing; every control names its turn; an odd backend answer renders nothing instead of crashing the page |
| Real application restart | `cowork-smoke --only restart-persist-1`, then `--only restart-persist-2` in a new process | phase one runs a Cowork turn whose `write` creates a file and undoes it from the Changes panel; phase two, in a fresh process on the same data folder, lists that turn as undone, redoes it from the panel, and the file is back with the turn's content. **Passed on Windows 2026-09-10** |

## Confined `@` references (AH-204, containment only)

| Evidence | Where | Covers |
| --- | --- | --- |
| 20 unit tests | `web-app/src/lib/__tests__/safeReferences.test.ts` | relative paths accepted and normalized; `..`, `/abs`, `C:\`, `c:/`, UNC, `~` and `file://` refused before the backend is asked; a file is read through the confined reader; the backend's refusal (a symlink out of the folder, a key file) is reported; a folder is listed; nothing is offered or resolved without an attached folder; the picker offers only folder-relative entries |
| 2 unit tests | `web-app/src/containers/__tests__/ChatInput.test.tsx` | the picker opens where a folder is attached even outside chat agent mode (Cowork) and searches through the confined listing; with no folder nothing is searched or shown. Mutation-checked: restoring the agent-mode gate fails the first |
| 6 unit tests | `web-app/src/lib/__tests__/coworkReadiness.test.ts` | a file reference (`@src/index.ts`, `@README.md`, `@docs\guide.md`, `@src/index.ts:24-48`) is not read as a skill request, which used to resolve as missing and stop every change; an `@mention` naming a known skill still counts, dots included; an unknown plain `@name` is still an explicit request |
| Real WebView scenario | `cowork-smoke --only at-references-confined` | typing `@ind` in Cowork offers `src/index.ts` and no absolute path; a message naming `@src/index.ts`, `@../outside-secret.txt` and the absolute path of that file sends the in-folder file's content and neither the outside content nor its path, and says twice that a reference was not included. **Passed on Windows 2026-09-10** |

The unified menu (skills, agents, aliases in one ranked list) and references
that survive a rename are not built, so AH-204 stays `in-progress`.

## The change in the approval prompt (AH-146)

| Evidence | Where | Covers |
| --- | --- | --- |
| 1 integration test | `plugins/tauri-plugin-agent-tools/src/commands.rs` | `preview_change` returns the diff a `write` or `edit` would make without writing; a path outside every root the session may write -- absolute or climbing -- has no preview and is not read; other tools have none |
| 2 unit tests | `web-app/src/lib/__tests__/coworkDispatch.test.ts` | in Ask mode the backend preview for the session's workspace and grant is handed to the prompt; a failed preview still asks, without a diff |
| 2 unit tests | `web-app/src/components/ai-elements/__tests__/tool.test.tsx` | the pending approval renders the diff as a named region; a call with no diff shows none |
| Real WebView scenario | `cowork-smoke --only managed-worktree-review` | the approval prompt for the worktree write shows `LINE 1 (agent)` before Allow Once is clicked. **Passed on Windows 2026-09-10** |

## Stopping a process tree on Windows (`kill_tree`)

| Evidence | Where | Covers |
| --- | --- | --- |
| 4 unit tests | `plugins/tauri-plugin-agent-tools/src/tools/proc.rs` (`windows_tests`) | a running command is stopped within 5 s and its process is gone; a pid that does not exist reports `Gone`; a grandchild (`cmd` running `ping`) is stopped with its parent; a process outside the tree is left running |
| 1 unit test | `plugins/tauri-plugin-agent-tools/src/tools/jail.rs` | a timed-out probe's shell is stopped with the probe |
| existing suite | `tools::handlers::bash_job_registry_tests` | stopping a background job reports `Killed` and hands over its output. These failed on this host through `taskkill` ("the timeout period expired") and pass now |

Mutation-checked: skipping the descendants makes the tree tests fail. Run the
plugin suite as `cargo test -p tauri-plugin-agent-tools -- --test-threads=4`,
not with `--lib`: without the `jan-sandbox-helper` binary, the sandbox probe
re-executes the test binary and every `bash` test reports that no shell starts.

## One `@` menu, and aliases (AH-204 / AH-205)

| Evidence | Where | Covers |
| --- | --- | --- |
| 6 unit tests | `web-app/src/lib/__tests__/referenceMenu.test.ts` | files, skills, agents and aliases rank in one list, each inserting its identifier (`src/a.ts`, `skill:x`, `agent:x`, `alias:x`); exact above prefix above substring; a `kind:` query narrows to that kind; the others are still offered when the file index is empty; a name a typed token cannot carry is never offered; files only as folder-relative paths |
| 13 unit tests | `web-app/src/lib/__tests__/referenceAliases.test.ts` | an alias names a path inside its folder and belongs to that folder only; `..`, `/abs` and `C:\` targets refused; a name `@alias:` cannot carry refused; a taken name is not silently repointed and the refusal names what it names; no folder, no alias; only the aliases are persisted; two spellings of a Windows folder are one; resolution goes through the confined reader at use time; a target that now escapes (a swapped symlink) is refused naming the path; a broken alias names the path it cannot find; another folder's alias does not resolve |
| 2 unit tests | `web-app/src/lib/__tests__/path-references.test.ts` | typed references parse whole; skill and agent references stay in the text, aliases are replaced by what they name |
| 1 unit test | `web-app/src/lib/__tests__/coworkReadiness.test.ts` | `@skill:x` is a skill request; `@agent:x` and `@alias:x` never are |
| 6 unit tests | `web-app/src/containers/__tests__/ChatInput.test.tsx` | one list of files, skills and agents; the arrows move the active row (`aria-activedescendant`) and Enter inserts it without sending (mutation-checked); Escape closes without sending; Alt+A names the active file, the field is labelled with its path, the save is announced and focus returns to the composer; a refused name is announced with `role=alert` and nothing is saved; an agent reference tells the model how to reach it and names one that is not saved |
| Real WebView scenario | `cowork-smoke --only unified-at-menu` | with a skill in the folder and a saved agent in Jan's store, `@rev` offers the skill, the agent and the file in one list and no absolute path; ArrowDown moves the active row and Enter inserts its token instead of sending; Alt+A names `src/index.ts` as `entry` from the keyboard, the save is announced and focus returns; `@alias:` offers it back; sending `@alias:entry` and `@agent:review-bot` gives the model the file's content and how to reach the agent. **Passed on Windows 2026-09-10** |
| Real application restart | `cowork-smoke --only alias-persist-1`, then `--only alias-persist-2` in a new process | an alias saved from the keyboard reaches `settings.json`; after a restart it is offered again and resolves to the same file |

A selection is named with the same keystroke: the alias field has an optional
line range (`12-20`). Covered by 4 more unit tests in `referenceAliases.test.ts`
(a selection resolves to its lines only; `0`, `5-2`, `a-b` and `1-` are refused;
a file that no longer has the lines says so, naming them) and 1 in
`ChatInput.test.tsx` (the lines field is labelled and the range is stored), and
by `unified-at-menu`, which names line 1 of `src/index.ts` from the keyboard and
sends it: the model receives that line and not the file's last line. **Passed on
Windows 2026-09-10.**

## Project initialization assistant (AH-209)

| Evidence | Where | Covers |
| --- | --- | --- |
| 8 unit tests | `plugins/tauri-plugin-agent-tools/src/project_init.rs` | a Node project is described from `package.json` and the README (name, description, scripts, languages); a Rust workspace is described from `Cargo.toml` and its `build.rs` is never run; `.gitignore`d and credential-shaped files are neither listed nor read; a symlink out of the folder is not followed; a tree past the bounds is surveyed partly and says what it did not list; accepting writes exactly the text, refuses to overwrite unless asked and leaves no temporary file (mutation-checked); empty or oversized text writes nothing; a `JAN.md` that is a link is never written through. The link tests ran for real on this Windows host, where creating a symlink is permitted |
| 7 unit tests | `web-app/src/containers/__tests__/CoworkProjectInit.test.tsx` | not offered without a folder or with a `JAN.md`; a draft is proposed with what was not read, labelled, and nothing is written; accept writes exactly the edited text and clears the draft; a refusal is announced with `role=alert` and keeps the draft; an edited draft survives closing and is continued rather than re-surveyed; an abandoned survey's result is dropped; only drafts are persisted |
| Real WebView scenario | `cowork-smoke --only project-init` | on the fixture, the dialog proposes a `JAN.md` named from `package.json`, carrying the README's description and the language, and lists what was not read; nothing is on disk until Accept; the edited text is written byte for byte; the offer goes away once `JAN.md` exists; a second write over it is refused by name and changes nothing |
| Real application restart | `cowork-smoke --only project-init-draft-1`, then `--only project-init-draft-2` | a draft edited and closed without accepting reaches `settings.json`; after a restart the offer reads "Continue the JAN.md draft", the edit is there, and discarding it writes nothing |

## Handing a session to another computer (AH-210)

| Evidence | Where | Covers |
| --- | --- | --- |
| 3 unit tests | `src-tauri/src/core/agent/session_bundle.rs` | a handoff names the folder by name, branch and 40-character commit and carries no path from this machine -- the folder, Jan's data folder and the home folder are replaced by `<folder>`, `<jan-data>` and `~` in either separator (mutation-checked) -- and keeps only the model's provider and id, dropping a key sent with it; it is still an export this and older builds import; a handoff with no folder says so; a folder that is not a checkout is named without a branch |
| 7 unit tests | `web-app/src/lib/__tests__/sessionHandoff.test.ts` | the folder is always something to attach; a provider missing or unusable here and a model its provider does not offer are named; nothing to say for a session with neither; each item said plainly; an attached folder matches, or every difference is named |
| 5 unit tests | `web-app/src/containers/__tests__/CoworkHandoffNotice.test.tsx` | item by item in a live region; an attached folder is checked through the backend and replaces the request; a different branch is named; dismissal is final; nothing for a session that was not handed off |
| 3 unit tests | `web-app/src/hooks/__tests__/useCoworkSessions.handoff.test.ts` | the record is kept on a new, unbound session with no access; dismissal is remembered; an ordinary export has no record |
| Real WebView scenario | `cowork-smoke --only session-handoff` | a run in a session with the fixture attached is handed off through the session menu with the save dialog scripted; the file carries the conversation, `<folder>`, the folder's name and commit and the smoke provider's name, and no path under the workspace in either separator and no provider key; importing it names the folder to attach and does not report the model missing; attaching the fixture is checked as a match; a copy naming `not-a-model` is imported and the model is named as unavailable. **Passed on Windows 2026-09-10** |
| Real application restart | `cowork-smoke --only handoff-persist-1`, then `--only handoff-persist-2` | a handoff whose folder and provider this machine lacks is imported and reaches `settings.json`; after a restart the imported session still names both, and dismissing the notice works |
