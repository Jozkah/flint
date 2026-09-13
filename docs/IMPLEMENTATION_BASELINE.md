# Implementation baseline for the redesign

This note is for the separate visual redesign that starts from the Phase 6
implementation branch (`feat/integrated-phase-6`). It lists what the redesign
must preserve, what it can freely change, and where the evidence behind the
current behaviour lives. It does not describe a design.

Baseline commit: the commit that adds this note (see git log; the last commit whose Rust+JS gate completed cleanly is 8ec5a528a, and this note adds only documentation on top of it).

## What a redesign may change

Layout, visual language, typography, colour, spacing, iconography, motion, the
arrangement of panels and rails, and copy that is not a refusal or a security
statement. The behaviour below is independent of how any of it looks.

## Contracts the redesign must preserve

**The canonical execution record is the source of truth.** Runs, tool calls,
approvals, steering, subagents, background jobs, usage and replays are events in
`events/<hash of session>.jsonl` (AH-004, AH-005), each with `session`, `run`,
`invocation`, `seq` and `kind`. The Timeline, run tree, context diff, replay and
exports read that record; a new UI must read it too, never reconstruct state from
what it happened to render. Order is `seq`, never a clock.

**Typed failures.** Every refusal and failure carries a harness error kind
(`permission_denied`, `approval_refused`, `policy_violation`, `tool_unavailable`,
`cancelled`, ...; AH-009). A UI shows the kind's meaning and the message; it must
not parse message text to decide what happened.

**Authority is decided by the backend, never by the UI.** Permission defaults,
deny lists, machine policy (`policy.toml`), Plan mode, role allowlists, forge
approval, write/read escapes and the git hardening are enforced where tools are
dispatched. A redesigned approval dialog is presentation only: the backend asks,
the UI answers `allow once`, `allow always` or `deny`, and a missing answer is a
denial. Nothing a project file says can widen what the user or machine allowed.

**Cache and usage wording.** Cache status is computed only from provider counts:
cached input > 0 is "Cache reused", an explicit 0 is "No cached input", an absent
field is "Not reported". Never infer it from latency or repeated prompts.

**Semantic search is only semantic with an embedding model.** Without one the tool
refuses; text search is labelled as text search.

**Stores on disk** (catalogued with their versions and upgrade behaviour in
`src-tauri/src/core/agent/state_schema.rs`, `jan cli agent state`): under the data
folder `events/`, `audit/tool-activity.jsonl`, `audit/permissions.jsonl`,
`audit/prompts.jsonl`, `audit/payload-usage.jsonl`, `audit/utility-agents.jsonl`,
`jobs/`, `mail/`, `index/`, `reviews/`, `replays/`, `proposals/`, `undo/`,
`team-children/`, `consensus/`, `pull_requests/`, `semantic/`, `snapshots`
(prompt snapshots); in a project `.jan/agent/memory/*.md` and
`.jan/agent/roles.toml`; user-chosen bundle, export and handoff files. A redesign
must not write these directly; it goes through the existing commands.

**Desktop commands and events.** The web app talks to the backend through the
Tauri commands registered in `src-tauri/src/lib.rs` and the plugin APIs under
`src-tauri/plugins/*`. Their names and payload shapes are the contract; a UI
rename does not rename a command.

## Accessibility requirements that stay in force

- AH-179: agent surfaces expose roles, labels and live regions; the Timeline list
  is a named feed with `aria-busy`, its state is a polite live region, its filters
  are a named group of `aria-pressed` toggles.
- AH-180: every agent surface is operable without a pointer; a structural scan of
  the agent-surface files fails on any click target a keyboard cannot reach.
- Both are held by `web-app/src/containers/__tests__/agentSurfaceAccessibility.test.tsx`;
  the scenario matrix drives the real app through the same selectors
  (`data-testid`). A redesign keeps these tests passing or replaces them with
  equivalent ones, and keeps the `data-testid` hooks the harness uses or updates
  the harness in the same change.

## Unfinished validation (external)

- AH-190 custom CA bundles: code-complete, validated on Windows only; macOS and
  Linux validation needs those hosts.
- AH-071 semantic search: code-complete, exercised with a local embedding fixture
  and the real servers' refusals; neither real provider serves an embedding model.

## Final gate

`/c/tmp/jan-p6-final-gate.sh <label>` (JS: plugin API build, typecheck, lint,
production web build, web/core/extension/scripts suites, registry validation and
render consistency, local-only guard, `git diff --check`; Rust: desktop library
tests, CLI check/library/bin tests, golden repositories, clippy for both feature
sets, agent-tools with the sandbox helper, LSP with gopls, TLS fixture, semantic
search, jan and harness builds), then the scenario matrix
`/c/tmp/jan-all-int-scn.sh` with retries off (includes the 8555 lanes and the
8080 cache lane) and the BranchCraft independent verification.

## Evidence

Kept outside the repository under `C:\tmp\jan-p6-evidence\` (ledger, per-batch
logs, real-provider lanes, BranchCraft transcripts, events and verification).
