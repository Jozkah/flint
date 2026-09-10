# Jan audit handoff

This file consolidates the eight pasted chat audits for the next PC. It is an
evidence index, not a claim that the work is complete.

## Authoritative registry

The 200-feature registry is on commit `7c48d71aa65e61543134a25e5ff677fd8ef80f31`,
branch `feat/cowork-background-tasks`, at:

```text
docs/agent-harness-features.json
```

Retrieve it without guessing feature names:

```bash
git show 7c48d71aa65e61543134a25e5ff677fd8ef80f31:docs/agent-harness-features.json
```

Reported registry counts at that audit:

```text
verified: 0
implemented: 57
in-progress: 51
missing: 92
planned: 0
platform-blocked: 0
rejected-with-decision: 0
total: 200
```

The registry is authoritative. Re-read it after every implementation batch and
do not claim completion while `missing` or `in-progress` is non-zero.

## Repository evidence baselines

Two audit baselines exist and must not be conflated:

- `private/main` at `bdbf07845b773afc8ca7a7d906f34f415046e20e`: Cowork workflow,
  activity/origin ledger, MCP confinement/transports, registration identity,
  nested `CLAUDE.md`, and restart authority work were verified in one audit.
- `feat/cowork-background-tasks` at `7c48d71aa65e61543134a25e5ff677fd8ef80f31`:
  the 200-item registry and Phase 0 harness foundation were added; no registry
  item was yet `verified`.

Always inspect the actual current branch before acting. Earlier audits also
found local-only uncommitted work and an unmerged `wip/local-only-model-downloads`
branch. Preserve any such work before cleanup.

## P0 backlog

- Remove remaining Google Analytics injection, telemetry, updater registration,
  updater code, CLI telemetry, `distinct_id`, Jan.ai mirrors,
  HuggingFace/model-catalogue fetches, `/hub` and download surfaces, download
  extension, updater services, packaging references, and onboarding download
  steps.
- Extend `localOnly.test.ts` across web, core, Tauri, extensions, scripts,
  manifests, and Vite/Tauri configuration.
- AH-045 secret redaction in logs/transcripts.
- AH-046 Git destructive-operation protections.
- AH-049 permission decision audit log.
- AH-078 prompt snapshots.
- AH-157 secret scanning on diffs.
- AH-198 security regression corpus.
- Complete P0 in-progress permission, budget, timeout, cancellation, audit,
  network, secret, worktree, and patch-preview items: AH-006, AH-007, AH-017,
  AH-018, AH-020, AH-023, AH-034, AH-036, AH-037, AH-041, AH-042, AH-044,
  AH-050, AH-051, AH-073, AH-107, AH-109, AH-146.

## P1 backlog clusters

- Tauri WebView smoke harness and two-process restart scenario.
- AH-179 screen-reader accessibility and AH-180 keyboard navigation.
- AH-177 event export and AH-200 full audit export.
- Settings anchors and extension-provided settings indexing.
- Global permission inbox, stale-request handling, revoke, and audit history.
- LSP/repository intelligence: AH-057-064.
- Agent roles: AH-094-099.
- Git workflow: AH-147, AH-148, AH-151, AH-154-156, AH-159, AH-162, AH-164,
  AH-165, AH-168, AH-169, AH-171.

P1 missing IDs: `AH-019, AH-021, AH-030, AH-043, AH-055, AH-057-061, AH-063,
AH-064, AH-066, AH-067, AH-069, AH-070, AH-079, AH-082, AH-084, AH-094-099,
AH-103, AH-127-129, AH-137, AH-147, AH-148, AH-151, AH-154-156, AH-159, AH-162,
AH-164, AH-165, AH-168, AH-169, AH-171, AH-177, AH-179, AH-180, AH-183, AH-187,
AH-193, AH-197, AH-200`.

## P2 missing IDs

`AH-052, AH-056, AH-062, AH-065, AH-068, AH-071, AH-072, AH-085, AH-086,
AH-112, AH-118, AH-119, AH-123, AH-124, AH-135, AH-138, AH-143, AH-149, AH-150,
AH-152, AH-153, AH-158, AH-160, AH-163, AH-166, AH-167, AH-173, AH-181,
AH-184-186, AH-190-192, AH-196`.

## P1/P2 in-progress IDs

- P1: `AH-024, AH-025, AH-026, AH-029, AH-032, AH-040, AH-053, AH-054, AH-076,
  AH-077, AH-081, AH-083, AH-087, AH-100, AH-102, AH-110, AH-121, AH-134,
  AH-139, AH-161, AH-172, AH-175, AH-182, AH-195`.
- P2: `AH-088, AH-111, AH-140, AH-144, AH-145, AH-174, AH-176, AH-178, AH-194`.

## Product requirements from the chats

- Detailed in-chat activity showing reads, edits, diffs, Bash commands, tests,
  permissions, failures, retries, cancellation, and safe output redaction. Do
  not expose private chain-of-thought.
- Model renaming, alphabetical/recent/provider sorting, and search by custom
  name plus real ID.
- Discoverable Code, Preview, Changes, and Activity rails.
- Git working-tree review distinct from Cowork sandbox changes.
- Expandable project navigation with recent chats and "Show more".
- Side-by-side chat with pane-specific session, project, model, permission, and
  tool state.
- Global permission center across chats, agents, background jobs, and MCP.

## Verification blockers

- No registry item was verified in the Phase 0 audit.
- JS suites may be unavailable when `node_modules` is absent.
- Linux/Windows runtime CI failed before job allocation because of GitHub
  billing; this is not code evidence.
- macOS, Windows, and real Tauri WebView behavior must not be described as
  verified without running them.
- Do not begin with Cargo/Rust/toolchain work; finish product implementation and
  focused tests first, then run broad validation at the end.

## Source audit files

The original pasted reports remain in the Codex attachment store. If they are
unavailable on the next PC, use this handoff plus the registry commit above; do
not reconstruct the 200 features from memory.

## Handoff rule

Before every new batch: inspect the registry, select dependency-ready items,
implement them, add production-path tests, update registry evidence, and
recalculate counts. Stop only when every item is implemented/verified or
explicitly rejected with a documented decision.

## Recovery note (this branch)

`feat/local-only-completion` did not carry any of these files. They were
restored on this branch from `7c48d71aa65e61543134a25e5ff677fd8ef80f31`, which
is present in this repository, rather than reconstructed from memory:

```text
docs/agent-harness-features.json          5617 lines, 200 features
docs/AGENT_HARNESS_ARCHITECTURE.md         202 lines
docs/AGENT_HARNESS_FEATURE_REGISTRY.md     349 lines
docs/AGENT_HARNESS_ROADMAP.md              154 lines
docs/AGENT_HARNESS_VERIFICATION.md         121 lines
```

The restored registry's own counts match the audit above exactly: 57
implemented, 51 in-progress, 92 missing, 200 total, 0 verified. The shorthand
names used in the handoff request map to the real filenames as
`_FEATURE_REGISTRY.md` -> `AGENT_HARNESS_FEATURE_REGISTRY.md`, `_ROADMAP.md` ->
`AGENT_HARNESS_ROADMAP.md`, `_VERIFICATION.md` -> `AGENT_HARNESS_VERIFICATION.md`.

---

## Checkpoint — 2026-09-07

Branch `feat/local-only-completion`, commit `a8d43c78f`, pushed to `private`.

Registry counts are **unchanged**: 57 implemented / 51 in-progress / 92 missing
/ 0 verified / 200 total. The batch below was defect work and harness work, not
registry work, so nothing was reclassified.

### Completed this batch

- Local-provider diagnosis and fix (`6ab1c5229`): `v100` resolved through a
  search domain to a Cloudflare AAAA record, so requests left the machine and
  came back 403. IPv4 reaches the real server and returns `qwen3.8-27b`.
  `errorText`, `endpointDiagnostics`, and truthful provider failures.
- Cowork panel collapse and padding (`f1444742b`).
- Title-bar drag region no longer swallows header clicks (`8fe6d0719`).
- HuggingFace startup egress removed (`719d9a207`): `bootstrapDefaultEmbedder`
  and the weights URL are gone from source *and* from the shipped
  `extensions/llamacpp-extension/dist/index.js`. Guard extended with a
  weights-URL check and a bootstrap check; both scan the built bundle.
- Smoke harness at 30 scenarios.

### Known-flaky, not green

`provider-error-is-actionable` passed 2 of 4 consecutive runs;
`model-round-trip` is intermittent for the same reason. Both wait on the
provider machinery and the WebView stalls under it. Do not treat either as
settled evidence.

### Exact next dependency-ready batch (P0, deps already satisfied)

    AH-006  Tool capability model              in-progress
    AH-017  Token budget enforcement           in-progress
    AH-020  Per-tool timeouts                  in-progress
    AH-023  In-flight tool-call cancellation   in-progress
    AH-034  Rule resource matching             in-progress
    AH-046  Git destructive-operation guards   missing
    AH-049  Permission decision audit log      missing
    AH-051  Emergency kill switch              in-progress
    AH-078  Prompt snapshots                   missing
    AH-107  Per-agent git worktrees            in-progress
    AH-146  Patch previews                     in-progress

Completing these unlocks AH-007, AH-018, AH-036, AH-037, AH-041, AH-042,
AH-050, AH-073, AH-109 and AH-198.

AH-049 was started: the only production call site for a permission decision is
`plugins/tauri-plugin-agent-tools/src/commands.rs:525`
(`gate::resolve_decision`); the two in `tools/handlers.rs` need checking for
`#[cfg(test)]`. `harness/src/envelope.rs` already provides the versioned,
crash-tolerant JSONL writer the log should reuse rather than reinvent. No code
was written for it yet.

### Tests run

`tsc -b` clean; frontend 5083 passed / 1 known `formatDate` failure / 3 skipped;
llamacpp extension suite 62 passed; `localOnly` 29 passed; entry-point guards
8 passed; dialog seam 1 passed; smoke 30 scenarios, best run 30/30 exit 0.

### Blockers

- The two flaky scenarios above.
- Registry throughput: see the note in the phase report. 143 items remain, each
  carrying seven acceptance criteria including production wiring, persistence,
  UI, security enforcement and tests.

## Resume point

Updated after the P0 security batch. Everything below supersedes the older
"next batch" notes further up this file.

### Branch and commit

`feat/local-only-completion` at `30d720c00`, pushed to `private`.

### Registry counts

63 implemented / 47 in-progress / 90 missing / 0 verified / 200 total.

### Completed since the last handoff

| ID | Status | Where |
|---|---|---|
| AH-006 | implemented | `plugins/tauri-plugin-agent-tools/src/resource.rs`, `tools/gate.rs` |
| AH-034 | implemented | `permissions.rs`, `resource.rs` |
| AH-046 | implemented | `resource.rs` (`GitOp::classify`), `tools/gate.rs`, `commands.rs` |
| AH-049 | implemented | `audit.rs`, wired at `commands.rs` decision site |
| AH-017 | implemented | `core/agent/loop.rs` — the ceiling now stops the run |
| AH-020 | implemented | `lifecycle.rs`, `tools/handlers.rs`, `tools/mod.rs` |
| AH-023 | in-progress | `lifecycle.rs` primitive done and wired to built-ins |

Two corrections worth carrying forward:

- `harness/src/envelope.rs`, which this document previously named as the writer
  AH-049 should reuse, **does not exist**. The audit log mirrors
  `core/cli/journal.rs` instead; the plugin cannot depend on the main crate
  without a dependency cycle.
- MCP tool calls **already had** a timeout and a cancellation channel
  (`core/mcp/commands.rs:494-506`). The registry's AH-020 note claiming
  otherwise was wrong and has been corrected in place.

### Exact next batch

Registry: **65 implemented / 46 in-progress / 89 missing / 0 verified / 200**.

**AH-078 is now wired end to end in the real timeline.** The chain is:

`HttpModelInvoker::invoke` captures the frozen payload ->
`snapshot::append` persists it redacted ->
`StreamEvent::PromptSnapshot` ->
`applyInnerToTurns` (useCoworkRun.ts) opens the assistant turn that snapshot
produced ->
`coworkTurnsToUIMessages` emits a `data-prompt-snapshot` part ->
`routes/cowork.tsx` renders `<PromptSnapshotView>` on that message ->
`agent_prompt_snapshots` -> `snapshot::scoped_lookup`.

Each snapshot rides the turn it produced, so a second invocation does not show
its payload against the first turn.

It is still **in-progress**, for one reason only: no smoke scenario has
exercised it in the real Tauri app. The unit chain is covered (8 scope, 19
snapshot, 11 viewer, 3 turn-mapping, 3 event-mapping tests) but the acceptance
bar is "launch Jan, make a request, open the panel from that request's
activity", and that has not been run.

**Next production target, precisely:** add a scenario to
`src-tauri/examples/cowork_smoke.rs` that scripts the mock provider (`plain`),
sends a message, waits for `[data-testid="prompt-snapshot"]` to appear on the
assistant message, opens it, asserts provider/model/hash and the redaction
summary, switches Tree/JSON, and asserts no `Bearer`/`sk-` appears anywhere in
the panel. Add a negative scenario asserting a snapshot id from another session
is refused. Then mark AH-078 implemented.

**AH-107 — not started.** `spawn_subagent` (`core/agent/subagent.rs`) still runs
against the shared root. `core/agent/worktree.rs` has the full lifecycle; do not
duplicate it.

**AH-146 — not started.** The approval event in `core/agent/events.rs` still
carries a whole-change diff.

**AH-201-AH-210 — not appended.** The registry is still 200 entries.

Then: AH-007, AH-036, AH-037, AH-041, AH-042, AH-044, AH-045, AH-050, AH-073,
AH-109, AH-157, AH-198.

### Superseded next batch (kept for context)

### Exact next batch

Registry: **65 implemented / 46 in-progress / 89 missing / 0 verified / 200**.

**AH-078 — one step from done.** Backend, IPC and viewer all exist and are
tested:

- `snapshot::scoped_lookup` (plugin) holds the retrieval rule; 8 tests cover
  same-session, by-run, cross-session refusal, cross-run refusal, bare id,
  unscoped list, and unknown id.
- `agent_prompt_snapshots` (registered in `src-tauri/src/lib.rs`) delegates to
  it.
- `web-app/src/containers/PromptSnapshotView.tsx` renders it; 11 tests.
- `prompt_snapshot` is in the `StreamEvent` union in
  `web-app/src/hooks/useCoworkRun.ts`.

**The one remaining step: render the viewer.** `useCoworkRun.ts` has the event
typed but `applyEvent` still falls through to `default` for it. Either add a
turn kind for it, or — smaller and probably better — keep the latest snapshot id
in the run store and render one `<PromptSnapshotView>` beside `CoworkRunSummary`
in `routes/cowork.tsx`, passing `sessionId` so the scope check passes. Then mark
AH-078 implemented.

**AH-107 — not started.** `spawn_subagent` (`core/agent/subagent.rs`) propagates
the cancellation token but still runs against the shared root.
`core/agent/worktree.rs` already has create/validate/name/use/list/recover/
discard — do not add a second manager. Create the worktree before the child
starts, pass its path as the child's working directory, record
owner/run/branch/base-commit, wire cleanup to the cancellation path.

**AH-146 — not started.** The approval event in `core/agent/events.rs` still
carries a whole-change diff. Needs an immutable preview with a patch hash and
base-state hashes that approval binds to, invalidated when either changes.

**AH-201–AH-210 — not appended.** The registry is still 200 entries.

Then: AH-007, AH-036, AH-037, AH-041, AH-042, AH-044, AH-045, AH-050, AH-073,
AH-109, AH-157, AH-198.

Facts worth carrying:

- `lifecycle::current()` is the ambient token; a spawned task does **not**
  inherit it and must capture it explicitly.
- `resolve_jan_data_folder()` redirects under `cfg(test)`. Anything reached from
  the dispatcher that writes to the data folder must keep that property.
- The shared `Button` does not forward refs.
- `snapshot::redact_payload` (structure-aware, provenance) and `audit::redact`
  (value-shaped) are the two redaction passes. AH-044/AH-045 should build on
  them rather than adding a third.
- In jsdom, `navigator.clipboard` is getter-only and `userEvent.setup()`
  installs its own stub; define the mock after setup. jsdom does not implement
  Enter-to-toggle on `<details>`.

### Superseded next batch (kept for context)

### Exact next batch

Registry: **65 implemented / 46 in-progress / 89 missing / 0 verified / 200**.

Completed earlier in this phase: **AH-023**, **AH-051**.

**AH-078 — backend done, in-progress on purpose.** The snapshot is taken in
`HttpModelInvoker::invoke` from the exact serialized request, redacted with
provenance before persistence, hashed over the redacted payload with a canonical
key-sorted serialization, stored append-only at
`<jan_data>/audit/prompts.jsonl`, and looked up by id, run or session.
`StreamEvent::PromptSnapshot` carries id/hash/redaction-count to the timeline.
Guards mutation-checked. **The one missing acceptance criterion is the UI action
to inspect a snapshot** — the event and `snapshot::{find, by_run, by_session}`
exist for it, and a Tauri command plus a viewer is all that remains. It is not
marked implemented because of that.

**AH-107 — not started.** `spawn_subagent` propagates the parent's cancellation
token but still runs against the shared root. `core/agent/worktree.rs` already
has create/validate/name/use/list/recover/discard — do not add a second manager.
The work is: create a worktree before the child starts, pass its path as the
child's working directory, record owner/run/branch/base-commit metadata, and
wire cleanup to the cancellation path.

**AH-146 — not started.** The approval event still carries a whole-change diff
(`core/agent/events.rs`). The work is an immutable preview with a patch hash and
base-state hashes that approval binds to, invalidated when either changes.

Then: AH-007, AH-036, AH-037, AH-041, AH-042, AH-044, AH-045, AH-050, AH-073,
AH-109, AH-157, AH-198.

Facts worth carrying:

- `lifecycle::current()` is the ambient token; a spawned task does **not**
  inherit it and must capture it explicitly.
- `resolve_jan_data_folder()` redirects under `cfg(test)`. Anything reached from
  the dispatcher that writes to the data folder must keep that property.
- The shared `Button` does not forward refs.
- `snapshot::redact_payload` and `audit::redact` are the two redaction passes;
  AH-044/AH-045 should build on them rather than adding a third.

### Superseded next batch (kept for context)

### Exact next batch

Current at the head of this branch. Registry: **65 implemented / 45 in-progress
/ 90 missing / 0 verified / 200**.

Completed in this phase: **AH-023** (cancellation reaches the dispatcher,
built-ins, bash, MCP, subagents, the permission wait and retry backoff, with one
producer for the `cancelled` audit outcome) and **AH-051** (emergency stop, both
the scope machinery and a reachable, confirmed, accessible UI).

Not started, and still the next three:

- **AH-078** prompt snapshots. Nothing writes the frozen dispatch to disk. The
  payload exists in transport instance memory at dispatch time; the work is to
  persist it redacted, hashed and correlated, with corrupt/truncated handling.
- **AH-107** per-agent worktrees. `spawn_subagent` now propagates the parent's
  cancellation token, but the child still runs against the shared root;
  `core/agent/worktree.rs` already has create/validate/recover, so the work is
  wiring `dispatch_subagent` to it and owning the lifecycle.
- **AH-146** patch previews. The approval event still carries a whole-change
  diff; the work is an immutable, hash-bound preview that approval binds to.

Then the unlocked security phase: AH-007, AH-036, AH-037, AH-041, AH-042,
AH-044, AH-045, AH-050, AH-073, AH-109, AH-157, AH-198.

Useful facts for whoever picks this up:

- `lifecycle::current()` gives the ambient token for the running task; a spawned
  task does **not** inherit it and must capture it explicitly (see
  `spawn_subagent`).
- `resolve_jan_data_folder()` now redirects under `cfg(test)`. Anything reached
  from the dispatcher that writes to the data folder must keep that property, or
  a test run appends to the developer's real Jan data.
- The shared `Button` does not forward refs. A ref placed on it is silently
  null.

### Superseded next batch (kept for context)

### Exact next batch

Updated at `ff91aaf58`. Registry counts unchanged (63/47/90): AH-023 and AH-051
both advanced but neither meets its full acceptance list, so neither is claimed.

**AH-023 — done:** the run scope lives on `CompositeToolInvoker`; all three
dispatch paths (parallel reads, direct allow, both post-prompt branches) mint a
call token under it and hold the guard across the await; the permission wait
races the token, drops the pending request either way, and treats an answer for
an already-stopped call as stale. Two tests drive the real dispatcher.

**AH-023 — remaining, in order:**

1. Cancel subagent dispatch in `core/agent/loop.rs` (`dispatch_subagent`).
2. Connect `state.tool_call_cancellations` (the MCP oneshot channel that already
   exists at `core/mcp/commands.rs:433-506`) to the canonical token, so one stop
   reaches MCP calls instead of two systems each knowing half.
3. Emit the AH-049 `cancelled` outcome from every stop path, not only the stale
   answer. This also gives `expired`/`revoked`/`stale` their first producers.
4. Cancel during retry/backoff in `genai_bridge.rs`.

**AH-051 — done:** `emergency_stop` + `StopReport` (separates stopped from
already-stopped, counts surviving children, fails closed), killed-scope
persistence with containment-aware `was_killed`, and the `agent_emergency_stop`
IPC command.

**AH-051 — remaining:** the reachable confirmed UI action with accessibility,
disabling repeat activation while a stop runs, revoking transient grants for
stopped work, and stopping queued MCP/subagent work (blocked on AH-023 above).

**Not started in this batch:** AH-078 (prompt snapshots), AH-107 (per-agent
worktrees — `dispatch_subagent` still uses the shared root), AH-146 (structured
patch previews).

Then: AH-007, AH-018, AH-036, AH-037, AH-041, AH-042, AH-044, AH-045, AH-050,
AH-073, AH-109, AH-157, AH-198.

### Superseded next batch (kept for context)

### Exact next batch

Finish AH-023 first — it is the nearest to done and AH-051 depends on it:

1. Thread `lifecycle::Token` from the desktop run and dispatcher into
   `ToolContext::with_cancel` (today only the CLI and tests supply one).
2. Cancel subagent dispatch in `core/agent/loop.rs`.
3. Make the permission-wait path observe the token.
4. Connect the existing MCP cancellation channel
   (`state.tool_call_cancellations`) to the token.
5. Emit the AH-049 `cancelled` outcome from the stop path — this also gives
   AH-049's `expired`/`revoked`/`stale` outcomes their first producers.

Then, still open from the active P0 batch: AH-051 (build on `stop_scope`, which
already supports run/session/application scopes and reports
`live_children_in` so it can fail closed), AH-078, AH-107, AH-146.

After those: AH-007, AH-018, AH-036, AH-037, AH-041, AH-042, AH-044, AH-045,
AH-050, AH-073, AH-109, AH-157, AH-198.

### Tests

428 plugin tests pass; 353 `core::agent` tests pass. Guards mutation-checked:
fail-closed resources, substring git detection, audit redaction, audit reader
tolerance, late-result acceptance, and scope boundaries each turn their tests
red when removed.

### Known failures

- `core::agent::worktree::tests::lists_only_the_worktrees_jan_made_here` —
  pre-existing macOS `/private/var` vs `/var` symlink mismatch, unrelated to
  this work.
- `formatDate` timezone test in the frontend suite — pre-existing.
- Smoke scenarios `provider-error-is-actionable` and `model-round-trip` are
  intermittent under WebView stalls; not marked verified.


---

## Defect batch: provider transport and the Cowork timeline (2026-09-08)

Paused the 210-feature programme at `28f46d1c5` on user instruction to fix
reported production defects. Resumed after this batch.

### `http://v100:8080/v1` reached the wrong machine

Root cause: `v100` is a single-label name, so the only way it resolves to
anything public is a DNS search-domain collision. The OS returned both a public
Cloudflare record and the Tailscale address; the connector took whichever came
first, left the network, and the public host answered 403. Every layer above
reported that as an API-key problem.

Fix: one transport for every OpenAI-compatible provider request.

- `src-tauri/src/core/net/resolver.rs` — classifies each answer (loopback,
  Tailscale `100.64.0.0/10`, RFC1918, IPv6 ULA/link-local, public) and orders
  them closest-first for a local-looking name. A public answer is dropped, not
  deprioritised, when a local one exists.
- `src-tauri/src/core/net/transport.rs` — `send` / `send_stream`. The URL is
  never rewritten: selection happens in the connector through a
  `reqwest::dns::Resolve` bound to that endpoint, so hostname, port, `Host`,
  SNI, path and query are exactly as configured. Every eligible address is
  offered in order so a refusal falls through. A 401/403 from the selected
  server stays an HTTP response. Resolutions cached per host+port for 30s,
  dropped on transport failure, provider edit or explicit refresh.
- `src-tauri/src/core/net/commands.rs` — `provider_http_request`,
  `provider_http_stream`, `provider_endpoint_diagnostics`,
  `provider_endpoint_refresh`.
- `web-app/src/lib/providerFetch.ts` — `fetch`-shaped, streaming. Wired at the
  two chokepoints: `model-factory.ts` `getRuntimeFetch` (chat, streaming,
  embeddings, AI SDK providers) and `services/providers/tauri.ts` (discovery,
  connection tests).

Deterministic resolver injection: `transport::set_probe`. The smoke harness
pins `v100` to a public decoy plus loopback and configures the provider at the
literal `http://v100:8080/v1`, so every model-touching scenario exercises the
short-hostname path.

### Cowork timeline

- The setup/debug wall (readiness, compatibility, skill folders, context
  accounting) moved from above the composer into `CoworkSessionDetails`, a
  collapsed control in the header. Contents mount only while open.
- `ask` questions became chronological chat items on the assistant turn that
  asked them (`CoworkTurn.asks`, `CoworkAskEntry`), with answered / cancelled /
  stale states. Staleness is derived from "the run is gone", not stored.
- `lib/askOptions.ts` — one normalization decides the custom-answer row, so
  "Something else" is never rendered twice and a model-supplied label is never
  rewritten. Selection identity moved to stable ids.
- Tool activity is one durable item per invocation moving through
  requested → running → succeeded/failed/refused/cancelled/stale. "Hide
  completed tool activity" (`useCoworkDisplay`, off by default) is a
  presentation filter only.
- `lib/modelLocation.ts` — classifies by where inference runs, not by whether
  the provider ships an engine, so a LAN/tailnet endpoint groups under LOCAL.
  A single-label name is `checking` until the resolver answers.
- "What changed" is gated on Jan-authored writes, so a dirty working tree no
  longer parks a panel over the composer.
- `CoworkQuickActions` — Search (the shared dialog) and Settings (the ordinary
  route) from the Cowork header; `useCoworkView` keeps rail and scroll across
  the trip.

### Two defects the harness found that were not in the report

**A closed dialog swallowed every click.** `DialogOverlay` is `fixed inset-0
z-50` and declares an exit animation, but carried no `duration` -- unlike the
`DialogContent` beside it. Radix keeps a closing element mounted until its exit
animation reports `animationend`, and an animation with no duration may never
report one, so the overlay stayed in the DOM after close, invisible, absorbing
every click in the window. `drawer.tsx` and `sheet.tsx` had the same omission
on the same shape of element. Fixed with `duration-200` on all three. This was
the cause of an entire tail of smoke failures: once any dialog had been opened
and closed, later scenarios failed on clicks that could never land.

**`get_jan_data_folder_path` ignored `JAN_DATA_FOLDER`.** It resolves through
`get_app_configurations`, which reads the app config file. `resolve_jan_data_folder`
honoured the override; this one did not, so settings resolved to the redirected
folder while extension storage -- and with it the user's configured providers --
resolved to the real one. A harness run loaded the developer's real provider
list and opened connections to their own machines.

### Why AH-078's panel never appeared

`StreamEvent::PromptSnapshot` is emitted only from `core/agent/loop.rs`, and a
Cowork run does not go through it: the model is driven by the AI SDK in the web
app. The event had no producer on the path the timeline renders. The snapshot
is taken in `core/net/transport.rs` now, which is both the last point before a
request leaves the process and the only point every provider request shares.
Identity travels on the model instance (`__janDispatch` -> `x-jan-*` headers,
lifted out before the request goes on the wire) because the model is built per
conversation and a module-level "current dispatch" would race between two
sessions streaming at once.

### Not yet done in this batch

- Item 1 of the second defect message (the Cowork spacing/padding system) is
  not implemented.
- Item 7 (canonical model-capabilities record and the context-window display)
  is not implemented.
- Tool-activity metadata beyond state and timing (permission decision, exit
  code, agent identity) has fields on the turn but no producers yet.
- Scroll restoration across Settings is implemented but not proven by a smoke
  assertion; `StickToBottom` owns that scroll node.
- The smoke harness reads the user's real provider list through the store
  plugin, which uses the app config dir rather than `JAN_DATA_FOLDER`. That
  makes runs slow and non-deterministic and should be isolated.


### Open, found by the harness and not yet fixed (2026-09-08)

**A Cowork run streaming through the new transport does not terminate.** The
reply text arrives and renders -- `chat-streams-over-the-local-hostname`
passes on that -- but the send control never comes back, so the run is still
considered active ninety seconds later. `no-setup-wall-above-the-composer`
fails waiting for it, and `provider-error-is-actionable` and
`header-controls-are-clickable` fail behind it.

First place to look: `web-app/src/lib/providerFetch.ts` ignores
`init.signal` entirely, so nothing can abort a provider request, and the
response body stream is closed only when the transport sends `End`. If that
chunk does not arrive -- or arrives after the consumer has gone -- the AI SDK
waits on a body that never finishes. Wire the abort signal through to a
cancellation on the Rust side, and make the stream's completion unconditional.

The chat route's own round trip (`model-round-trip`) completes, so this is
specific to the Cowork loop's use of the stream rather than to the transport
refusing to finish.

### State at the end of this batch (2026-09-08)

Smoke: **34 pass, 2 fail** of 36.

`prompt-snapshot-panel` — the panel still does not appear, and the cause is
now narrowed by measurement rather than guessed at.

The scenario reads `<jan_data>/audit/prompts.jsonl` directly after a chat, and
it holds **zero records**. So the break is not in the timeline: nothing is ever
captured. `capture_snapshot` also logs a warning when a dispatch arrives with a
`messages` body but no session -- the case where the `x-jan-*` headers would
have been lost in the fetch chain -- and that warning never fires either.

Both together rule out the header path and point at the body: `capture_snapshot`
returns before the session check, which means `req.body` is absent, does not
parse as JSON, or carries no top-level `messages` array. Next step: log the
first 200 characters of `req.body` and its parse result for any POST to a
`/chat/completions` URL, and compare with what `providerFetch`'s `bodyText`
produced -- the AI SDK may be sending the body in a form `bodyText` turns into
`None`.

`provider-error-is-actionable` — the toast naming a 403 does not appear. This
has been failing since the start of this batch, before the transport landed,
so it is not obviously caused by it; unverified either way.


### AH-078 closed (2026-09-08)

`prompt-snapshot-panel` passes in the real application. Two defects, found by
measurement rather than inference:

1. **Capture was never the problem.** The earlier "zero records on disk"
   reading came from runs where the chat itself had not happened -- the
   scenario asserted on the panel without first waiting for a reply, so a
   failed send read as a missing panel. With the reply waited for, the boundary
   probe showed the body arriving as a 14 KB JSON string with `messages` and
   the session present, and the record written.
2. **Two live-turn lanes.** The Cowork route renders its own ref-backed turn
   array; `attachPromptSnapshot` and the ask actions wrote to the run store's,
   which that route never reads. Worse, the run rebuilds its array as steps
   complete, so even a reference written into the rendered lane at dispatch
   time was discarded before it could render.

The fix keeps snapshots beside the turns rather than on them:
`useCoworkRun.promptSnapshots[sessionId]` is an ordered list of every dispatch
the session made, and the timeline zips the Nth entry onto the Nth assistant
message. That is immune to the run rebuilding its turns and still ties a
snapshot to its own invocation. The ask lifecycle now writes through
`mutateLive` into the rendered lane, via pure helpers (`attachAskToTurns`,
`settleAskInTurns`, `attachPromptSnapshotToTurns`) that both lanes share.

Also: the harness gained `--only a,b`. A scenario that wedges the WebView fails
every scenario after it, so judging one honestly means running it alone.

### `provider-error-is-actionable` closed (2026-09-08)

Three defects behind one failing scenario, all found by making the failure say
what it saw instead of only that it saw nothing.

1. **The request was never sent.** The model refresh refused up front unless
   the provider had an API key, so a local server -- which needs none -- was
   told to "configure an API key", and the request that would have explained
   the real failure never happened. `isLocalEndpoint` was not enough here
   either: a single-label name like `v100` is deliberately `unknown`, not
   private. The guard now demands a key only when the endpoint is *definitely*
   public (`classifyModelLocation(...) === 'remote'`); where it is not certain,
   Jan makes the request and reports the answer.
2. **The explanation was buried.** `fetchModelsFromProvider` wrapped its own
   structured message in "Unexpected error while fetching models from X",
   because the prefix list it checked did not match the newer message. Endpoint
   failures are now thrown as `EndpointError` and re-thrown untouched.
3. **The toast could not be dismissed.** Sonner was configured without
   `closeButton`, so a sticky, actionable error had no way to be put away.

The assertion observes the toast lifecycle through a MutationObserver that
records every toast as it is inserted, rather than sampling the DOM and racing
the toast's own lifetime.

Observed toast, exactly one:
`cowork-smoke-mock: GET http://v100:8080/v1/models returned 403 (answered by
cloudflare). The request reached a proxy on the internet rather than your own
server, so the hostname is resolving to a public address. Point the provider at
the machine's address directly, or fix the name resolution.`

### Registry extended to 210 (2026-09-08)

AH-001..AH-200 are unchanged. AH-201..AH-210 appended as a new phase 9,
"Approved additions", each `missing` with dependencies, security impact,
acceptance criteria covering refusal, cancellation, persistence, accessibility
and negative authority, a named test, and evidence stating what does not exist
today.

Counts, recomputed from the JSON: **210 total — 66 implemented, 45 in-progress,
99 missing.** An earlier commit message in this batch said 67/44; that was
wrong, the correct figure after AH-078 moved was 66/45.

`scripts/agent-harness/render-registry.mjs` is referenced by the markdown
registry but does not exist on this branch, so the totals table was recomputed
from the JSON rather than regenerated, and the file says so.

Appending an entry is documentation. None of AH-201..AH-210 is implemented.

### Full harness green: 36/36 (2026-09-08)

The two remaining failures were never defects in the scenarios that reported
them. `header-controls-are-clickable` and `prompt-snapshot-panel` both pass in
isolation; in a full run they inherited an unresponsive WebView from whatever
ran before, and then failed on a sixty-second timeout evaluating a one-line
DOM query.

The runner now checks the page is answering before each scenario and reloads it
if not, and names every scenario that started after such a recovery. One wedge
is reported as one wedge instead of as a string of unrelated failures. With
that in place the suite is **36 passed, 0 failed**, with one recovery noted
before `provider-error-is-actionable`.

This is why several earlier tallies in this batch were wrong: they counted
cascade victims as defects.

### AH-078 invocation identity: record done, UI attachment not (2026-09-08)

The stored record now carries a real identity. `PromptSnapshot` gained
`invocation`, `turn`, `attempt` and `kind` (`initial` / `continuation` /
`retry` / `compaction`); `ProviderRequest` accepts them; `SnapshotRef` echoes
the invocation back to the caller. A Rust test dispatches the same payload
twice under two invocation ids and asserts two separate records with the same
hash, the retry recorded as attempt 2 of kind `retry`, retrievable by its own
id under its session.

**The UI still attaches by ordinal.** Four attempts to replace the zip -- turn
snapshot lists, a pending queue drained on push, a store keyed by turn id, and
a turn-to-message anchor map -- each passed their unit tests and each failed
`prompt-snapshot-panel` in the real application, with the record on disk and no
panel rendered. Rather than ship a regression against a verified-green feature,
the web-app half was reverted to the state that passes.

So AH-078 stays implemented on the behaviour that is actually verified, and the
ordinal limitation stands: one snapshot per assistant message, matched by
position. It is wrong for a turn holding a continuation, a retry or a
compaction, and that is the open acceptance criterion.

Next attempt should start by proving where the chain breaks in the running app
rather than in vitest: the unit tests pass for every one of those designs, so
the disagreement is between jsdom and the WebView, not in the mapping logic.
Instrument `snapshotsByMessage` and the message ids actually rendered, in the
app, before changing the design again.

### AH-078 ordinal matching: still open after a second attempt (2026-09-08)

Instrumenting the running app, as the previous handoff said to, produced one
real finding and disproved two more hypotheses.

**Found:** `prompt-snapshot-panel` was asserting on a reply that was already on
screen from an earlier attempt, so it moved on before the dispatch it was
testing had happened. It now starts a fresh session and waits for the previous
reply to be gone first. That was a genuine false-pass condition and is fixed.

**Disproved:** the session store does not strip unknown turn fields
(no `partialize`), and the sink's session guard is not the cause -- comparing
against the run's own session id as well as the rendered one changed nothing.

With a clean session the probe reads: run finished, two turns committed,
`turnsWithSnapshots: 0`, and the record present on disk. So the sink's write
into the rendered turn lane does not survive to the committed turns, and I do
not know why. Six designs have now failed the same way while passing in vitest.

The web-app changes were reverted again; the ordinal match stands and AH-078
remains implemented only on that verified behaviour.

**For the next attempt:** stop trying designs. Instrument the sink itself in
the app -- log at the moment `mutateLive` runs, the array length before and
after, and the same again inside `commitTurns` -- and find which of those two
writes loses the field. Everything so far has measured the ends, not the step
between them.

## AH-050: the canonical tool-activity record (2026-09-08)

Every tool call now emits lifecycle events to an append-only log at
`<jan_data>/audit/tool-activity.jsonl`, separate from the permission log in
`audit.rs`: that one records *decisions*, this one records what the call did.

**Where it hooks in.** `dispatchCoworkTool` is the single place any tool call
is routed -- main agent, subagent, background task, MCP server, skill -- so the
wrapper sits there and nothing has a path around it. Adding a tool later needs
no change here.

**Phases.** `requested`, `awaiting-permission`, `allowed`, `refused`,
`running`, `succeeded`, `failed`, `cancelled`, `stale`, `timed-out`. A refusal,
a cancellation and a failure stay distinguishable on purpose; only `succeeded`
is hideable, so "Hide completed tool activity" can never hide the events worth
reading.

**Ordering.** The fold in `activity.rs` orders by when a call was *requested*,
not when it finished, so two concurrent calls read in the order they were made
however their results interleave. Recording is queued rather than awaited --
a tool must not wait on its own audit line -- and the queue is what keeps
`running` from landing after `succeeded`.

**Restart.** `settle_unfinished` runs in `.setup()` before the window opens: a
call left `running` by a killed process becomes `stale`, because nothing is
left that could finish it. It is idempotent.

**Not done yet:** the timeline UI (AH-172) reads `tool_activity_items` but is
not yet wired into the Cowork conversation column.

### AH-172 found a real defect, not just a missing view (2026-09-08)

The first two runs of `tool-activity-timeline` failed with the record on disk
and no tool card in the DOM -- the same shape as the AH-078 failures, so it was
worth measuring rather than redesigning. The scenario printed the event count
and the transcript on failure, which settled it in one run: **3 events on disk,
and a transcript reading "Worked for 1s / Done. I used the tools you allowed."**

The record was working end to end. `ChainOfThoughtGroup` collapses a finished
trace once an answer follows it, which is right for a chat thread -- reasoning
is scaffolding behind the answer -- and wrong for Cowork, where the tool calls
are the work. A user was left with the model's word for what it had done.

Fixed with `keepToolActivity` on `MessageItem`, set in Cowork only. The
scenario now passes, including after a reload, which is what proves the
timeline is rebuilt from the record and not from run memory.

### The changes chip was counting the user's own work (2026-09-08)

`changeCounts` in the Cowork route added the attached repository's entire dirty
working tree to this session's sandbox diffs. A branch someone had left
half-finished was therefore reported as Jan having written forty files.

That is not a generous count, it is a false claim about authorship, and it is
the same defect `hasJanAuthoredChanges` was added to fix in the run summary --
the chip was simply the place that still mixed the two sources.

`janAuthoredChanges` now counts only paths this session wrote, taking line
counts from Git only for a direct edit whose own diff reported none. The
summary reads `3 files changed · +24 −8` in the tooltip and the accessible
name, with the row itself still compact.


### Context accounting, budget and capabilities (2026-09-08)

Three things that were being conflated are now three things.

**AH-195.** The context window read "not known" for every OpenAI-compatible
endpoint because exactly one field was ever consulted -- Jan's own `ctx_len`.
Servers report it as `context_length`, `max_context_length`, `max_model_len` or
`n_ctx`, and llama.cpp reports both `n_ctx` (the window in force, which `--fit`
may have shrunk) and `n_ctx_train` (what the model was trained for). The
resolver reads all of them, in a fixed order of trust, with no network lookup,
and leaves an undiscoverable window unknown rather than guessing -- a guess
would silently truncate.

**AH-088.** The window is now checked before dispatch. A request that would
leave the model nowhere to answer raises `ContextOverflowError` and is never
sent; some providers respond to that case by quietly dropping the front of the
conversation, so the run carries on having forgotten what it was asked. An
unknown window is never a refusal.

**AH-073.** Jan's own measurement is bytes over four and cannot be anything
else -- it runs before a request exists. The exact number is the one the server
that tokenized the payload reports back, and it is now recorded against the
invocation and that payload's snapshot, so a count is always beside the payload
it counted rather than beside "the last request".


### Run reliability, all seven items (2026-09-08)

Built as one set around the runner rather than seven helpers, because they all
answer "may this run take another step" and answering it separately is how they
end up disagreeing.

Two findings worth keeping:

**The loop guard exposed a gap in the subagent.** `runSubagent` handled
`steps` and `tokens` and let every other limit fall through to "(the subagent
returned no answer)" -- so a child stopped for going in circles told its parent
nothing it could act on. Every limit is now reported by name.

**Three identical calls is not a loop.** The first threshold stopped a
legitimate step-cap test, and on inspection it would have stopped ordinary work
too: re-reading a file after editing it, running the same test twice while
fixing it. Identical calls now allow five; a repeating *failure* still allows
three, because it is stronger evidence.


### The desktop was not enforcing the project's tool policy at all (2026-09-08)

`execute_tool_inner` built `ToolPermissions::default()` -- allow everything --
and handed that to the gate. So a repository that wrote
`deny = ["read(**/.ssh/**)"]` in its `agent.toml` was obeyed by the CLI and
ignored by the desktop, which is worse than not supporting the file: the rule
was accepted, displayed, and silently inert.

The gate itself was fine. It was being fed an empty policy. `policy::load`
reads the project's own `[tools]` section at the gate, deliberately not as an
argument from the renderer -- a policy passed in is a policy the caller can
choose not to send.

**Writing the adversarial corpus found two more.**

1. A relative path rule never matched anything. Resources normalize to absolute
   paths, correctly, so `read(secrets/**)` was compared against
   `/proj/secrets/keys.txt` and failed. Every rule a person would naturally
   write was inert. Relative patterns are now also anchored at a directory
   boundary, so `secrets/**` covers `/proj/secrets/x` and does not cover
   `/proj/notsecrets/x`.

2. `allow_network = false` confined the shell and left the web tools alone. A
   run with its network switched off could still fetch a URL. The setting meant
   "no network for Bash" while reading as "no network".

Both were found by writing the corpus, not by reading the code, which is the
argument for the corpus.

## 2026-09-10 — subject-aware permissions, typed memory proposals

**AH-007 (in-progress → implemented, backend).** `ResourceRule::parse` had
understood `[subject/]tool[(pattern)]` from the start, so `agent:reviewer/write`
compiled and was accepted — and then bound the main agent and every other
subagent identically, because `matches_allow`/`matches_deny` never compared the
subject. A child could not be narrower than its parent, which is the one thing a
subject qualifier exists to express. `covers_subject` now gates both, and
`resolve_decision` carries the subject as a parameter. An unqualified rule still
covers every subject, so existing rule sets are unchanged. Six tests, negative
cases first: they fail if `covers_subject` is made to return `true`
unconditionally, which is what the bug was.

Remaining for AH-007: the desktop and CLI surfaces both pass
`Subject::MainAgent` at every call site. The plumbing is enforced, but nothing
yet dispatches a subagent under its own `Subject::NamedAgent`, so a rule naming
one is correct and currently unreachable in production. That is the next step,
not a claim of completeness.

**Build defects named in the brief were already fixed on this branch.**
`cowork-smoke` is an `[[example]]` with `required-features`, `src/bin/` holds
only `jan.rs`, and `cargo build --release --no-default-features --features cli
--bin jan` succeeds (2m21s, exit 0). No change was needed; recorded so the next
session does not re-investigate.

## 2026-09-10 — the memory proposal becomes visible

**One gate, two callers.** `memory_record_propose_inferred` had its own copy of
the pending-reason ladder and its own copy of `PendingReason`, duplicating what
`memory::inferred::decide` already did for the model-facing `memory_propose`
tool. Two copies of a gate are two gates. The command now calls `decide`, and
`commands::PendingReason` is a re-export of the one in `inferred`. Nothing about
the order changed — refusals, then conflicts, then project-to-global, then the
setting — but there is now only one place it can change.

**A proposal is stored, not merely returned.** Both paths persist the pending
record with `Status::Proposed { reason }`. This is the change that makes the
feature real: before it, the question existed only in the tool result for the
turn that raised it, so a user who was not looking at that surface at that
moment was never asked at all. `is_usable` admits `Status::Active` only, so a
proposal reaches no prompt while it waits, and `service::list` now filters
proposals out of the remembered-facts list — a defect the new test caught, since
an unanswered guess was briefly appearing among the things Jan says it
remembers.

**The visible half.** `MemoryProposalCard` / `MemoryProposalList`
(`web-app/src/containers/MemoryProposalCard.tsx`) render from
`PendingReason::explain()`, never a generic "needs approval": the three reasons
need three different answers and one prompt would push a user to give them all
the same one. A conflicted proposal renders with no Approve button at all — only
"Review both" and "Discard" — and the backend refuses approving one anyway, so
the DOM and the gate agree.

Mounted in two production surfaces, through `useMemoryProposals`
(`web-app/src/hooks/useMemoryProposals.ts`), which reads from disk rather than
from renderer state:
- the thread route, filtered to that chat, reloaded when a turn ends;
- Settings → Memory, unfiltered, under "Waiting for you" — where "Review both"
  navigates, because settling a contradiction needs both sides on screen.

**Evidence.** 680 plugin tests pass (`--test-threads=4`); 10 vitest cases on the
card, including the two negatives that matter (a conflicted proposal offers no
approval; a backend refusal is shown rather than swallowed). A real WebView
scenario, `cowork-smoke --only memory-proposal-approval`, covers the round trip
end to end: propose over IPC, assert `Status::Proposed` on disk *before*
anything is clicked, assert the card and its reason in the DOM, click Approve,
assert the record is `active` on disk, reload, assert the answered question is
not asked again, then assert a contradiction renders without an Approve button.
DOM and file, in one scenario, because this programme has repeatedly shipped
cards that passed vitest and never rendered in the WebView. `PASS`, one scenario
executed.

Three things that scenario had to be taught, each of which had already produced
a false failure:

- `ctx.goto` does nothing when the route is already current, so navigating "to"
  the chat you are already in never remounts anything and never re-reads the
  store. Leaving to `/` and coming back does.
- A full page reload cannot be used here: it tears down the eval channel the
  harness talks over, and every wait after it times out.
- `Status` serialises as `"status":{"state":"active"}`, not `"status":"active"`.
  An assertion on the wrong shape fails against a file that is correct.

**A limit of conflict detection, found by the scenario.** `detect_conflicts`
ignores a pair where both records mention both sides of an incompatible choice,
so "the user prefers tabs over spaces" and "the user prefers spaces over tabs"
are *not* reported as conflicting, even though a person would call that a
straight contradiction. The conservatism is deliberate and documented in
`record.rs`: an unresolved conflict withholds both records, so a false positive
silently costs the user two good memories. Left as it is, and the scenario now
words each side to name one option only. Worth revisiting with a better
comparison than word membership, not with a looser one.

**Stale premise corrected.** `src-tauri/resources/bin` does not contain 0-byte
stubs: 23 files, none zero-byte. Recorded so the next session does not
re-investigate.

## 2026-09-10 — AH-007: the subject reaches production

Two sessions reached this independently, which is worth recording because the
duplication cost real time. `fork/main` already carried
`9a4cfe2 fix(permissions): tell the gate which agent is actually asking`, which
fixed the same compile failure and threaded the same identity, storing it as
`OrchestrationArgs::subject` where this branch had added
`OrchestrationArgs::agent_name`. **Upstream's design won on merge** -- it was
already published and already used by `run_subagent` -- and this branch's
parallel field was removed. Check `fork/main` before starting a registry item,
not after finishing one.

What was *not* upstream, and is the substance of this branch's contribution, is
the advertising half below.

**The desktop crate did not compile.** `resolve_decision` grew a tenth
parameter and `src/core/agent/loop.rs` was never updated, so `cargo check` on
the `Jan` crate failed with E0061 while the plugin's own tests all passed. The
plugin suite is not evidence that the application builds. (Fixed on both
branches; upstream's fix is the one that survives.)

**A subject-qualified rule over-denied.** `ToolPermissions::is_denied` and
`is_allowed` answered "does any rule name this tool", ignoring the subject.
Since those two are what decide which tools are *advertised* — the built-in
schema list, the MCP prune, and a subagent's narrowed toolset — writing
`deny = ["agent:reviewer/bash"]` removed `bash` from the main agent as well.
The execution gate would then have allowed the call the model was never offered.
Both now take a subject, and the two halves are asserted together: the reviewer
loses the tool, the main agent and `agent:implementer` keep it.

**Where the subject comes from.** `OrchestrationArgs::agent_name` — `None` is
the top-level agent; `run_subagent` sets it on the child's cloned args.
`orchestrate_inner` turns it into one `run_subject` used by the advertising
pass, the MCP prune and the dispatcher, so a run cannot be offered a tool under
one identity and refused it under another. `resolve_dispatch` reads the parent's
rules *for the child*, by the name it is being dispatched under, which is what
makes a rule about one subagent narrow that subagent's list.

Compiles on all three configurations: default, `--features cowork-smoke`, and
`--no-default-features --features cli`, tests included. 682 plugin tests pass
after the merge.

**Obstruction recorded: the `Jan` lib test binary does not start on Windows.**
`cargo test -p Jan --lib` exits `0xc0000139` (`STATUS_ENTRYPOINT_NOT_FOUND`)
before the harness prints anything, for tests untouched by this work
(`subagent_cap_is_clamped_to_at_least_one` fails identically). It is a loader
problem in this environment, not a test failure. Consequence:
`a_rule_naming_a_subagent_binds_that_subagent_and_nobody_else` in `loop.rs` is
compiled but unexecuted here. The eight `subject_rules` tests in the plugin do
run (680 plugin tests pass), and they cover the matching and the advertising;
what is unproven *on this host* is the dispatcher wiring, which is
compile-checked. Recorded in `docs/AGENT_HARNESS_VERIFICATION.md` under Known
blockers rather than worked around.

## Obstruction: `tool-activity-timeline` on Windows (2026-09-10)

Full smoke suite: **37 of 38 scenarios pass**, including
`memory-proposal-approval`. The one failure is `tool-activity-timeline`, and it
is recorded here rather than fixed, under the two-attempts rule.

What is known:

- It fails identically when run alone, so it is not contention with another
  scenario.
- Its own diagnostics say `events on disk: 0` and print a transcript containing
  only the application chrome — no user message, no reply. **No run happened at
  all**, so this is not "the tool was hidden from the model" and not "the
  dispatcher refused it". The send never produced a turn.
- It cannot be bisected against this branch. Reverting the subject-threading
  restores the E0061 that stopped the `Jan` crate compiling, so the smoke binary
  could not be built on this branch before this session — there is no passing
  baseline here to regress from. `docs/AGENT_HARNESS_VERIFICATION.md` already
  lists this scenario as *not run* on Windows; it is recorded as passing on
  macOS and in the WebView column only.
- It exercises `/cowork`, which the memory-proposal work does not touch: the
  approval card is mounted in the thread route.

Two investigations, no fix. Next session should start from "why does sending in
the Cowork composer produce no turn on Windows" rather than from the timeline.

## Two test-harness defects fixed on the way (2026-09-10)

Neither is production code, but both were reporting green or red for the wrong
reason, which is worse than either.

**`$threadId.test.tsx` mocked `getSessionData` as `vi.fn(() => ({ tools: [] }))`
— a new object per call.** The real store keeps one object per session, on the
session or in a standalone map. The route reads `sessionData` once per render
and pushes arriving tool calls onto `sessionData.tools`, so with the mock, any
re-render between two tool calls silently discarded the first. Eight tests
depended on the route re-rendering exactly zero times, and mounting anything new
in the route broke them — which reads as "the new feature dropped a tool call"
rather than "the mock does not behave like the store". The mock now memoises per
session id, reset per test.

**`preCommitHook.test.ts` computed the repository root as `cwd()/..`.** That is
right when vitest runs from `web-app/` and one level too high under
`yarn test:web`, which runs from the repository root; in a git worktree it lands
in the directory that holds every *other* worktree, so all eleven tests failed
on `ERR_MODULE_NOT_FOUND` for a path that was never going to exist. Anchored to
the test file's own location instead.

Full web suite after both: **5484 passed, 3 skipped, 0 failed** (400 files).

## 2026-09-10 — AH-045: the transcript stops carrying credentials

`redact_secrets` was named as though it covered everything and covered one
shape. It matched assignments (`API_KEY = "..."`), which is what configuration
looks like and almost never what *tool output* looks like: a `curl -v` trace, an
error quoting an `Authorization` header, a sentence naming a key. Those went
into the session transcript verbatim.

Worse, where `classify_line` *did* recognise a credential in prose, the answer
was `redact_line`, which replaces the whole line -- so the redaction destroyed
the sentence that said where the credential came from. The word-level pass now
runs first and replaces the credential in place; the line-level pass is the
fallback for the assignment shape, where the value need not look like anything
recognisable (`PASSWORD = hunter2` is a secret no shape rule can spot).

The renderer reaches it through a new `secrets_redact` command rather than a
TypeScript reimplementation. Two copies of a matching rule drift the first time
either is extended, and the copy that drifts is the one wearing the name.

**No fallback to the original.** When redaction cannot be confirmed -- the call
threw, or returned something that is not a string -- the text is withheld, not
stored. A fallback that persists the input on error persists exactly what this
exists to remove, on the branch least likely to be exercised.

One gate in the thread route: every `addToolOutput` call site goes through
`persistToolOutput`, and none bypasses it. The route test is mutation-checked --
replacing `redactDeep(part.output)` with `part.output` fails it, and it mocks
only the IPC hop, not the redaction module, so it fails if the route ever stops
routing output through it.

Evidence: 16 secrets tests (including one asserting ordinary build output comes
back byte-identical -- a redactor that eats normal text is one people switch
off), 10 wiring tests, 1 route test. 687 plugin tests pass.

Registry: AH-045 `in-progress` to `implemented` (86/36/88). Not `verified`: no
test covers the generic cancellation criterion here, and MCP output is redacted
at the renderer boundary rather than inside the MCP client.

## 2026-09-10 — AH-041: trust an MCP server, not a tool name

The registry said server trust lived in "renderer localStorage". Half stale:
`useToolApproval` persists through `backendStorage`, which writes Jan's
`settings.json`. The part that mattered was still true — the *decision* was made
in the renderer and `call_tool` checked nothing at all.

The acceptance criterion names the real problem: **policy keys on the MCP server
identity, not on a tool name a server can choose.** A tool name is published by
whoever wants to publish it, and `call_tool` with no `server_name` answers from
whichever connected server the search reaches first. So "trust `fetch`" is
"trust whoever got there first", and a second server can publish `fetch` and
inherit an answer the user gave about a different one.

`mcp_trust` (in the plugin crate, so its tests actually run on this host)
records trust per server, persisted with an atomic rename — a truncated trust
file reads as "nothing is trusted", which would re-prompt for every server the
user had already answered for. `call_tool` checks it **against the server the
tool was resolved on**, not the name the request carried, and checks it *before*
the arguments go out: a refusal that has already sent them has refused nothing.

"Allow once" is a single-use, short-lived ticket, never written to disk. An
answer of "just this once" that survived a restart would be a standing
permission nobody granted. A ticket is spent even when it does not match, so it
cannot be retried against server after server until one accepts it.

**Where it was put matters.** The first version of this module went in the main
crate, next to the MCP client. Its tests compiled and could not run — the `Jan`
lib test binary exits 0xc0000139 on this host. Moved to the plugin crate, whose
suite does run, and all 11 execute here. Policy belongs next to the rest of the
gate anyway.

**Scope, stated rather than implied.** This moves the persisted decision into
the backend and makes every call carry a backend-issued authorization. It is not
a defence against the renderer: the renderer is what asks the user, and it can
mint a ticket whenever it likes. What it stops is a server becoming trusted
without a recorded decision, a tool name standing in for a server identity, and
an "allow once" quietly becoming permanent.

Evidence: 11 unit tests, 1 route test (the call carries a backend-issued ticket
for the resolved server), 1 hook test (an "always" answer reaches the backend,
not just renderer state). 698 plugin tests pass.

Registry: AH-041 `in-progress` to `implemented` (87/35/88). Not `verified`: no
cancellation test on this path, and the Cowork/CLI path keeps its own separate
MCP gate (`SessionGrants::covers_mcp`) rather than sharing this one — worth
unifying, and deliberately not attempted in the same change as the gate itself.

## 2026-09-10 — AH-037: an exec grant means the command that was shown

`grant_command` recorded the *base commands* a shell string ran. So "allow
always" on `git status` granted `git`, and `git push` ran unprompted for the
rest of the session: the user was shown a question about reading and taken to
have answered one about publishing. Approving a compound was worse — `git status
&& rm foo` granted `rm`, so `rm bar` ran without a prompt, and the user had
never seen `rm bar`.

A grant is now the exact normalized command. Re-running the same command spelled
with different spacing is the same command; a changed flag, path or order is a
new decision. That closes the composition routes by construction rather than by
enumerating them: `&&`, `|`, `;` and `$(...)` all build a string nobody
approved.

**Desktop was never affected, and that was checked rather than assumed.** `bash`
is in `AGENT_TOOL_NAMES`, so the renderer auto-allows it and Rust gates it; the
renderer's per-thread approval is keyed on tool name and would otherwise have
been a worse instance of the same defect (approve one `bash` call, get every
`bash` call in the thread). It does not apply here. The grant lives on the
CLI/Cowork path, which is what changed.

Two existing tests asserted the old behaviour — `exec_grant_is_scoped_to_base_command`
asserted that `git push` *was* allowed after approving `git status`. They were
rewritten to the narrowed intent, keeping a comment about what they used to
claim, rather than quietly flipped or deleted.

Registry: AH-037 `in-progress` to `implemented` (88/34/88). Not `verified`: no
cancellation test on this path, and `cowork-smoke` does not drive the CLI prompt
flow, so there is no WebView scenario for it.

## 2026-09-10 — AH-078: why six designs failed, measured rather than guessed

The instruction was to stop designing and instrument `mutateLive` and
`commitTurns` in the running app. Doing that answered it in one run.

A probe recording every write to the live turn lane — where, length before and
after, and how many rows carried a snapshot — printed this for a real dispatch:

```text
mutateLive    len 1→1   carrying 0→0     <- the sink fires here
pushLive      len 1→2   carrying 0→0     <- the assistant row is created here
settleFilter  len 2→1   carrying 0→0
pushLive      len 1→2   carrying 0→0
```

**The write never attached at all.** `lengthBefore: 1` at the sink is the whole
finding: when a snapshot is taken the lane holds the *user* turn and nothing
else. The assistant row does not exist yet. Every design so far wrote the
reference from the sink onto "the last assistant turn", so every one of them
searched an array with no assistant turn in it, found nothing, and returned the
array unchanged. Nothing was lost between the ends, because nothing was ever
written.

They all passed vitest because a unit test hands the mutation an array that
already contains an assistant row. The app never does.

**One correction on the way.** The first probe watched `t.snapshot`; the field
is `promptSnapshot`, so its `carrying` counts were meaningless and only the
sequence was real. Re-run against the right field, with the attach moved to
where the row is born:

```text
pushLive      len 1→2   carrying 0→1     <- optimistic row stamped
settleFilter  len 2→1   carrying 1→0     <- that row is dropped
pushLive      len 1→2   carrying 0→1     <- settled row stamped, and survives
```

**The fix is one map in `pushLive`**: stamp `promptSnapshot` onto an assistant
row as it is added, from `lastSnapshotRef.current` — the dispatch that just went
out. Everything downstream was already built and waiting: `coworkTurns.ts`
emits a `data-prompt-snapshot` part for any turn carrying one. Only the attach
was in the wrong place.

The render prefers the message's own part and keeps the positional map as a
fallback for turns already on disk, written before rows carried one.

**Verified in the app, twice.** `cowork-smoke --only prompt-snapshot-panel`
passes — but it passed with ordinal matching too, so that alone proves nothing.
The mutation check is the evidence: with the positional fallback disabled
entirely, the panel still renders. The per-turn reference is doing the work.

That closes the open criterion — a continuation, a retry and a compaction each
carry their own snapshot, which position cannot express.

## Use `yarn typecheck`, not `tsc --noEmit -p tsconfig.json`

`f318081` was pushed with a broken production build. `tsc --noEmit -p
tsconfig.json` passed; `yarn build:web` did not, because a base-class stub in
`services/mcp/default.ts` took no parameters while the desktop override took
two. The repo typechecks with `tsc -b` (project references), which is what
`yarn typecheck` runs and what catches that. Fixed in the next commit. Use
`yarn typecheck` and `yarn build:web` before claiming either.
