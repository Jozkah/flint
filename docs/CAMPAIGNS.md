# Campaigns (multi-thread coordinator)

Status: P0 to P6 implemented, P7 open; see "Status" below. The feature is called Campaigns in the UI and `campaign` in code, because "project" already means a folder in Flint.

## Goal

One conversation acts as a coordinator. It splits a prompt into at most 12 tasks with dependencies. Each task runs as its own top-level Cowork session on its own `flint/...` worktree branch, in parallel up to a bounded limit. Context and decisions pass between threads. The coordinator verifies each result, merges in dependency order into an integration branch, and hands one proposal to the user's checkout for approval. Local only; no cloud sessions.

Non-goals: replacing subagents or the Cowork team (those stay for in-run delegation), auto-merging into the user's checkout, widening permissions, and extracting the Cowork run loop in the MVP.

## What already exists

- Programmatic session creation: `web-app/src/hooks/useCoworkSessions.ts` (`createSession`, `setFolder`, `setMode`, `setModel`, `setAccess`).
- Worktree per session: `useCoworkWorktrees.ensure(...)` calling `agent_worktree_ensure`; `worktree::ensure_with` takes `EnsureOptions{title, base}`; `agent_worktree_merge` and `agent_worktree_unmerged` exist and `ensure` is idempotent. Source: `src-tauri/src/core/agent/worktree.rs`.
- Per-child records, fingerprinting and proposals: `src-tauri/src/core/agent/team_children.rs`.
- Dependency graph, limits and retries: `web-app/src/lib/coworkTeam.ts` (`MAX_TEAM_PARALLEL`, `MAX_TEAM_TASKS`).
- Messaging between sessions: `src-tauri/plugins/tauri-plugin-agent-tools/src/session_mailbox.rs` and `docs/AGENT_MESSAGING.md`. Limits: 8000 chars, 10 per 60 s per sender, 30 per hour per pair, reply depth 6. Message content is untrusted.
- Completion notices: `web-app/src/lib/coworkRunNotices.ts` (in-memory only).
- Verification: `src-tauri/src/core/agent/verification.rs` (PASS/PARTIAL/FAIL/BLOCKED, `RepairBudget`).
- Budgets and spend: `web-app/src/lib/coworkBudget.ts`, `spend.rs`, `quota.rs`.

Constraint that shapes the design: the Cowork run loop is renderer-driven (`web-app/src/routes/cowork.tsx`, `lib/coworkRunner.ts`), so a session can only run while on screen. Parallelism is bounded by split panes (default 4, max 6). `lib/mailboxDelivery.ts::applyAutoWake` already adds a pane to wake a session.

## Data model

Stored under `<data>/campaigns/<campaign_id>/`, written with `atomic_file.rs`, with an append-only `events.jsonl` via `event_log.rs`.

- `campaign.json`: id, title, coordinator session, source root, base branch and sha, integration branch and worktree, mode ceiling, model, limits (max parallel, max tasks, token budget, per-task tokens and steps, wall clock), status, process epoch, and the task list.
- Each task: id, title, brief, acceptance criteria, declared paths, `dependsOn`, session id, branch, worktree path, base sha, status, attempt, verdict, tokens used, handoff path, merged sha, fingerprint.
- `decisions.md`: append-only, written by the coordinator only.
- `tasks/<id>/handoff.md`: a task's final summary, changed files and open questions.

Project status: `draft`, `planned`, `approved`, `running` (or `paused`), `reviewing`, `merging`, `done`, `failed`, `cancelled`. A running record from an earlier process epoch reads as `interrupted`.

Task status: `pending`, `blocked`, `queued`, `running`, `awaiting_input`, `awaiting_approval`, `completed`, `verifying`, `verified`, `merged`, plus `failed`, `cancelled`, `interrupted`, `conflict`. `completed` is only a worker claim; `verified` requires a verification PASS and a missing verdict is BLOCKED, never PASS. Retries are capped at 2.

A session gets an optional `campaign: {id, taskId, role}` pointer. The backend record is the source of truth for status.

## Coordinator flow

1. The coordinator session calls `campaign_plan` with the task list. The backend validates limits, cycles and path overlap.
2. The user approves a plan card (always-ask, allow once) that shows task count, paths, mode, budget and parallelism.
3. The backend ensures the integration worktree and writes `campaign.json`.
4. The scheduler starts every task whose dependencies are `merged`, up to the parallel limit. For each: create a session, ensure a worktree based on the integration branch, register with the mailbox, seed the first turn with the brief, acceptance criteria, a `decisions.md` snapshot and upstream handoffs (fenced as untrusted data), open a pane so the run can start.
5. When a task's run ends, the renderer writes `handoff.md`, commits pending changes, records the fingerprint and notifies the coordinator.
6. The coordinator collects results and runs verification per task, with one repair round on FAIL or PARTIAL.
7. Verified tasks merge into the integration branch in topological order. A conflict aborts the merge, marks the task `conflict`, and spawns a resolver task or parks it for the user.
8. When everything is merged, run the final build and test gate on the integration worktree, then create a single proposal to the user's checkout through the existing proposal path. The user approves the apply.

## Context passing

No transcripts cross threads. Briefs go in seed turns, not in mail, to stay inside mailbox rate limits. Mid-run steering uses the mailbox or `campaign_steer`. A task writes only its own handoff; only the coordinator appends decisions.

## New code

Rust, in `src-tauri/src/core/agent/`: `campaign.rs` (types, state machines, plan validation, persistence) and `campaign_scheduler.rs` (a pure `next_actions` function). Tauri commands: `agent_campaign_create`, `_get`, `_list`, `_transition`, `_task_settle`, `_merge_task`, `_integrate`, `_propose`, `_cancel`, `_resume`, `_decisions_append`, registered next to the `agent_team_child_*` commands.

Agent tools, coordinator session only: `campaign_plan`, `campaign_status`, `campaign_collect`, `campaign_decide`, `campaign_steer`, `campaign_merge`, `campaign_cancel`.

Web: `lib/campaignPlan.ts`, `lib/campaignRunner.ts`, `lib/campaignTools.ts`, `lib/campaignDelivery.ts`, `hooks/useCampaigns.ts`, `routes/campaign/$campaignId.tsx`, `components/campaign/{Board,TaskCard,PlanCard,BudgetBar}.tsx`, plus locale keys.

## Limits, cancellation, recovery

- At most 12 tasks. Max parallel threads is a user setting (Settings, Campaigns). Default 4, allowed range 1 to 6, matching the split-pane limit (`SPLIT_DEFAULT_MAX_PANES=4`, hard max 6). It is read when the scheduler starts a task, so changing it applies to running campaigns without a restart. Free panes still cap the effective value.
- Token budget per task and per project; warn at 80 percent, stop spawning at 100 percent. Wall-clock cap and step cap per task.
- Cancel a task with `abortRun`. Cancel the project by aborting running tasks and marking queued ones cancelled. Worktrees are discarded only on an explicit user action.
- On startup, reconcile: records from another process epoch become `interrupted`. Resume re-ensures worktrees, fingerprints changes and re-queues. Unfinished work is never treated as clean.

## Security

A task's mode is the minimum of the project ceiling and the coordinator's mode; `bypass` is never inherited. Tasks use managed-worktree access. Plan approval does not pre-approve tool calls. Mailbox content, handoffs and briefs are untrusted and fenced. Campaign tools are never given to tasks or subagents. Org policy and hooks apply per session unchanged. Declared paths are advisory for scheduling; the real boundary is the worktree plus the apply-time proposal.

## Delivery phases

Each phase is independently committable and testable.

- P0: pure model (types, state machines, plan validation, scheduler). Unit tests only.
- P1: persistence, events log, Tauri commands, list and reconcile. Temp-dir tests mirroring `team_children`.
- P2: MVP, no UI. `campaign_plan`, `campaign_status`, `campaign_collect`, `campaign_cancel`, and a runner that creates N worktree sessions and collects completion notices. Vitest with mocked invoke; manual check on a repo with two independent tasks.
- P3: plan approval card, `campaign_steer`, `campaign_decide`, decisions and handoff files.
- P4: verification glue, integration worktree, topological merge, conflict handling, final proposal. Fixture git repos for clean and conflicting merges.
- P5: sidebar grouping, session pointer and migration, status dots.
- P6: board route with cards, actions and budget bar.
- P2 also adds the `campaigns.maxParallel` setting and its settings control (web-app settings route, locale keys).
- P7: hardening: aggregate budget, wall-clock cap, pause and resume, orphan worktree sweep. Optional headless runner through the durable worker to remove the pane cap.

## Status

Implemented (P0 to P3):

- Rust model, scheduler, persistence and commands (`campaign.rs`, `campaign_scheduler.rs`, `agent_campaign_*`), plus `agent_campaign_context` (decisions tail and handoffs), `agent_campaign_events`, `agent_campaign_notified` and `agent_worktree_commit_pending`. A campaign move may carry the integration branch and worktree (`TransitionInput.integration`), recorded on approval so a denied plan creates nothing.
- Renderer: `lib/campaignModel.ts` (types, clamp, mode rules, a TS port of `next_actions`), `campaignRunner.ts` (start, settle, resume, cancel, re-push notices), `campaignSeed.ts` (fenced seed turn), `campaignTools.ts` and `campaignToolSchemas.ts` (the six tools), `campaignHost.ts` (store wiring, started from `useMailboxDelivery`).
- Tools `campaign_plan`, `campaign_status`, `campaign_collect`, `campaign_cancel`, `campaign_steer`, `campaign_decide`, offered only to a top-level Cowork run that is not a campaign task (`campaignCoordinator` tool option, `DispatchContext.onCampaign`). Every campaign id is checked against the calling session.
- `campaign_plan` is always-ask, allow-once only (`ALWAYS_ASK_TOOLS`), asked in every mode including bypass. It records `planned`, asks, then `approved` and `running`; a denial cancels the recorded plan (nothing had started), so it leaves no group in the sidebar. The plan card is the existing approval card (title, task titles and paths, summary of count, mode, budget, parallelism); the dedicated board components are P6.
- Setting `campaigns.maxParallel` (store `useCampaignSettings`, default 4, clamped 1 to 6, Settings, Agent tools, Behaviour) and the optional `campaign?: {id, taskId, role}` on `CoworkSession` (persisted shape v5, additive migration).

Implemented (P4: verify, merge, gate, propose):

- Backend `campaign_integration.rs`, commands `agent_campaign_verify_prepare`, `_verify_finish`, `_merge_task`, `_integrate`, `_gate_plan`, `_finalize`, `_refresh`, `_orphans`.
- **Verify.** `verify_prepare` re-derives the task worktree from Git, builds the verifier request with `verification::build_request` (task spec and acceptance, the committed diff, the output of the detected build or test command, and the handoff as a fenced worker claim; worker reasoning is not passed) and moves the task to `verifying`. The renderer runs that request with the campaign's model (`RunnerHost.askVerifier`, a utility-agent call with no tools, audited) and hands the reply to `verify_finish`, which uses `parse_report`. This is the answer to open question 12: the Rust `ModelInvoker` is not reachable from the renderer, so the renderer owns the model call and the backend owns the framing and the verdict. PASS makes the task `verified`. FAIL or PARTIAL gets one repair round (`RepairBudget`, 1): the task is queued again in its own session, its `detail` carries the findings and its seed turn fences them as data (done through the seed turn rather than mailbox mail, to stay out of mailbox rate limits and to reuse the pane and worktree it already has); a second FAIL or PARTIAL is `failed`. BLOCKED, an unreachable model, an empty reply or a reply with no VERDICT line stays `completed` with verdict BLOCKED and never merges. The runner verifies automatically when a task settles `completed`; `campaign_verify` retries.
- **Merge.** `merge_task` and `integrate` merge `verified` tasks into the integration branch with `worktree::merge` in topological order. Before anything is read or merged the recorded worktree path, branch and base are matched against Git: the path must be a worktree of the source repository listed on that branch, under Flint's worktrees folder, on a `flint/` or `jan/cowork/` branch, in the state it was recorded in, and the base commit must be in the branch history. A task depends only on merged work. The merge is tested with `merge-tree` first, so a conflict moves no ref and aborts nothing half-done: the task becomes `conflict` with `detail` naming the files and `campaign_merge` returns them. A merged task records `mergedSha` and the runner starts the tasks that were waiting on it. Conflicts are parked for the coordinator (steer the task to rebase on the integration branch, or skip it with `campaign_merge skip=[...]`); spawning a resolver task is not built.
- **Gate and proposal.** When every task is merged or cancelled (at least one merged) the campaign moves to `reviewing` and the coordinator is told. `campaign_merge finalize=true` asks the user (always-ask, shows the gate command), then `finalize` moves to `merging`, runs the gate command on the integration worktree and, when it passes, stores ONE proposal against the campaign's base commit through the ordinary proposal store (`proposal::create`); nothing is written to the user's checkout. A failing gate returns to `reviewing` with the output kept in `campaign.gate`. Gate command source: `[campaign] gate = "..."` in `.jan/agent/agent.toml` (there was no existing build or test key), else the repository's own `package.json` `test` then `build` script (run with yarn, pnpm or npm by lockfile), else `cargo check`, else `go build ./...`, else none. With none, the gate is skipped and the result carries a visible warning that the merged result was not built or tested. The proposal's apply is the user's approval; `refresh` (run at startup and by `finalize`) moves a `merging` campaign to `done` when its proposal was applied and back to `reviewing` when it was rejected.
- Tools `campaign_verify`, `campaign_merge`, `campaign_orphans`, coordinator only. `campaign_merge` is not blanket always-ask: merging into the integration branch does not touch the user's checkout, so only the `finalize` step asks (always, with the command shown).
- **Gaps closed.** An idle coordinator is woken by mail from the finished task through the mailbox auto-wake path (a running one still gets a step-boundary notice, and a failed send falls back to it). `awaiting_input` and `awaiting_approval` are mirrored from the pending ask and approval stores by a 10 s sweep. Per-task wall-clock, step and token limits are enforced by the same sweep: the run is aborted and the task is `failed` with the reason. The project token budget counts live runs, warns at 80 percent and stops starts at 100 percent. A task whose pane closed before its run began is detected (not shown, no run, past a 15 s grace) and re-queued through `interrupted`. `agent_campaign_orphans` and `campaign_orphans` list the worktrees finished campaigns left, with what removing each would destroy; nothing deletes them.

Implemented (P5 sidebar, P6 board):

- **Sidebar group (P5).** Derived, not persisted, so the user's own groups and the Home projects are untouched. `lib/campaignView.ts::deriveCampaignGroups` builds one group per backend campaign that still has a session in the store (coordinator row, then one row per task session in plan order, a session in at most one group, active campaigns first). `CoworkNav` lists these above its own groups and leaves the claimed sessions out of the ordinary tree. Task rows are the normal session rows with a status dot (queued, blocked, running, needs-you, verifying, verified, merged, failed, conflict, cancelled); the header reads "3/5 done · running" and opens the board. Sessions of a campaign the backend does not list keep their normal place.
- **Board (P6).** Route `/campaign/$campaignId` (`routes/campaign/$campaignId.tsx`, kept on the Cowork sidebar by `isCoworkRoute`), components `components/campaign/{Board,TaskCard,BudgetBar,StatusDot}.tsx`. Columns: Blocked, Queued, Running, Needs you, Verifying, Done (verified or merged), Failed / Conflict (cancelled is shown here too). A pending task with unmerged dependencies sits in Blocked. Header: status, progress, parallel limit from `campaigns.maxParallel`, token budget bar (warns at 80 percent), Pause, Resume, Cancel, and Review & apply when the campaign is `reviewing`.
- **Actions** (`lib/campaignBoardActions.ts`, all through existing paths): open session; send note (the `campaign_steer` mail path from the coordinator session to the task session, running tasks only); stop (aborts the live run, which the runner settles as cancelled; a not-yet-running task is cancelled by transition); retry (failed or conflict back to queued, cap 2, then the scheduler is kicked); skip (the `campaign_merge skip` set, a transition to cancelled); view handoff (`agent_campaign_context`); pause and resume (campaign transition, resume kicks the scheduler); cancel (runner `cancel`, with a confirm); Review & apply (shows the gate command from `agent_campaign_gate_plan` in a confirm dialog, then `agent_campaign_finalize`, which stores the one proposal; applying it is still the user's step in the proposal review).
- **Data.** `hooks/useCampaigns.ts` polls `agent_campaign_list`: every 3 s while a campaign is approved, running, reviewing, merging or interrupted, every 15 s otherwise, only while a component uses it. No new Rust command.
- Board keys are in `settings:campaigns.board.*`, English in every locale file.

Live QA fixes (F1 to F12, after the first smoke run of the whole feature):

- **F1 limits.** `CampaignLimits` deserializes with defaults for every field (max parallel 4, clamped 1 to 6; max tasks 12; budget and per-task limits optional), and the renderer sends a full limits object. A bare `{maxParallel, tokenBudget}` used to fail with "missing field maxTasks".
- **F2 first turn.** A campaign task session never gets the read-only opening: `decideOpening` takes `campaignTask` and follows the request, so write, edit and bash are there from turn one (the managed worktree is still the boundary). The coordinator keeps the read-only opening for a plain first remark but is offered `campaign_plan` in it (the tool list is judged on the session's own mode, not the opening's forced review); `campaign_plan` still asks first, and the tasks' mode ceiling comes from the session's own mode. A review-mode session gets no campaign tools.
- **F3 panes.** Free panes count empty panes, room to add, and panes that only show a campaign task with no live run, no pending seed, no live-status record and no start in the last 30 s (`lib/campaignPanes.ts`). Those panes are recycled when a start needs one. The user's own sessions and chats are never recycled or closed.
- **F4 runs off screen.** The board route mounts `CoworkRunHost`: a hidden copy of the Cowork page for every Cowork pane (and for the current session when it belongs to a campaign), so runs keep progressing while the board is open. It is mounted only on the campaign route, never beside the Cowork route, so a session is not driven twice. Closing every pane still stops a run, which the sweep re-queues.
- **F5 review transition.** Any task move that leaves every task merged or cancelled with at least one merged moves a running campaign to `reviewing` (`advance_to_review`), including a skip or cancel of the last open task.
- **F6 proposal state.** The campaigns poll calls `agent_campaign_refresh` for every merging or reviewing campaign that has a proposal, so an applied proposal reaches `done` and a rejected one returns to `reviewing` without a tool call.
- **F7 review and apply.** The board shows the campaign's proposal (found by the id on the record) in the ordinary proposal review: file and hunk choice, conflicts and the apply approval, then refreshes the campaign. Proposal listing compares project paths without the Windows verbatim prefix, slash style, trailing separators or case, so a plain path finds a proposal stored under the verbatim form.
- **F8 gate source.** The gate command is read from the integration worktree's `agent.toml` first (`agent_toml`), then from the user's checkout's `agent.toml`, committed or not (`agent_toml_checkout`), then detected. The finalize card says which. The checkout fallback is the user's own file, and the command is shown in the approval before it runs.
- **F9 denied plan.** Denial cancels the recorded campaign; a campaign that never started a task (planned, draft or cancelled with no task session) has no sidebar group.
- **F10 restart.** Interrupted tasks still resume on their own at startup. The board shows "Resumed N task(s) that were interrupted when the app stopped" until dismissed (in memory, per launch).
- **F11 steering.** A note is a mailbox message from the coordinator to the task session. For a running task it is taken for delivery, queued ready, and claimed at the run's next step boundary (covered by `campaignSteerDelivery.test.ts` over the real delivery code and an in-memory mailbox). The card shows "Note sent" until the message is no longer unread in the recipient's inbox (the run claimed it), then "Note delivered to the task".
- **F12 context.** "The estimated request exceeds the available context size" is the renderer's own guard (`assertEstimatedContextFits`): system prompt, tool definitions and history against the window, less the reserve. It is not double counting. The coordinator's nine campaign tools add about 5.5 KB of definitions (roughly 1.4k tokens) to a tool list of about 13 KB, so a small configured window fails on a tiny prompt. Reduce the enabled tools or raise the window. A task's seed was the only unbounded campaign text: decisions are now capped at `SEED_MAX_DECISIONS_CHARS` (8 000, newest kept) and upstream handoffs share `SEED_MAX_HANDOFFS_CHARS` (24 000, at least 1 500 each), each cut marked with how much was left out.
- Minor: the board breadcrumb reads "Cowork / Campaign"; top toasts start below the 52 px header.

Known gaps and limits:

- The fixes above are covered by unit tests and need one more live pass. Verification, merge and gate were exercised by Rust fixture-repo tests (clean merge, conflict, topological order, dependents unblocked, path and branch and base re-verification, gate selection, gate fail and pass, proposal creation without writing the checkout) and by vitest with mocked invoke; not smoke-tested in the running app.
- A step is counted as one tool call in the live run's turns, not the Rust loop's step index.
- The verifier's own token spend is recorded in the utility-agent audit, not on the task (`tokens` is 0 from the renderer call).
- No resolver task for conflicts and no `add_task` to a running plan.
- A campaign with a failed or conflicted task finishes only after the coordinator skips it (`campaign_merge skip`); `campaign_cancel` cancels everything.
- Gate and task checks run the repository's own commands with the user's shell, bounded by a deadline (180 s for a task check, 600 s for the gate). A repository can set the gate command in its `agent.toml`; the finalize approval shows it first, but the per-task check that runs while verifying uses the detected or configured command without a prompt.
- Pane-bound parallelism, the 12-worktree disk cost and pause and resume remain P7.
- A notice reaches a running coordinator at its next step boundary and is in memory only; the event log re-pushes after a restart.
- The integration worktree (`campaign-<id>` key) and task worktrees are kept until the user discards them.
- Added locale keys are English in every locale file.
- Board: "view diff" shows the files the task session changed (from its recorded file activity), not a rendered diff; there is no backend command for a task branch's diff yet. The files-changed count and last activity come from the renderer's session store, so they are blank for a session that was deleted. Not smoke-tested in the running app; covered by vitest on the mapping, group derivation, budget math and action dispatch with mocked invoke.

## Open questions

1. Decided: the UI name is Campaigns. Legacy "project" (folder) naming is untouched.
2. Decided: parallelism stays pane-bound for the MVP, default 4, user-configurable 1 to 6 in settings. Removing the pane cap needs the run driver extracted or the headless CLI worker (P7, optional).
3. The scheduler lives in the renderer, so closing the window pauses everything. Backend state keeps resume correct.
4. Mailbox rate limits could throttle heavy steering; a campaign-origin exemption would be a security-sensitive change in `session_mailbox.rs`.
5. Coordinator notices must not count as depth-greater-than-zero replies or they will be blocked by the loop guard (`lastRunWasWake`).
6. Textually clean merges can still break the build; the final build and test gate is the only defense, and its command source (agent.toml or detected) is undecided.
7. Worktree disk use and Windows path length with up to 12 worktrees; may need `agent_worktree_optimize`.
8. Cost: N parallel top-level sessions multiply spend. The plan card needs an estimate and a sane default budget.
9. Uncommitted work in the source checkout is invisible to worktrees (existing behavior); the plan card must say so.
10. Adding the `campaign` field to persisted sessions needs a migration bump in `useCoworkSessions.ts`.
11. Backend and renderer state can disagree after a crash. Rule: the backend wins for status, the session store wins for transcript.
12. Decided in P4: the renderer runs the model call; the backend builds the fenced request and parses the verdict (`agent_campaign_verify_prepare` and `_verify_finish`).
