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
| Native title bar and window placement | not run (config unchanged: borderless, app-drawn controls) | not run (config unchanged: overlay title bar) | passed (real mouse input, restart in a new process) | passed |
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


## Native Windows title bar and window placement

The Windows window uses the operating system's own title bar
(`decorations: true` in `tauri.windows.conf.json`). The app no longer draws
caption buttons there, declares no `data-tauri-drag-region` under a native
bar, and has no full-width strip over the top of the page. macOS keeps its
overlay title bar and Linux its borderless window; neither configuration
changed, and neither was run.

| Evidence | Where | Covers |
| --- | --- | --- |
| 14 unit tests | `src-tauri/src/core/window_state.rs` | a frame on screen comes back exactly; logical size survives a monitor with different scaling; a record for an unplugged monitor, or with its title bar off every screen, falls back to the default; a frame hanging off an edge is pulled back inside; oversize and undersize frames are clamped; nonsense sizes fall back; maximised survives restore and fallback; the normal frame is the OS placement's, whether the window is maximised or minimised (Windows parks a minimised one at -32000); sizes are logical; corrupt and older records load safely |
| 10 unit tests | `web-app/src/containers/__tests__/HeaderPage.test.tsx` | no drag region and no reserved caption-button room under a native title bar; the drag region and its clickable controls where the app draws its own chrome. The three native-bar tests fail against the previous header |
| 3 unit tests | `web-app/src/routes/__tests__/__root.test.tsx` | no app-drawn caption buttons, grips or top strip under a native title bar; drawn only for the borderless window |
| 5 + 9 unit tests | `web-app/src/lib/__tests__/titlebar.test.ts`, `windowTitle.test.ts` | who draws the chrome per platform; the window title names the chat or Cowork session and project folder without any path |
| Real Windows scenario, real mouse input | `cowork-smoke --only window-chrome` with `COWORK_SMOKE_REAL_INPUT=1` and `COWORK_SMOKE_KEEP=<dir>` | starts unmaximised; drags by the native caption and the frame moves by exactly the pointer's travel with no resize; minimise button, then restore; double-click maximises and restores to the same frame; minimise again after that restore; maximise/restore caption button; a button just under the title bar receives a trusted click and the window does not move; the band under the title bar hit-tests as client area end to end; no drag region in the page; the record is written with the normal frame and `maximized: true` |
| Restart in a new process | `cowork-smoke --only window-chrome-restart`, same `COWORK_SMOKE_KEEP` | the window comes back visible, on a monitor, maximised, and restoring it returns exactly the normal frame the first process left |

Aim at what is drawn. On Windows 11 `WM_NCHITTEST` still answers with the
legacy caption-button geometry, which is narrower than the buttons DWM draws;
its "minimise" centre sits on the visible maximise button, and a real press
there maximises -- a plain WinForms window does the same. The scenario aims
through `DWMWA_CAPTION_BUTTON_BOUNDS`, as a person aims at the drawn button.
Its first six runs aimed through the hit test and failed at the minimise step
for that reason; the logs are kept in `C:\tmp\jan-dwi\logs\wc-1..6-first.log`.

The scenario also drags the window by its title bar onto the second monitor
and checks it lands there with the same logical size. That step found a real
defect: the first implementation rebuilt the normal frame from debounced move
and resize events, so a move made just before a maximise was lost and the
record kept the other monitor's position (`FIRST-FAILURE-mm1-first.log`, 3 of
3 runs). The normal frame is now read from `GetWindowPlacement` and restored
with `SetWindowPlacement` while the window is hidden. The same change removed
a restart race in which tao's queued move landed after the maximise
(`FIRST-FAILURE-rep2-restart.log`, 1 of 4 restarts).

Run history on this host (two 100% monitors), every run a new pair of
processes:

| Build | Runs | Result |
| --- | --- | --- |
| hit-test aiming | 6 | failed at the minimise step (harness aim, see above) |
| DWM aiming, event-built record | 1 + 3 + 5 | 7 passed; 1 restart came back unmaximised (race); 2 failed under concurrent desktop use (foreground lost, pointer on the other monitor mid-drag) |
| + cross-monitor step | 3 | 3 failed: record kept the other monitor (defect, fixed) |
| placement record | 3 | 3 passed, first run and restart |

Not verified: monitors with different scaling (both monitors here are 100%;
the placement logic is unit-tested for it), Snap Layouts flyout selection,
macOS and Linux. The real-input scenario moves the desktop's actual pointer,
so a person using the machine at the same time can fail it; the failure
message then says whether the window still had the foreground.

## Background tasks: lifecycle, isolation and restart (AH-101 / AH-102)

One task system, extended rather than duplicated: background `bash` jobs live
in the agent-tools plugin's job registry, subagents in the Rust loop's
`BackgroundSubagents` and the Cowork runner, and the desktop records both in
the canonical activity model (`coworkActivity`) that the Background Tasks
panel, the inline workflow card and the activity chip all read.

| Evidence | Where | Covers |
| --- | --- | --- |
| unit tests | `plugins/tauri-plugin-agent-tools/src/tools/handlers.rs` (`bash_job_registry_tests`) | another conversation's job is invisible and untouchable (list, status, collect, kill all read as "no such job"); a status check shows state and recent output and never takes the result; listed commands and peeked output are redacted; a finished job reports its exit code, a stopped one says so; the registry is bounded per conversation (oldest finished job makes room, all-running refuses); job ids carry a per-process prefix; the live tail is bounded and keeps the end |
| unit tests | `src-tauri/src/core/agent/subagent.rs` | one running child cancelled while its sibling finishes; a queued child cancelled before it starts, releasing its queue count exactly once and never taking a slot; finished, unknown and repeated cancels reported as such; teardown after a cancel announces nothing twice; the two new tools are routed to the subagent handler |
| unit tests | `web-app/src/lib/__tests__/coworkBackgroundLifecycle.test.ts` | restart marks live work *interrupted by application exit*, never running; older `cancelled` + restart records read the same way; a late event cannot revive interrupted work; job lookup confined to the session; a finished job's exit code, signal or stop request decides its row; only a collection settles a row; no credential from a command line or its output reaches the stored record; the end of a long log is kept |
| unit tests | `coworkCancel.test.ts`, `CoworkTasksPanel.test.tsx` | kills are scoped to the session; a failed stop stays on the row; kind in words, exit code, start/end time, copy of the whole output; finished workflows render a bounded page |
| Real Windows app, real IPC | `cowork-smoke --only background-job-isolation` | `execute_tool` runs `bash {"background": true}` in the confined shell (PowerShell 5.1 in AppContainer on this host) and gets a job id at once; another session's `bash_jobs_list` shows nothing and its `bash_job_kill` answers `unknown` without stopping anything; the listed command is redacted; the owner's kill reports `killed`, the job says `stoppedByRequest`, and the kernel shows the job's `ping` gone (1 process before, 0 after); another session's collection is refused; the owner collects once and a second collection is refused. **Passed on Windows 2026-09-11.** Its first two runs failed on the scenario's own command (`&&` is not a PowerShell 5.1 separator; logs `FIRST-FAILURE-bgjob.log`, `bgjob-2.log`) |
| Mutation checks | `C:\tmp\jan-dwi\mut2.sh` | removing the owner check on collection, the queue-count release on a queued cancel, output redaction, or the `interrupted` restart state each fails its test |

### Restart semantics

Jobs and subagents are run-scoped: nothing keeps running once the app exits
(`proc::kill_all` reaps every process tree at graceful exit; subagent futures
die with the process). After a restart the record is truthful rather than
hopeful -- anything left in flight is `interrupted` with the reason
"Interrupted by application exit", its stale job id is dropped, and it can
never be shown as running. No durable worker exists, so AH-101's persistence
criterion is not met and the item is `in-progress`.

## Execution record v2: one contract for Chat and Cowork (AH-050 / AH-200)

| Evidence | Where | Covers |
| --- | --- | --- |
| 23 unit tests | `plugins/tauri-plugin-agent-tools/src/activity.rs` | one item per call; request order under interleaved results; refusal, cancellation, failure and interruption distinct; sequence numbers continue across a restart; version-1 lines and lines with fields from a later build (a snapshot id, token usage) still read; a damaged line costs that line only; two sessions reusing a call id stay two items with stable `session|call` ids; an edit keeps its own diff and +/- counts; an oversized diff is counted, not kept; a diff path cannot leave the audit folder; input bounded to its start, output to its end, unrecorded output reads `unavailable`; no credential reaches the log or a stored diff; lifecycle events (compaction, steering) share the sequence; the export joins decisions and activity for one session only |
| 10 unit tests | `web-app/src/lib/__tests__/toolActivityRecord.test.ts` | Chat and Cowork write the same event keys, each under its own session; input on the request, outcome and diff on the end; a chat-shaped error is a failure; a background job id and exit code are captured; an aborted run is cancelled; the outcome is passed through untouched; a huge input is bounded; lifecycle events; a stored diff is read by session and call, and is unavailable rather than empty when missing |
| Real Windows app, real IPC | `cowork-smoke --only execution-record` then, in a new process on the same profile, `--only execution-record-restart` | events written through `tool_activity_record` read back from `tool_activity_items` in sequence with the edit's +2/-1 counts, the compaction lifecycle item, the failed command's exit code; no credential in the items or the stored diff; another session cannot read the diff; `audit_export` is scoped to the session and refuses an empty one; after a restart the same items come back in the same order with the same states. **Passed on Windows 2026-09-11** |

Run history for batch 3 (retries disabled): first combined run -- `background-job-isolation` failed because `ping` in the AppContainer reported "Unable to contact IP driver" and ended before the kill (the scenario now sleeps instead); second -- `tool-activity-timeline` failed on a WebView stall (the page stopped answering scripts); third, and `tool-activity-timeline` alone -- all passed. Logs: `.dwi-artifacts/logs/gate-b3final`, `gate-b3scen2`, `gate-b3scen3` in the session worktree.

Negative authority (AH-200, unit level): `event_export.rs::another_sessions_run_or_a_path_shaped_session_exports_nothing` (another session's run named under this session, and `../s1`, `s1/../s2`, `S1`, `s10` reach no log and write nothing), `event_export.rs::a_planted_event_of_another_session_is_refused_not_exported` (a foreign line in a session's log makes the export refuse with `LogUnreadable`), `activity.rs::an_audit_export_holds_only_its_own_session` (no prefix-sharing session, no session-less decision, no other session), and `loop.rs::a_model_cannot_call_an_export_or_audit_command_by_name` (export and audit commands are not offered as tools; a role naming them is refused `tool-not-offered` before any gate and nothing is written). No real-app scenario attempts these refusals.

Steering is represented only as a lifecycle name (`lifecycle: "steering"`); no steering implementation is imported here. Prompt snapshots and token usage attach later through the existing `invocation` join key and optional fields, which older and newer builds both tolerate -- no second event store.

Recommendation for the per-edit timeline diff (not implemented): generate a standard unified diff in the backend from trusted before/after snapshots (the undo journal already captures both), rather than treating the tool's custom display diff as authoritative.
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

## Team children: pre-run overlap check and per-child review (AH-109 / AH-107)

| Evidence | Where | Covers |
| --- | --- | --- |
| 14 unit tests | `web-app/src/lib/__tests__/coworkTeamScopes.test.ts` | a declared path that could leave the project (`..`, `/abs`, `C:`, `c:x`, UNC, `\\?\`, `~`, a stream) is refused, and refuses the whole team; Windows spellings normalise; the same file however spelled, a folder and something inside it, either end of a move, a delete and a regenerated lock file are overlaps, and a prefix of a name is not; reads never conflict; ordered tasks never conflict; serializing adds an ordering-only edge that neither blocks on a failure nor trips the isolation rule; a revised scope is looked at again; `runTeam` refuses an overlap nobody decided and runs an allowed one; an allowance covers only the overlap that was shown. Mutation-checked: six mutations (no refusal in `runTeam`, no case-fold, reads counted, `after` ignored, no lock-file table, `..` allowed) each fail a test |
| 4 unit tests | `web-app/src/containers/__tests__/CoworkTeamConflicts.test.tsx` | the overlap names both tasks, the path and both briefs; Continue waits for an answer to every overlap; serialize and revise answers are sent as chosen; declining, and stopping the run, answer "cancel" |
| 5 unit tests | `web-app/src/containers/__tests__/CoworkTeamReviews.test.tsx` | each child's task, state, branch, base, worktree, files and counts; a failed child's review stays shut until acknowledged, and its proposal is asked for by identity with the acknowledgement, never by path; a deleted worktree and a link escape cannot be reviewed at all; a side-by-side decision is shown. Mutation-checked: dropping the acknowledgement gate, or treating `link-escape` as reviewable, fails a test |
| 6 integration tests | `src-tauri/src/core/agent/team_children.rs` | on real git worktrees: identity worked out from Git, never from the renderer; a record swapped on disk refused; a completed child listed with counts and proposed; failed and cancelled children refused as clean proposals and marked when acknowledged; a worktree changed after its child finished, and a deleted one, are typed errors; a child `running` in another process's record is interrupted; a junction out of a child's worktree refused |
| 3 integration tests | `src-tauri/src/core/agent/proposals.rs` | a junction out of any worktree refuses its proposal; a nested `.git` (any case, trailing dot) is never proposed |
| 3 unit tests | `plugins/tauri-plugin-agent-tools/src/proposal.rs` | Windows spellings of `.git`, device names, streams and trailing dots/spaces refused on every platform; a destination directory swapped for a junction after review is refused at apply with nothing written anywhere; list counts equal proposal counts |
| 4 integration tests | `src-tauri/src/core/agent/subagent.rs` | AH-107: two writing children dispatched in a git project get distinct worktrees under Jan's folder, recorded before they start, and a reused run id never lands in an earlier checkout; a read-only child and `isolate: false` share the tree; isolation asked for where it cannot be had is a typed refusal; the first ending of an isolated child is the one kept |
| 2 + 2 + 3 unit tests | `useToolApprovalRequests.sameId.test.ts`, `CoworkChildApprovals.test.tsx`, `coworkStreamCutOff.test.ts` | defects the scenario found: two approval requests under one call id are shown in turn and both answered (the old code hangs the first); a child's request is shown on its own and answered there; a reply cut off mid-stream (`finishReason: 'other'`, no `rawFinishReason`) ends the turn as an error, never as done |
| Real WebView scenario, through the UI, **phase one** | `cowork-smoke --only team-review-persist-1` (mock provider, Windows) | a team of four isolated tasks (`alpha` and `beta` both declare `team-target.txt`): **the overlap is shown before any child runs**, naming both tasks, the path and both briefs, with no child request at the model and no child recorded; "Run alpha first, then beta" is chosen; each child's write is allowed in its own prompt; beta starts after alpha ends; four distinct worktrees under Jan's folder, all based on the project's HEAD, on `jan/cowork/` branches; the attached folder untouched by the run; the run is stopped with delta still going. The review list shows alpha and beta completed, gamma failed (its stream was cut off) and delta cancelled, with branch, base and `+2 -2` for alpha. Gamma and delta cannot be reviewed until acknowledged; the backend refuses gamma's proposal without it (`kind: incomplete`), and the proposal made after acknowledging says "failed, reviewed despite the warning". Alpha's diff shows both hunks; with one unticked, the folder holds exactly the other. Beta's proposal, applied against a line edited in the folder since, is refused with the conflict against its hunk; the folder is byte-for-byte unchanged and beta's new file is not written. A junction created in gamma's worktree refuses its proposal (`kind: link-escape`). **Passed on Windows 2026-09-11, first attempt, retries off** |
| Real WebView scenario, **phase two after a real restart** | `cowork-smoke --only team-review-persist-2` on the kept profile | a new process on the same data folder and WebView profile: all four children are listed with their endings (alpha and beta completed, gamma failed with its junction reported as `link-escape`, delta cancelled); alpha's proposal is partly applied and beta's and gamma's are still waiting; beta's stored review reopens with its proposal intact and, once the conflicting line is put back, applies: the folder holds alpha's hunk and beta's change, and beta's new file lands. **Passed on Windows 2026-09-11, first attempt** |
| 3 regression tests for the sandboxed shell | `readiness::tests::an_unattached_session_finds_the_shell_a_folder_would`, `handlers::tests::a_sandboxed_command_runs_in_a_relatively_spelled_workspace`, `handlers::tests::a_sandboxed_command_starts_in_its_workspace` | why no Cowork run on this host was offered `bash`, and two defects behind it. The unattached probe used all of `%TEMP%` as the sandbox workspace; it failed on the old code (no-folder unavailable vs folder Degraded, 81 s) and passes with an empty Jan-owned probe directory (1.6 s). A relatively spelled workspace (default `./data`) made every command fail in setup. Sandboxed PowerShell started at a drive root instead of the workspace. Each test fails with its fix reverted |
| 2 Windows integration tests | `plugins/tauri-plugin-agent-tools/tests/windows_sandbox.rs` | the shell this host selects (PowerShell; MSYS2 bash fails with `STATUS_DLL_INIT_FAILED` in an AppContainer) writes a Jan-owned worktree granted as a write root and is refused on the user's checkout beside it; a sandboxed command stopped part-way leaves no helper, shell or grandchild running |

| Review fixes (after `1e925e397`) | `proposal.rs`, `proposals.rs`, `proc.rs`, `team_children.rs`, `useToolApprovalRequests.sameId.test.ts`, `CoworkChildApprovals.test.tsx` | `GIT~1` and any `git~N`/`jan~N` refused by spelling, and at apply by where the path resolves (measured against a real short name on Windows); a workspace named with `’` neither breaks PowerShell nor runs an injected command (real PowerShell); an answer names its request, so a repeated click cannot answer the next one, and buttons pause 600 ms when the request under them changes; a child's queued request is shown; racing settles agree on one ending. Mutation-checked: 7 mutations (spelling rule off, resolution check off, only `'` doubled, lock off, answer ignores its id, no pause, queued hidden) each fail a test |
| Full round r44, retries off | all suites plus `team-review-persist-1`, `team-review-persist-2`, `managed-worktree-review`, `proposal-review-apply` | app `core::agent` 392 passed; plugin 780 passed (1 ignored) and 13 Windows sandbox tests; web typecheck, 5753 + 171 + 320 tests and `build:web`; every scenario passed on its first attempt. Earlier rounds r39 and r43 each stalled once at a proposal-apply click (see the handoff: open, undiagnosed) |

Not run: macOS, Linux, and any real model. The scenarios use the mock
provider; they are UI coverage, not real-model verification.

Run: `cargo test -p tauri-plugin-agent-tools -- --test-threads=4 proposal::`,
`cargo test --lib --no-default-features --features test-tauri -- team_children proposals subagent`,
`npx vitest run src/lib/__tests__/coworkTeamScopes.test.ts src/containers/__tests__/CoworkTeam*`.

## Shipped agent roles (AH-094 … AH-099)

| Evidence | Where | Covers |
| --- | --- | --- |
| 4 unit tests | `src-tauri/src/core/agent/roles.rs` | the read-only roles hold only read-capability tools, checked against the capability table; every role lists real tools and no dispatch tool, the implementer is the only writer and the tester the only shell user; a parent that denies writes gets an implementer that cannot write, and a call-site request for `write` on the reviewer is refused even under an allow-all parent; every role is a versioned built-in with no model of its own |
| 2 registry tests | `src-tauri/src/core/agent/subagent.rs` | with nothing saved the registry holds exactly the shipped roles; a saved definition of the same name replaces a role; the built-in scope cannot be written through `create`, `create_in` or `subagent_dir_for` |
| 5 unit tests | `web-app/src/lib/__tests__/coworkRoles.test.ts` | as the renderer resolves them: read-only roles get no write, edit, bash, network or MCP tool; a call site cannot widen a role; a role never holds what its parent lacks; no role is offered `task`, `team`, `ask` or `todo`; a saved definition listed first wins |
| Windows scenario `agent-roles` (mock provider) | `src-tauri/examples/cowork_smoke.rs` | the desktop list returns the six roles as `builtin`, versioned, with no mutating tool on a read-only role; a real parent run in Ask before changes dispatches the built-in reviewer and explorer with `task`; each child is offered only `read`, `ls`, `find`, `grep`, `skill_list`, `skill_read`; the fixture's scripted `write` and `bash` calls are refused as unavailable, no approval prompt appears, no file is written, the tool-activity record has no write or bash for either role; both answers reach the parent; the UI names both children |

Superseded on 2026-09-11 (feat/integrated-phase-2), which adds:

| Evidence | Where | Covers |
| --- | --- | --- |
| 2 loop tests | `src-tauri/src/core/agent/loop.rs` | for each of the six roles, under the CLI's auto-approval, forged `write`, `edit`, `bash`, `task`, `dispatch_subagent`, `ask`, `todo` and an MCP tool are each refused as `HarnessRefusal::ToolNotOffered` before any gate, nothing is written or edited, and the role's own `ls` runs; without an allowlist nothing is refused that way |
| 2 web tests | `web-app/src/lib/__tests__/coworkRunnerRecord.test.ts` | a call the runner refuses is recorded under its run and agent as a refusal of kind `tool-not-offered`; the SDK's reasons map to `tool-not-offered` / `invalid-call` |
| Windows `agent-roles` (mock provider, retries off) | `cowork_smoke.rs` | all six roles dispatched through the UI in one run; each child is offered exactly its allowlist plus `skill_list`/`skill_read`; every scripted call outside it (write, edit, bash, and a nested `task`) is recorded as a typed `tool-not-offered` refusal under that role in the run's session; no file is written or edited; no child reaches an approval prompt; the UI names every child |
| Windows `agent-role-cancel` then `agent-role-cancel-restart` | `cowork_smoke.rs` | all six roles running at once, each stopped on its own from the Background Tasks panel while the others keep running; each ends as cancelled; six `subagent` cancellations are in the session's record; no cancelled role calls the model again; no raw translation key on screen; in a new process on the kept profile all six read back as cancelled (not running, not interrupted), the six built-ins are listed, and nothing is dispatched |

Not covered: Chat has no subagents, so roles do not apply there; the CLI's
enforcement is shown by unit tests, not a CLI session; escalation through a
saved definition is by design (a saved definition of the same name replaces
the role with its own allowlist, `a_saved_definition_shadows_a_builtin_role`),
and escalation through handoff, replay, import or edited serialized state was
not exercised.

First attempts, kept: ro1 and ro2 timed out waiting for the page (the lost
event-bus result, fixed below). ro3 and ro4 got no child at all: attaching a
repository leaves the session in Review first, a plan mode that withholds
`task`. ro5 still dispatched nothing: "Dispatch …" is not a directive verb, so
the first turn was an opening inspection, which runs in review. ro5b exited 0
with no scenario verdict (the app shut down before the driver finished) and
is not counted as a pass. ro6 and ro7 failed on the scenario's own checks: it
waited for summary text that is folded into the task cards, and a filter still
named the old prompt. ro8 and ro8b passed, but they are not counted. When
ro5b's app shut itself down, the harness never stopped its fixture server,
which kept listening on port 8080. Every later run, ro6 to ro8b and the first
full gate g3, started a second server on the same port. The first gate's
`context-replay` pair then failed against the leftover server's request log.
The leftover server was stopped. The harness now refuses to start when the
port answers, and the runner reports any listener left after a scenario. The
role evidence is taken from runs after that fix: see the handoff.

**Harness transport.** `Ctx::eval_with_timeout` now leaves each result in
the page (`window.__smokeResults`) and collects it with `eval_with_callback`.
It no longer uses the Tauri event bus, whose `emit_filter` only `try_lock`s
its handler table and can park an emit indefinitely. This duplicates the fix
in `2bd94407a` on `claude/token-usage-integration`, ported as it is because
that commit is not on `fork/main`.

Run: `cargo test --lib --no-default-features --features test-tauri -- core::agent::roles core::agent::subagent`,
`npx vitest run src/lib/__tests__/coworkRoles.test.ts`.

## Canonical event log (AH-005) and event export (AH-177)

| Evidence | Where | Covers |
| --- | --- | --- |
| 6 unit tests | `plugins/tauri-plugin-agent-tools/src/event_log.rs` | events come back in `seq` order with their envelope, per session; the same id is one event, also after a simulated restart, and the sequence continues; a torn last line is skipped and cut off by the next write with every earlier line intact; an unknown kind is kept verbatim, a newer envelope version and a corrupt middle line are typed errors; payloads are redacted and bounded, and malformed ids, sessions and kinds are refused; every `activity::Phase` is a known kind |
| 4 unit tests | `plugins/tauri-plugin-agent-tools/src/event_export.rs` | a metadata-only export keeps order and drops prompts, paths and summaries, and holds no other session's events; content only when asked, and one run can be chosen; nothing to export and a stopped export leave nothing; a tampered, truncated, cross-session, reordered, newer-schema, extra-file or unknown-field export is a typed refusal |
| 4 + 2 component tests | `CoworkEventExport.test.tsx`, `eventLog.test.ts` | metadata only unless ticked, with the warning shown when it is; a typed refusal; stopping a running export; the inspector's summary and a damaged export's typed refusal; recording never throws into the run |
| Real WebView scenario, **phase one** | `cowork-smoke --only event-export-1` (mock provider, Windows) | a run with a tool call; the session details export its events metadata-only; a reader written in the harness, not the app's, checks every line is envelope 1 of that session in strictly increasing order and the manifest hash and count; the export starts with `run.started`, ends with `run.ended`, holds the tool's requested, running and terminal phases in the durable tool-activity record's order, and holds no prompt, `resource`, `summary`, `title` or project path; the content export appears only once ticked, after the warning, and holds the run's title; the inspector reads the export back; a tampered copy is refused (`hash-mismatch`). **Passed on Windows 2026-09-11, first attempt** |
| Real WebView scenario, **phase two after a real restart** | `cowork-smoke --only event-export-2` on the kept profile | a new process exports the same session's events with exactly the same ids in the same order, and phase one's export still reads back. **Passed on Windows 2026-09-11** |

Mutation-checked: keeping content in a metadata-only export, no
deduplication, no torn-tail repair, accepting a newer envelope, no redaction,
keeping a partial export, an inspector that trusts the hash, and one that
skips the order check each fail a test.

Not covered: the Rust CLI and subagent loop's `StreamEvent`s, and steering
and compaction, are not yet in the log (AH-004 stays in progress). Mock
provider only; macOS and Linux were not run.

## Bundle import (AH-169), and the flag review UI (AH-154 / AH-155 / AH-156)

| Evidence | Where | Covers |
| --- | --- | --- |
| 2 unit tests | `plugins/tauri-plugin-agent-tools/src/patch_export.rs` | whatever the exporter writes reads back to exactly the proposed content (edits, additions, deletions, missing final newlines, emptied files); a patch that does not fit its base, has mismatched names or counts, repeats a file or carries a rename header is refused |
| 1 unit test + 2 updated | `review_flags.rs`, `proposal.rs` | binary content and deletions are flagged in every proposal; an existing binary and an existing deletion test now also prove the file lands only when acknowledged |
| 11 integration tests | `src-tauri/src/core/agent/bundle_import_tests.rs` | on real git, an exported bundle imported into a fresh clone: <br>• **Round trip:** every file matches the worktree byte for byte; the clone stays on its branch with nothing staged, and an unrelated dirty file is untouched. <br>• **Acknowledgement:** five flagged files are refused until acknowledged. <br>• **Twice:** importing or applying the same bundle again is `already-applied`. <br>• **Partial:** one hunk of two lands. <br>• **Stale destination:** an edit after review is refused whole, by hunk, with nothing written. <br>• **Binding:** another bundle hash, manifest hash, destination or import is refused. <br>• **Tampered bundle:** 9 kinds (patch, binary, declared hash, unknown field, version, base, extra entry, missing entry, truncated manifest), each typed and leaving no private copy. <br>• **Hostile paths:** 16 kinds (`..`, absolute, drive, UNC, backslash, stream, device, `.git`, nested `.git`, `GIT~1`, `.jan`, trailing dot, decomposed Unicode, case collision, Unicode collision). <br>• **Container:** an archive, a missing folder, and size and count bounds. <br>• **Junction** inside a bundle (Windows). <br>• **Destination:** a repository without the base, and a subfolder, are refused. <br>• **Cancellation:** part-way and before the start, with a dead process's partial swept. <br>• **Abandon:** read back from disk, then refused at apply. |
| 5 component tests | `web-app/src/containers/__tests__/CoworkBundleImport.test.tsx` | the picked bundle and destination are sent; a typed refusal is shown; a closed picker does nothing; a running import can be stopped; a pending import shows its origin and applies through the import-bound approval, never the plain proposal apply; abandoning |
| Real WebView scenario, **phase one** | `cowork-smoke --only bundle-import-1` (mock provider, Windows) | through the Changes panel's Import button and its folder picker, against the attached project at the bundle's base:<br>• **Exported first:** a managed worktree with text, binary, dependency, lock-file, migration, deletion and new-file changes, exported through AH-168.<br>• **Refused, typed:** a tampered manifest, a tampered binary, a junction inside the bundle, and paths with `..`, absolute, drive, UNC, `.git`, `GIT~1`, a case collision and a Unicode collision. Each leaves no private copy and no record.<br>• **Stopped:** an import stopped part-way leaves nothing.<br>• **Imported:** the real bundle shows its origin, base and schema.<br>• **Flags in the review:** all five are shown; the dependency is named, the migration labelled irreversible and the lock file listed apart. Apply is held until each is acknowledged, and the acknowledgements are focusable, labelled controls.<br>• **Stale destination:** an edit to the project after review is refused against its hunk, with nothing written.<br>• **Tampered stored flags:** removed from the proposal on disk (re-hashed so it verifies), the review shows none, and Apply is refused by the backend as not acknowledged.<br>• **Applied:** one hunk of two, with one file left out; the rest lands; the unrelated file is byte-identical; HEAD, branch and index are unchanged.<br>• **Double-click:** one apply in the audit.<br>• **Again:** the same bundle is `already-applied`; a second bundle is left pending. **Passed on Windows 2026-09-11** |
| Real WebView scenario, **phase two after a real restart** | `cowork-smoke --only bundle-import-2` on the kept profile | both imports listed from disk (partially applied, pending); the pending one's review opens with its files; abandoning removes it, records it and writes nothing; the unrelated file is unchanged; no private copy is left. **Passed on Windows 2026-09-11** |

Mutation-checked: turning off the patch hash check, the path authorization,
the approval's binding to its bundle, the acknowledgement requirement, or the
rollback each fails a test.

What the scenario does not show: the destination is the attached project at
the base commit, not a separate clone (the clone round trip is the Rust test
above). The keyboard check proves each acknowledgement is focusable and
labelled; it does not send real key presses.

## Worktree export (AH-168)

| Evidence | Where | Covers |
| --- | --- | --- |
| 3 unit tests | `plugins/tauri-plugin-agent-tools/src/patch_export.rs` | text changes become one git-style patch in path order, with new and deleted markers; an unchanged file is left out; a missing final newline is marked; a file that is not text ships whole |
| 5 integration tests | `src-tauri/src/core/agent/worktree_export.rs` | on real git: a bundle applied with `git apply --check` and `git apply` to a fresh clone at the base, plus the files shipped whole, reproduces the worktree byte for byte (committed, uncommitted, deleted, new and binary files), the manifest and patch hash agree, and nothing in the worktree or checkout changed; no changes, the user's checkout, and a worktree moved off its branch are typed refusals with no bundle; a junction out of the worktree refuses the export (Windows); an export stopped part-way leaves nothing, and a partial bundle from a dead process is swept; a bundle path cannot leave the bundle |
| 2 component tests | `web-app/src/containers/__tests__/CoworkProposalReview.test.tsx` | Export as patch sends the run's own worktree record and shows where the bundle went; a refusal is shown; a team child's review, which has no record, offers no export |
| Real app over real IPC | `cowork-smoke --only worktree-export` (Windows) | an unchanged worktree is refused (`no-changes`); after a change, the bundle is written under Jan's exports folder with the change in its patch and the base in its manifest, and the user's checkout is unchanged; the checkout presented as a worktree record is refused (`not-managed`) |

Mutation-checked: keeping the partial bundle on failure, dropping the
managed-folder check, and not sweeping dead partial bundles each fail a test.

Not run: macOS and Linux. AH-169 (applying a bundle) is not implemented.

## Dependency, lock file and migration flags (AH-154 / AH-155 / AH-156)

| Evidence | Where | Covers |
| --- | --- | --- |
| 7 unit tests | `plugins/tauri-plugin-agent-tools/src/review_flags.rs` | a package added, upgraded, dev-added and removed in `package.json`, each named; a manifest edit that leaves dependencies alone is not flagged; Cargo dependencies in plain, `target.*` and `workspace` tables, including a git source; `requirements.txt`, `go.mod` and `pyproject.toml` entries; an unreadable manifest flagged, not passed; lock files flagged on their own; schema and data migrations, a migration directory, a deleted migration, and SQL without schema or data statements left alone |
| 4 integration tests | `plugins/tauri-plugin-agent-tools/src/proposal.rs` | a flagged file in an approval without acknowledgement is refused with `Unacknowledged` and nothing is written, the unflagged file included; acknowledging another file, or a differently cased path, does not cover it; acknowledged, it applies, and an unflagged file never needs it; **negative**: flags emptied in the stored record, re-hashed so the record still verifies, are worked out again and the file is still refused; lock files and migrations need it too |
| 4 component tests | `web-app/src/containers/__tests__/CoworkProposalReview.test.tsx` | flags and their details are shown on the file; lock files listed apart from source changes; Apply held, naming the files, until each selected flagged file is marked reviewed; the approval carries exactly the selected, flagged, acknowledged paths; leaving the flagged files out applies the rest with no acknowledgement |
| Real app over real IPC | `cowork-smoke --only proposal-flags` (Windows) | a worktree with a dependency upgrade and addition, a lock file and a `DROP TABLE` migration: the stored proposal carries the three flags with what changed; an approval with no acknowledgement, and one acknowledging only the manifest, are refused naming the rest, and the folder is unchanged; fully acknowledged, everything lands |

Mutation-checked: trusting the stored flags only, not checking the
acknowledgement, not flagging lock files, and not holding Apply each fail a
test.

The UI's flag display is covered by component tests. The Windows scenario
drives the backend over IPC; it does not click through the review.

## Context replay (AH-079)

| Evidence | Where | Covers |
| --- | --- | --- |
| 10 integration tests | `src-tauri/src/core/agent/replay.rs` | against a real snapshot log: the payload handed out is the stored one, and a replay dispatch with the same payload is `matched`; a different one is not, and one from another session is not evidence; redacted, unavailable, not-a-chat, foreign and unknown snapshots are typed refusals, a redacted one kept as a record, a foreign one leaving none; a cancelled replay keeps its first ending when a late completion arrives; a replay `running` in an earlier process is `interrupted`; settling is scoped to the session and refuses `running`; a key in the reply never reaches disk and the text is bounded at a character boundary; records are read back from disk |
| 1 unit test | `plugins/tauri-plugin-agent-tools/src/snapshot.rs` | a snapshot id is never one an earlier launch issued; the old `snap-N` counter failed it |
| 9 unit tests | `web-app/src/lib/__tests__/contextReplay.test.ts` | the stored request is sent byte-for-byte to the provider's chat endpoint with its key and the `replay` identity; tool calls are recorded, not run; a redacted snapshot sends nothing; a provider that is gone or speaks Anthropic, and a local model that is not running, are typed refusals with nothing sent and nothing started; an HTTP error and a cut-off stream are failures; a replay stopped part-way aborts the request and records `cancelled`; a replay whose window went away is recorded as abandoned; whole and split streamed replies are read |
| 2 component tests | `web-app/src/containers/__tests__/PromptSnapshotView.test.tsx` | a redacted snapshot's replay control is disabled with the reason; a replay's ending, `matched` and reply are listed under the snapshot |
| Real WebView scenario, **phase one** | `cowork-smoke --only context-replay-1` (mock provider, Windows) | a turn is sent; "Replay this context" in its panel completes with `matched`, and the model fixture received a request byte-identical to the turn's; a slow replay is stopped from the panel and reads as stopped; a second turn carrying a key-shaped string has its replay control disabled with the reason, and the backend refuses it (`redacted`) and refuses the first snapshot to another session (`not-found`); a replay is left running as the app exits. **Passed on Windows 2026-09-11** |
| Real WebView scenario, **phase two after a real restart** | `cowork-smoke --only context-replay-2` on the kept profile | a new process lists the first snapshot's replays as interrupted, cancelled, completed (the completed one still `matched`, with its reply), and the redacted turn's refusal; the panel shows the same three after the restart. **Passed on Windows 2026-09-11** |

Not run: macOS, Linux, a real model, and a local llama.cpp model (the
`model-not-running` refusal and the local path are unit-tested only).

Run: `cargo test --lib --no-default-features --features test-tauri -- replay::`,
`cargo test -p tauri-plugin-agent-tools --lib snapshot::`,
`npx vitest run src/lib/__tests__/contextReplay.test.ts src/containers/__tests__/PromptSnapshotView.test.tsx`.

## Context diff between turns (AH-086)

| Evidence | Where | Covers |
| --- | --- | --- |
| 7 unit tests | `web-app/src/lib/__tests__/contextDiff.test.ts` | what a follow-up adds and why (tool call, tool result, new request, tool offered); what left the window when older turns were trimmed; recalled memory and instruction changes told apart in the system prompt; same text answering a different call counts as different; empty payloads; bounded previews; the previous snapshot found in time order |
| 3 view tests | `web-app/src/containers/__tests__/PromptSnapshotView.test.tsx` | comparing against the request just before, never another session's; the first request says there is nothing earlier; an unreadable list is shown as an error |
| Windows `context-diff` then `context-diff-restart` (mock provider, retries off) | `cowork_smoke.rs` | a second Cowork turn compared with the first names the previous answer and the new request as entered and nothing as left; after a restart the same comparison comes from disk with nothing sent |

Not exercised in the real app: a window that actually overflowed, so the
"left the window" path is shown by unit tests only.

## User-level skills in the CLI (AH-121)

| Evidence | Where | Covers |
| --- | --- | --- |
| Real provider | `jan cli agent run` against vLLM `http://v100:8555/v1` (`pxa-27b`), isolated `JAN_DATA_FOLDER` with `house-style` only in `<data>/agent-workspace/skills`, project with no skills; then `jan cli agent prompts <session> --show last` | the system prompt lists `house-style`; the model calls `skill_read({"name":"house-style"})` and gets the body; the reply ends with the marker the skill asks for |
| Rust tests | `core/agent/skills.rs::user_skills_apply_in_every_project_and_a_project_skill_shadows_them`, `tools/handlers.rs::skill_tools_reach_user_skills_and_the_project_shadows_them`, `core/agent/loop.rs::the_loop_reads_a_user_skill_from_any_project` | catalog in two unrelated projects, `read_raw`, project shadowing, the enabled whitelist, nothing without a user store; `skill_list` / `skill_read` through the plugin handlers; the loop's own dispatch with the store root |

First attempts, retries off: the first real run failed because only the
catalog saw user skills (`skill_read` said "not found"); the second because the
loop passed the skills folder where the handlers take a store root. Both were
fixed in code, with the loop test above added for the second; the third run
passed. Evidence kept in `/c/tmp/jan-p2-first-failures/ah121-*`.

## One record for Chat, Cowork and the CLI (AH-004, in progress)

| Evidence | Where | Covers |
| --- | --- | --- |
| Real WebView | `cowork-smoke --only chat-execution-record` | a Chat turn with an approved MCP tool call writes 11 events: `run.started`, the approval phases, `tool.requested/running/succeeded`, `usage.reported` per request, `message.completed`, and `run.ended` with `stoppedBy: done` and two steps -- all under one run, with the tool call's invocation matching one request's usage, no two requests sharing an invocation, and nothing in another session's log |
| Real CLI run | `jan cli agent run` against the local model fixture (`tests/fixtures/mock_openai_server.py`), isolated `JAN_DATA_FOLDER` | 10 events in order: `run.started`, the dispatch `message.completed` carrying the prompt snapshot id, `usage.reported`, the reply's `message.completed` (`tool_calls`), `tool.requested` and `tool.succeeded` **under the same invocation**, then the second request's dispatch, usage and reply, then `run.ended` `done`. Kept in `/c/tmp/jan-p2-first-failures/ah004-cli-record.json` |
| Rust tests | `loop.rs::each_request_gets_one_invocation_id_and_records_under_it`, `activity.rs::one_call_id_reused_by_two_invocations_stays_two_items`, `activity.rs::an_item_id_is_its_session_invocation_and_call` | ids are per request, current between requests, recorded under the run, and a run with no data folder writes nothing; a reused provider call id stays two items; a legacy event with no invocation folds as before |
| Render tests | `chatRun.test.ts` (5), `executionTimeline.test.ts::keeps one call id used by two invocations as two rows` | a turn is one run across tool steps, cancelled and failed turns say so, two threads never share a run, and the timeline keeps the reused call id apart |

Still missing for AH-004, and why it stays in progress: the CLI loop does not
record steering, compaction, reasoning or subagent lifecycle events (its
compaction and goal-evaluation dispatches deliberately keep their own,
unrecorded ids); retention is bounded by size and session count but has no test
of its own; and the real-provider lanes could not be used for this batch --
`v100` stopped resolving partway through (see the Phase 3 report), so the CLI
evidence above is against the local fixture, not 8555.

## Agent provenance on changes (AH-110)

| Evidence | Where | Covers |
| --- | --- | --- |
| Real WebView pair | `cowork-smoke --only agent-provenance`, then `--only agent-provenance-restart` on the same `COWORK_SMOKE_KEEP` | one run writes three files: the primary agent, a saved custom agent (`scribe`) and a shipped role (`implementer`); the journal names `agent`, `agent:scribe` and `role:implementer` file by file; the Changes panel says all three in words and the Timeline carries the same ids; a `write` refused in Review mode adds nothing to the journal; **after a restart**, with the custom agent renamed on disk, the old change still names `agent:scribe` and shows its recorded label (not the new name); another session's journal is empty; stripping one change's actor on disk makes that row read "an unknown agent" while the others keep their agents |
| Rust tests | `undo.rs` (5), `commands.rs::a_tool_call_journals_its_agent_and_refuses_an_identity_that_is_not_one`, `activity.rs::the_execution_record_carries_the_agents_identity` | per-file actors including two children in one turn, parent/invocation/task, restart through the file, the last writer taking over a file's attribution while undo still restores the first "before", legacy records staying unattributed, refusal of every non-agent identity and of a non-agent parent, a hostile label flattened to one bounded line, session isolation, the refusal happening before the tool runs, and the identity travelling through the audit export |
| Render tests | `changeActor.test.ts` (5), `CoworkTurnUndo.test.tsx` (2 new), `coworkDispatch.test.ts` (1 new) | the label rules (a role is never a named agent, an unknown is never the current agent, a renamed agent keeps its identity), the panel's per-turn actor ids and words including the unknown case, the same words inside the button's `aria-label`, and the dispatcher sending the actor with every call |

Last run 2026-09-12, Windows WebView2, scripted provider, retries off: the pair
passed after two harness fixes (the panel had to be remounted to re-read the
journal; a `location.reload()` killed the harness's own eval channel). No
product behaviour was changed to make it pass.

Not covered: partial-hunk application (the app applies a tool's change whole),
and session export/import, which does not carry the undo journal -- provenance
travels in the audit export instead, which is tested above.

## MCP liveness by protocol ping (AH-139)

| Evidence | Where | Covers |
| --- | --- | --- |
| Real WebView app | `cowork-smoke --only mcp-liveness-uses-the-protocol-ping` | the seeded stdio fixture (`tests/fixtures/mock_mcp_web_search.py --methods --pid`) records every method it receives: `initialize`, then `ping` at +30.5s and +60.5s (the monitor's schedule) with no second `initialize`; the harness stops exactly that process (its own pid file, checked to be python); the next probe logs `health check failed: Transport closed` and `failed health check, attempting auto-reconnect`; the app starts it again (new pid, `initialize` at +91.6s) and pings the new process at +122.1s |
| Integration tests | `src-tauri/src/core/mcp/tests.rs::liveness_tests` (5) | through the real rmcp client over an in-process JSON-RPC peer: a server answering `ping` is alive and is sent no `tools/list`; an error reply to `ping` is alive; a server ignoring `ping` but answering `tools/list` is alive and reported as such; a server answering nothing is unresponsive; a server that hung up is never alive |

Last run 2026-09-11, Windows WebView2, retries off: passed on the first
attempt. The five `tools/list` requests after each `initialize` come from the
app's startup and tool refresh, not the probe.

## What the model saw, from the CLI (AH-087)

| Evidence | Where | Covers |
| --- | --- | --- |
| Real provider | `jan cli agent run` against vLLM `http://v100:8555/v1` (`pxa-27b`), isolated `JAN_DATA_FOLDER`, then `jan cli agent prompts <session>` and `--show last` | the run recorded two requests and the list shows both (id, time, kind, model, message count, hash); `--show last` printed the 4-message request -- system prompt, the user task, the assistant's `ls` call, the tool result -- and the 23 tools offered; every message text and the hash match `prompts.jsonl`; a read of that snapshot id under another session is refused |
| Rust tests | `snapshot.rs::the_text_view_is_what_the_model_saw`, `the_text_view_shows_redactions_not_secrets`, `a_snapshot_without_a_payload_says_why`; `bin/jan.rs::agent_prompts_lists_and_prints_a_sessions_requests_only`, `prompts_is_a_cli_agent_command` | order and roles, no truncation of a 5,000-character message, non-text parts named, tool calls with arguments, tools offered; a credential is redacted and counted; a payload-less snapshot says why; list, last, by id, another session's id refused, unknown session and blank session refused |

A request carrying tool results back is now labelled `Continuation` rather
than `Initial`: proven in a real `jan cli agent run` against the local model
fixture, whose two snapshots read `Initial` then `Continuation` under
invocations `#1` and `#2` (`/c/tmp/jan-p2-first-failures/ah087-dispatch-kinds.json`),
with `loop.rs::a_request_carrying_tool_results_is_a_continuation` covering the
rule itself.

Limits: the TUI has no in-session text view (the command works from a second
terminal), `/context` still re-derives category sizes from disk, .

## Harness error taxonomy (AH-009)

| Evidence | Where | Covers |
| --- | --- | --- |
| Rust tests | `harness_error.rs` (11) | tags are unique and stable; denials, budget stops, cancellations and bad input are never retried while upstream and transport failures are; a cancellation is distinguishable from a failure; io and serialization errors are classified rather than flattened; internal failures are not taught to the model; the model-facing wire shape is unchanged; and `classify_upstream` places refusals, context-length rejections, cancellations, timeouts, transport faults and gateway errors -- including a refusal whose text contains an outage word |
| Real CLI run | `jan cli agent run` with no provider listening | the run prints `[error:transport] ...` rather than an unclassified error line, and the same classification is what the provider chain reads. Kept in `/c/tmp/jan-p2-first-failures/ah009-cli-tagged-error.err` |
| Production use | `loop.rs::is_failover_worthy` delegates to `may_try_another_provider`; `core/cli/mod.rs` prints `[stopped]` for a cancellation and `[error:<kind>]` otherwise | the taxonomy is the shared decision, not a second opinion beside the call sites |

Not yet converted: the orchestration loop still returns `Result<_, String>`
internally, and the per-module kinds (`ExportErrorKind`, `ChildErrorKind`,
`ReplayErrorKind`) remain their own types. What the taxonomy owns today is the
provider-failure decision and how the CLI reports a failure.

## Provider fallback (AH-193)

| Evidence | Where | Covers |
| --- | --- | --- |
| Real two-lane run | `jan cli agent run` with `[agent] fallback = ["backup-model"]`, an isolated `JAN_HOME` naming two providers: a primary pointing at a closed port and a backup pointing at the local model fixture | the run answers from the backup ("Answered by the backup provider."), the log says `primary-model did not answer (...); falling back to backup-model`, and the record holds `run.started` (model primary-model), the primary's dispatch under invocation `#1`, a `fell-back` event under `#2` naming from, to, the reason and the request it follows, then the backup's usage, reply and `answeredBy: backup-model`, and `run.ended done`. Kept in `/c/tmp/jan-p2-first-failures/ah193-fallback-record.json` |
| Real refusal | the same run with the primary pointed at the fixture's `echo-401` script | the run fails with the provider's own 401 and never falls back (no "falling back" line), so a rejected key is not retried elsewhere. Kept in `ah193-no-failover-on-401.err` |
| Rust test | `loop.rs::only_an_unreached_provider_is_worth_failing_over` | connection refused, DNS failure, 502/503/504 and timeouts fail over; 401/403, an invalid key, a context-length refusal, a cancelled run and a 400 do not -- including an answered refusal whose text contains an outage word |

Limits: the chain is configured in `agent.toml`, so it applies to the agent
loop (the CLI and desktop agent runs that pass one). Chat and Cowork have no
chain configuration and never fail over. A compaction or goal-evaluation
dispatch deliberately keeps its own provider: those are the run's own
bookkeeping, not the user's request.

## Context pressure warnings (AH-077)

| Evidence | Where | Covers |
| --- | --- | --- |
| Real CLI run | `jan cli agent run` against the local model fixture with `[agent] context_window = 10, compaction_reserve_tokens = 2`, isolated `JAN_DATA_FOLDER` | the run prints exactly one `[context]` line: "150% of the context window is in use (15 of 10 tokens, counted by the provider): the next turn auto-compacts. /context shows what is using it" -- the deliberately tiny window is what makes crossing the threshold deterministic without a huge prompt. Kept in `/c/tmp/jan-p2-first-failures/ah077-cli-small-window.err` |
| Rust tests | `core/agent/context_pressure.rs` (4), `core/cli/tui.rs::context_pressure_is_warned_once_before_the_window_fills`, `no_context_pressure_warning_without_a_window` | nothing is said below 80%, with no window, or with nothing counted; the line carries share, figures, source and headroom; an estimate says it is one; past the reserve it says the next turn compacts; the TUI warns once and re-arms after the fill drops |
| Render tests | `TokenCounter.test.tsx` | "Nearly full" at 85% with `role="status"`, "Full" over 100%, nothing at 50%, how many tokens are left, and the used/capacity figures labelled as the provider's count or Jan's estimate |

Both surfaces read the window the run actually resolved (the configured
override, then the catalog, then the fallback), and both re-arm when the fill
drops back -- which is what a compaction or a new conversation does.

Not covered: the desktop counter has render-test evidence only. The harness's
scripted provider reports no context window and no local runtime is loaded in
it, so nothing in the WebView can cross the threshold; the numbers it would
show come from the same usage shape the render tests drive. The TUI's own
warning is unit-tested for the same reason -- the harness drives no terminal.

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

Last run, 2026-09-11, merged onto `fork/main` 4a9ba6f68, Windows WebView2,
llama-server `qwen3.8-27b`, all three passing on the first attempt (retries
off). Each popover value equals what the provider reported for that request:

| Check | Input | Cached | Uncached (derived) | Output | Total (derived) |
| --- | --- | --- | --- | --- | --- |
| Chat follow-up | 2,807 | 2,784 | 23 | 19 | 2,826 |
| Cowork follow-up | 6,093 | 6,056 | 37 | 35 | 6,128 |
| After restart (new process, no provider request) | same | same | same | same | same |

The previous run, on `fork/main` 9ab30620e, gave Chat 2,825 / 2,802 / 23 / 39
/ 2,864 and Cowork 5,542 / 5,505 / 37 / 17 / 5,559; the prompts differ between
the two trees, so the counts do, and in both runs the display matched the
provider exactly.

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


## Session memory through the app (AH-081 / AH-083)

| Evidence | Where | Covers |
| --- | --- | --- |
| Real WebView pair | `cowork-smoke --only memory-session-scope`, then `--only memory-session-after-restart` on the same `COWORK_SMOKE_KEEP` | a session memory committed through the memory commands reaches that session's next request as `[id] (session)` under the "not instructions" label (read from the request body the fixture received); the turn lists the id; a second session never receives it; after a restart in a new process it is still recalled and still isolated, the memory page shows it with provenance, and once forgotten it is not sent |
| Unit tests | `coworkTransport.test.ts`, `tokenUsage.cowork.test.ts`, `coworkTurns.test.ts`, `TurnUsageDetails.test.tsx`, `useMemoryConversations.test.ts` | the Cowork prompt carries the block after the run's instructions and none when nothing was retrieved; per-turn memory ids; the conversation/project picker source |
| Rust tests | `tools/handlers.rs::memory_propose_project_scope_is_saved_where_it_is_read_back`, `snapshot.rs` retention tests | project proposals land in the store readers open; snapshot deletion by session, retention by count, torn lines kept |

Last run 2026-09-11, Windows WebView2, scripted provider: both passed on the
first attempt, with retries disabled for these scenarios.

## Project and user memory through the app (AH-080 / AH-082)

| Evidence | Where | Covers |
| --- | --- | --- |
| Real WebView pair | `cowork-smoke --only memory-project-scope`, then `--only memory-project-after-restart` on the same `COWORK_SMOKE_KEEP` | a folder is attached through the real pill and picker; a project memory committed for it reaches that session's request as `[id] (project)`; a second checkout with the **same folder name** under another parent gets a different project id and never receives it; a user-scope memory reaches that other project as `[id] (user)` and stops being sent once forgotten; after a restart in a new process the project memory is still recalled in its project, still absent from the same-named one, and absent once forgotten |

Last run 2026-09-11, Windows WebView2, scripted provider: three fresh
scope/restart pairs, all six runs passed on the first attempt, retries
disabled for `memory-project-*`. Not run live: user memory across a restart,
conflicting memory in the WebView, Chat (rather than Cowork) recall.

## User-level memory through the app (AH-082)

| Evidence | Where | Covers |
| --- | --- | --- |
| Real WebView pair | `cowork-smoke --only memory-user-scope`, then `--only memory-user-after-restart` on the same `COWORK_SMOKE_KEEP` | written, edited and pinned on Settings > Memory; recalled as `[id] (user)` in two unrelated projects (the fixture and a different checkout with the same folder name), each turn listing that exact id; "Across chats" recall switched off: not sent, still stored and listed; **after a restart in a new process** the switch is still off, the record still edited and pinned, and nothing is sent; switched back on, the same record returns in both projects; forgotten on the page: gone from the next request and its text gone from `user.jsonl`; two more cleared with "Forget all" after confirmation: neither sent, neither on disk; a damaged line in `user.jsonl` shows as an error on the page, not as an empty store |
| Rust tests | `memory/commands.rs::user_memory_tests` (recall off withholds without deleting and on restores; a switched-off scope takes no part in conflicts; clearing forgets one scope only and leaves no text; chat/project saves never create a user memory; damaged or unreadable storage and damaged settings reported, settings fail closed with recall off; a forgotten memory leaves the list), `memory/create.rs` (forget removes the text from the file, restore needs the exact forgotten text, forget-all respects visibility), `memory/settings.rs` (recall defaults on, survives a restart, damaged file turns it off and says so) | |
| Mutation checks | each fix removed in turn, the test that guards it run | forget keeping text, forgotten rows listed, recall filter removed, damaged settings recalling: all four fail their test |
| Render tests | `routes/settings/__tests__/memory.user.test.tsx` | recall switches, rollback on failure, storage error banner, add, clear only after confirmation, undo hands back the text |

Last run 2026-09-11, Windows WebView2, scripted provider, retries off.
First attempt of the restart scenario **failed**: after "Forget memory" the
row stayed on the page as an empty "deleted" entry, because the list showed
tombstones. Fixed (`service::list` excludes forgotten records, regression
test `a_forgotten_memory_leaves_the_list`) and the pair re-run on a fresh
profile: both passed on the first attempt. Earlier prompt snapshots keep the
text a forgotten memory contributed to requests already sent; forgetting does
not rewrite what was sent.

## Memory provenance (AH-083, in progress)

| Evidence | Where | Covers |
| --- | --- | --- |
| Real WebView pair | `cowork-smoke --only memory-provenance`, then `--only memory-provenance-after-restart` on the same `COWORK_SMOKE_KEEP` | a memory written on Settings > Memory is version 1, user-authored; a Cowork turn that carried it says why ("applies to this user", rank 1); the memory then records that use with the session and the exact prompt-snapshot id, and that snapshot in `prompts.jsonl` contains the memory id; an edit on the page makes version 2 with version 1 on record by hash, and the old text is not on disk; **after a restart in a new process** the version, history, source type and recorded snapshot are unchanged and the page shows version 2 and the snapshot |
| Rust tests | `memory/commands.rs::provenance_tests` | new record's version, source type, run, session, message, hash; editing bumps the version and keeps only the replaced hash; saving the same text is not a version; a record from before provenance loads with version, run and session unknown, and its first edit starts at version 0 rather than inventing one; retrieval gives rank and reason; a use records turn and snapshot; uses are refused on another chat's or a forgotten memory; the use list is bounded while the count is not; source type from creator and origin |
| Mutation checks | revision history and the visibility check on uses removed in turn | both fail their tests |
| Render tests | `memory.user.test.tsx` (provenance panel: known and unknown version, history, uses with snapshot ids), `TurnUsageDetails.test.tsx` (reason per memory, recall off, storage error), `memoryUses.test.ts` (exact ids, reasons, turn and snapshot; nothing without a session or memory; failure never reaches the turn) | |

Last run 2026-09-11, Windows WebView2, scripted provider, retries off: both
passed on the first attempt, and the AH-082 pair re-run alongside also passed.

### Forgetting reaches past prompts

| Evidence | Where | Covers |
| --- | --- | --- |
| Real WebView | `cowork-smoke --only memory-forget-redacts-prompts` | a session memory is committed, a Cowork turn carries it (checked in the system prompt the fixture received), and the prompt log holds it; after forgetting it through the same command the page uses, the log no longer contains the text, does contain `[redacted: forgotten memory]`, still contains the request that was sent, and has exactly as many snapshots as before -- redacted, not dropped. The snapshot reader shows the same |
| Rust tests | `snapshot.rs::forgotten_text_leaves_the_prompts_it_was_sent_in`, `redaction_refuses_to_rewrite_for_nothing`, `memory/commands.rs::forgetting_a_memory_redacts_it_from_the_prompts_it_reached` | only the snapshots that carried it are rewritten, the payload stays a payload, the redaction is recorded on the snapshot, another session's snapshot is untouched, a second forget changes nothing more, an empty or absent needle rewrites nothing, and the end-to-end command path does it |

Scope clears do the same for every memory they forget. `memory/` still logs
nothing -- the reporting lives in the snapshot module, which is covered by the
existing no-print rule test.

### Export and import with provenance

| Evidence | Where | Covers |
| --- | --- | --- |
| Real WebView pair | `cowork-smoke --only memory-export-import`, then `--only memory-export-import-restart` on the same `COWORK_SMOKE_KEEP` | two user memories are saved and one forgotten; **Export** on Settings > Memory goes through the real `save_dialog` command (only the OS picker is scripted) and writes a v1 export holding the kept memory as user-authored and not the forgotten text; the kept memory is then forgotten; a copy with altered text imported through **Import** and the real `open_dialog` command is refused and named (original id, "changed after it was exported") and its text is not in the store; the real file imports one record, a second import reports one duplicate and adds nothing; the new record shows source "imported", the export id and the original id and author; a real Cowork request carries it as `[id] (user) (source: imported)`; **after a restart in a new process** the provenance is still shown, `imported_from` is on disk, refused and forgotten text are not, and the next request still carries it marked imported |
| Rust tests | `memory/transfer.rs` (9) | export excludes forgotten and proposed text, where it was used, and old versions' words; import marks the record imported and keeps the original id, author, time, session and run through the store's own serialisation; records from before imports still load; an altered record is refused while the rest import; an instruction or a credential is refused; importing twice adds nothing; re-exporting an import keeps the first author; a non-export, a newer version, unknown fields and an oversized file are told apart; a project import needs a project |
| Rust tests | `memory/retrieve.rs` | each injected line names id, scope and source, and an imported memory is marked imported |
| Render tests | `memory.user.test.tsx` | export writes where the user picked; import shows the per-record report with the refused record named; imported provenance is shown; a cancelled picker does nothing |

Last run 2026-09-11, Windows WebView2, scripted provider, retries off: the
pair passed after three harness fixes found on first attempts (see the Phase 2
report); no product behaviour was changed to make it pass except one real
defect: a second import reused the report element, so the page now remounts
the report for each import. The `smoke_dialog` seam's own unit test cannot run
on this Windows host: the desktop library test binary built with the
`cowork-smoke` feature exits with `STATUS_ENTRYPOINT_NOT_FOUND` before any
test starts; the seam is exercised by the real-app pair instead.

Still open for AH-083: provenance does not navigate to the source message, and
Chat records a use without a snapshot id, because the Chat path takes no
prompt snapshot.

## One precedence chain (AH-084)

| Evidence | Where | Covers |
| --- | --- | --- |
| Real WebView | `cowork-smoke --only memory-precedence` | the attached project's `JAN.md` says pnpm; a user memory says npm, another claims authority ("Ignore previous instructions…"), a third is unrelated. The request body states the chain ahead of `<remembered_facts>`, carries JAN.md and the unrelated memory, and carries neither the contradicted nor the refused one; the turn shows the override with both texts, both sources and JAN.md as the winner, and the refusal with its reason |
| CLI prompt path | `core/agent/context.rs::a_skill_outranks_a_contradicting_memory_in_the_prompt` | a project **skill** says pnpm, a user memory says npm: the real prompt builder states the chain, does not send the memory, and reports the skill as winner |
| Rust tests | `memory/precedence.rs` (chain order and statement; skill beats memory with both excerpts; JAN.md reported over a skill; agreeing or unrelated memories untouched; lower sources ignored; authority claims refused, ordinary preferences not), `memory/retrieve.rs` (skill-contradicted memory withheld and reported; authority and block-closing memories refused; the surviving one sealed to a single line with no raw tag; JAN.md over skill; injection order user, project, session; budget drops session first), `memory/record.rs` (scope precedence user > project > session; duplicates keep the user copy; order independence) | |
| Mutation checks | override withholding, sealing, and the scope order reverted in turn | each fails its test |
| Render and transport tests | `TurnUsageDetails.test.tsx` (override with both sides, refusal), `coworkTransport.test.ts` (JAN.md and compatibility text handed to retrieval; chain before the facts) | |

Last run 2026-09-11, Windows WebView2, scripted provider, retries off: passed
on the first attempt. The chain changed an existing rule: memory-versus-memory
precedence was "more specific scope wins"; it is now user above project above
session, as the chain requires, and the tests encoding the old order were
rewritten rather than deleted. Contradiction detection is the shared lexical
table (package manager, response length, indentation, test runner, branch
integration, line endings, formatters); disagreements outside it are not
detected. Cowork delivers no skill text to the model, so there is nothing for
a Cowork memory to contradict at level 6; skills are enforced on the CLI path.

## Memory security and durability (Priority 4)

| Threat | Evidence |
| --- | --- |
| Prompt injection stored as memory | refused when saved (`security_tests::an_injection_is_refused_when_it_is_saved`, and on the page in `memory-security`); one already in the store is refused at retrieval (`memory-precedence` plants one) and shown on the turn |
| Secrets, API keys, auth headers, private keys | refused when saved (`credentials_are_refused`: OpenAI-style key, bearer token, OpenSSH private key, AWS keys) |
| Oversized records and collections | 2,000-character record limit (`create.rs` existing test); 2,000 live records per scope (`a_full_scope_refuses_more`) |
| Path traversal, filesystem root, data-folder overlap | `a_named_project_folder_is_validated_before_anything_is_written_into_it`: unresolvable `..` paths, the Jan data folder and anything inside it, and `C:\` are refused and nothing is written |
| Symlink/junction/reparse escape | `a_junctioned_jan_folder_is_refused_and_nothing_is_written_through_it` (real `mklink /J`); WebView `memory-security` attaches a checkout whose `.jan` is a junction: the turn reports why project memory was not used, a project save is refused, and the junction target stays empty |
| Cross-scope leakage; same-named unrelated repositories | `memory-session-*`, `memory-project-*` (same folder name, different repository), `conflicts_are_listed_...only_where_they_apply`, `uses_are_only_recorded_on_records_this_place_may_see` |
| Concurrent writers | `concurrent_writers_do_not_lose_each_others_records`: 8 threads x 10 records, all 80 present, no lock left; an abandoned lock is taken over after 30 s, a live one makes a writer report "busy" |
| Interrupted atomic writes, corrupt and partial records | `an_interrupted_write_leaves_the_store_as_it_was` (a half-written temp file is ignored, the next write succeeds); torn lines skipped and reported (`damaged_or_unreadable_storage_is_reported_to_the_caller`); an unreadable store is never overwritten |
| Stale versions | `service.rs::editing_refuses_a_stale_hash`; restore requires the exact forgotten text (`restoring_with_different_text_is_refused`) |
| Deletion leaving plaintext or index entries | forget and clear remove the text from the file (`forgetting_removes_the_text_from_the_store_file`, WebView `memory-user-after-restart`); there is no separate memory index since the BM25 index was removed |
| Cancellation during create/update/delete | each command does its file work synchronously in one call with a single atomic write under the scope lock, so an abandoned request is wholly before or after it; not separately fault-injected |
| Subagent access | Cowork subagents receive no memory (`coworkPrompt.test.ts`); CLI subagents inherit the parent's session and project, as documented |
| Audit and log output | the memory module has no log or print output (`the_memory_module_has_no_log_or_print_output`, checked against the sources) |
| Recalled memory as untrusted data | sealed single lines inside `<remembered_facts>`, below every instruction source (AH-084) |

Last run 2026-09-11, Windows WebView2, retries off. First attempts of two
scenarios **failed** and are recorded: `memory-security` because `cmd mklink`
read the forward-slash path `C:/tmp/...` as a switch (harness fix: pass
backslashes); `memory-precedence` because its setup saved an injection, which
this batch now refuses at the door (scenario changed to expect the refusal
and plant the record directly). Both then passed on fresh profiles, with the
project and user pairs re-run alongside. Malicious import is covered with the
import work (Priority 5).

The batch gate then **failed** once more, on a real defect:
`concurrent_writers_do_not_lose_each_others_records` passed alone but failed
inside the full parallel agent-tools suite with "could not lock the memory
store: Access is denied (os error 5)". On Windows a lock file another writer
has just deleted is "delete pending" until its handle closes, and creating it
in that window fails with access denied rather than "already exists"; the lock
treated that as fatal and aborted a save. Fixed by treating it as contention
(wait and retry within the 5 s deadline). The full suite and the WebView user
pair were re-run after the fix; this note is the record of the first failure,
not a retry that hid it.

## Conflicting memory, surfaced and settled (AH-085)

| Evidence | Where | Covers |
| --- | --- | --- |
| Real WebView | `cowork-smoke --only memory-conflict-settle` | a project memory ("npm") and a user memory ("yarn") that disagree are both withheld from the request body; the turn lists both ids as withheld; Settings > Memory shows the pair in full; "Keep this one" on the project side forgets the user side, and the next request carries only the project memory |
| Real WebView pair | `--only memory-conflict-scope`, then `--only memory-conflict-after-restart` on the same `COWORK_SMOKE_KEEP` | the conflict made in one process is still withheld and still listed after a restart in a new process, and is settled there the other way (user side kept, project side not sent) |
| Rust test | `memory/commands.rs::conflicts_are_listed_with_both_sides_and_only_where_they_apply` | both sides returned in full; another chat's disagreement is not listed; the same ids are what retrieval withholds; forgetting one side clears the conflict and lets the other be injected; none for a temporary chat |
| Render test | `routes/settings/__tests__/memory.conflicts.test.tsx` | both sides and where each applies; asked for the picked conversation and project; keeping one forgets the other in its own scope, never the kept one; no card when nothing disagrees |

Last run 2026-09-11, Windows WebView2, scripted provider: all passed on the
first attempt (the settle scenario twice, on fresh profiles), retries off.
Detection is the existing lexical table (package manager, indentation,
response length); contradictions outside it are not detected.

### Harness defect found on the way: eval results lost on the event bus

Before the fix above, these scenarios failed about half the time with
`eval timed out after 60s` on a trivial DOM query, always during the first
send in a folder session. Diagnosis over the WebView's DevTools protocol
(`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=...`):

- the page stayed responsive the whole time; no dialog, crash or long task;
- the timed-out script had started, and its `plugin:event|emit` had resolved
  in the page -- the result reached Tauri and was not delivered;
- Tauri's `Listeners::emit_filter` (tauri 2.11.5, `event/listener.rs`) only
  `try_lock`s its handler table. When another thread holds it, the emit is
  parked in a pending queue that is flushed only by a later emit that reaches
  a handler. The harness was blocked waiting, so nothing flushed it;
- the window is widest during the first folder-session send, when
  `advertised_tool_schemas` spends ~40 s in the sandboxed shell probe
  (`PROBE_TIMEOUT` is 10 s per candidate) while the app's own events flow.

Fix: `Ctx::eval` no longer returns results over the event bus. The script
stores its result in the page and the harness collects it with
`WebviewWindow::eval_with_callback`. No retry was added. The ~40 s first-send
probe is a real product latency, recorded separately and not fixed here.

### Prompt snapshot ids were reused after a restart (AH-078)

The same runs showed `prompts.jsonl` holding two records with id `snap-1`:
the id was a process-local counter, so the first snapshot after a restart took
an old record's id, and a lookup by id could return the wrong request. The
same defect was fixed independently on `fork/main` alongside AH-079 replay
(which depends on lookup by id); the merged tree keeps that version, ids of the
form `snap-<launch>-<n>`, with its regression test
`snapshot.rs::an_id_from_an_earlier_launch_is_never_issued_again`.


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


## Project tooling: frameworks, build systems, test runners (AH-068 / AH-069 / AH-070)

| Evidence | Where | Covers |
| --- | --- | --- |
| 18 unit tests on Windows (17 on Unix) | `src-tauri/src/core/agent/tooling.rs` | see below |
| 1 prompt test | `src-tauri/src/core/agent/context.rs` (`build_system_prompt_names_the_project_tooling`) | the CLI/TUI prompt carries the block, and no block without manifests |
| 3 + 3 + 1 web tests | `projectTooling.test.ts`, `CoworkReadinessCard.test.tsx`, `coworkPrompt.test.ts` | the IPC loader never throws and types a refusal; the card lists facts with source and certainty, a typed failure, and "none"; the Cowork prompt carries the backend's block verbatim, only with a folder attached |
| Real WebView scenario | `cowork-smoke --only project-tooling-is-detected-and-told-to-the-model` | a monorepo with a junction out of it is attached; the card shows React, Tauri, Cargo, the pnpm workspace, and Vitest with `pnpm test`, sourced and high; the backend's block reports the junction as not followed, and Express from behind it appears nowhere; the model's system prompt contains the backend's block verbatim |

The unit tests cover:
- a single framework with its evidence;
- a monorepo with two ecosystems, an inherited package manager, unit vs e2e,
  and Cargo integration tests;
- conflicting lockfiles (reported, no command);
- `packageManager` outranking a lockfile;
- a bare `package.json` proposing no command;
- wrapped and unsafe scripts;
- a runner that is not a dependency;
- Python backend, manager and runner;
- JVM, .NET, Flutter, CMake and Go;
- a malformed or oversized manifest reported;
- an unsupported project;
- dependency and output directories skipped;
- directory, byte and time bounds;
- cancellation writing nothing;
- a typed refusal;
- a junction escape (Windows) and a symlink escape (Unix);
- Windows casing and separators;
- repository text unable to break out of the prompt block.

Mutation checks (precedence and boundary): taking the lockfile before the
`packageManager` field fails
`the_package_manager_field_outranks_a_stray_lockfile`; following links fails
`a_junction_out_of_the_project_is_not_followed`.

## Steering a running agent (janhq/jan#8864)

| Evidence | Where | Covers |
| --- | --- | --- |
| 4 loop tests | `src-tauri/src/core/agent/loop.rs` | delivery after every tool result, in order; the final-answer boundary continues the same run; a gone surface never blocks; an empty final reply is never offered |
| 10 TUI tests | `src-tauri/src/core/cli/tui.rs` (`steering_*`) | images, paths and order; cancel; permission prompt; failed handoff; plan transition; event order; error/cancel fallback; reset; resume; skill expansion |
| 3 runner tests | `web-app/src/lib/__tests__/coworkRunner.test.ts` | Cowork: after the tool round, in order; final answer continues the run; nothing taken after a stop |
| 4 + 3 + 3 + 1 web tests | queue store, `CoworkHeldInput`, `cowork.sessions.test.tsx`, `coworkTurns.test.ts` | held vs ready, hold, release, restore-as-held; the held notice's send and discard; per-session delivery marked as steering, a failed run's input held and not sent, input after a finished run sent next; the steered marker |
| Real WebView scenario | `cowork-smoke --only steering-reaches-the-running-session-at-its-next-boundary` | typed during session A's first step, both messages reach the model after the tool round, in order, as user input; the first request carried neither; both are marked in the transcript; session B's request carries neither |

## Completion audit: sessions, Stop and headers (janhq/jan#8905, janhq/jan#8208)

Real WebView scenarios on Windows 11 with the mock provider:
- `stop-cancels-only-the-selected-session`, then
  `session-models-survive-a-restart` in a second process on the kept
  profile. Each session's recorded model is on disk after the restart, and
  the app comes back on it.
- `deleting-a-running-session-stops-only-its-run`: the deleted session's run
  ends and the session leaves the disk; the other session's run is untouched.
- `custom-headers-reach-the-provider-and-secrets-stay-secret`, then
  `custom-headers-survive-a-restart`:
  - a header is added, a reserved one refused, and headers switched off and
    on;
  - an error body echoing the secret leaves no trace on the page or the
    disk;
  - the value is restored from the credential store after a restart;
  - removal takes effect on the next request.
- Mutation check: with the error-body redaction disabled,
  `an_error_body_echoing_a_secret_header_comes_back_redacted` fails.

## Integration of the four agent workstreams (2026-09-11)

Branch `feat/integrate-all-agent-workstreams`, from `fork/main` at
`f3d6d2b81`. Merge commits, in order: `2e4a4dca7` (agent roles, `5f872e750`),
`fb3acc93a` (desktop workflow, `47fb778bd`), `734840eea` (token usage and
memory, `54f02cf3f`), `f8b416369` (agent completion, `d202d05dd`). Each
merge was checked with `cargo check` (desktop, all targets) and the web
typecheck before the next; the CLI configuration was checked after the last.

**Integration fixes on top of the merges**

| Commit | What |
| --- | --- |
| `af757d7a0` | One execution record: the session event log (AH-005) is the only store; `activity` is a projection of it; the legacy `audit/tool-activity.jsonl` is read-only input |
| `ca58a1d18` | A step's tool events, usage and snapshot stamp share the invocation of the request that asked for them |
| `0e749b610` | Harness: the fixture server stops when the app ends on its own |
| `c7747b19a` | Steering is recorded in its own session's execution record, without the user's text; registry notes |
| `860bfc9e0` | A refused-without-dispatch call is recorded under its run and agent; a reused provider call id is not dropped as a repeat |
| `e45209626`, `64c95ea3b` | Harness: native separators for the tooling fixture's junction; wait for the memory page's tabs |

**Full gate, on `860bfc9e0`** (the two later commits change only the
smoke harness and this document; the harness was rebuilt and the affected
scenarios rerun):

| Step | Result |
| --- | --- |
| `yarn build:tauri:plugin:api` | ok |
| `yarn typecheck` | ok |
| `yarn lint` | 0 errors, 14 warnings |
| `yarn build:web` | ok |
| `yarn test:web` | 458 files passed, 2 skipped; 6029 tests passed, 3 skipped |
| `yarn test:core` / `yarn test:ext` | 171 / 320 passed |
| `yarn test:scripts` | 46 passed |
| `node scripts/agent-harness/validate-registry.mjs` | 211 features, clean |
| `yarn guard:local-only` | clean |
| `git diff --check f3d6d2b81 HEAD` | clean |
| `cargo test --lib --no-default-features --features test-tauri` | 946 passed |
| `cargo check --no-default-features --features cli --all-targets` | 0 errors |
| `cargo test --lib --no-default-features --features cli` | 1628 passed |
| `cargo test --bin jan --no-default-features --features cli` | 14 passed |
| `cargo clippy` desktop (test-tauri) / cli, all targets | 0 errors (53 / 55 warnings) |
| `cargo test -p tauri-plugin-agent-tools -- --test-threads=4` (with `jan-sandbox-helper`) | 897 passed, 1 ignored |
| `cargo build --features cowork-smoke --example cowork-smoke` | ok; embeds the `build:web` output of this commit (checked by asset name) |

**Windows real-app matrix** (Windows 11, one process per scenario or per
restart half, a fresh profile and a unique fixture port per unit,
`COWORK_SMOKE_RETRIES=0`; the real-input title bar scenarios with
`COWORK_SMOKE_REAL_INPUT=1`). Final full run on `860bfc9e0`: 47 of 48
processes passed first time; the one failure (`memory-session-after-restart`,
a harness race) was fixed and that pair then passed three runs out of
three. Covered:
window-chrome and its restart; Stop, session models after restart, deleting
a running session, approval withdrawal, steering; custom headers and their
restart; background-job isolation; execution record and its restart; tool
activity timeline and its restart; event export 1/2; session export/import;
project attachment with session isolation; memory session, project, user,
provenance (each with its restart), precedence, conflict settle, conflict
scope with restart, security, proposal approval; prompt snapshot panel and
cross-session refusal; context replay 1/2; managed worktree review; team
review 1/2; proposal flags; proposal review/apply; worktree export; bundle
import 1/2; project tooling; agent roles.

First failures, kept, and what they were:

| Scenario | First failure | Kind | Resolution |
| --- | --- | --- | --- |
| `project-tooling-is-detected-and-told-to-the-model` | `mklink` "Invalid switch - tmp" (the caller spelled the kept profile `C:/...`) | harness | the fixture now passes native separators, as the other junction fixtures did (`e45209626`) |
| `memory-session-after-restart` | no "This chat" tab (first and second full runs) | harness race | wait for the tabs (`64c95ea3b`); 3 of 3 passes after |
| `session-isolation` alone | the attached session never appeared | harness ordering | it relies on `project-attachment` in the same process; passes run after it |
| `agent-roles` (passed, but its record showed it) | a child's refused calls written with no session, two children's `call_0` merged | integration defect | `860bfc9e0` |

**Real provider.** llama-server at `v100:8080` (`qwen3.8-27b`), through the
fixture's relay: `token-usage-cache` (Chat) showed input 2,816, cached 2,793,
output 26 against the provider's 2816 / 2793 / 26; `token-usage-cache-cowork`
showed 6,379 / 6,342 / 22 against 6379 / 6342 / 22; after a restart with no
provider traffic both were shown again unchanged.

Not run: macOS, Linux; providers other than the mock and this llama-server.
