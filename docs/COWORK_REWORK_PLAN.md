# Flint Cowork Trust and Coding Rework

## Decision

Proceed with a focused Cowork rework. Keep ordinary Flint chats lightweight and conversational. Make Cowork the explicit, repository-bound agent experience.

Use `4ad88aaf1` (`fix(cowork): tell the truth about external files, and prove it`) as the integration baseline. It already contains the external-file safety, file activity, session isolation, model organization, and related fixes described in the September 4 handoff. Do not recreate those changes on an older branch.

This is not a project to clone the full Claude Code, OpenCode, or Hermes harness. It is a project to make Flint's smaller harness predictable, honest, and safe enough that a user can trust which repository it is reading, what instructions it loaded, and whether it is allowed to act.

## Product diagnosis

### Target user

A developer who wants to open a local repository in Flint, ask it to inspect or continue work, review the proposed next step, and then let it make verifiable changes without writing a long defensive prompt.

### Observed failure

The screenshot shows a sidebar item named `D:\Code\obs-forwarder` while the assistant reports that it selected and inspected `D:\Code\note-py`. The current legacy "Projects" model explains the mismatch: a project stores only an id, display name, timestamp, and optional assistant. It is a chat/RAG collection, not a filesystem binding. A path-shaped project name therefore creates a false affordance.

The same run also demonstrates three behavioral failures:

1. It inferred a repository instead of treating the selected repository as an invariant.
2. It moved directly toward task 2 instead of stopping after the requested read/continuity check and obtaining consent for the next action.
3. It did not make requested skills/instructions visibly loaded or visibly unavailable.

The external-file handoff adds a second class of trust failures: snapshot files previously looked reloadable, restored tabs could resolve against the wrong workspace or session, and late reads could overwrite newer selections. Those defects are fixed on `4ad88aaf1`, but the native macOS flow and a clean full-suite run remain unverified.

### Root causes

- "Projects" conflates chat organization, uploaded knowledge, and a local code folder.
- Cowork's folder binding exists, but it is visually secondary and separate from the older Projects surface.
- New Cowork sessions default to action mode; plan mode is opt-in and represented by a subtle icon.
- The Cowork system prompt says to prefer acting over asking, which is wrong for an ambiguous first turn asking Flint to learn and resume work.
- Only root-level `JAN.md` is automatically loaded. Other harness files are deliberately ignored, and skill activation is not presented as a preflight contract.
- The attached repository is read-only while generated changes land in a hidden session sandbox. That is safe, but it does not match a developer's ordinary meaning of "work on this project."
- Capability and context assembly are mostly invisible, making failures look like model mistakes instead of missing setup.

## Product promise

When Cowork says a repository is open, every project read, search, instruction, skill, command, and edit belongs to that exact repository-bound session. Before the first mutation, Flint shows what it loaded and asks the user to approve the proposed next action unless the user explicitly chose an autonomous mode.

## Anti-goals

- Do not inject a 50k-token generic coding prompt into normal chats.
- Do not silently emulate every Claude Code or OpenCode convention.
- Do not scan sibling directories to guess which repository the user meant.
- Do not call an uploaded-file collection a local code project.
- Do not claim that sandbox output changed the attached repository.
- Do not merge while the required native smoke gate is still unverified.

## Rework plan

### Phase 0 — Integrate and stabilize the existing fixes

1. Base the work on `4ad88aaf1`, or merge that branch first with conflict review. Preserve its external-file semantics and tests:
   - external `File` objects are snapshots;
   - the action is "Choose again," not "Reload";
   - every replacement passes size, sensitive-file, binary, and readability checks;
   - restored external tabs never resolve against a project or session workspace;
   - handles are session-scoped;
   - late selection results cannot overwrite a newer selection;
   - file activity remains deduplicated, correctly settled, attributed, and ordered.
2. Free enough disk space for a native build. Prefer removing the current worktree's regenerable `src-tauri/target` only after confirming the target. Do not delete sibling worktrees or their state.
3. Stop or relocate the unrelated long-running Flint process that is causing random test failures, with explicit user approval if it belongs to another session.
4. Re-run the full root suite in a stable environment and record exact totals, skips, todos, and the unchanged baseline `formatDate` failure if it still exists.
5. Build the macOS app and execute all 12 prepared drag/drop and file-opening smoke cases. Record evidence for each case. Repeat the equivalent critical path on Windows because the original defect was reported with Windows paths.

Exit gate: the branch has a reproducible test result and the native file workflow is verified, not merely compiled.

### Phase 1 — Remove the false project affordance

1. Rename legacy sidebar **Projects** to **Collections** (or **Chat projects**) everywhere. Describe them as groups of conversations and indexed uploads. Never render them as filesystem folders.
2. Replace **New Projects** with **New collection**. If a user enters path-like text, show a non-blocking explanation: "This names a chat collection; it does not open that folder," plus an **Open code folder in Cowork** action.
3. Add a primary **Open code folder** entry point that opens the native directory picker and creates/selects a Cowork session already bound to the chosen canonical path.
4. Keep the selected repository identity persistent and visible in Cowork: basename, full canonical path, Git branch, availability, and access mode.
5. On restore, missing, moved, or inaccessible roots must block execution and ask for re-selection. Never fall back to a parent, sibling, recent, or same-named directory.

Exit gate: a user cannot reasonably mistake a chat collection for an opened local repository.

### Phase 2 — Make repository identity an enforced runtime invariant

1. Introduce a `WorkspaceBinding` captured at run start:
   - Cowork session id;
   - canonical root path and stable project key;
   - Git branch/head when available;
   - access mode;
   - binding revision incremented on attach/change/detach.
2. Pass the immutable binding to prompt construction, tool advertisement, every tool dispatch, subagents, code tabs, file activity, and artifact attribution.
3. Root all relative paths against the binding. Reject absolute or normalized paths outside it. Remove any repository guessing or broad `D:\Code`-style discovery from project-bound runs.
4. Cancel or discard in-flight reads when the binding revision changes. Clear project-derived selections, tabs, cached instructions, and pending references atomically.
5. Before each model step that can dispatch tools, verify that the live session still matches the run binding. Stop with a visible "project changed" state if it does not.

Exit gate: with several sibling repositories present, the exact screenshot prompt can touch only the folder chosen by the picker; tests assert that no call targets `note-py` or another sibling.

### Phase 3 — Add a visible readiness and first-turn review gate

1. New repo-bound Cowork sessions start in **Review first** mode. The initial run may read, list, search, inspect Git state, read instructions, and resolve skills, but cannot write or run mutating commands.
2. Replace the subtle first-run plan icon with an explicit mode selector:
   - **Review first** — default for a new repository;
   - **Ask before changes** — approvals gate mutations;
   - **Autonomous** — opt-in, clearly labeled.
3. Show a compact readiness card before the first run:
   - exact repository path and branch;
   - read-only sandbox, managed worktree, or direct-write mode;
   - instruction files loaded;
   - requested/active/missing skills;
   - MCP and built-in tool availability;
   - selected model and whether it supports tools;
   - context budget status.
4. Classify first-turn intent. Requests such as "read this project," "learn it," "continue where another harness stopped," or "probably task 1" end after inspection with:
   - what repository was inspected;
   - what instructions and plans were found;
   - current Git status;
   - completed/incomplete task evidence;
   - the proposed next task;
   - an explicit **Continue with task N** approval.
5. Keep direct execution available only when the user's wording is unambiguous (for example, "implement task 2 now") or they explicitly selected Autonomous.

Exit gate: the feedback prompt produces a status/continuity report and approval request, with zero writes and zero mutating shell calls.

### Phase 4 — Build a small, inspectable coding context pack

1. Assemble context dynamically for Cowork only. Include:
   - workspace binding and access rules;
   - concise tool/permission contract;
   - repository instructions;
   - selected skill manifests;
   - Git status and current task/todo/handoff state;
   - a shallow repository map generated on demand;
   - relevant conversation summary after compaction.
2. Keep normal chat's initial context small. Do not pay the coding-harness cost unless the user opens Cowork.
3. Preserve `JAN.md` as Flint's authoritative native instruction file. Add an explicit compatibility setting for recognized foreign files (`AGENTS.md`, `CLAUDE.md`, or project-defined paths) rather than silently ingesting them. The readiness card must name every file actually loaded and its precedence.
4. Resolve explicitly named skills before the model can act. If the user requests "superpowers" and it is missing, disabled, unreadable, or ambiguous, stop and present the exact issue. Never silently ignore the request.
5. Add a context inspector showing approximate tokens by category and warning when instructions, skills, or history were omitted or compacted.

Exit gate: a user can answer "what context did Flint receive?" from the UI, and requested skills cannot disappear silently.

### Phase 5 — Align write behavior with the coding promise

1. Offer three honest access modes:
   - **Review only**: attached repository is read-only; outputs stay in the session sandbox.
   - **Managed worktree**: recommended for Git repositories; Flint edits an isolated worktree and shows a branch diff.
   - **Edit this folder**: explicit opt-in for direct repository mutation with approval policy and Git dirty-state warning.
2. Do not hide the destination of changes. Show it beside the project identity and in every Changes view.
3. For managed worktrees, record source repository, base revision, worktree path, and branch. Refuse stale or mismatched bindings.
4. Before the first mutation, summarize the planned files/actions. After work, show the actual diff, tests run, failures, and files that remain only in the sandbox.

Exit gate: "continue implementing this project" either changes the selected repo/worktree as explicitly authorized or clearly remains a review-only run. No third interpretation exists.

### Phase 6 — Consolidated regression and release gate

Automate these scenarios end to end:

1. **Wrong sibling regression (Windows):** select `D:\Code\obs-forwarder`, place `note-py` beside it, send the reported prompt, and assert every read/search/tool root is `obs-forwarder`.
2. **First-turn consent:** the reported continuity prompt performs inspection only and waits for approval before task 2.
3. **Explicit execution:** "implement task 2 now" can proceed under the chosen approval/access mode.
4. **Skill adherence:** a present requested skill is loaded and named; a missing or disabled requested skill blocks action with an explanation.
5. **Instruction precedence:** loaded instruction files and precedence match the readiness card and context inspector.
6. **Project switch race:** switch roots during a slow read; the old result is discarded and no stale tab/reference/tool call crosses sessions.
7. **Restore:** restart with a missing or moved repository; execution is blocked until the user chooses it again.
8. **External files:** preserve every lifecycle and safety test from `4ad88aaf1`, including same-name replacement and out-of-order completion.
9. **Activity:** preserve per-operation settling, cancellation, retry, deduplication, attribution, deterministic ordering, and session-switch coverage.
10. **Native smoke:** complete the 12 macOS cases and the critical Windows directory/project cases from packaged apps.
11. **Full suite:** run in a non-contended environment and distinguish known unchanged baseline failures from regressions with commit-to-commit proof.
12. **No false claims:** UI and assistant copy never call a collection a folder, a snapshot a live file, or a sandbox write a repository edit.

Release only when all product invariants pass on the integrated branch. A green web test subset is not sufficient.

## Priority and sequencing

| Priority | Work | Why first |
| --- | --- | --- |
| P0 | Integrate `4ad88aaf1` and clear native/test blockers | Prevents losing already-fixed safety work and establishes a trustworthy baseline |
| P0 | Rename legacy Projects and add Open code folder | Removes the exact false affordance in the screenshot |
| P0 | Enforce immutable repository binding | Prevents the highest-severity wrong-repository failure |
| P0 | Default first repo turn to Review first | Prevents surprise edits and task skipping |
| P1 | Readiness card and skill/instruction resolution | Makes harness context observable and requested behavior enforceable |
| P1 | Managed worktree/direct-write access modes | Makes Cowork useful for real implementation without lying about destinations |
| P1 | Context inspector and compaction visibility | Reduces derail risk without bloating every chat |
| P0 release | Cross-platform integrated regression gate | Proves both feedback sets are fixed together |

## Success measures

- 0 wrong-root tool calls in automated sibling-repository and session-switch tests.
- 0 mutations before approval for ambiguous first-turn continuity prompts in Review first mode.
- 100% of explicitly requested skills end in one visible state: loaded, missing, disabled, or failed.
- 100% of agent-created file changes are attributed to the selected repository, managed worktree, or session sandbox.
- 100% of restored missing roots require re-selection rather than fallback.
- The full test suite and packaged macOS/Windows critical flows have recorded, reproducible results before merge.

## Go/no-go recommendation

Go, with the scope above. The highest-value work is not a larger system prompt. It is making the selected repository and permission mode a hard runtime boundary, then making first-turn intent and loaded context visible. If managed/direct repository editing is deferred, market Cowork honestly as review/prototyping rather than as a coding harness that continues implementation in place.
