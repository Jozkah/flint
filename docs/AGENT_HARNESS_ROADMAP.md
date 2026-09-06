# Agent harness roadmap

Delivery plan for the 200-item backlog in
[`AGENT_HARNESS_FEATURE_REGISTRY.md`](./AGENT_HARNESS_FEATURE_REGISTRY.md).
Status counts in this document are a snapshot; the registry is authoritative.

## Starting position

Statuses come from auditing the tree, not from assumption. The first audit ran
against `adfd071` and was 282 commits stale by the time it was written up; it
was redone against the current head before anything was committed, and 26 items
moved as a result -- checkpoints, managed worktrees, team task coordination,
compatibility ingestion and dispatched-payload measurement had all landed in the
interval. The registry's `auditNote` fields carry the evidence per item.

The harness is substantial: roughly 35k lines across `core/agent/` and the tools
plugin, 33 Cowork modules in `web-app/src/lib/`, and 1,810 Rust tests. The
backlog is therefore mostly *completion and consolidation*, not greenfield work:

| Status | Count |
| --- | --- |
| `implemented` (exists, verification outstanding) | 57 |
| `in-progress` (partial, does not meet acceptance criteria) | 51 |
| `missing` | 92 |
| `verified` | 0 |

| Phase | Theme | `missing` | `in-progress` | `implemented` |
| --- | --- | --- | --- | --- |
| 0 | Foundation | 0 | 2 | 10 |
| 1 | Core execution | 3 | 9 | 8 |
| 2 | Security and permissions | 5 | 9 | 6 |
| 3 | Repository intelligence | 18 | 2 | 0 |
| 4 | Context and memory | 6 | 7 | 3 |
| 5 | Agent orchestration | 8 | 6 | 11 |
| 6 | Compatibility and integrations | 11 | 6 | 15 |
| 7 | Coding and Git workflows | 23 | 2 | 1 |
| 8 | UX, automation and operations | 18 | 8 | 3 |

Two domains remain effectively unbuilt: repository intelligence (18 of 20
missing -- the new repository map is an orientation blob, not an index; no LSP,
no symbols, no diagnostics) and Git/PR workflows (23 of 26 missing -- there is
no agent-facing git tool, so the model reaches git only through `bash`).

The delta audit also found an asymmetry worth stating plainly, because it sets
the priority for Phases 1 and 2. The last 282 commits invested heavily in
*containment and authority* -- worktree isolation, MCP confinement, write
grants, shell confinement -- and almost nothing in *observability and control*:
there is still no persisted event log, no run id, no error taxonomy, no hooks,
no loop detection and no hard budget. The harness can now isolate a run well,
but it cannot reconstruct what one did afterwards, and nothing except user
cancellation bounds its spend.

## Phase order and rationale

Phases run in dependency order. A phase opens only when every dependency of its
`P0` items is `implemented` or better.

| Phase | Theme | Items | Why it is here |
| --- | --- | --- | --- |
| 0 | Foundation | `AH-001`..`AH-012` | Identity, events, errors and state schema are cited by every later phase. Nothing else can be correlated, audited or replayed until they exist. |
| 1 | Core execution | `AH-013`..`AH-032` | Budgets, timeouts and loop-detection are the containment story for unattended runs. Today budgets are advisory and an unattended run has no hard ceiling. |
| 2 | Security and permissions | `AH-033`..`AH-052` | The resource-matching redesign (AHD-005) unblocks five separate gaps. Highest security impact in the backlog. |
| 3 | Repository intelligence | `AH-053`..`AH-072` | Independent of 1 and 2 once the state schema exists, so it can run in parallel from Phase 1 onward. |
| 4 | Context and memory | `AH-073`..`AH-088` | Gated on prompt snapshots (`AH-078`), which is gated on the Phase 0 state schema. |
| 5 | Agent orchestration | `AH-089`..`AH-113` | Gated on worktree conventions (`AH-012`); concurrency must not increase before isolation exists (AHD-008). |
| 6 | Compatibility and integrations | `AH-114`..`AH-145` | Hooks and MCP completeness depend on the canonical event model from Phase 0. |
| 7 | Coding and Git workflows | `AH-146`..`AH-171` | Depends on Phase 2 (a git tool needs destructive-operation gating) and Phase 5 (worktrees). |
| 8 | UX, automation and operations | `AH-172`..`AH-200` | Consumes the canonical event stream; largely a rendering and export layer over earlier phases. |

Phases 3 and 6 are the natural parallel lanes: neither writes to the modules
Phases 1, 2, 4 or 5 own.

## Critical path

The longest dependency chain in the registry, and the one that determines how
early the high-value work can start:

```
AH-003 architecture decisions
  -> AH-010 persistent state schema
       -> AH-078 prompt snapshots
            -> AH-079 context replay, AH-086 context diffing, AH-100 forked contexts
  -> AH-004 canonical event model
       -> AH-005 event serialization and versioning
            -> AH-032 run replay, AH-049 permission audit log, AH-177 event export
                 -> AH-183 headless event stream -> AH-184 webhooks
                 -> AH-200 full audit export
  -> AH-012 worktree conventions
       -> AH-107 per-agent worktrees
            -> AH-108 lifecycle -> AH-109 conflict-aware merge -> AH-165 conflict resolution
            -> AH-168 worktree export -> AH-169 worktree apply
```

`AH-005`, `AH-010`, `AH-012` and `AH-078` are the four items with the largest
downstream fan-out. Three of the four are Phase 0.

## Entry and exit criteria

A phase **opens** when: every `P0` dependency is `implemented` or better; the
owning lane has exclusive file ownership recorded in the architecture document;
and the verification plan names the commands that will prove the phase.

A phase **closes** when every item in it is `verified`, or carries a
`platform-blocked` / `rejected-with-decision` record the user has approved. The
closing report states: features completed, still missing, blocked; exact commits;
tests run; tests *not* run and why; files owned by each lane; and the next
dependency-ready phase.

An item reaches `verified` only against the twelve acceptance rules -- production
implementation, real call-site wiring, success path, refusal path,
cancellation/race behaviour, persistence across restart where applicable, unit
tests, integration tests, route/UI tests where applicable, security or mutation
tests where authority is involved, documentation, and a registry update. A type,
a button, a config parser or a mock does not make an item complete.

## Parallelism rules

- One lane per agent, with exclusive file ownership (AHD-012).
- Each agent works in its own git worktree; two agents never edit one file.
- Cross-boundary changes are made by the owning lane and consumed by the other.
- `lane-12-security-regression-review` owns no production module and reviews every
  lane's output independently.

## Phase 1 status (in progress)

Nine commits on `feat/agent-harness-phase-1`. What moved, and what did not:

| Item | Status | What landed |
| --- | --- | --- |
| `AH-017` Token budget enforcement | `implemented` | Crossing ends the run; `on_exhausted = "continue"` is the opt-out |
| `AH-019` Wall-clock budget | `implemented` | `[budget] max_duration_secs`, checked before the turn that would cross it |
| `AH-020` Per-tool timeouts | `implemented` | Every built-in, by capability class, on both dispatch paths |
| `AH-021` Per-run timeout | `implemented` | Subagents inherit what is left, so a child cannot outlive the run |
| `AH-029` Stuck-loop detection | `implemented` | A turn identical to the last is no progress; nudge then stop |
| `AH-030` Doom-loop detection | `implemented` | Fingerprinted by name and canonicalised arguments |
| `AH-032` Run replay | `implemented` | `jan cli agent runs show` |
| `AH-049` Permission decision audit log | `implemented` | Auto-approval included -- previously untraceable |
| `AH-050` Tool invocation audit log | `implemented` | Per-call durations, redacted resources, never raw arguments |
| `AH-177` Event export | `implemented` | `jan cli agent runs export`, round-trips into the same types |
| `AH-004`/`AH-005`/`AH-008`/`AH-010` | `implemented` | Now consumed by real call sites, not just defined |
| `AH-018` Step budget | `in-progress` | Configurable; the default stays unbounded, which its criterion does not accept |
| `AH-023` In-flight cancellation | `in-progress` | Hangs bounded, CLI process leak closed; no cancellation token yet |
| `AH-026` Resume after restart | `in-progress` | Interruption detectable and diagnosable; resumption not built |
| `AH-045` Secret redaction | `in-progress` | Event log only; transcripts and tool output still unredacted |
| `AH-110` Agent provenance | `in-progress` | Events carry their agent; file changes do not |

Three items are deliberately short of their own acceptance criteria rather than
marked done at a weaker standard:

- **`AH-018`** asks for a turn ceiling enforced by default. The mechanism is
  built and configurable, but the default stays unbounded: the config states
  that the agent takes as many turns as the task needs, and the token and
  wall-clock ceilings now bound a run that will not end. Choosing a non-zero
  default would cut off legitimate long tasks, which is a product decision.
- **`AH-023`** asks for a cancelled run to kill the processes its tools
  started. Every deterministic exit now reaps, and foreground children die on
  drop, but there is no cancellation token and a signal-terminated CLI still
  leaks -- agent shells sit outside the terminal's process group by design.
- **`AH-026`** asks for a run to resume without losing the in-flight turn. An
  interrupted run is now detectable and reports which calls were dispatched
  with no recorded outcome; resuming from that point is not built.

One behaviour change is worth restating outside the pull request: a configured
token budget now stops a run, and every CLI run carries the 128k default, so it
binds where it previously did not.

## Phase 0 status

Delivered in this pass:

| Item | Status | Evidence |
| --- | --- | --- |
| `AH-001` Feature registry | `implemented` | `docs/agent-harness-features.json`, rendered registry |
| `AH-002` Registry validation | `implemented` | `scripts/agent-harness/`, 26 passing tests |
| `AH-003` Architecture decisions | `implemented` | `docs/AGENT_HARNESS_ARCHITECTURE.md`, AHD-001..AHD-012 |
| `AH-004` Canonical event model | `implemented` | `src-tauri/harness/src/event.rs` |
| `AH-005` Event serialization and versioning | `implemented` | `src-tauri/harness/src/envelope.rs` |
| `AH-008` Run and session identity | `implemented` | `src-tauri/harness/src/identity.rs` |
| `AH-009` Error taxonomy | `implemented` | `src-tauri/harness/src/error.rs` |
| `AH-010` Persistent state schema | `implemented` | `src-tauri/harness/src/state.rs` |
| `AH-011` Test fixture library | `implemented` | `src-tauri/harness/src/fixtures.rs` |
| `AH-012` Worktree conventions | `implemented` | `src-tauri/src/core/agent/worktree.rs` (pre-existing), AHD-008 |
| `AH-006` Capability model | `in-progress` | Extending to MCP tools is Phase 2 work under `AH-041` |
| `AH-007` Permission model core | `in-progress` | The resource-matching redesign is Phase 2 work under `AH-034` |

`AH-012` is satisfied by the managed-worktree module already on this branch
rather than by new code: a second naming convention in a foundation crate would
be the exact drift AHD-008 forbids. What remains -- extending it from
per-session to per-agent -- is tracked as `AH-107`.

`AH-006` and `AH-007` stay `in-progress` deliberately: their remaining work is the
Phase 2 redesign, and moving them would mean claiming a design that has not been
built. They do not block Phase 1.

None of the Phase 0 items are `verified` yet. They become `verified` when the
consuming modules are migrated onto them in Phases 1 and 2 -- an unconsumed model
has no call-site wiring, and call-site wiring is acceptance rule 2.
