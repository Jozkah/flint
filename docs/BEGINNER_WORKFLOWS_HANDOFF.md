# Beginner workflows: functional handoff for the design chat

Branch: `feature/beginner-workflows` (based on `feat/windows-agent-completion` at
`728f5cb0a`). Not pushed, not merged.

This document describes behaviour, state and contracts independently of the
current layout, so the JAN Atelier redesign can re-skin these workflows without
changing what they do. The visual redesign was deliberately not attempted: new
UI uses the existing shadcn/Radix components and tokens.

The authoritative AH-001..AH-210 registry (`docs/agent-harness-features.json`)
was not renumbered or re-scoped. No registry status was changed by this work;
where a workflow touches a registry item it is noted below as evidence for a
later registry update, not as a claim that the item is `verified`.

---

## 1. Initial findings and what was reused

| Area | Found | Reused / extended |
| --- | --- | --- |
| Onboarding | `SetupScreen` 3-page wizard (welcome, engine setup, finish) shown whenever no usable provider exists. In-memory state, no intents, no resume, no guide. Local-only fork: no model downloads. | Same wizard and gate; added intentions, processing explanation, persisted progress, a home guide card. |
| Model fit | Two estimators (Rust `is_model_supported`, unused by UI; TS `estimateModelFit`, used for a colour dot). Conservative: ~2.13 GiB reserve subtracted from RAM *and* VRAM, any partial offload "yellow", iGPU memory added on top of RAM, KV = 10% of file per 4k tokens. Nothing blocked. No measured results. | `modelCompatibility.ts` rewritten in place (old exports kept); dot kept, now opens a details popover. |
| Permissions | Rust gate + `useToolApproval` / `useToolApprovalRequests`. Prompt received tool name only; Cowork dropped call input; no revoke except MCP checkbox; audit log written but unreadable from UI; no pending count. | Same engine and stores; richer request description, scopes, revoke APIs, Permissions page, read-only audit command. |
| Results / recovery | `CoworkRunSummary` (files only), `CoworkRunNotice`, `CoworkRewind`. Managed checkpoints after the first all held the same tree (capture used `changed: []`); restore could silently overwrite newer edits. | Same components; one derived `RunOutcome`; safety checkpoint before restore; Rust capture fixed. |
| Connections | MCP settings page with boolean connected state, toast-only errors, form without field validation. Skills dialog without explanations. Plugin commands exist in Rust with no UI. | Same page/dialogs; validation, connection state model, explanations. No marketplace. |
| Settings | Registry-driven menu, core/integrations groups, search. | Advanced group added in the menu only; registry and search untouched. |
| Glossary | None. | New `TermHint`. |

## 2. Implemented improvements

### 2.1 First run and guide
- Welcome page asks for one of three intentions: **ask a question**, **work with
  documents**, **build or change a project**. Choosing is optional.
- "Skip the guide" still runs engine setup; it only suppresses the home guide.
- The final page explains local processing (stays on this computer, no
  account) and remote processing (messages and included files are sent to the
  provider, which may charge), with a link to provider settings. Local use never
  requires credentials.
- Finishing with a local model: project intention goes to Cowork with that model
  selected; other intentions open a new chat with it.
- Home guide card lists steps per intention. Observed steps: *choose a model*
  (a usable provider exists) and *first task* (a conversation was created after
  the guide started). User-confirmed steps: *add material* and *check what JAN
  used*. The card can be hidden; the guide can be reopened from
  Settings > General.
- Returning users (guide not in progress) see a link to their most recent
  conversation.
- No demo content is created. The guide never creates threads, files or
  activity.

### 2.2 Progressive disclosure
- `TermHint` keeps a technical term visible and opens its plain-language
  definition on click or keyboard (not hover-only). Terms: worktree, context,
  MCP server, checkpoint, agent (`locales/en/glossary.json`).
- Settings menu groups Local API server, HTTPS proxy, Hardware and Agent tools
  under a collapsible **Advanced** group that auto-opens on those pages. Search
  and routes are unchanged; grouping changes no behaviour.

### 2.3 Evidence-based model selection
See section 4 for the contract. User-facing behaviour:
- The fit indicator separates **Measured on this device** from **Estimate**.
- Measured states: *Not tested on this device*, *Ran successfully with these
  settings*, *Failed with these settings* (other settings may work),
  *Unsupported by this runtime* (architecture refused; settings will not help),
  *Tested before, but something changed* (lists what changed).
- Estimate states: *Estimated to fit*, *Estimated to fit with part of the model
  on the CPU* (slower), *May require adjusted settings* (under 10% headroom),
  *Estimated not to fit — you can still try*, *Not enough information*.
- "Show how this was estimated" lists model file, conversation memory for N
  tokens, vision component, runtime overhead, need vs available, memory already
  used by loaded models, every assumption, and a confidence level.
- Actions: **Test on this device**, **Cancel test**, **Adjust settings** (opens
  the existing model settings sheet), **Use for new chats** / stop, **Hide this
  hint**.
- Picker rows are keyboard-selectable, show *Worked here* and *Default* labels,
  and provider sections state local vs remote processing.
- Nothing is blocked or hidden by an estimate.

### 2.4 Permissions (lane report)
- Approval prompts state the action in plain language, the category (file
  change, command, network, external tool, read), affected resources,
  consequences, only the scopes the backend genuinely supports (once / this
  conversation / always), with broader scope marked, and collapsible technical
  details. Focus starts on Deny. Esc denies.
- Pending approvals are announced (polite live region) with a visible count when
  more than one waits.
- Refusals are classified from the backend's exact texts into denied,
  cancelled, server not trusted, one-time ticket rejected, project policy,
  network off, blocked domain, secret file, destructive git, unresolvable
  argument, outside workspace, and Cowork access states, each with a next step.
- New Settings > Permissions page: conversation grants, tools allowed
  everywhere, allow-all MCP switch, trusted MCP servers (backend and local
  reconciled), revoke buttons, last 50 audit decisions.

### 2.5 Task results and recovery (lane report)
- One `RunOutcome` drives the Cowork run summary for completed, failed,
  cancelled and partial runs: what happened, where the result is, what was
  checked (observed commands with exit codes), unverified claims from assistant
  text (never counted as checks), unresolved items, and next actions that exist
  only when a real handler exists.
- Restore shows scope (tree, files), recovery boundaries, saves a safety
  checkpoint first (aborts if that fails), and requires explicit confirmation
  when files changed since the checkpoint were not written by JAN.

### 2.6 Skills and connections (lane report)
- MCP add/edit form validates name, command, URL, timeout, headers and env with
  field-associated errors and focus on the first invalid field.
- Per-server state: not installed, disabled, connecting, connected,
  needs authorization, failed, not connected. "Connected" is shown only after
  activation resolves and the server appears in the connected list; failures
  revert the switch and show an inline error with a next step.
- Rows explain what the server does, where it runs, whether it may contact
  external services, required access (names only), where it applies and setup
  requirements, plus its tool names when connected.
- Turn off / clear authentication / delete are explained as different effects.
- Skills dialog explains what a skill is, where it applies, that enabling grants
  no new tool access, and installed vs enabled counts. Import success is shown
  only after the import resolves.

## 3. User journeys and state transitions

### 3.1 First run
```
welcome ──start──▶ setup ──continue/skip──▶ finish ──start chat──▶ home (new chat)
   │                                           └──project intention──▶ cowork
   └──skip guide──▶ setup (guide status = skipped)
```
- `setupPage` persists `welcome | setup | finish`; relaunching resumes on that
  page (engine setup re-runs; a "Welcome back" notice appears). Completing sets
  it back to `welcome`.
- Guide `status`: `not-started → in-progress` (start) `→ skipped` (skip/hide)
  or `→ completed` (finish after all steps). Reopen from Settings restarts at
  `in-progress` with the current conversation count as baseline.

### 3.2 Model compatibility test
```
idle ──test──▶ [plan]
  plan needs unload of other models ─▶ confirm ──don't test──▶ idle
                                         └──unload and test──▶ running
  plan ok ─▶ running ──success/failure──▶ idle (result recorded)
  running ──cancel──▶ idle (released) | idle ("could not unload" notice)
```
- Load cannot be interrupted; a cancel during load is honoured when loading
  returns, by unloading what the test loaded.
- Only models the test loaded are unloaded. An already-loaded model stays
  loaded and is not reloaded.
- Leaving the popover mid-test cancels it.

### 3.3 Evidence staleness
A result applies only if settings (`ctx_len`, `ngl`, `cache_type_k`,
`cache_type_v`, `flash_attn`, `n_cpu_moe`, `offload_mmproj`), device signature
(OS, CPU, RAM, GPU names/memory/driver), app version (engine is bundled) and
model file size all match. Concurrently loaded models are recorded but are not a
staleness key. A newer result under the same conditions supersedes an older
one, so *adjust settings → test again* replaces a failure.

### 3.4 Preferred model
`preferredModel` wins over last-used when starting a new chat and when a model
is auto-started for the local API server; if the preferred model no longer
exists, last-used applies, then the first local model. Nothing ever switches a
selection to a remote provider on its own.

## 4. New or changed contracts

### Frontend libraries
- `lib/modelCompatibility.ts`
  - `assessModelFit(FitInput): FitAssessment` — `verdict` (`fits`,
    `fits-partial-offload`, `tight`, `exceeds`, `unknown`), `memoryModel`
    (`unified`, `discrete-gpu`, `integrated-gpu`, `cpu-only`, `unknown`),
    `kvMethod`, `effectiveContext`, `required` breakdown, `budgets`,
    `headroomBytes`, `assumptions[]`, `uncertainty`.
  - `kvArchitectureFromGguf(metadata)`, `kvCacheBytesFromArchitecture(...)`,
    `cacheTypeBytes`, `isIntegratedGpu`, `tierForVerdict`.
  - `estimateModelFit` kept as a tier wrapper.
  - Constants: system reserve 2 GiB (RAM only), 512 MiB per dedicated GPU,
    unified reserve 2.5 GiB, Metal share 0.67 (≤36 GiB) / 0.75, runtime overhead
    300 MiB + 2% of weights, tight threshold 10%.
- `lib/modelEvidence.ts` — `ModelTestResult`, `TestConditions`, `TestMetrics`,
  `settingsFromModel`, `deviceSignature`, `conditionDifferences`,
  `evidenceFor → { state, latest, differences, otherSuccess }`.
- `lib/modelCompatibilityTest.ts` — `planCompatibilityTest`,
  `runCompatibilityTest(request, deps)` with injectable engine/session/fetch.
  Request: `POST /v1/chat/completions` to the local engine session,
  `max_tokens: 16`, `temperature: 0`, prompt "Reply with the single word:
  ready". Success = HTTP 200 with at least one choice. Metrics recorded only when
  reported (`timings.predicted_per_second`, `prompt_per_second`, `usage`).
- `lib/onboarding.ts` — intents, `guideSteps`, `isStepDone`, `remainingSteps`,
  `shouldShowGuide`, `destinationFor`.
- Lane libraries: `permissionRequest.ts`, `permissionOutcome.ts`,
  `permissionAudit.ts`, `coworkRunOutcome.ts`, `mcpServerProfile.ts`,
  `mcpServerValidation.ts`, `mcpConnectionState.ts`.

### Components
- `ModelSupportStatus` gains `onAdjustSettings`; `ModelSetting` gains controlled
  `open` / `onOpenChange`; new `ModelEvidenceBadges`, `TermHint`,
  `GettingStartedCard`, `PermissionRequestDetails`,
  `McpServerConnectionDetails`.
- `ToolApprovalDialog` gains `request` and the `allow-thread` decision.
- `CoworkRunSummary` accepts `outcome` and action handlers; `CoworkRewind`
  requires `onSafetyCapture` and accepts `janAuthored`.
- `AddEditMCPServer` accepts `existingNames`.

### Stores
- `useModelEvidence` (new): `results`, `preferredModel`, `dismissedHints`.
- `useOnboardingGuide` (new): `status`, `intent`, `threadCountAtStart`,
  `confirmedSteps`, `setupPage`.
- `useToolApproval`: `revokeToolForThread`, `revokeThread`,
  `revokeToolEverywhere`, `revokeAllowAllMCPPermissions`, `revokeServerTrust`
  (backend first; store unchanged on failure).
- `useToolApprovalRequests`: optional request context, `refusals`,
  `takeRefusal`, `usePendingApprovalCount`.
- `useCoworkCheckpoints`: `captureSafety`, per-session `head`, `safety` flag.

### Backend
- New Tauri command `plugin:agent-tools|permission_audit_recent
  { dataFolder, limit? }` — newest first, limit clamped 1–200, re-redacted.
- Checkpoint capture for managed worktrees snapshots the whole tree
  (`read-tree` parent + `add -A` into a temp index, respecting `.gitignore`).
- Restore plan returns `files` and `changedSinceLatest`.

### Routes
- `/settings/permissions` (registered in `routeTree.gen.ts`, routes constants,
  settings search registry, menu icon).

## 5. Persistence

| Data | Where | Key / file |
| --- | --- | --- |
| Model test results, preferred model, hidden hints | backendStorage (settings store; localStorage on web) | `model-evidence` (max 10 results per model) |
| Guide status, intent, setup page, confirmed steps | backendStorage | `onboarding-guide` |
| Thread/global tool grants, allow-all, local server list | backendStorage | `tool-approval` (existing) |
| MCP server trust | backend file | `mcp-trust.json` (existing) |
| One-time MCP tickets | backend memory, 300 s, single use | — |
| Pending approvals, refusal reasons | memory only | — |
| Permission audit | backend file | `<data>/audit/permissions.jsonl` (existing, now readable) |
| Checkpoint chain, safety points, head | backendStorage | `cowork-checkpoints` (existing, extended) |
| Last-used model | localStorage | `last-used-model` (existing) |

New backendStorage stores are registered in `lib/hydrateStores.ts`.

## 6. Permission and recovery boundaries

- The approval UI presents the existing engine's decisions; it does not add a
  second authorization system. The Rust gate remains authoritative for built-in
  tools; MCP trust remains keyed on the server, not the tool name.
- "Always" for built-in tools without a server is enforced only by the renderer
  store (pre-existing limitation, now stated in the prompt).
- Revoking affects future requests only; a call already running is not
  recalled.
- Deleting an MCP server does not revoke its auto-approve entry or backend
  trust; both are keyed by name, so a re-added server with the same name
  inherits them. The delete confirmation says this; revoke in Permissions.
- Restoring a checkpoint restores files in the managed worktree only. It does
  not undo messages, remote pushes, published content, installed packages, or
  commands already run. The user's own checkout is never restored (patch only).
- A restore is preceded by a safety checkpoint and can itself be undone.
- The model test may unload another model only after the user names it in a
  confirmation; it never switches local processing to remote, never downloads,
  and never changes the selected model.

## 7. Verification

All automated checks below are **mock-backed unit/component tests** (vitest +
jsdom). They prove state transitions, persistence shapes and UI contracts, not
behaviour inside the real Tauri app, real hardware, real git or real MCP
servers.

- Typecheck: `node node_modules/typescript/bin/tsc -b` in `web-app` — exit 0
  after all merges and the context panel. (`npx tsc -b` does not resolve in
  worktrees.)
- Full vitest run from the repository root (core, web-app, extensions): 483
  files passed, 2 skipped, 2 failed. Both failures are environmental and also
  occur without these changes in a fresh worktree:
  `src/__tests__/tauriResources.test.ts` (Tauri resources are not prepared in
  the worktree) and `src/services/core/__tests__/tauri.test.ts` (cannot resolve
  `@janhq/assistant-extension` because extension `dist` builds are absent).
  Both pass in the main checkout, where those artifacts exist.
- Deterministic hardware accounting (`lib/__tests__/modelCompatibility.test.ts`,
  40 tests): dedicated-VRAM reserve not double subtracted; partial offload is
  runnable; integrated GPU memory counted once; unified pool with GPU budget
  inside it and Metal share by RAM size; KV from GGUF metadata (Llama 3 8B
  shape = exactly 1 GiB at 8k f16); quantized cache types; trained-context cap;
  sliding-window uncertainty; GPU layers = 0; loaded models subtracted; tight
  headroom; unknowns.
- Evidence (`modelEvidence.test.ts`, 8), runner (`modelCompatibilityTest.test.ts`,
  13): confirmation before unloading, cancel before/during load and request,
  release failure reported, non-OK reply is a failure, only reported metrics.
- `ModelSupportStatus.test.tsx` (6): measured vs estimate separation, test
  records settings and releases, confirmation path loads nothing, failure then
  adjusted settings becomes stale, default set/cleared.
- `getModelToStart.test.ts` (+2): preferred model wins; falls back when gone.
- Onboarding: `onboarding.test.ts` (7), `SetupScreen.test.tsx` (+5: intentions,
  skip, processing explanation, resume, project to Cowork),
  `GettingStartedCard.test.tsx` (5).
- Settings menu (+1): advanced group keyboard toggle keeps pages reachable.
- Lane suites: permissions 346 tests across 15 files; results 189 across 12;
  connections 175 across 14 — all passing at merge time.
- `node scripts/local-only-guard.mjs`: clean (the model test only calls the
  local engine on localhost). `node scripts/agent-harness/validate-registry.mjs`:
  OK, 210 features, counts unchanged.
- Rust: `cargo check` passed in the permissions and results lanes; the new Rust
  tests (audit recent, managed capture, undoable restore) **compiled but were
  not run**.

### Verification checklist from the brief

| Requirement | Status |
| --- | --- |
| Beginner can start a conversation without advanced knowledge | Covered by SetupScreen/guide tests (mocked). Not run in the real app. |
| Document can be attached and its usage inspected | Attach flow pre-existing; `WhatJanIsUsing` shows pending, inline-sent and indexed files with distinct claims (mocked sources, section 9). |
| Project work produces understandable approval and discoverable result | Covered by permission prompt and RunOutcome tests (mocked). |
| Compatible model selectable outside recommendations | Nothing is gated; picker unchanged in reach. Tested. |
| Uncertain estimates do not block | Tested: no disabled state exists. |
| Failed settings can be adjusted and retried | Tested (stale after settings change; retry supersedes). |
| Preferred models remain selected | Tested in `getModelToStart`; picker initialisation covered by code path, not a component test. |
| Local never silently becomes remote | No code path switches provider; fallback is first local model. Not a runtime test. |
| Denial and revocation propagate | Store and page tests (mocked backend). |
| Partial failures preserve unrelated work | Safety checkpoint and newer-edit confirmation tests (mocked invoke). |
| Memory and context controls reflect scope | Memory items show conversation / project / all-conversations scope and "sent with the last message" only for injected ids; temporary chats say memory is off (mocked, section 9). |
| Failed connection setup does not show success | Tested (mocked services). |
| Existing advanced workflows remain accessible | Existing suites pass; nothing removed. |

**Untested (requires unavailable hardware, credentials or runtime):** a real
model load/test on CPU, discrete GPU, integrated GPU or Apple Silicon; the
Tauri IPC for the new audit command; real git restore and undo; real MCP servers
and OAuth; screen reader and real keyboard behaviour in the webview; narrow
window layouts.

## 8. Remaining limitations and blockers

- Model test measures a 16-token reply only; it proves nothing about long
  context or concurrent workloads (stated in the UI).
- The engine's eviction order is not observable, so the test names every model
  that could be unloaded.
- No download-size step: this fork has no model downloads; testing uses
  installed files only.
- Vision projector size is not included unless known.
- Rust `is_model_supported` still uses the old assumptions and remains unused
  by the UI.
- Permission prompt "reason" is empty until callers pass task context.
- Cowork refusal text still says "did not allow" for cancellations
  (`coworkDispatch`).
- Plugins have no UI (Rust commands only).
- Claim detection in run outcomes is intentionally narrow; command
  classification is pattern-based.
- Managed checkpoint capture now scans the whole worktree (slower on large
  trees).

## 9. "What JAN is using"

### Behaviour
A conversation-level control opens a summary (currently a side sheet from the
chat header) with six sections: **Model**, **Instructions**, **Attachments**,
**Saved memory**, **Tools and connections**, **Exact request**. Each item shows
a label, a usage state, a scope where meaningful, a one-line reason and, where
supported, one action.

Usage states, strongest claim last:

| State | Meaning | Sources |
| --- | --- | --- |
| `available` | Offered to the model, which decides whether to use it. | Enabled MCP/built-in tools. |
| `available-on-search` | Indexed; only parts the model searches can be used. Which parts is not recorded. | Embedded attachments, vector index. |
| `pending-next-message` | Attached, not yet sent. Removable. | Composer attachment store. |
| `included-with-message` | Text placed into the message that attached it. | Inline file metadata in user messages. |
| `included-every-request` | Sent as the system prompt / model for every message. | Assistant instructions, selected model. |
| `included-last-request` | Chosen and sent with the last message from this window. | Transport `memoryUsed().injectedIds`. |
| `not-offered` | Configured but withheld, with the reason. | Temporary chat memory, conflicting or over-budget memories, tools for a model without tool support, tools turned off. |
| `not-recorded` | Not observable. | Memory before the first send in this window; the exact chat request. |

Scopes: this conversation, this project, all conversations (memory "user"),
whole app (tool switches are global).

Actions: remove a pending attachment; open Memory settings (edit, forget, pin,
move scope already exist there); open MCP servers; open Assistant settings;
open the provider's settings. The panel states that memory changes affect
future messages only.

### Contract
`lib/contextSummary.ts` — `summarizeChatContext(ChatContextInput):
ContextSection[]`; `ContextItem { key, label, labelIsKey?, detail?, state,
reason?, scope?, action? }`. The component gathers inputs from
`useThreads`, `useModelProvider`, `classifyModelLocation`,
`useChatAttachments`, the VectorDB extension `listAttachments(threadId)`,
`useChatSessions().sessions[id].transport.memoryUsed()`, `memoryRecordGet`
(tries chat, project, user scopes because retrieval returns ids only),
`useAppState.tools` and `useToolAvailable.disabledTools`. Loading happens when
the panel opens or on Refresh.

### Boundaries and gaps (verified in code)
- Chat does not record a per-request payload snapshot or usage; only Cowork
  does (`PromptSnapshotView`, `CoworkContextBreakdown`), so the chat panel says
  "not recorded" instead of estimating.
- The memory selection lives on the in-memory transport; after a reload it is
  unknown until the next message.
- `setMemoryBinding` has no callers in chat, so project-scope memory is not
  retrieved for project conversations. The panel reports what was injected,
  which therefore never includes project memory in chat.
- Chat does not read project instruction files (JAN.md, CLAUDE.md, AGENTS.md);
  Cowork does. The empty Instructions section says so.
- RAG retrieval is a model tool call; which chunks were read is not recorded.
- No managed-policy or locked instruction layer exists in this codebase, so no
  read-only restriction is shown.
- Cowork keeps its existing readiness card, context breakdown and sanitized
  prompt snapshot; this panel was not added there.

Tests (mock-backed): `contextSummary.test.ts` (7) and
`WhatJanIsUsing.test.tsx` (5): inline vs indexed vs pending files, pending
removal, memory resolved with scope, tools listed as available not used, local
processing stated, exact request marked not recorded.

## 10. Accessibility notes for the redesign

Implemented in the new and touched workflows:
- Model picker rows are focusable buttons (Enter/Space) with visible focus;
  provider settings is a labelled button.
- Fit details, term hints and the context panel open on click/keyboard, never
  hover-only; popovers and sheets use Radix focus management.
- Test progress and results use a polite live region; the unload confirmation
  is an `alertdialog`.
- Setup intentions and local model choice are `radiogroup`/`radio` with
  `aria-checked`.
- Settings Advanced group is a button with `aria-expanded`/`aria-controls`.
- Approval prompts focus Deny first; restore dialog moves and restores focus;
  MCP form errors use `aria-invalid`/`aria-describedby` and focus the first
  invalid field (lane reports).
- All new copy is in English locale namespaces (`model-fit`, `onboarding`,
  `glossary`, `navigation`, `context`, `permissions`, `results`,
  `connections`, plus `mcp-servers` additions) and tolerates long text by
  wrapping.

Not done: arrow-key roving focus inside radio groups, a formal screen-reader
pass (AH-179) and full keyboard audit (AH-180), narrow-window layout checks.
