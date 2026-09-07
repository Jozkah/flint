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

