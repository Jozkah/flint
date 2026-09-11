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

## 2026-09-10 — Batch A: staged patches (AH-146, AH-148 implemented; AH-147 in progress)

**The defect AH-148 names was live.** The Rust agent loop computes the diff
preview when it shows a permission prompt, then waits — for as long as the
person takes — and then calls `execute_builtin_with_diff` against whatever is on
disk *by then*. For `write` that meant an approval given against one version of
a file silently overwrote whatever an editor, a formatter or another agent had
written in the meantime. The person approved a change; they were not shown the
change that happened.

`patch::StagedPatch` holds the change as hunks plus a `BaseStamp` (FNV-1a hash
and length) of the content it was computed from. The loop stages when it asks,
keeps the stage until the answer arrives, and re-stamps the file before acting.
If it moved — changed, created or deleted underneath — the call is refused with
a message saying nothing was written, and nothing is. Refuse, not merge: a merge
would produce a file nobody reviewed.

**AH-146.** The prompt event gains `patch: Option<PatchView>` beside the text
diff: hunks with 1-based ranges, removed and added lines, and the base stamp.
Hunks are maximal runs of changed lines with no context merged in, so two
unrelated edits are two decisions. The replacement loop moved out of `edit`
into `apply_edits`, which both `edit` and staging call — one answer to "what
will this edit do", with a test asserting the written file equals the staged
proposal.

**AH-147 is not done, and the registry says so.** `StagedPatch::select` is
built and tested — rejected hunks leave the base untouched, an unknown hunk is
refused — but no person can yet choose hunks: `PermissionDecision` carries no
selection and the TUI prompt has no per-hunk controls. Moved from `missing` to
`in-progress` with that named as the gap. Next: `AllowSome(Vec<usize>)`, TUI
toggles, and the execution path writing `select(accepted)` after the base check.

**Where this applies.** The prompted path of the Rust agent loop — the CLI/TUI,
and Cowork runs that prompt. The desktop's renderer-driven built-in tools never
prompt (they are gated in Rust and refused rather than asked), so there is no
approval window there to guard.

Also corrected: the `SessionGrants` doc comment still described exec grants as
per base command, contradicting the AH-037 change. Rewritten.

Evidence: 12 patch tests, 3 handler integration tests; 713 plugin tests pass.
The loop wiring compiles on default, `cowork-smoke` and `cli`, and is not
executed here (the `Jan` lib test binary blocker). Registry: AH-146 and AH-148
`implemented`, AH-147 `in-progress`.

## The `cli` build was broken from `3c501f8` to this commit

The merge that reconciled AH-007 with `fork/main` left three
`agent_name: None` literals — this branch's pre-merge field, removed from
`OrchestrationArgs` in favour of upstream's `subject` — in code compiled only
under `--features cli`: `core/cli/mod.rs`, `core/cli/tui.rs`, and a
`#[cfg(feature = "cli")]` test helper in `core/agent/subagent.rs`. The
post-merge dedupe checked `loop.rs` and the default build, never the `cli`
build, so it went out green-looking and was not.

It surfaced here because Batch A's new `patch` field also had to reach four
cli-only test constructors in `tui.rs`, which meant running
`cargo check --tests --no-default-features --features cli` for the first time
since the merge. Both are fixed in this commit.

The rule this adds to the one about `yarn typecheck`: a change to a shared
struct is checked on **all three** configurations — default,
`--features cowork-smoke`, and `--no-default-features --features cli`, each with
`--tests` — before it is called compiled. Checking one and inferring the others
is how both this and `f318081` shipped broken.

## Corrections (2026-09-10, continuing from `e213b3c`)

**AH-146 and AH-148 are back to `in-progress`.** `e213b3c` marked them
`implemented` on the strength of a staged patch and a base check in the Rust
approval loop. Held to the completion standard now in force — persisted,
restart-safe, UI-accessible, permission-enforced, Windows-tested — they are not:
the patch is not stored as a versioned record before approval, approval does
not bind to an immutable patch hash and base-state hash, there is no desktop
review UI and no real-WebView scenario. Registry after this correction:
89 implemented / 35 in-progress / 86 missing.

**The `Jan` lib tests were never unrunnable.** Earlier entries in this file say
`cargo test -p Jan --lib` "exits 0xc0000139 on this host". Wrong diagnosis: that
is the `cowork-smoke` feature combination, whose unit-test harness gets no
Common-Controls v6 manifest — the limitation `build.rs` already documents. CI's
command, `cargo test --lib --no-default-features --features test-tauri`, runs:
786 passed before the run was stopped. Every "compiled, not executed here"
caveat written on that premise was unnecessary.

**A test I added hung the suite.** Running it for real exposed it:
`a_rule_naming_a_subagent_binds_that_subagent_and_nobody_else` left the main
agent's exec prompt unanswered and waited forever. Under CI's
`--test-threads=1` that stalls the whole Jan test job. It now answers the prompt
with Deny, bounds both halves with a timeout, and asserts *which* refusal came
back — policy for the reviewer, the user's Deny for the main agent. Another
session's `cargo test ... --test-threads=1` (PID 21452, not mine) was running
against this tree at the time and would have hit it; it was left alone.

## 2026-09-10 — `tool-activity-timeline` on Windows: five defects, found by tracing the send path

The previous obstruction entry said "no run happened at all" and stopped there.
This time the Cowork send path was instrumented at every transition, with only
step names, ids, counts and tool names recorded — never prompts, keys, memory
values or tool output — and each run's trace named the first transition that
did not happen. Four real defects were behind the one failing scenario, each
hiding the next.

**1. The model picker cleared the user's selection.** First trace:
`composer-send-clicked` → `composer-guard: no-selected-model`. The click reached
the composer; the composer's `selectedModel` was empty, so it set "Please select
a model" and returned. Cowork mounts `<DropdownModelProvider useLastUsedModel />`,
whose initializer effect depends on `providers` and therefore re-runs on every
provider change — a model-list refresh, a capability probe writing back through
`updateProvider`. Each re-run re-decided the selection, and whenever the model
was momentarily missing from an active provider's list it fell through to
`selectModelProvider('', '')`. The picker kept showing the model (that is local
display state), which is also why the smoke harness's own "is a model selected"
check passed. Fix: the initializer initialises and never overwrites an existing
selection. Regression test uses the real store; mutation-checked.

**2. Readiness withheld every file, memory and skill tool without a folder.**
Next trace: the run advertised `web_search, web_fetch, todo, ask, task, team` —
no built-ins — and the SDK refused `ls` as an unavailable tool. The traced
omission list named all fifteen, each `filesystem:workspace-unattached` or
`shell:workspace-unattached`. `probe_filesystem(None)` reported Unavailable, and
Filesystem is the only component granting `FS_READ`/`FS_WRITE`. The premise was
false: with no folder attached the desktop runs those tools in the
conversation's private workspace, and memory/skill tools use the permanent
store. **This regression is from the readiness gating added earlier in this
programme.** `probe_filesystem(None)` now reports that workspace as usable;
`probe_shell(None)` probes from the temp directory instead of refusing; the
Workspace component still says, truthfully, that no folder is attached. The test
that pinned the old behaviour was rewritten, and three regressions added at the
probe and `tool_availability` levels.

**3. The tool-schema cache was not keyed.** The same trace showed later calls
served `count: 0` from cache. `schemaCache` was one module-level list shared by
chat and Cowork, so whichever surface asked first decided the tool set for every
later caller. Now keyed by project root and reported component states.
Mutation-checked.

**4. The runner silently dropped an invalid tool call.** The AI SDK reports a
call to an unadvertised tool, or input that fails its schema, as
`tool-input-error`. `coworkRunner`'s stream `switch` ignored that part type, so
the step had no tool calls and the loop ended the run as `'done'` — nothing ran,
nothing was recorded, the model was never told, and a "running" row was left on
screen. An invalid call is now kept as a failed call: never dispatched, answered
to the model with the reason, recorded on the timeline as requested → refused.
Two regressions; mutation-checked.

**And one fixture gap, not a product defect.** With the above fixed, the
scenario reached its accounting assertion and failed there: the smoke mock never
honoured `stream_options.include_usage`, so it was the only provider that never
reported usage. Jan does request it (`includeUsage: true`) and real servers
answer. The mock now sends the usual final usage chunk when asked.

**Where the scenario now stands (mock provider, real Windows WebView).** The
scenario was extended to script two calls — `ls` that succeeds and `read` of a
missing file that fails — and to assert, after the run: both calls on the
durable record with the right phases; at least two items rendered; the items
survive a full reload; with "Hide completed tool activity" switched on in
Settings, the hidden-activity notice appears, the failed call stays visible and
fewer items are shown; the switch is put back; and the provider key appears in
none of `audit/tool-activity.jsonl`, `prompts.jsonl`, `payload-usage.jsonl` or
`permissions.jsonl`. The accounting assertion was moved to the end so it could
not mask the others.

On the first run every one of those assertions passed, and the run then failed
at the deferred check, **"the dispatched payload was never accounted for"**.

**5. No dispatch was ever given an invocation id, so AH-073 never recorded
anything.** `recordPayloadUsage` deliberately refuses to write a count that is
not bound to an invocation. The Rust transport takes the invocation from the
request's `invocationId` field — and nothing in the web app ever set it: the
dispatch identity headers carry session, run, thread, agent and provider, not an
invocation. Every snapshot therefore came back with `invocation: ""`, and every
usage record was dropped before it was written, on every surface, not only in
Cowork. `providerFetch` now names each model dispatch (`inv-…`, one per fetch,
so an SDK retry is correctly its own invocation) whenever it carries a session;
discovery and health requests are still not named. Three regressions in
`providerFetch.test.ts`; mutation-checked (removing the field fails two).

With that fixed, `cowork-smoke --only tool-activity-timeline` **passes on
Windows**: run created, both calls on the durable record with the right
phases, both rendered, surviving reload, Hide completed hiding the success and
keeping the failure, no key in any audit file, and the dispatched payload
accounted for with the provider's count.

**Real-model proof is blocked, externally.** Your brief requires the success
path against `http://v100:8555/v1` (`pxa-27b`). From this machine `v100` does
not resolve at all ("No such host is known"); Tailscale reports
"Tailscale is starting — unexpected state: NoState". That is machine network
configuration and was not touched. Every claim above is against the mock.

**Harness hygiene.** Failed runs were leaving `cowork-smoke.exe` processes alive
(four at once), which locked the next build with "Access is denied". Runs now
stop this worktree's own stranded harnesses afterwards, identified by path —
never any other Jan or WebView2 process.

## 2026-09-10 — Batch 2: one proposal record for patches, hunks, conflicts and worktrees (AH-146 / AH-147 / AH-148 / AH-107 / AH-109)

**The architecture.** A proposed change is one versioned record
(`tauri_plugin_agent_tools::proposal`, schema 1) from the moment an agent
produces it to the moment it lands, is rejected or is abandoned.

- *Immutable before approval.* Creating a proposal writes the exact base and
  proposed bytes of every file to a content-addressed, write-once blob store
  under `<data>/proposals/blobs/`, and the record to
  `<data>/proposals/<id>.json`. Nothing is regenerated later: what is applied
  is read back from the blobs, and a blob that no longer hashes to its name,
  or a record whose files no longer hash to its `patchHash`, is refused.
- *Approval binds identities.* An approval names the proposal id, its
  `patchHash`, its `baseStateHash`, its scope (session, run, agent, project,
  worktree) and the exact hunks chosen. Every field is compared with the stored
  record; any difference refuses. The renderer sends ids and hashes, never
  content, so it has no field in which to add a line.
- *The backend builds the result.* Selection, a three-way merge against the
  destination as it is now, and the writes all happen in Rust. Edits made in
  the destination since the proposal are preserved; a chosen hunk whose lines
  were also changed there is a conflict, reported by file and hunk id, and
  nothing is written. A hunk the destination already holds exactly is not a
  conflict (the second proposal from a worktree after a partial apply).
- *All or nothing.* Files are written through a temporary file and a rename;
  a failure part way puts back every file already written.
- *Never applied:* credential-shaped files (by name or content), paths outside
  the project, `.jan` and `.git`, and two spellings of one path.
- *Audit.* `audit/proposals.jsonl` records created / applied / conflict /
  refused / rolled-back / rejected with ids and hashes only — never content.

**Where proposals come from today.** A Cowork session in *Managed worktree*
mode writes only its Jan-owned worktree. `agent_proposal_from_worktree`
checks the record the renderer sends (inside Jan's worktree root, and still
`Ready` — same repository identity, same branch), reads every file the
worktree changed relative to its base commit (commits on its branch,
uncommitted edits, untracked files; Jan state excluded) and stores a proposal
whose destination is the worktree's recorded source. `agent_proposal_apply`
takes the destination from the *stored* proposal, never from the approval.

**The UI.** The Changes panel of a managed-worktree session shows a review
(`CoworkProposalReview`): *Review changes* creates the proposal; every file and
hunk is listed with a checkbox, credential-shaped files cannot be selected,
binary and oversized files are whole-file; *Apply selected* sends the
approval; a refusal shows its message and marks each conflicting hunk; *Reject*
discards the proposal with nothing written.

**Windows evidence.** `cowork-smoke --only proposal-review-apply` passes on
Windows, over real IPC into the real backend with real git (see the
verification document for exactly what it asserts). It found one real defect on
the way: the worktree-ownership check compared paths lexically, and the data
folder Jan resolves and the one the renderer is handed differ in form on
Windows, so a worktree Jan had just made was refused as "not a worktree Jan
manages". It now compares canonical paths.

**The boundary, stated plainly.** On Windows the review UI cannot be reached:
Managed worktree mode is disabled because AppContainer cannot yet confine a run
to a repository (`jail::supports_write_roots(Backend::AppContainer)` is false,
deliberately). So on Windows the backend is proven end to end and the UI only
by unit tests; on macOS/Linux the mode is available but was not run here.
Because the completion definition requires the UI to be reachable and
Windows-tested, **AH-146, AH-147, AH-148 and AH-109 stay `in-progress`**, with
their notes updated to what now exists. AH-107 is unchanged: the Rust
`dispatch_subagent` fan-out (headless CLI / API server) still shares one tree,
and team children's worktrees are not yet offered for review (their owner ids
are not recoverable from branch names, which are hashed).

**Next for this batch.** (1) Windows confinement for a Jan-owned worktree:
AppContainer write ACE on the worktree directory, with git metadata writes
handled (the worktree's `.git` file points into the source repository). That
single change makes the mode — and this review — reachable on Windows.
(2) Offer team children's worktrees for review from the team report, which
already names each child's worktree.

## 2026-09-10 — Batch 4: command palette (AH-206 implemented) and rebindable shortcuts (AH-207 in progress)

- **Palette.** `CommandPalette` is mounted once above every route and opened
  by `ShortcutAction.COMMAND_PALETTE` (Ctrl/Cmd+Shift+P; Shift because the
  unshifted chord is New Project). Entries are the app's own actions, routes,
  settings pages and conversations, ranked in memory with Fuse. Nothing is
  fetched.
- **Keybindings.** `useKeybindings` stores only overrides through the backend
  settings store (`keybindings` key) and is rehydrated with the other backend
  stores. `bind` refuses a chord any other command uses — rebindable or not,
  aliases included — and names it. While a new binding is being recorded,
  every app shortcut (`useHotkeys`, zoom, the sidebar's own Ctrl+B) stands
  down; the first Windows run showed why: Ctrl+N ran New Chat and navigated
  away instead of being reported as taken.
- **Also fixed on the way.** The sidebar component's hard-coded Ctrl+B toggled
  the sidebar even after the user moved Toggle Sidebar elsewhere; it now stands
  down when that action has an override.
- **Left.** The sidebar's New Chat hint shows the default chord, not the
  user's; a restart on Windows was not exercised (see the verification note).

## 2026-09-10 — Batch 5: hidden utility agents (AH-208 implemented); AH-209 not started

- **What changed.** `runUtilityAgent` is the one way Jan makes a model call for
  itself. Titling (`generateThreadTitle`) and compaction summaries
  (`compactMessages`) use it. It passes no tools and `toolChoice: 'none'`, and
  its request type has no field for a tool, grant or write root. Every call is
  recorded in `audit/utility-agents.jsonl` (kind, session, model, outcome,
  duration, token counts) through `utility_agent_record`.
- **Two leaks found and closed.** The title path logged the conversation
  excerpt's title and the raw model output to the webview console, which is
  written to the app log; it no longer logs either. And the first version of
  the backend sanitizer filtered disallowed characters out of a field, which
  turned `model\nsummary: the plan` into `modelsummarytheplan` — still the
  content. A field that is not an identifier is now refused whole.
- **AH-209 (project initialization assistant) is not started**: it depends on
  AH-204 (unified @ references), which is `missing`. While reading the current
  `@` path code for AH-204 I noted that a manually typed `@../x` or `@/abs`
  reference in chat resolves outside the working directory (the picker itself
  inserts a plain absolute path, not an `@` reference). The user typed it, so
  it is not an escalation, but AH-204's "nothing outside the folder is
  resolvable" criterion is not met today.
- **Sidebar hints follow rebinding.** The Search, New Chat and New Project
  hints in both sidebars now render the binding in force (`ShortcutHint`).

## 2026-09-10 — Batch 6: portable session export and import (AH-203)

- **Export.** A session's own menu has *Export session…*. The renderer builds a
  `jan.cowork-session` bundle (schema 1: turns with their tool states and
  questions, subagent runs, this session's durable tool activity, file
  activity, and the change summary). `session_export_save` drops folder,
  access, consent, continuity, code panel, run budget and messages, redacts
  credentials — named fields through the snapshot redactor **and prose through
  the text redactor** — and only then opens a save dialog *it* owns; the
  renderer never supplies a path, so the command is not a write-anywhere
  primitive. The toast reports how many credentials were left out.
- **Found on the way.** The snapshot redactor alone left
  `Authorization: Bearer …` typed into a turn untouched; it only knows
  credential-named fields. The export now runs every string through the text
  pass as well, and the unit test asserts both.
- **Import.** *Import session…* in the Cowork sidebar. `session_import_open`
  opens its own picker, caps the size, and refuses a document that is not an
  export or whose schema version it does not understand, by name. The store
  creates a new session under a fresh id, unbound like a fork, with pending
  questions marked stale and file activity re-keyed; `importedFrom` makes a
  second import of the same export a refusal that selects the session it
  became. Durable tool activity is carried in the file but not replayed into
  this machine's audit log, which records only what happened here; the tool
  turns carry their states.
- **AH-210 (PC-to-PC handoff)** builds on this and is not started.

## 2026-09-10 — Windows confinement for Jan-owned worktrees; undo by turn; confined `@` references

**Windows confinement for a managed worktree.** AppContainer already confined
the shell by granting a write ACE on the thread workspace. It refused to grant
one on the user's own folder, which is still right, but that refusal also made
Managed worktree mode unavailable on Windows, even though a managed worktree is
a folder Jan owns under its data folder. Now:

- `jail::supports_owned_write_roots` is true for AppContainer.
  `jail::can_confine_write_roots` holds a shell to its roots, and on
  AppContainer only when every root is strictly inside Jan's worktree folder.
  The helper re-exec carries each root as a marked `--write-root=` argument and
  grants each an ACE, refusing a missing root rather than skipping it.
- `grants::authorize` authorizes a Jan-owned worktree on Windows. The user's
  own folder is still refused, decided on the canonical path, so no spelling of
  a user folder passes as a worktree.
- A separate `managed_worktree_capability` command. The renderer asks about each
  mode separately, so Windows offers Managed worktree while still not offering
  Edit this folder.

**Bugs found on the way, all fixed with regression tests:**

- *Relative data folder.* The app's configured default data folder is `./data`.
  With a relative data folder, git resolved the worktree against the repository
  (inside it) and everything else resolved it against the process's working
  directory. Authorizing it then failed with "cannot find the file".
  `worktree::absolute` now resolves the root once, and the ensure/list/discard
  commands use it.
- *Leaked shell probes.* When a sandboxed shell probe passed its 10-second
  timeout it was reported unusable but never killed, because the child had been
  moved into the wait thread. Each hung probe left its helper and shell running
  for the life of the app. The first fix killed the tree with `taskkill /T`,
  and that regressed every Cowork run on this host. Bisected: a scenario that
  had passed earlier stalled before the model was called, and passed again with
  only the kill removed. The cause is that `taskkill` itself takes about a minute
  here and then fails ("the timeout period expired"), even against a plain
  `ping`, and the probe sits on the readiness check every run waits for.
  `wait_or_kill` now polls `try_wait` and kills the helper directly (the helper
  ties its shell to itself). The test checks the pid is gone through
  `OpenProcess`/`GetExitCodeProcess`, not `taskkill`.
- *`taskkill` itself, fixed later in this batch:* `proc::kill_tree` (the
  `taskkill /T /F` path) is also what stopping a background `bash` job uses,
  and on this host it took about a minute and then reported failure. It now
  walks the tree natively (see below).
- *Compatibility manifest ignored late inputs.* Saved subagent names and the
  advertised tools were read only when a scan finished. If they arrived after
  the scan, an imported agent reusing a saved name was never reported as a
  duplicate. Tightening one request's timing exposed this. The hook now
  re-resolves the last scan when those inputs change. Mutation-checked.

**AH-202 undo/redo by turn.** A backend journal (`undo.rs`) records the exact
bytes before and after every file a `write` or `edit` changes, against the run
that changed it. `execute_tool` gains `undo_run` and captures the bytes at the
path the handler itself resolves. `undo_turn`/`redo_turn` run all-or-nothing
with rollback. Any file changed since, by the user or a later turn, refuses the
whole operation and names the path. Scope is re-checked when the undo is asked
for: the session's workspace, scratch folder and live grant. The position is
per session, on disk. The Changes panel lists the turns with an Undo or Redo
button on each, and results are announced through `aria-live`.

**AH-204 containment.** In agent mode the `@` picker searched the user's home
directory and read references with the unconfined filesystem API, so
`@../x`, `@/abs` or `@C:\...\.ssh\id_rsa` put that file into the prompt. Now a
reference is a path relative to the attached folder (`referenceRoot`). It is
checked lexically (no absolute path, drive letter, UNC path, `~` or `..`) and
then by the backend's `project_browse` reader, which refuses symlink escapes and
credential-shaped files. A refused reference is stated in the message rather
than silently dropped. With no folder attached, nothing is offered and nothing
resolves. The unconfined `searchFiles`/`resolvePathReference` were removed.

**AH-146: the change is shown before it is allowed.** Cowork's *Ask before
changes* prompt showed a tool name and an argument table; the diff arrived only
after the write had landed. `preview_change` returns the diff a `write` or
`edit` would make -- the same `preview_diff` the executed call reports, against
the same path resolution -- and only inside the roots the session may write, so
a preview cannot be used to read a file no tool may read. The dispatcher hands
it to the prompt, which renders it as a named region above Allow Once. The
post-run diff and the prompt share one `ChangeDiff` component.

**Found by running the Windows scenarios, all fixed:**

- *The `@` picker never appeared in Cowork.* It was drawn only in chat "agent
  mode", which Cowork never is. Regression test added and mutation-checked.
- *The proposal commands froze the window.* `agent_proposal_from_worktree`,
  `list`, `apply` and `reject` were synchronous Tauri commands, which run on the
  main thread. During one run the WebView stopped answering for over a minute
  after *Review changes* was clicked. They now run on a blocking thread. The
  command itself takes ~150 ms on the fixture, so the length of that stall is
  not explained by the command alone; it did not recur after the change.
- *A file reference was read as a skill request.* `parseSkillRequests`
  counts `@name` as an explicit skill mention, so `@src/index.ts` requested a
  skill called `src` and `@README.md` requested one called `README.md`. Neither
  exists, so the request resolved as missing, and a missing requested skill
  stops every change the run would make. A mention that continues with a path
  separator, or contains a dot, is now a path unless a skill has exactly that
  name. Regression tests added.
- *Examples and integration tests missed a signature change.* `helper_args`
  gained its write-roots parameter, and `examples/sandbox_probe.rs` and
  `tests/windows_sandbox.rs` still passed the old five arguments. `--lib` runs
  never compile them; the full suite did.
- *A harness race.* Opening the Changes panel right after a navigation looked
  for its button once; it now waits. A pass on retry now prints what the first
  attempt hit, so a retry cannot hide a defect.
- *Open, not diagnosed: WebView stalls on this host.* Four runs of
  `restart-persist-1` in a row (and one each of `managed-worktree-review` and
  `session-export-import`) failed the same way: the model's turn finished and
  its write landed, but the composer never returned to idle, and later `eval`
  calls got no answer for 60 s. During one stall, the app and its WebView2
  processes were idle (under 0.1 s of CPU in 10 s), so this is a wait, not a
  busy loop. The next runs of the same scenarios passed cleanly, with no retry.
  The harness now reports what a stuck run is waiting on (the approval state,
  the composer's buttons, the pane text), so the next occurrence names the cause.
  Each of these runs also waited about 40 s for the environment check to probe
  shells that cannot start here.

**Windows evidence (mock provider on `v100:8080`; the real model lane is not
reachable from this host).** Each scenario was run by itself with
`cowork-smoke --only <name>`:

| Scenario | Result |
| --- | --- |
| `managed-worktree-review` | passed: Managed worktree and Ask before changes chosen in the UI, the prompt shows the write's diff, the worktree gets the write, the folder does not, one hunk of two applied through Review changes. The `bash` half is reported, not passed: no sandboxed shell starts on this host |
| `at-references-confined` | passed |
| `proposal-review-apply` | passed |
| `command-palette-keybindings` | passed |
| `session-export-import` | passed (the probe-kill regression is gone) |
| `restart-persist-1` then `restart-persist-2` | passed across two processes on one kept data folder: the rebound palette chord and the undone turn both came back, and redo after the restart restored the file |

**Registry.** AH-146, AH-147, AH-148, AH-202 and AH-207 are `implemented`
(macOS/Linux not run). AH-109 stays `in-progress`: team children's worktrees
are not offered for review. AH-204 stays `in-progress`: containment is done, but
the one ranked menu of files, folders, skills, agents and aliases, and
references that survive a rename, are not built.

**AH-204/AH-205: one `@` menu, and aliases.** The composer's `@` menu is a
single ranked list of files and folders in the attached folder, the folder's
skills, the saved agents, and the folder's aliases. Each row inserts its
identifier rather than its label: a folder-relative path, or a typed reference
(`@skill:name`, `@agent:name`, `@alias:name`). The prefix keeps a skill, an
agent and a file of the same name apart, and it is what `parseSkillRequests`,
the reference parser and the resolver key on. A skill reference stays in the
text for the skill machinery. An agent reference adds a note that tells the
model to use the `task` tool with that agent, or says that no such agent is
saved. An alias is replaced by the file it names, which is read through the
confined reader at use time. So an alias whose target has since escaped the
folder is refused, and a broken one reports the path it can no longer find.
Aliases belong to one folder and persist through the backend settings store.

The menu works from the keyboard alone. Focus stays in the composer, the
arrows move the active row through `aria-activedescendant`, Enter and Tab
insert it without sending, and Escape closes the menu. Alt+A opens a labelled
name field for the active file or folder, and closing that field returns focus
to the composer. A polite live region announces the match count and the
outcome of each alias save or refusal.

**Found on the way:** the first alias restart run failed because phase one
exited inside the settings debounce, before the write had left the WebView.
The app flushes on exit what it has received; it cannot flush what it was never
sent. The scenario now waits for the alias to reach `settings.json` before
exiting, as a person would.

A selection is named by giving the alias field a line range as well
(`src/a.ts:12-20`). It is read as those lines of the file as it is now, and a file
that has since shrunk below the range says which lines are missing.

**AH-209: describing a newly attached project.** A folder with no `JAN.md`
gets a *Describe this project* button beside the composer. The backend
`project_survey` walks the folder through the same confined listing and reader
the Code panel uses, so it honours `.gitignore`, skips dependency and build
output, drops symlinks that lead out of the folder, and refuses
credential-shaped files. It reads only the manifests and the README: it names
the project from `package.json`, `Cargo.toml`, `pyproject.toml` or `go.mod`,
takes the description from the manifest or the README's first paragraph, tallies
languages by extension, and describes the build from what the manifests declare.
It runs nothing. It stops after 200 folders, 4,000 entries or 4 levels, and
lists what it did not read. The draft opens in a dialog for editing and is kept
per folder in the backend settings store, so it survives closing the dialog and
restarting the app. `project_init_accept` is the only write. It writes
`<folder>/JAN.md`, only with the accepted text, by renaming a temporary file into
place, and refuses an existing file (unless asked to overwrite), a `JAN.md` that
is a link or a folder, and empty or oversized text. After the write, Cowork
reads the instructions again. A survey still running when the dialog closes is
dropped.

Found while running it on Windows, both fixed with regression tests:

- *A missing `JAN.md` was reported as unreadable.* The instruction probe
  treated a read failure as "absent" only when the message said "not found",
  "no such file" or "ENOENT". Windows reports "The system cannot find the file
  specified (os error 2)", so every folder without a `JAN.md` was shown as
  having one that could not be read, and the offer never appeared.
  `isMissingFileError` now recognises both forms.
- *The announcement of the write vanished with the offer.* Writing `JAN.md`
  removes the offer, and the live region was inside the removed element. The
  live region now stays mounted. Mutation-checked.

**AH-210: handing a session to another computer.** A session's menu has
*Hand off to another computer…*. It writes the AH-203 export, which uses the
same schema and the same credential redaction and drops the authority the
session held. It adds a `handoff` block. The block names the folder by its name,
branch and commit, never its path. It names the model by provider and id, and
nothing else sent under `handoff` survives, keys included. Every absolute path
that only means something on this machine is replaced by what it means: the
session's folder becomes `<folder>`, Jan's data folder becomes `<jan-data>`, and
the home folder becomes `~`. The file is written and read through dialogs the
backend owns. Nothing is uploaded, and no account or Jan service is involved.

Importing a handoff creates the session unbound, like any import. It then
states, item by item, what could not be restored:

- the folder to attach, which is checked against the recorded name, branch and
  commit once one is attached;
- a provider that is not set up on this machine;
- a model that its provider does not offer here.

The notice stays on the session until dismissed, including across a restart.
It is placed beside the composer and uses a polite live region.

**Stopping a process tree on Windows no longer goes through `taskkill`.**
`kill_tree` takes one process snapshot, then calls `TerminateProcess` on the
root and on every descendant. A process counts as a child only if it was created
after its recorded parent, because Windows recycles parent ids and an unrelated
process (another Jan window, a WebView) could otherwise be adopted and killed.
Stopping a background `bash` job and the shutdown reaper use it, and so does a
timed-out shell probe. The probe used to kill only its helper, so the helper's
shell stayed running. On this host, the five job-registry tests and two
`kill_tree` tests that failed with "the timeout period expired" now pass in a
fraction of a second. New tests cover a grandchild killed with its parent, an
unrelated process left running, and a probe's shell killed with the probe. The
tree-kill tests were mutation-checked: with descendants skipped, they fail.

**Test-invocation note.** `cargo test -p tauri-plugin-agent-tools --lib` does
not build the `jan-sandbox-helper` binary, so the sandboxed-shell probe
re-executes the test binary, which exits with code 101. Seven `bash` tests then
fail with "no shell could be started". Run the suite without `--lib`.

## 2026-09-11 — AH-109 team-child review, AH-107 per-agent worktrees, and four defects the Windows scenario found

**What changed.**

- **Team children are recorded, listed and reviewed.** `core/agent/team_children.rs`
  records each isolated team child before it runs and settles it when it ends.
  The record names the child by parent session and task id. Its worktree,
  branch and base commit are found from Git. When the child settles, the
  record stores a fingerprint of what the child changed. The first ending is
  the one kept, and a record still `running` from another process reads as
  `interrupted`. The Changes panel lists the children (`CoworkTeamReviews`)
  with task, branch, base, worktree, files, counts and ending. A child's
  review is the ordinary proposal review, made by `agent_team_child_propose`
  from the backend record, so there is no second apply path. These are typed
  refusals, never an empty review:
  - a deleted, corrupt or moved worktree;
  - a worktree that holds a link out of itself;
  - a worktree that changed after its child finished;
  - a child that did not finish. Its changes can be reviewed only after the
    user acknowledges this, and the proposal's subject then says so.
- **Overlaps are decided before anything runs.** Team tasks declare `writes`,
  `deletes`, `renames` and `reads`. `scopeConflicts` finds these overlaps
  between tasks that could run at once:
  - the same file, compared normalised and case-folded;
  - a folder and something inside it;
  - either end of a move;
  - a delete;
  - a lock file both tasks would regenerate.

  Reads never conflict, and neither do ordered tasks. The user sees each
  overlap (`CoworkTeamConflicts`) before any worktree is provisioned. They can
  run the tasks one after the other, which adds an ordering-only `after` edge,
  narrow a scope, or let the tasks run side by side. The side-by-side choice
  is recorded on both children's records, and the apply-time check still runs.
  `runTeam` refuses any overlap nobody decided. This is declared-path overlap,
  not semantic conflict detection, and the dialog says so.
- **Paths are hardened on both ends of a proposal.**
  - A changed path in any worktree that passes through a symlink, junction or
    other reparse point refuses the proposal.
  - Nested `.git` and `.jan` directories are never proposed.
  - Windows spellings are refused on every platform: `.git.`, device names,
    streams, and trailing dots or spaces.
  - Immediately before writing, each destination path is re-checked for a link
    anywhere along it, so a directory swapped for a junction after review is
    refused with nothing written.
- **AH-107: the Rust subagent runner isolates writing children.** In a git
  project, a child that can change files works in a Jan-owned worktree by
  default. Its `project_root` is re-pointed there, so its tools, write roots
  and shell all start in the worktree. `isolate: false` is the only way for a
  writing child to share the project tree. Isolation that cannot be had is
  `SubagentError::Isolation`, and the child does not start. The parent is told
  where the work is.

**Defects found by the Windows scenario, each fixed with a test that fails on
the old code:**

1. **A child's approval prompt could never appear.** The prompt is drawn under
   a tool card in the transcript, and a child's calls are not message parts.
   Before the fix, a child's prompt showed only when its call id happened to
   match a parent card: the mock numbers calls per response, so the first call
   matched and the second did not. Otherwise the child waited forever. Child
   requests now carry their origin and are shown on their own
   (`CoworkChildApprovals`).
2. **Two requests with one call id overwrote each other.** The earlier promise
   never resolved. Requests now queue by id and are shown in turn
   (`useToolApprovalRequests.sameId.test.ts`, which hangs on the old code).
3. **A reply cut off mid-stream counted as a success.** The AI SDK ends a
   dropped stream with a normal `finish` part: `finishReason: 'other'` and no
   `rawFinishReason`, measured against the mock. A team child cut off after
   one word was recorded as completed. `streamCutOff` flags this case, and
   `consumeStep` turns it into an error, for the parent and for children
   (`coworkStreamCutOff.test.ts`).
4. **A first message that only describes work** gets a read-only proposal, by
   design. This is not a defect. The scenario now sends an imperative.

**The sandboxed shell on this host.** The diagnosis comes from
`examples/shell_report.rs` in the plugin, which calls the production
`shell_reports` and `select_shell` and prints what each returns.

- Git Bash and MSYS2 bash fail with `STATUS_DLL_INIT_FAILED`. Their runtime
  cannot initialise in an AppContainer, whatever the install location. This is
  external and has no repository-side fix that keeps confinement.
- PowerShell starts inside the sandbox, probed in about 0.3 s, and is
  selected. The result is the same with the full app binary as the helper.
- **The defect was in the repository.** A Cowork run builds its tool list by
  asking readiness with no project root. With no root, the shell probe used
  the temporary directory itself as the sandbox's workspace. The AppContainer
  grants a workspace by rewriting its ACL, and for all of `%TEMP%` that takes
  longer than the probe's ten seconds. Every candidate therefore "failed to
  start", and `bash` was withheld from every Cowork run, while the same probe
  scoped to a folder found PowerShell in a third of a second. The in-app
  evidence, from `cowork-smoke`: with the project root, `bash` is advertised;
  with no root, it is withheld with "No shell on this machine could be started
  inside the sandbox".
- **The fix** makes the unattached probe run in an empty `jan-shell-probe`
  directory of Jan's own under the temporary directory. Confinement is
  unchanged. The regression test
  `readiness::tests::an_unattached_session_finds_the_shell_a_folder_would`
  failed on the old code on this host: no-folder unavailable versus folder
  Degraded, with the readiness suite taking 81 s. It passes with the fix, in
  1.6 s for the suite.

- **Two more defects appeared once a shell started in the app.** Each is fixed
  with a test that fails on the old code:
  - *Relative sandbox paths.* Jan's data folder defaults to the relative
    `./data`. The confined helper starts in the workspace, so a relative
    workspace named somewhere else, and every command failed in setup with
    "workspace does not exist". `bash` now makes every path it hands the
    sandbox absolute:
    `handlers::tests::a_sandboxed_command_runs_in_a_relatively_spelled_workspace`.
  - *PowerShell's starting location.* Inside an AppContainer, Windows
    PowerShell starts at a drive root the container can see (`G:\` here),
    not the workspace, so a relative path in a command landed elsewhere.
    `Set-Location` into the workspace is refused with "Access is denied",
    because PowerShell checks each ancestor. The command now mounts the
    workspace as its own drive and starts there:
    `handlers::tests::a_sandboxed_command_starts_in_its_workspace`.

New Windows integration tests in `tests/windows_sandbox.rs`:

- the selected shell writes a Jan-owned worktree granted as a write root, and
  is refused on the user's checkout beside it;
- a sandboxed command stopped part-way leaves no helper, shell or grandchild
  running.

**The composer-busy stall.** The harness now asks the app's main thread
directly when an eval times out:

- Before the change, two stalls (r29, r31) read "the app's main thread is
  answering; the page is not". The renderer had stopped running scripts while
  the app, with idle CPU, was fine.
- That fits Chromium backgrounding an occluded WebView, which throttles its
  timers.

The harness now starts WebView2 with occlusion and background throttling
disabled (`COWORK_SMOKE_THROTTLE=1` keeps the default). Runs r32 to r36 had no
eval timeouts. Retries are off by default (`COWORK_SMOKE_RETRIES=<n>` to
allow them), so a flaky pass cannot hide.

**The stall is not closed.** It came back twice with throttling disabled: in
r39 (`managed-worktree-review`) and r43 (`team-review-persist-1`), both at
the click that applies a proposal. Each time the main thread answered, and
WebView2's renderer used 0.00 s of CPU across the sample, so the page was
idle rather than busy: it was not running a script loop. No app state was
found that stays busy, so there is no race to fix yet and no deterministic
test. The harness now saves a screen capture (PNG) when an eval times out,
for the next occurrence. Round r44 passed every scenario on the first
attempt with retries off. Whether the cause is external is not proven, so
the defect stays open.

**Other harness changes.**

- `cowork-smoke` builds now run at idle priority with one cargo job, and
  vitest runs with one or two workers.
- The mock provider gained per-request `routes`. Each child's first user
  message selects its behaviour, and `{{FOLDER}}` becomes the folder named in
  its system prompt.

## 2026-09-11 — Review of `1e925e397`: four defects in the AH-109 batch, fixed

An adversarial review of the AH-109/AH-107 commit found four defects. Each was
reproduced, then fixed with a test, and each test fails with its fix reverted.

1. **`GIT~1` got past the `.git` refusal (high).** NTFS gives `.git` the
   8.3 short name `GIT~1`, and opens the directory by either name. A child
   could create `GIT~1/hooks/pre-commit` in its worktree. The proposal
   refused `.git` only by its long spelling, so applying it would have
   written the user's Git hook. Two fixes:
   - `proposal::is_reserved_name` refuses every `git~N` and `jan~N`, the rule
     Git itself uses. `proposals::is_jan_state` uses the same function.
   - At apply time, `plan` resolves the deepest existing part of each
     destination and refuses any write whose real location is inside the
     folder's `.git` or `.jan` (`proposal::resolves_into_reserved`). This
     still holds if a new alias turns up.

   Tests: `a_path_windows_would_read_differently_is_refused` (spellings) and
   `a_short_name_for_git_is_refused_by_where_it_resolves` (Windows, measured
   against a real `GIT~1`).
2. **Typographic quotes broke out of the PowerShell prefix (medium).**
   PowerShell also ends a single-quoted string on U+2018 to U+201B. With a
   workspace named `Bob’s project`, every command failed to parse, and a
   folder named to close the literal could run a command nobody approved.
   `proc::ps_literal` now doubles all five. Tests:
   `every_quote_powershell_honours_is_doubled`, and
   `a_folder_named_to_close_the_literal_runs_nothing`, which runs real
   PowerShell in a folder named `Bob’; Write-Output INJECTED; ’x`.
3. **A second click could answer the next approval unread (medium).** When
   two requests shared a call id, answering the first put the second under the
   same buttons, so a double-click approved a diff that was never on screen.
   Three fixes:
   - Every request has its own `requestId`, and an answer names it. A second
     answer for a request that is already gone does nothing.
   - Answer buttons pause for 600 ms when the request under them changes
     (`useArmedAfterChange`).
   - `CoworkChildApprovals` also shows a child's request that waits, queued,
     behind another session's request under the same id.

   Tests: `useToolApprovalRequests.sameId.test.ts` and
   `CoworkChildApprovals.test.tsx`.
4. **Racing settles could relabel a child (low).** A run's teardown settles
   its children as cancelled on a thread of its own. With no lock between a
   settle's read and its write, the later write won, and a completed child
   could become cancelled. The temporary file name was shared too. Reads and
   writes of a child's record are now serialised, and each temporary file
   name is unique. Test: `racing_settles_agree_on_one_ending`, which failed
   three runs out of three without the lock.

## 2026-09-11 — AH-079 context replay, and two harness defects

**AH-079.** A prompt snapshot's panel now has "Replay this context". The
backend (`core/agent/replay.rs`) hands out the stored request and keeps the
record. The renderer (`lib/contextReplay.ts`) sends the request unchanged to
the provider the turn used, and reports how it ended. The transport's own
snapshot of the replay dispatch is compared with the original by hash, so
"same context" is checked on the record. Refusals are typed and kept:

- redacted, unavailable, foreign or missing snapshots;
- a provider that is gone, or speaks Anthropic;
- a local model that is not running.

A replay left running when Jan stops reads as interrupted after a restart.
Tool calls in a replay's reply are recorded and never run. Details:
`AGENT_HARNESS_ARCHITECTURE.md` AHD-009 and the verification section.

**An AH-078 defect found on the way.** Snapshot ids came from a counter that
restarted at `snap-1` in every launch, so an id could name an earlier launch's
record, and the timeline could show the wrong payload. Ids now carry the
launch. `an_id_from_an_earlier_launch_is_never_issued_again` fails on the old
scheme.

**Harness: a script that does not parse read as a stalled page.** The first
two runs of `context-replay-1` "stalled" at the same step. The cause was the
scenario's own script, which declared `const p` twice. That made the whole
injected script a syntax error, so nothing ran and nothing replied, which is
exactly what a stalled page looks like. The eval body is now compiled inside
the `try`, so a body that does not parse is reported as an error. The r39
and r43 stalls are not explained by this: the same scripts passed in other
runs.

**Harness: the stall diagnostic captured the whole desktop.** The screen
capture added in the AH-109 batch (`1e925e397`) recorded every monitor,
including unrelated windows. It is removed, and the one capture it had taken
was deleted. The diagnostic now reports the app window's visibility,
minimised and focused state, position, size and monitor instead.

**Harness: `prompt-snapshot-panel` read the prompt log once.** It checked the
log straight after clicking send, racing the transport's write, and failed
with "0 records" when the check came first. It now polls for up to 60 s.

Scenario results on Windows with the mock provider:

- `context-replay-1/2`, `prompt-snapshot-panel`, `prompt-snapshot-cross-session-refused`;
- `team-review-persist-1/2`, `managed-worktree-review`, `proposal-review-apply`;
- `app-startup`.

All passed on their first attempt with retries off (rounds rg2 and rp4). In
round rg1, another process emptied this session's scratch directory
mid-run, taking the logs with it. That round is not counted.

## 2026-09-11 — AH-154/155/156: dependency, lock file and migration flags

A proposed change can now say more than its diff:

- a manifest's dependencies were added, changed or removed, each one named;
- a lock file changed; lock files are listed apart from source changes;
- a migration will change a database in a way that reverting the file does
  not undo.

`review_flags.rs` works these out in the backend. `plan` works them out again
from the stored content when the change is applied. A flagged file is written
only when the approval acknowledges that exact path, so neither a renderer nor
a record edited on disk can drop a flag. The review holds Apply, naming the
files, until each flagged file that is selected has been ticked as reviewed.
Coverage and the one thing not run through the UI are listed in the
verification section.

Environment note: during this work another process ran `yarn install` in the
main checkout. It moved the web dependencies from the repository root into
`jan/web-app/node_modules`, and this worktree could no longer find
`@vitejs/plugin-react`. A junction to that folder was tried and removed: it
resolved the workspace packages (`@janhq/core` and the plugin APIs) to the
main checkout's older copies. The worktree now has its own install
(`yarn install --immutable`; `yarn.lock` unchanged). Nothing in the main
checkout was changed. Gates after the install:

- web typecheck ok; 5771 + 171 + 320 tests; `build:web` ok;
- app `core::agent` 403, plugin 795 plus 13 Windows sandbox tests, `cli` check ok;
- Windows scenarios passed: `proposal-flags`, `proposal-review-apply`,
  `team-review-persist-1/2`, `context-replay-1/2`, `managed-worktree-review`
  and `prompt-snapshot-panel`.

One part of the finding is left open. A tool card in one conversation can
show another conversation's request only when both conversations' main agents
wait on the same call id at the same moment. The card shows that request's own
diff, and the answer names that request.
