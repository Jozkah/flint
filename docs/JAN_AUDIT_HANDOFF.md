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
