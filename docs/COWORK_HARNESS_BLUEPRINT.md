# Cowork coding-harness blueprint (Phase 0)

Baseline: `origin/main` at `bdbf078`, merged into
`feat/cowork-background-tasks`. Scope: architecture, ownership, boundaries and
per-phase exit criteria for the remaining Cowork coding-harness work. **No
production code is changed by this document.**

> **Correction.** The first version of this document analysed `adfd071`, the
> branch's own baseline, and concluded that four premises of the epic did not
> hold. `main` was 79 commits ahead at the time, and on `main` they do hold:
> the access-mode axis, direct-edit consent, compatibility-file detection,
> Cowork MCP and `scripts/cowork-compat-smoke.sh` all exist there. That earlier
> reading was right about the branch and wrong about the product. Everything
> below is re-verified against the merged tree. Section 1.3 now records what
> the real gap is in each area, which in several cases is narrower and more
> precisely located than either the epic or the first draft assumed.

---

## Status

| Phase | State |
|---|---|
| 1 — managed worktree enforcement | **Built.** `core/agent/worktree.rs`, grant names the worktree, capability follows the backend. |
| 2 — context measurement | **Built.** Measured from the run's own payload; per-category breakdown. |
| 3 — first-turn inspect → propose | **Built.** Classifier widens only; review mode is the enforcement. |
| 4 — compatibility ingestion | Largely pre-existing on `main`; the envelope is now sealed so ingested text cannot escape it. |
| 5 — coordinated agent teams | **Built and wired.** `lib/coworkTeam.ts` + a `team` tool dispatching through the real subagent runner. |
| 6 — checkpoints and rewind | **Built.** `core/agent/checkpoint.rs`; a managed tree restores, a user's checkout gets a patch. |
| 7 — parity UX review | **Smoke harness extended** and now runs off macOS. |
| 8 — verification and platform evidence | Largely pre-existing (5.8); blocked on runners (6.3). |

Each built phase turned out smaller than this document first estimated, and
always for the same reason: `main` already carried the types, the vocabulary and
the refusal paths, and what was missing was the layer underneath them. The
estimates below are left as written rather than revised after the fact, so the
gap between them and what the work took stays visible.

## 0. How to read this

Section 1 records what is in the merged tree, with references. Sections 2-4 map
architecture and security boundaries. Section 5 is the per-phase blueprint.
Section 6 covers verification and what this environment can and cannot prove.
Section 7 recommends a sequence.

Everything asserted here was read out of the merged tree or observed from a
command run against it. Where something could not be verified in this
environment, it says so.

---

## 1. Baseline

### 1.1 There are two agent harnesses, not one

| | Rust harness | Cowork harness |
|---|---|---|
| Location | `src-tauri/src/core/agent/*.rs` | `web-app/src/lib/cowork*.ts` |
| Drives | the CLI / TUI | the Cowork desktop route |
| Owns the loop | `core/agent/loop.rs` | `lib/coworkRunner.ts` |
| Compaction | `core/agent/compaction.rs` | none |
| Subagents | `core/agent/subagent.rs` | `lib/coworkSubagent.ts` |

They share one substrate: `src-tauri/plugins/tauri-plugin-agent-tools`, which
provides the file/shell tools, the path jail, the three OS sandbox backends
(bubblewrap / Seatbelt / AppContainer), skills and memory. Above that line
everything is implemented twice, deliberately -- `coworkRunner.ts` documents why
the loop cannot be the SDK's, and `coworkSubagent.ts` why a child cannot go
through the chat transport.

**Consequence for every phase:** a feature landed in `core/agent` is not thereby
landed in Cowork. Each phase must say which side it targets.

### 1.2 What `main` already has

Cowork on `main` is much further along than the branch baseline. The library has
roughly doubled, and the additions are the scaffolding this epic assumes:

- **`lib/coworkAccess.ts`** -- the access-mode axis, kept explicitly separate
  from the run mode ("two questions that kept being answered as one"). Modes:
  `review-only`, `managed-worktree`, `edit-folder`. Plus `EditConsent` bound to
  one session *and* one folder, `rootsFor()` deriving read/write roots,
  `decideMutation()` ordering refusals, and `effectiveAccess()` separating a
  stored *preference* from an in-force *authority*.
- **`lib/coworkReadiness.ts`** -- a `ReadinessManifest` snapshotted per binding,
  carrying instructions, skills, tools, model, context accounting and an
  evidence limit. This is already the "one frozen manifest" the epic asks for.
- **`lib/coworkOrigins.ts`** -- an origin ledger that refuses to infer authorship
  from location; "this appeared while Jan was running, and nothing proves Jan
  caused it" is a first-class outcome.
- **`lib/coworkGit.ts`** + `core/agent/git.rs` `status`/`file_diff` -- read-only
  working-tree inspection.
- **`scripts/cowork-compat-smoke.sh`** -- 143 lines of real-runtime checks that
  explicitly state what they do *not* cover (no GUI driver, so nothing about
  pixels or focus order).

The house style throughout is worth naming, because every phase below should
match it: **the codebase would rather report a limitation than imply a
capability.** `Measured` is `{known:false}` rather than a guess; compatibility
files are detected but inactive because "detection is not consent"; an absent
access mode reads as Review only because "an old session's silence is not
consent".

### 1.3 Where the real gaps are

Each area, re-verified against the merged tree. Several gaps are narrower and
better located than the epic assumes.

1. **Managed worktree -- declared, deliberately inert.**
   `BACKEND_ACCESS_CAPABILITY = { managedWorktree: false, directEdit: false }`
   (`coworkAccess.ts`). Both write modes are false *by design* until enforcement
   lands, and `effectiveAccess()` downgrades a stored `managed-worktree`
   preference to sandbox with reason `no-capability` -- the comment says being
   inert "is the whole of its behaviour". So the UI, the mode, the consent
   model, the downgrade reporting and the refusal vocabulary all exist. **The
   gap is exactly two things:** a Git worktree lifecycle, and a writable root
   threaded through the tool gate (which today measures every write against the
   sandbox). Not a new axis -- an enforcement layer under an existing one.
2. **Context accounting -- typed, wired, and fed nulls.**
   `ContextAccounting` and `Measured` exist; `accountedTotal()` reports whether
   the total is complete. The single call site,
   **`routes/cowork.tsx:398-405`**, passes `measured(null)` for all five
   categories and for the budget. The gap is the measurement itself, and it is
   one function's worth of surface area, not an architecture.
3. **Compatibility files -- detected, never active.**
   `COMPATIBILITY_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md']`, classified
   with full state (`loaded`/`missing`/`unreadable`/`oversized`/`empty`) and a
   64 KiB cap, but `classifyInstruction()` sets `active: probe.role ===
   'native'`, so a compatibility file is never in context. The type comment
   already anticipates the switch: "never read into the model's context
   *without the user turning it on*". The gap is the opt-in and the ingestion
   path. The policy governing that switch is decided and recorded in 5.4; the
   scaffolding being present did not settle it, and does not substitute for the
   five constraints there.
4. **First-turn gate -- absent.** `coworkSessionStart.ts` is about the "New
   session" button, not about inspect-then-propose. `coworkMode.ts` has
   `isReadOnly`, and `decideMutation()` refuses with `review-mode`, so the
   *enforcement* primitive exists; what is missing is the state machine and the
   classifier that put an ambiguous first turn into it.
5. **Checkpoints and rewind -- the engine is on the wrong side of the wall.**
   `core/agent/git.rs` implements a shadow-snapshot chain: `snapshot()` writes a
   commit object without touching the user's branch, HEAD or index and without
   scanning the working tree; `restore(target, latest)` rolls back and removes
   files added since. The TUI drives it (`core/cli/tui.rs`, double-Esc picker).
   These are `pub(crate)`; only `repo_root`, `status` and `file_diff` are `pub`
   -- which is exactly what `coworkAccess.ts` says when it explains why the
   worktree cannot be enforced yet. **Promotion of already-exercised code, not
   new work.**
6. **Agent coordination -- isolated children only.** Subagents run, bounded and
   transcript-separated; there is no shared task graph, no dependency ordering,
   no conflict detection.

### 1.4 Reusable assets

- The shadow-snapshot engine above (1.3.5).
- Three OS sandbox backends behind one choke point (`tools/proc.rs`).
- `tools/sandbox.rs::escapes_project` -- canonicalises before deciding, handles
  the not-yet-existing leaf for new-file writes, treats the Linux `/tmp` bind as
  scratch rather than escape.
- `tools/gate.rs` -- transient, never-persisted, per-base-command grants; opaque
  commands (`sudo`, `eval`) match only an exact prior grant, so a grant cannot
  be escalated by composition.
- `coworkToolSignature()` -- the freeze-for-the-run discipline the manifest
  generalises.
- The subagent injection defence: definitions come only from
  `<jan-data>/agent-workspace/subagents`, never an attached folder, precisely so
  a cloned repo cannot inject a system prompt and a tool allowlist.

## 2. Ownership map

| Concern | Owner today | Owner after this work |
|---|---|---|
| Cowork loop, steps, budget | `lib/coworkRunner.ts`, `lib/coworkBudget.ts` | unchanged |
| Advertised tool surface | `lib/coworkTools.ts` | manifest-derived |
| Tool routing | `lib/coworkDispatch.ts` | manifest-derived |
| System prompt | `lib/coworkPrompt.ts` | manifest-derived |
| Session persistence | `hooks/useCoworkSessions.ts` (zustand + `backendStorage`) | + binding, access, worktree, checkpoints |
| Path confinement | `plugins/.../tools/sandbox.rs`, `jail.rs` | + authorized writable root |
| Access decision | `lib/coworkAccess.ts` | unchanged; capability flags flip |
| Run manifest | `lib/coworkReadiness.ts` | extended (section 4) |
| Change attribution | `lib/coworkOrigins.ts` | unchanged |
| Shell confinement | `plugins/.../tools/proc.rs` + 3 backends | unchanged |
| Git snapshots | `core/agent/git.rs` (`pub(crate)`) | promoted, + worktree lifecycle |
| Skills on disk | `plugins/.../skills.rs` | + compat roots (Phase 4) |
| Subagent definitions | `core/agent/subagent.rs`, `lib/coworkSubagentRegistry.ts` | + coordination layer (Phase 5) |

---

## 3. Security boundaries, stated as invariants

These hold today and must survive every phase. They are the acceptance spine.

1. **One canonical root per run.** The run's writable world is exactly one
   canonicalised directory. Everything else is read-only or refused.
2. **The root is frozen for the run.** It cannot change while a run, subagent,
   shell, background job or lifecycle transition is live.
3. **Canonicalise before deciding.** Symlinks and `..` are resolved before any
   containment check (`sandbox.rs::escapes_project`). A path that cannot be
   canonicalised grants nothing.
4. **Grants are transient and never model-visible.** In memory, thread-scoped,
   never persisted, never surfaced to the model (`gate.rs:34`).
5. **Prose cannot grant.** No instruction file, skill, agent definition or MCP
   description may widen tools, change the root, or alter access. This is the
   invariant Phase 4 puts under the most pressure.
6. **A child never exceeds its parent.** Tool sets intersect; they never union.
7. **Unsupported is visible, never silent.** A detected-but-unsupported feature
   is reported as such; it is never ignored, and never claimed as supported.
8. **Attribution comes from evidence.** A change is described from the diff or
   the tool result, never from model prose.

---

## 4. The frozen manifest

`ReadinessManifest` (`lib/coworkReadiness.ts`) already **is** this manifest:
snapshotted per binding, carrying instructions, skills, tools, model, context
accounting, write destination and evidence limit, with `manifestMatches()`
guarding against a slow read for a folder the user has already moved off.

So this is an extension, not an introduction. What the epic needs added:

```
ReadinessManifest += {
  access:  { mode, effective, destinationRoot, downgradedFrom, reason }
  worktree:{ path, branch, baseSha, repoId, state }      // Phase 1
  compat:  { agents[], commands[], unsupported[] }        // Phase 4
  mcp:     { servers[], fingerprints[], consentState }    // Phase 4
}
```

Two rules keep it load-bearing rather than decorative:

- **Readiness, prompt and dispatch must all derive from it**, with a test that
  fails if any of the three computes independently. `effectiveAccess()` already
  states this intent -- "everything that needs to know ... asks this one
  function, so they cannot answer it differently" -- and the manifest should
  inherit it.
- **Persist it with the checkpoint** (Phase 6), so a resumed run can prove what
  the interrupted run was allowed to do.

One caution. The manifest is a snapshot, and `effectiveAccess()` is deliberately
*not*: it recomputes authority from a live grant, because a grant "lives in that
process and dies with it". Folding access into the snapshot must not turn a dead
grant into a remembered permission. Store the *preference* and the
*resolved-at-snapshot* value, and keep the authority query live.

## 5. Per-phase blueprint

Each phase states: goal, where it starts from, files, the decisions that need
making, persistence, tests, and exit criteria. Effort is in rough
implementation-days for one engineer, excluding review.

### 5.1 Phase 1 -- managed worktree enforcement

**Starts from:** the mode, the UI, the consent model, the downgrade reporting
and the refusal vocabulary, all present and deliberately inert (1.3.1). This is
an enforcement layer under an existing axis, not a new axis.

**Two pieces, and only two.**

**(a) Git worktree lifecycle** -- a new `core/agent/worktree.rs` beside `git.rs`,
reusing its `run()` helper and fixed agent identity so worktree commits never
need user git config and never trigger signing. Validate repo, capture base
(HEAD sha, branch, dirty state, repo identity), create a Jan-owned worktree
**outside** the user checkout under
`<jan-data>/agent-workspace/worktrees/<repo-id>/<session-id>`, create a
collision-safe stable branch. Then reuse on restart when identity matches,
detect missing/moved/corrupted/externally-deleted, expose status, refresh,
recover, diff against recorded base, apply/merge/export, discard on
confirmation.

**(b) A writable root through the tool gate.** Today every write is measured
against the sandbox. The worktree root has to become the enforced write root,
and the source checkout must simply never be handed to the tool layer -- so that
a managed-worktree run is *structurally* unable to write it. This is the
property to mutation-test, and it is shared work with direct edit: both write
modes are blocked on the same missing plumbing, which is worth knowing when
sizing them.

Decisions to take before code:

- **Repo identity.** Path alone is wrong (repos move). Suggest first-commit sha
  where one exists, path hash as fallback, both recorded; a mismatch on either
  refuses the stale binding rather than silently rebinding. Note
  `consentCovers()` already keys consent on the *folder string*; worktree
  identity should be stronger, and the two should not be conflated.
- **Branch naming.** Stable across restarts, collision-safe. Suggest
  `jan/cowork/<session-id-short>`, with an explicit refusal -- never a silent
  suffix bump -- when the ref exists and does not point at our recorded base.
- **Dirty source.** `git worktree add` gives the *committed* state, so the
  user's uncommitted work is invisible to the run. Warn in the confirmation and
  record the dirty file list in the manifest so the completion summary can say
  what was excluded. Silence here would be exactly the kind of implied
  capability the codebase's style refuses.
- **Serialisation.** One lifecycle operation per (repo, session), with the lock
  held across the whole create/reuse decision, not just the git call.

**Capability flip.** `BACKEND_ACCESS_CAPABILITY.managedWorktree` goes true only
when *both* (a) and (b) hold. Flipping it on lifecycle alone would make
`effectiveAccess()` report an authority the gate does not enforce -- the precise
class of claim `coworkAccess.ts` says the rework exists to remove.

**Persistence.** New session fields for the worktree record; absent means no
worktree, and `accessOf()` already defaults a silent session to `review-only`.

**Tests.** Creation, reuse across restart, branch collision, dirty source,
missing/moved worktree, stale base, concurrent lifecycle calls, apply/export,
discard confirmation, refusal to touch the source checkout, sibling containment,
symlink escape, cancellation mid-lifecycle, crash recovery. Mutation tests:
source-checkout write, parent-root widening, stale-worktree acceptance,
capability-true-while-gate-unenforced.

**Exit criteria.** Worktree created, reused after restart, reviewed as a diff,
applied or exported, recovered, discarded on confirmation; a managed-worktree
run cannot write the source checkout, proven by mutation test; capability true
only when the gate enforces.

**Effort:** 8-12 days. **Risk:** medium-high -- git worktree edge cases are
numerous and platform-specific (Windows path length, case sensitivity).

### 5.2 Phase 2 -- context measurement

**Starts from:** the types, the accounting, the completeness check and the
inspector's contract, all present; five nulls at `routes/cowork.tsx:398-405`
(1.3.2). The smallest phase in the epic, and the one whose diagnosis is exactly
right.

**The pack** is assembled once per run and frozen: binding and access policy,
repository map, build manifests, git state, `JAN.md`, active skills, agent
definitions, MCP schemas, todo/handoff state, compacted summary, current turn,
capability metadata.

**Repository map.** Bounded shallow tree plus important-file index, on demand,
respecting ignore files and the repository boundary, cached by binding plus
revision identity, invalidated on binding change or explicit refresh. Never a
recursive ingest -- the bound is part of the design, not a later safeguard.

**Measurement.** Jan runs local models through llama.cpp and remote providers
through the AI SDK; they do not share a tokenizer. `Measured` is today a
two-state type (`known` / not). It needs a third state, or the honesty it
enforces will be bought at the cost of showing blanks where a labelled estimate
would genuinely help:

```
Measured = { known: true; tokens: number; method: 'exact' | 'provider' }
         | { known: 'estimated'; tokens: number; method: string }
         | { known: false }
```

The existing comment -- "a plausible guess is worse than a blank" -- is right
that an *unlabelled* guess is worse than a blank. A labelled one is not,
provided the method travels with the number all the way to the screen, which
making it part of the type is what guarantees. `accountedTotal()` then needs to
distinguish "complete" from "complete including estimates".

**Compaction.** Cowork has none. Rather than porting `compaction.rs` wholesale,
Cowork needs compaction preserving a pinned set: binding, instructions, active
skills, todo state, tool results, approvals, origin ledger, unresolved
questions, and explicitly any user correction or refusal. Record a visible
compaction event.

**Exit criteria.** Every category shows a measured number or a labelled
estimate; omissions and truncations visible; a test proves prompt, readiness,
inspector and dispatch read the same frozen pack.

**Effort:** 5-8 days. **Risk:** medium -- the honesty requirement is easy to
satisfy sloppily.

### 5.3 Phase 3 -- first-turn inspect, propose, continue

**Starts from:** plan mode's mechanism plus `decideMutation()`'s `review-mode`
refusal (1.3.4). Plan mode is a read-only mode that stages a plan via `todo`
then blocks on an `ask` with the reserved id `plan_review`, and
`PLAN_DENIED_TOOLS` is enforced **twice** -- withheld from the advertised set
*and* refused by name in the dispatcher, because a model can call a tool that
was never advertised. That double enforcement is the pattern to copy.

**The addition** is a persisted state machine -- `inspecting`, `proposal-ready`,
`awaiting-continuation`, `executing`, `completed`, `blocked`, `cancelled` --
plus a classifier for ambiguous first turns.

**The classifier is this phase's risk**, and it is worth stating plainly: a
false negative silently reintroduces the drift the phase exists to prevent. Two
mitigations, both worth taking: (a) make the first turn of a newly-bound
repository session default to inspect-only regardless of classification, so the
classifier can only ever *widen* from a safe default -- which also matches the
codebase's existing "silence is not consent" reading of a missing field; (b)
never let the classifier be the only enforcement -- the state machine gates the
mutation tools, as plan mode does.

**Resume must not auto-execute a staged plan.** Most likely property to regress
silently; it needs its own test.

**Tests.** The original screenshot scenario, and an `obs-forwarder` / `note-py`
sibling fixture.

**Effort:** 4-6 days. **Risk:** medium, concentrated in classification.

### 5.4 Phase 4 -- compatibility ingestion

**Starts from:** detection without consent (1.3.3). The scaffolding is done --
recognised names, precedence order, full state classification, a size cap, and a
type comment anticipating an opt-in switch.

**Decision taken.** Ingestion is approved, under the policy below. It was worth
deciding explicitly rather than inferring from the scaffolding, because turning
the switch on means feeding content from a repository the user may have merely
cloned into a tool-using agent with filesystem access, and two existing
decisions pushed the other way: `JAN.md` is authoritative because only what a
user wrote *for Jan* counts, and subagent definitions are kept out of attached
folders precisely so a cloned repo cannot inject a system prompt and a tool
allowlist. Project-level skills and agent definitions -- which carry tool
allowlists and executable resources -- are the same shape as the thing already
refused.

The policy resolves that tension by separating *reading* from *authority*:
compatibility content may inform the model and may never empower it. The five
constraints below are the decision, not suggestions, and each one is a test:

1. **Off by default.** No compatibility file is ever active because it exists.
   `classifyInstruction()` already has the right shape: `active` flips from a
   policy input, never from the file's presence. Detection stays what it is
   today, and stays visible whether or not ingestion is on.
2. **Enabled per repository, by explicit user action.** The switch is bound to
   one repository, like `EditConsent` is bound to one session and one folder, so
   enabling it for a repository the user vetted cannot follow them to the next
   one they clone. Enabling is a user act; no instruction file, skill, agent
   definition or MCP server may enable it, for itself or for anything else.
3. **Path-contained.** Every read -- instruction files, skill roots, bundled
   resources, agent definitions -- is canonicalised and required to resolve
   inside the enabled repository, by the same `escapes_project` discipline the
   tool layer already uses. Nothing above the repository root, nothing from a
   sibling, no symlink out. A path that cannot be canonicalised is refused, not
   guessed at.
4. **Tool-allowlisted.** A project-sourced allowlist may only narrow: requested
   tools are **intersected** with what the user has already granted, never
   unioned. A skill's bundled scripts are never executed merely because the
   skill exists, and hooks, plugin installers and lifecycle scripts stay
   disabled and are reported individually -- partial plugin support shown
   per-portion, never as "compatible".
5. **Never able to grant authority.** Ingested content is inert prose inside an
   untrusted-content envelope. It cannot grant a tool, widen or change the root,
   activate a skill, consent to an MCP server, alter the access mode, or turn on
   ingestion itself. This is invariant 5 in section 3, and it is the one to test
   hardest -- per source type, because the envelope is easy to get right for
   `AGENTS.md` and easy to forget for a skill's frontmatter.

Precedence once enabled: system/security, then binding and access policy, then
`JAN.md`, then `AGENTS.md`/`CLAUDE.md` -- the order
`COMPATIBILITY_INSTRUCTION_FILES` already encodes. Nested `CLAUDE.md` stays
directory-scoped; nested `AGENTS.md` gets equivalent scoping or a precise
unsupported-scoping report. Never above the repository root.

**Exit criteria.** Every imported component listed in readiness with source,
state, precedence and unsupported fields; a prose-cannot-grant test per source
type; a path-containment test per resource root; a tool-intersection test
proving a project-sourced allowlist can only narrow.

**Effort:** 8-12 days. **Risk:** high -- the one phase where a subtle mistake
becomes a prompt-injection path into an agent with filesystem access. The
decision is made, which removes the scheduling block but none of the care: the
sequencing in section 7 still puts it last, because the risk is in the code and
not in the approval.

### 5.5 Phase 5 — coordinated agent teams

**Starts from:** working isolated subagents — `MAX_PARALLEL_SUBAGENTS = 3`, a
run-id-bucketed transcript per child, `SUBAGENT_SKILL_TOOLS` always granted,
children unable to ask the user or spawn their own children.

**The addition** is coordination: a shared todo/task graph with ownership,
status and dependencies; provenance-tagged shared read-only findings; isolated
write destinations (this is where Phase 1's worktrees pay off a second time);
conflict detection before apply; per-child cancellation without corrupting
siblings; parent-cancellation propagation; deterministic merge and report order.

Two rules carry most of the safety: a child never widens authority (intersect,
never union), and **one child's failure never becomes a fabricated success in
the parent summary** — the parent's report is assembled from child *results*,
not from parent prose about them.

**Depends on:** Phase 1 (isolated write destinations). Attempting it first means
children share one sandbox and conflict detection has nothing to detect.

**Effort:** 8–12 days. **Risk:** medium-high — concurrency plus recovery.

### 5.6 Phase 6 — checkpoints, rewind, crash recovery

**Starts from:** a working engine on the wrong side of the wall (1.3.5). The
first task is not writing a snapshot system; it is **promoting `git.rs`** from
`pub(crate)` to a shared service both harnesses use, without regressing the TUI.
`coworkAccess.ts` independently names this same boundary when it explains why
the worktree cannot be enforced yet, so the promotion serves two phases.

Checkpoint contents per the request: binding, access/destination, manifest
version, origin ledger, todo/task state, transcript/tool rows, worktree
identity, recoverable diff metadata. Captured at run start, before each
mutation-capable operation, before worktree apply/export, before access changes,
before compaction, after task milestones.

**The asymmetry that must not be flattened:** in a managed worktree or sandbox,
rewind can hard-restore, because Jan owns the tree. In direct-edit mode it must
not — the user's checkout may contain work Jan never saw. There, the answer is a
reviewable inverse patch, or an explicit refusal. Implementing one rewind path
for both modes is the failure mode to guard against.

Crash/restart: detect interrupted runs, subagents, shells, jobs, MCP processes
and worktree operations; mark incomplete work explicitly; offer resume /
inspect / recover / discard; **never** resurrect transient grants or MCP consent
automatically (invariant 4); make cleanup idempotent.

**Tests.** Failure injection at every checkpoint boundary.

**Effort:** 7–10 days. **Risk:** medium — much of the hard part exists and is
already exercised by the TUI.

### 5.7 Phase 7 — parity UX review

Acceptance scenarios, not implementation. `scripts/cowork-compat-smoke.sh`
already exists (143 lines of real-runtime checks, and it states plainly what it
does not cover: no GUI driver, so nothing about pixels or focus order), so this
is extension rather than creation -- plus an end-user manual checklist.

The GUI gap it names is worth taking seriously rather than working around: two
of the epic's parity scenarios ("a path-shaped collection name never pretends to
open a folder", "repository, branch, mode ... visible before execution") are
claims about what a person sees, and no headless check can settle them.

**Effort:** 2–3 days.

### 5.8 Phase 8 -- verification and platform evidence

See section 6. The classification scheme -- runtime-verified /
unit-tested-only / construction-only / detected-but-unsupported /
externally-blocked -- should be applied per claim and recorded in the phase's
report. The rule that matters: a skipped test is never reported as support.

**Much less of this phase is outstanding than the epic implies.**
`.github/workflows/cowork-sandbox-runtime.yml` already exists and is written to
the standard this phase is asking for:

- **Linux (bubblewrap)** installs `bwrap`, then *verifies the backend is really
  there* before running any confinement check -- `command -v bwrap`, a version
  probe, and a real `bwrap --ro-bind / / --unshare-all` execution -- with the
  comment noting that without it "a runner missing bubblewrap would pass every
  confinement" test vacuously. Then it exercises sandbox policy against real
  confined processes and a confined MCP launch with a real handshake.
- **Windows** is titled "refusal is the outcome": it records what the platform
  can enforce, asserts edit-folder is reported unsupported and imports fail
  closed, and checks path handling under Windows separators, casing and
  **prefix siblings**.
- **macOS (Seatbelt)** likewise confirms the backend before claiming it.

That is the fail-closed, prove-the-backend-first discipline this phase exists to
establish, already in place. What remains for Phase 8 is extending these jobs to
cover the new surfaces each phase adds -- worktree lifecycle, context
measurement, the first-turn gate -- not building the platform harness. The one
genuine blocker is runner allocation (6.3), which is an infrastructure problem,
not a coverage gap.

---

## 6. Verification: what this environment can and cannot prove

Measured in this container:

| Check | Status |
|---|---|
| Dependency install | Works, but **not out of the box** — see below |
| `yarn test:web` | Runs; baseline in 6.1. Red by 2 files after 6.1(a) |
| `yarn build:web` | Fixed on this branch; was failing on `main` — 6.1(a) |
| Rust plugin tests | Runs after installing GTK/WebKit headers; 2 container-specific failures |
| macOS native / WebView smoke | Impossible here (Linux container) |
| Windows fail-closed runtime | Impossible here |
| Linux bubblewrap runtime | Possible in principle; needs `bwrap` present |
| Any CI job | **No runners allocated** — see 6.3 |

**Install is not out of the box.** `corepack` cannot fetch Yarn 4.5.3:
`repo.yarnpkg.com` returns 403 through this environment's proxy (confirmed via
`__agentproxy/status`, which lists two `connect_rejected` entries for that host).
`registry.npmjs.org` is reachable, so the working route is
`npm pack @yarnpkg/cli-dist@4.5.3` and running `bin/yarn.js` directly. Worth
recording in contributor docs; it will bite anyone else in a restricted network.

**The web suite needs a build first.** A cold `yarn test:web` fails 64 test
files not on their assertions but on `Failed to resolve entry for package
"@janhq/core"` and `"@janhq/tauri-plugin-agent-tools-api"` — the workspace
packages are unbuilt. `yarn workspace @janhq/core build` plus the plugin
`workspaces foreach run build` fixes it. Any CI job added in Phase 8 must
order these, or it will report a false baseline.

**Rust tests need system headers.** A first `cargo test --lib` in
`tauri-plugin-agent-tools` failed building `atk-sys` and `gdk-sys` — GTK/WebKit
development headers absent. crates.io itself is reachable (the dependency graph
compiled up to those two). Installing `libgtk-3-dev` and `libwebkit2gtk-4.1-dev`
fixed it and the suite then ran; results in §6.1.

**Two of the 22 verification steps in the request cannot be satisfied from any
Linux container** — macOS native/WebView smoke and Windows fail-closed runtime.
They belong in CI on those runners, and any claim about them made from here is
construction-only by definition.

### 6.1 Baseline results on the merged tree

`yarn test:web`, with `@janhq/core`, the plugin API packages and the extensions
built first: **367 test files, 5,008 tests — 364 files and 5,006 tests pass.**

The three failures are all `main`'s, not this branch's (the branch's only diff
from `main` is this document), and two of them are worth acting on:

**a. `yarn build:web` does not build on `main`.** Two TypeScript errors, both in
`web-app/src/services/updater/tauri.ts`:

```
src/services/updater/tauri.ts(10,31): error TS2307:
  Cannot find module '@tauri-apps/plugin-updater'
src/services/updater/tauri.ts(151,40): error TS7006:
  Parameter 'event' implicitly has an 'any' type
```

Commit `3be8879` ("refactor(privacy): remove telemetry and update checking")
removed `@tauri-apps/plugin-updater` from `web-app/package.json` — deliberately,
and `web-app/src/__tests__/localOnly.test.ts` asserts the removal ("ships no
updater plugin"). But it left `services/updater/tauri.ts` importing the removed
package and `services/index.ts:145` dynamically importing that module into the
service hub. `services/updater/__tests__/tauri.test.ts` fails to resolve for the
same reason, which is the third failing test file.

**Fixed on this branch.** `DefaultUpdaterService`
(`services/updater/default.ts`) is a no-op returning `null`, which *is* the
intended local-only behaviour, and the hub already defaults to it
(`services/index.ts:96`) — the mobile branch already relies on exactly that. So
finishing the removal meant deleting `updater/tauri.ts` and its test, dropping
the three lines that loaded it into the desktop branch of the hub, and removing
two dangling `vi.mock` calls. `yarn build:web` goes from failing to exit 0, and
`services/updater/__tests__/tauri.test.ts` stops being a third failing file.

**b. Two tests cannot pass under the default runner.** *(Fixed: the specs now
skip themselves when `JAN_RESTART_FIXTURE` is unset, so `yarn test:web` is
green and the smoke script still runs them.)*
`web-app/src/hooks/__tests__/restart/processA.spec.ts` and `processB.spec.ts`
are a two-process fixture: they require `JAN_RESTART_FIXTURE` to name a shared
file, and are driven by `scripts/cowork-compat-smoke.sh`, which sets it and runs
the two specs in sequence. `web-app/vitest.config.ts` has no test-file `exclude`
— only a *coverage* exclude — so `yarn test:web` picks them up, `processA`
throws on the missing variable, and `processB` then fails because `processA`
never wrote the state.

The effect is that `yarn test:web` is permanently red on `main` by two tests
that are working as designed. Either exclude the `restart/` directory from the
default project and leave it to the smoke script, or have the specs skip
themselves when `JAN_RESTART_FIXTURE` is unset. The second is preferable: a
self-skipping spec still reports its own absence, where an exclude hides it.

Both findings are `main`'s and outside this epic's scope, recorded here because
a Phase 0 baseline that does not say "the tree does not currently build" is not
a baseline. (a) has since been fixed on this branch; (b) is still open.

### 6.2 Pre-merge results at `adfd071`

Kept because they show how much of a cold-run failure is build ordering. Web
suite, three runs, each adding one build step:

| Build state | Test files | Tests |
|---|---|---|
| Cold, nothing built | 241 passed, 64 failed (305) | 2,727 passed, 43 failed |
| + `@janhq/core` and plugin API packages | 304 passed, 1 failed | 3,850 passed, 0 failed |
| + `yarn build:extensions` | 305 passed, 0 failed | 3,860 passed, 0 failed |

Every cold-run failure is module resolution, not an assertion. The test *count*
climbs 2,770 → 3,850 → 3,860: unresolved imports cost whole files, so a cold run
under-reports coverage by roughly a thousand tests as well as reporting red. A
CI job that does not order the builds first measures a baseline that is both red
and short.

Rust plugin suite (`cargo test --lib` in `tauri-plugin-agent-tools`), after
installing `libgtk-3-dev`/`libwebkit2gtk-4.1-dev` — without them the build dies
at `atk-sys`/`gdk-sys` and no test runs: **319 passed, 2 failed, 1 ignored**.
Both failures are container artifacts, recorded with that context so neither is
carried forward as "known failing":

- `reports_a_permission_denial_distinctly` asserts a chmod-000 directory is
  refused, which cannot hold for **uid 0** — this container runs as root.
- `bash_runs_only_when_the_sandbox_can_enforce` needs a bubblewrap bind this
  container cannot set up.

### 6.3 CI is red for a reason unrelated to any diff

Every check on this PR fails 1–4 seconds after starting, with no runner assigned
(`runner_id: 0`, `runner_name: ""`). The same is true of `main`'s own pushes —
`Rust Check` on `bdbf078` and `Cowork sandbox runtime` both fail the same way.
This is runner allocation in this fork, not a code failure, and no re-run fixes
it.

The point is worth stating precisely, because it is easy to mistake for a
missing-CI problem. The per-platform jobs Phase 8 wants **already exist and are
correctly written** (5.8): `Cowork sandbox runtime` defines Linux-bubblewrap,
Windows-fail-closed and macOS-Seatbelt jobs, and `Linter & Test` defines
`test-on-ubuntu`, `test-on-macos` and `test-on-windows-pr`. Every one of them
fails without a runner ever being assigned, across `ubuntu-latest`,
`macos-latest` and `windows-latest` alike. So the platform evidence cannot be
produced here today, but nothing needs to be built for it to be produced the
moment runners are available -- this is an Actions availability or billing
question for whoever owns the fork, not work for this epic.

## 7. Recommended sequence

1. **Phase 1** (worktree enforcement) -- foundational; Phases 5 and 6 both
   depend on it. Its part (b), a writable root through the tool gate, also
   unblocks direct edit, so the two write modes are cheaper together than the
   epic's ordering suggests.
2. **Phase 2** (context measurement) -- independent of Phase 1, the smallest
   phase, and the one whose diagnosis is exactly right. Reasonable to do first
   if early visible payoff matters more than foundation.
3. **Phase 3** (first-turn gate) — small, and it reuses plan mode's mechanism.
4. **Phase 6** (checkpoints/rewind) — after Phase 1; mostly promotion of
   existing, already-exercised code.
5. **Phase 5** (agent teams) — after Phases 1 and 6.
6. **Phase 4** (compatibility ingestion) -- last. The policy decision is made
   (5.4), so nothing blocks starting it; it stays last because it is the only
   phase that relaxes an existing security property, and doing that under time
   pressure at the end of a long epic is how injection paths get shipped.
7. **Phases 7–8** continuously rather than as a tail.

Rough total: **40-60 implementation-days**, excluding the Phase 4 decision and
excluding review -- slightly below the first draft's estimate, because `main`
carries more scaffolding than the branch baseline showed: Phases 1, 2 and 4 each
start from types, UI and vocabulary that already exist.

The estimate assumes the house style is kept: every phase reports what it cannot
do rather than implying it can. Most of the per-phase cost above is in the
reporting and the refusal paths, not the happy path -- which is as it should be
for a harness whose whole premise is that a user can trust what the screen
says.
