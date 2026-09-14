# Beginner workflows: functional handoff for the design chat

Branch: `feature/beginner-workflows`, based on `feat/windows-agent-completion` at
`728f5cb0a`. Not pushed, not merged.

This document describes behaviour, state and backend contracts independently of
the current layout, so the Flint Atelier redesign can re-skin these workflows
without changing what they do. No visual redesign was attempted; new UI uses
the existing shadcn/Radix components.

Two passes are recorded here. The first built the workflows. The second (the
"completion pass") closed functional gaps found in review: MCP approvals
surviving deletion, project memory not reaching ordinary chat, no plugin
management, weak verification semantics, and unverified checkpoint safety. It
also ran the work in the real application.

---

## 0. Status at a glance

| Area | Implemented | Tested (how) | Still unverified |
| --- | --- | --- | --- |
| Onboarding and guide | Yes | Unit/component; web build in a browser (resume, 420 px and 560 px layouts, arrow keys); real-app guide scenario — see §8.3 | Screen reader |
| Progressive disclosure (term hints, Advanced group) | Yes | Component; web build keyboard check | Screen reader |
| Model fit and compatibility test | Yes | Deterministic accounting tests; runner and UI tests (mocked engine); real-app keyboard picker scenario — see §8.3 | A real model load on any hardware (no llama.cpp model in the test profile) |
| Permissions and revocation | Yes | Store/page tests; real-app always-allow → revoke scenario — see §8.3 | Screen reader |
| MCP permission lifecycle (identity) | Yes | 96 plugin-crate + 129 app-crate Rust tests; web store tests; real-app identity scenario — see §8.3 | Live server refusing after reconfiguration end-to-end |
| Task results and verification semantics | Yes | Unit/component | Real Cowork run producing a summary |
| Checkpoint safety | Yes | 21 Rust tests on disposable git repos (2 Unix-only skipped on Windows), 20 git tests | Unix-only paths; rollback-also-fails branch; missing git |
| Project (collection) memory in chat | Yes | 180 Rust + 32 app-crate thread tests; web binding tests; real-app collection memory scenario — see §8.3 | Model-proposed project memories in chat (see gaps) |
| Request attribution and context panel | Yes | Rust retention tests; web attribution and panel tests; real-app panel verification inside the memory scenario — see §8.3 | Anthropic-shaped payload in the real app |
| Plugin management | Yes | 36 + 141 + 50 + 79 Rust tests; web dialog tests | Real git clone over network (not run by design) |
| Plugin skills in Cowork | Yes | 30 plugin-crate + 20 app-crate Rust tests (parity); web tests | Managed-worktree mode (see gaps) |
| Accessibility foundations | Partial | Keyboard/narrow checks in the web build; component tests | Screen reader pass, full keyboard audit |

---

## 1. Findings and what was reused

| Area | Found | Reused / extended |
| --- | --- | --- |
| Onboarding | 3-page setup wizard shown while no usable provider exists; in-memory state; no intentions, resume or guide. Local-only fork: no model downloads. | Same wizard and gate. |
| Model fit | TS estimator subtracted ~2.1 GiB from RAM *and* VRAM, called partial offload "yellow", added iGPU memory on top of RAM, sized KV as 10% of file per 4k tokens. | `modelCompatibility.ts` rewritten in place. |
| Permissions | Rust gate + renderer approval stores. Prompt got tool name only; no revoke; audit unreadable. MCP grants keyed by server **name** everywhere (backend trust, renderer, OAuth) and by bare tool name in the Cowork gate. | Same engine; identity added (§6). |
| Results | Run summary listed files only; any command could look like a check. Managed checkpoints after the first held the same tree; restore could overwrite newer edits. | Same components; outcome derivation; guarded restore. |
| Memory | `setMemoryBinding` had no callers: ordinary chat never used project memory; temporary chat still *read* user memory; Cowork dropped the memory block from its prompt. Chat request snapshots were captured in Rust but the reference was discarded. No snapshot retention. | Existing memory store, retrieval and snapshot pipeline. |
| Plugins | Rust commands only (clone + delete), no UI, no enable/disable, string errors; Cowork loaded no plugin content. Cowork's skill tools also ignored the project and its whitelist (pre-existing bug). | Existing plugin/skill discovery, moved to one shared implementation. |

---

## 2. Behaviour by workflow

### 2.1 First run and guide
- Welcome asks for an optional intention: ask a question, work with
  documents, build or change a project. Arrow keys move and select within the
  choice. "Skip the guide" still runs setup.
- The finish page explains local processing (stays on this computer, no
  account) and remote processing (messages and included files are sent to the
  provider, which may charge) and links to provider settings.
- Setup page and guide state persist; relaunch resumes on the page it was
  left on with a "welcome back" note. The setup column scrolls, so actions stay
  reachable in short windows.
- Home guide card: observed steps (a usable model exists; a conversation was
  started after the guide began) and user-confirmed steps. Reopen from
  Settings > General. Returning users get a link to their last conversation.
- Nothing is fabricated: the guide never creates threads, files or activity.

### 2.2 Progressive disclosure
- Term hints (worktree, context, MCP server, checkpoint, agent) keep the term
  on screen and open the definition on click or keyboard.
- Settings groups Local API server, HTTPS proxy, Hardware and Agent tools under
  an Advanced toggle that opens itself on those pages. Search and routes are
  unchanged.

### 2.3 Model selection
- Fit details separate **Measured on this device** from **Estimate**, list the
  memory breakdown, every assumption and a confidence level.
- **Estimates are advisory and never block selection.** Concrete runtime
  incompatibilities are reported as such: a test whose engine refuses the
  architecture marks the model *Unsupported by this runtime* on its picker row
  and in details. Selection remains possible so the engine's own error is what
  the user sees, rather than a silent block.
- Compatibility test (§3.2) records only reported metrics, is tied to its
  conditions, runs one at a time, refuses to unload a model that is generating,
  and reloads the models it unloaded once its own model is released.
- Preferred default model wins over last-used; nothing ever switches to a
  remote provider on its own.

### 2.4 Permissions
- Prompts state action, category, resources, consequences, only the scopes the
  backend supports (once / this conversation / always), broader scope marked,
  collapsible technical details; focus starts on Deny.
- Settings > Permissions lists conversation grants, tools allowed everywhere,
  trusted MCP servers with their approval state, approvals invalidated with a
  reason ("configuration changed", "approved before this version"), revoke
  controls, and the last 50 audit decisions.

### 2.5 Task results and verification semantics
The run summary distinguishes, per shell command:

| Field | Values |
| --- | --- |
| attempted | false when the gate refused it |
| completion | not started, still running, ran to completion, cancelled, timed out, interrupted |
| exit | exit code when recorded |
| outcome | passed / failed / not run / unknown — "passed" means the command reported success |
| verification kind | test, build, lint, check-script, or none (ordinary command) |
| limitations | judged only by exit status; chained command; truncated output; background job; filtered subset of a suite; no exit status |

Only verification commands count as checks; other commands are counted
separately. A passing check carries the note that it does not prove the task is
correct. Assistant statements about checks stay separate as unverified claims.

### 2.6 Recovery
Restore is guarded in the backend, not only in the UI (§6).

### 2.7 Project (collection) memory in ordinary chat
- UI "projects" are called **collections** and have no folder. A collection's
  memory identity is `jan-project:<id>`, stored in the data folder. When a
  folder exists (Cowork), folder identity wins.
- Chats bind memory to their collection when created and rebind when moved or
  when the collection is deleted; a request already running keeps what it
  retrieved. Temporary chats are bound temporary at creation and read nothing.
- Settings > Memory: collection picker and a "Use saved memory in
  conversations" switch (off = nothing retrieved; saving still works).
- Cowork binds the attached folder and now includes the memory block after
  policy and project instructions.

### 2.8 Request attribution and "What Flint is using"
- Each assistant message stores an attribution record (ids and hashes only):
  request id, snapshot id/hash/status, invocation id, memory ids (candidates,
  injected, conflicts, dropped, project, disabled, temporary), advertised tools,
  inline and searchable attachments, provider/model, send state, usage flag.
- Send states: **assembled** (built, not sent) → **sent** (transport started,
  snapshot taken before dialing) → **response started** (head arrived) or
  **failed**.
- Panel states per item: available, retrieved (matched, not chosen), chosen for
  the last request, **verified in the last request** (id found in the sanitized
  snapshot read back from disk), attached to its message, pending, not used,
  not recorded. "Verified" is only claimed from the snapshot.
- Adapter boundary is stated: providers and local engines may still transform
  the request after Flint sends it (e.g. chat templates).
- "Inspect the sanitized request (advanced)" opens the existing snapshot view.

### 2.9 Plugins
- **What a plugin is** (shown in the dialog): a package that adds skills, and
  for the Flint CLI also slash commands and agent profiles, to one project. It is
  not an MCP server (a running connection configured in Settings) and not a
  single skill.
- Cowork > Plugins: list (name, version, enabled, component counts, source),
  details (source, path, install time, components, script files, `.mcp.json`
  present but **not loaded**), enable/disable (reverts on failure), remove
  (states exactly what is removed), install from a local folder or a git URL
  (states the host contacted), cancel.
- In Cowork, enabled plugin skills appear as `<plugin>:<skill>`, read-only,
  subject to the project's skill whitelist; disabled or removed plugins are
  hidden and unreadable. Desktop has no slash commands and loads agent profiles
  only from Flint's saved folder, so those plugin components are CLI-only; the
  dialog says so.

---

## 3. Journeys and state transitions

### 3.1 First run
```
welcome ──start──▶ setup ──continue/skip──▶ finish ──start chat──▶ new chat
   │                                           └──project intention──▶ Cowork
   └──skip guide──▶ setup (guide skipped)
```
Guide status: not-started → in-progress → skipped | completed. Reopen restarts
in-progress with the current conversation count as baseline.

### 3.2 Compatibility test
```
idle ─test─▶ plan
  another test running        ─▶ blocked (nothing changed)
  must unload other models    ─▶ confirm ─don't─▶ idle
                                         └unload and test─▶ busy check
  a model to unload is generating ─▶ blocked (nothing changed)
  load ─▶ short request ─▶ release test model ─▶ reload unloaded models ─▶ idle (result recorded)
  cancel at any point ─▶ release ─▶ reload unloaded models ─▶ idle
```
If the test model cannot be released, other models are not reloaded and the
notice says which still need loading.

### 3.3 MCP server lifecycle

| Event | Backend trust | OAuth tokens | Renderer approvals |
| --- | --- | --- | --- |
| Turn off | kept | kept | kept |
| Clear authorization | kept | cleared | kept |
| Delete (form or JSON editor) | revoked, audited "deleted" | cleared | removed |
| Rename | revoked under old name, audited "renamed" | cleared | removed; renewal needed |
| Change command, args, URL, transport, cwd/confinement, env names or header names | stops matching; invalidated at next use, audited | kept | invalidated with reason |
| Change env/header *values* only | unchanged (values are secrets, not identity) | kept | kept |
| Re-add same name | nothing inherited | nothing inherited | nothing inherited |

### 3.4 Memory binding
create → bind(collection, temporary) · move/delete collection → rebind (next
request) · transport re-reads the thread before every retrieval.

### 3.5 Request send states
assembled → sent → response-started | failed; usage recorded on finish when an
invocation exists.

### 3.6 Plugin
install (staging → record → move; cancel cleans staging) → enabled ⇄ disabled
→ remove (folder, disabled list, whitelist entries). Skill lists refresh after
each operation; a running Cowork run keeps its tool definitions but reads skills
from disk on each skill call.

---

## 4. Backend contracts (new or changed)

### MCP identity (`tauri-plugin-agent-tools::mcp_identity`, app `core::mcp`)
- Fingerprint `sha256:<hex>` over transport, command, args, normalized URL
  (scheme/host lower-case, default port and trailing slash dropped, query
  parameter **names** only, user info masked), cwd, env **names**, header
  **names**, import/confinement flags. Excludes server name and all values.
- `mcp-trust.json` v2: `{schema_version: 2, trusted: [{name, fingerprint,
  granted_at}], invalidated: [{name, reason, at, fingerprint?}]}`. A v1 file
  trusts nothing; its names are listed as invalidated (`schema-v1`).
- Commands: `mcp_trust_report`, `mcp_server_fingerprints`,
  `mcp_forget_server(serverName, reason: deleted|renamed)`;
  `mcp_trust_server` and `mcp_allow_once` take an optional expected fingerprint
  and refuse on mismatch. Tickets are bound to server, tool and fingerprint.
- Cowork gate grants are keyed by (server, tool).

### Checkpoints (`core::agent::checkpoint`)
- `agent_checkpoint_restore(checkpoint, latest, safety?, allowOverwrite?)`:
  refuses unless the working tree matches `safety ?? latest` (ignored files and
  nested repositories excluded), except listed paths; verifies the result;
  rolls back to the holding checkpoint on mismatch or failure and reports what
  still differs. Refuses the user's own checkout and roots below the repository
  top level.

### Memory (`tauri-plugin-agent-tools::memory`)
- `MemoryLocation.janProjectId` (1–128 chars `[A-Za-z0-9._-]`), accepted only by
  renderer memory commands; model tools never read it.
- `memory_settings_update(location, memoryEnabled?)`; retrieval returns
  `candidateIds`, `projectId`, `disabled`.

### Retention (`tauri-plugin-agent-tools::retention`)
- Startup compaction of `audit/prompts.jsonl` and `payload-usage.jsonl`:
  30 days, 5000 entries, 64 MiB (strictest wins, newest kept), atomic rewrite.
- Deleting a thread removes its snapshot and usage records.

### Plugins (`core::agent::plugins`)
- `agent_plugin_list`, `agent_plugin_details`, `agent_plugin_sources`,
  `agent_plugin_install(project, source{kind: local|git|marketplace}, installId)`,
  `agent_plugin_install_cancel(installId)`, `agent_plugin_set_enabled`,
  `agent_plugin_remove`, `agent_plugin_search`; errors `{code, message}`.
- Skill discovery rules (plugin skills, disabled list, whitelist matching,
  project-over-plugin precedence) live once in the agent-tools crate; the app
  crate calls them (parity test).

### Permissions audit
- `plugin:agent-tools|permission_audit_recent {dataFolder, limit?}`.

### Frontend contracts (selected)
- `RunOutcome.checks[]` gains `attempted`, `completion`, `limitations`;
  `RunOutcome.commands[]` lists every shell command.
- `runCompatibilityTest` outcomes: needs-confirmation, blocked
  (model-busy | test-in-progress), cancelled, completed; the latter two report
  `restored` / `notRestored`.
- Stores: `useModelEvidence`, `useOnboardingGuide` (new); `useToolApproval`
  v1 migration with fingerprint-bound server and MCP tool grants.

---

## 5. Persistence

| Data | Where |
| --- | --- |
| Model test results, preferred model, hidden hints | settings store `model-evidence` |
| Guide progress | settings store `onboarding-guide` |
| Renderer grants (fingerprint-bound), invalidated notices | settings store `tool-approval` (migrated) |
| MCP trust | `<data>/mcp-trust.json` v2 |
| Permission audit (incl. MCP trust events) | `<data>/audit/permissions.jsonl` — never pruned by deletion |
| Collection memories | data-folder memory store, `jan-project:<id>` |
| Memory switch | memory settings |
| Request snapshots / usage | `<data>/audit/prompts.jsonl`, `payload-usage.jsonl` (retention above) |
| Attribution | assistant message metadata |
| Checkpoint chain, safety points, head | settings store `cowork-checkpoints` |
| Plugin enabled state | `<project>/.jan/agent/agent.toml` `[plugins] disabled` |
| Plugin install record | `<plugin>/.jan-install.json` |

---

## 6. Permission and recovery boundaries

- One authorization system: the Rust gate remains authoritative for built-in
  tools; MCP trust is enforced in the backend against the server's current
  fingerprint. Renderer "always" for built-in tools without a server is still
  enforced only by the renderer store (stated in the prompt).
- Revoking affects future requests only.
- Audit history is separate from active grants and survives deletion.
- Restore affects only files `git add -A` sees under the managed root (tracked
  and untracked-not-ignored), byte-exact. It does **not** restore ignored files,
  nested repositories, branches/HEAD/index/stash, permissions beyond the
  executable bit (Unix), timestamps, messages, or external effects (commands,
  installs, network, pushes). The user's own checkout is never restored.
- The compatibility test never downloads, never changes the selected model,
  never switches to remote, and never unloads a generating model.
- Collection memory is keyed by an id the renderer supplies (the collection
  list lives in renderer storage and cannot be checked by Rust); model tools
  cannot supply it.
- Plugins execute no code on install or enable and grant no permissions;
  plugin skill scripts run only through the gated shell tool.

---

## 7. Accessibility and narrow layouts

Checked in the running web build (Chromium, keyboard driven):
- Setup at 420×760 and 420×560: no horizontal overflow; every action reachable.
  **Defect found and fixed:** at 560 px height the intentions pushed Start and
  Skip out of reach inside a non-scrolling column.
- Tab order through intentions → Start → Skip is logical; arrow keys select
  intentions. Resume after reload lands on the saved page.
- Settings at 420 px: no overflow; Advanced toggle focusable with
  `aria-expanded`. The existing settings shell leaves ~190 px for content at
  that width (pre-existing layout; a redesign concern, not changed here).
- Limitation of the browser tool: Enter/Space key activation could not be sent
  (key events arrived without a key value), so activation is covered by native
  button semantics and component tests rather than observed there. Computed
  focus-ring styles could not be confirmed visually because screenshots were
  unavailable in the hidden pane; the ring utilities are present in the CSS.

Implemented: labelled controls, dialog focus management (Radix), field
errors associated with inputs, polite live regions for test progress and
pending approvals, keyboard-selectable picker rows, non-hover term hints.

Not done: screen-reader pass (none available here), full keyboard audit of all
agent surfaces.

---

## 8. Verification

### 8.1 Unit and component (mock-backed)
- `tsc -b` (web-app): exit 0 on the final branch.
- **Full root vitest (core, web-app, extensions) on the final branch: 493 files
  passed, 2 skipped, 0 failed**, including the local-only guard
  (`src/__tests__/localOnly.test.ts`), which first flagged the plugin install
  parameter name `install_id`; it was renamed `operation_id`.
- `local-only-guard.mjs` clean; `validate-registry.mjs` 210 features, counts
  unchanged. Lane-level counts: permissions 346, results
  189, connections 175, memory/attribution 62 + 72, plugins 31, plugin skills 71,
  MCP identity 84 + 310, checkpoint web 48.
- The two tests that previously failed only in worktrees
  (`tauriResources.test.ts`, `services/core/tauri.test.ts`) pass in the feature
  worktree after building extension dists and preparing resources from the main
  checkout's local binaries.

### 8.2 Rust (executed)
| Suite | Result |
| --- | --- |
| `checkpoint::` (test-tauri) | 23 run: 21 passed, 2 skipped on Windows (symlink-as-link, executable bit) |
| `git::` (cli) | 20 passed |
| agent-tools `mcp_ gate::` | 96 passed |
| app `mcp` (test-tauri) | 129 passed |
| agent-tools `memory:: retention snapshot usage` | 180 passed |
| app `threads::tests` | 32 passed |
| app `plugins::` and related (cli) | 36 + 141 passed; test-tauri 50; combined cli filter 79 |
| agent-tools `skill` | 30 passed; app `core::agent::skills` 20 (parity) |
| agent-tools `bash_` | 32 passed, **5 failed — identical on base `728f5cb0a`** (sandbox helper exits 101 on this machine); environmental, not from this branch |

### 8.3 Real application (cowork-smoke harness)
The harness builds the real app, seeds an isolated data folder, a scripted
OpenAI-compatible mock provider and real stdio MCP fixture servers, and drives
the WebView. These are integration tests against local fixtures — **not**
real-provider, real-model or real-hardware validation.

Build: `cargo run --example cowork-smoke --features cowork-smoke -- --only <name>`
with a production `web-app/dist` and the main checkout's local engine
binaries. Each scenario was run on its own so one failure cannot cascade.

| Scenario | Result | What it exercises in the real app |
| --- | --- | --- |
| `mcp-web-search-is-approved-as-the-servers-tool` (existing, updated for the new prompt) | PASS | Approval prompt scope buttons; the tool runs on the offering server only after approval |
| `beginner-model-picker-rows-are-keyboard-selectable` | PASS | Picker rows focus and select with Enter; selection restored |
| `beginner-always-allow-then-revoke-asks-again` | PASS | "Always allow" writes fingerprint-bound backend trust; revoking in Settings > Permissions removes it; the next call asks again and a denied call never reaches the server |
| `beginner-mcp-trust-follows-server-identity` | PASS | Changing a server's arguments changes its fingerprint and a one-time approval for the old definition is refused; deleting the server in Settings revokes trust; re-adding the same name inherits nothing |
| `beginner-guide-card-persists-and-explains-terms` | PASS | Guide card from persisted state after reload; a confirmed step persists; term hint opens and closes with Escape; hiding persists |
| `beginner-collection-memory-reaches-its-chats-only` | PASS | A memory saved for one collection is in that collection's chat request and verified by the context panel; absent from another collection's chat and from an ordinary chat |

Defects found by these runs were in the new scenarios' own selectors and
request matching (CSS `capitalize` on server names, a title-generation request
that quotes the user's question, quoting in a selector); each was diagnosed
from the running app before being fixed. The first combined run also showed a
cascade: a scenario that left another model selected made the shared
"ensure a model is selected" helper fail, which is now fixed.

Not exercised in the real app: the compatibility test (no llama.cpp model in
the profile), checkpoint restore through the UI (covered by Rust tests on real
git repositories), plugin install through the UI, and screen readers.

### 8.4 Checks from the brief
| Requirement | Evidence |
| --- | --- |
| Beginner can start without advanced knowledge | Setup/guide tests; web-build walkthrough |
| Document attached and usage inspected | Panel tests; attachment claims |
| Project work → understandable approval and result | Permission and outcome tests |
| Compatible model selectable outside recommendations; uncertain estimates don't block | Nothing gated; tests |
| Failed settings adjusted and retried | Evidence staleness tests |
| Preferred model stays selected | `getModelToStart` tests |
| Local never silently becomes remote | No switching code path |
| Denial and revocation propagate | Store/page tests; real-app revoke scenario (§8.3) |
| Partial failures preserve unrelated work | Checkpoint Rust tests (rollback, newer edits) |
| Memory controls reflect scope | Rust isolation tests; panel tests; real-app collection scenario (§8.3) |
| Failed connection setup doesn't show success | MCP state tests |
| Advanced workflows remain accessible | Existing suites; nothing removed |

**Untested:** real model loads on any hardware; real providers and OAuth; real
git clone of a plugin; Unix-only restore branches; screen readers.

---

## 9. Registry reconciliation (210 authoritative IDs)

The authoritative registry is `docs/agent-harness-features.json` (210 entries).
The earlier 200-entry reference is the same file at
`7c48d71aa65e61543134a25e5ff677fd8ef80f31`:

- **AH-001..AH-200 keep their meaning** (titles, categories, phases,
  priorities, dependencies, acceptance criteria unchanged; only status, files,
  tests and audit notes evolved).
- **AH-201..AH-210 are the ten additions** (phase 9, P2, missing). Nothing was
  renumbered, merged or removed, and this branch changed no statuses
  (`validate-registry.mjs`: 210, counts unchanged).
- No separate 200-entry design brief exists in the repository; treat its items
  as AH-001..AH-200.

| ID | Addition | Workflow it requires | Likely home |
| --- | --- | --- | --- |
| AH-201 | Conversation/session forking | Branch from a message or turn; show parent; no inherited grants | Message/turn action |
| AH-202 | Message and file undo/redo | Undo a turn's Jan-authored changes; builds on the guarded restore here | Run result, turn action |
| AH-203 | Portable import/export | Versioned file; import preview; nothing granted | Conversation menu, Settings > Data |
| AH-204 | Unified @ references | Ranked composer menu limited to the attached folder | Composer |
| AH-205 | Persistent aliases | Named references; broken alias names the path | Composer, project settings |
| AH-206 | Local command palette | Shortcut overlay; confirmations; focus return | App overlay |
| AH-207 | Custom keybindings | Conflict refusal; reset | Settings > Shortcuts |
| AH-208 | Hidden utility agents | No own UI; label internal work in activity/audit | Activity views |
| AH-209 | Project initialization assistant | Read-only survey → editable instructions proposal; pairs with the "build or change a project" intention | Cowork empty state |
| AH-210 | PC-to-PC handoff bundle | Export/import with a report of what could not be restored | Settings > Data |

Existing items this branch provides evidence for (statuses left unchanged
because per-OS validation, cancellation criteria or documentation in the
harness docs remain): AH-027/028 (restore), AH-041/049 (MCP identity, audit),
AH-073/078/087 (attribution), AH-080–084 (memory), AH-130–132 (plugins),
AH-179/180 (accessibility).

---

## 10. Remaining gaps

- **Managed worktree + plugin skills:** in Cowork's managed-worktree mode the
  skill layer reads `.jan/agent` from the worktree, which likely has none, so
  the model may not see project or plugin skills that the selector lists.
- **Model-proposed project memory in chat** saves under folder identity, not
  the collection; collection memories reach chats through the UI path.
- Temporary-chat and Cowork-session snapshots are removed only by retention,
  not on clearing/deleting those sessions.
- The Cowork MCP gate matches (server, tool) without the fingerprint;
  permission request events do not yet carry the server name.
- MCP deletion detection relies on the renderer calling `mcp_forget_server`.
- Every renderer MCP call issues an allow-once ticket, so the audit log records
  one issuance per call.
- Rust `is_model_supported` still uses old assumptions (unused by the UI).
- Plugin install progress is a stage label; marketplace browsing UI is absent by
  design; repositories that ship `.jan/agent/skills` or plugins now expose
  readable skill text in Cowork without an opt-in.
- Only English strings were added; other locales fall back to English and still
  carry obsolete keys.
- Settings > Memory strings are literal English like the rest of that page.

## 11. Implications for the redesign

- Treat every state named in §2–§3 as a required visual state: blocked,
  confirm-unload, restored/not-restored, invalidated approval with reason,
  verified vs chosen vs retrieved, send states, plugin read-only skill.
- "Measured" and "Estimate" must stay visually distinct; an estimate must never
  look like a gate.
- Recovery boundaries and "passing check ≠ correct task" text are functional
  content, not decoration.
- The settings shell is too narrow for content below ~640 px; the redesign
  should address layout there.
- Plugin, skill and MCP concepts need the relationship text wherever they meet.
