# Campaigns (multi-thread coordinator)

Status: design, not implemented. The feature is called Campaigns in the UI and `campaign` in code, because "project" already means a folder in Flint.

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
12. `verification.rs` is a library with a `ModelInvoker`; confirm how the renderer invokes it, which may need a Tauri command wrapper.
