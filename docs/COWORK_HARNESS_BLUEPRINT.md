# Cowork coding-harness blueprint (Phase 0)

Baseline commit: `adfd071` on `feat/cowork-background-tasks`.
Scope of this document: architecture, ownership, boundaries and per-phase exit
criteria for the remaining Cowork coding-harness work. **No production code is
changed by this document.** It exists so the phases that follow are planned
against what the tree actually contains rather than against an assumed state.

---

## 0. How to read this

Section 1 records what is really in the tree today, with file references, and
corrects four premises the task description carries that this branch does not
match. Sections 2–4 map the architecture and the security boundaries. Section 5
is the per-phase blueprint. Section 6 covers verification and what this
environment can and cannot prove. Section 7 recommends a sequence.

Everything asserted here was read out of the tree at `adfd071` or observed from a
command run against it. Where something could not be verified in this
environment, it says so.

---

## 1. Baseline: what exists at `adfd071`

### 1.1 There are two agent harnesses, not one

| | Rust harness | Cowork harness |
|---|---|---|
| Location | `src-tauri/src/core/agent/*.rs` | `web-app/src/lib/cowork*.ts` |
| Size | 21,303 LoC | 3,356 LoC |
| Drives | the CLI / TUI (`src-tauri/src/core/cli/`) | the Cowork desktop route |
| Owns the loop | `core/agent/loop.rs` (5,357 LoC) | `lib/coworkRunner.ts` (439 LoC) |
| Compaction | `core/agent/compaction.rs`, wired in `loop.rs` | none |
| Instruction files | `core/agent/context.rs` | `lib/coworkPrompt.ts` |
| Subagents | `core/agent/subagent.rs` (2,265 LoC) | `lib/coworkSubagent.ts` (480 LoC) |

They share exactly one substrate: the Tauri plugin
`src-tauri/plugins/tauri-plugin-agent-tools` (13,643 LoC), which provides the
file/shell tools, the path jail, the three OS sandbox backends, skills and
memory. Everything above that line is implemented twice, deliberately —
`coworkRunner.ts` documents why the loop could not be the SDK's, and
`coworkSubagent.ts` documents why a child cannot go through the chat transport.

**Consequence for every phase below:** a feature landed in `core/agent` is not
thereby landed in Cowork, and vice versa. Each phase has to state which side it
targets, and whether the other side is meant to follow.

### 1.2 The access model today is sandbox + read-only folder

A Cowork session has one writable directory — a per-session sandbox under
`<jan-data>/agent-workspace/sessions/<id>` (`plugins/.../workspace.rs:26-33`) —
and optionally one *attached folder* mounted strictly read-only
(`lib/coworkPrompt.ts:106-135`, `types/coworkSession.ts` `CoworkSession.folder`).
The system prompt spends a whole block telling the model the attachment is
read-only, because a model does not assume that arrangement and will otherwise
retry the denied write until the step budget is gone.

Folder attach is a native directory picker (`routes/cowork.tsx:300-305`); the
picked absolute path is stored verbatim on the session.

### 1.3 Four premises in the request that this branch does not match

The task description opens by crediting the branch with "repository binding,
direct-edit consent, Claude compatibility, MCP confinement" and describes the
remaining work as filling gaps. Measured against `adfd071`:

1. **There is no access-mode concept at all.** `accessMode`, `access_mode`,
   `directEdit` and `direct-edit` have **zero** occurrences across
   `web-app/src`, `src-tauri/src` and `src-tauri/plugins`. There is no
   review-only / ask-before-changes / autonomous triad, and no direct-edit
   consent flow, because there is no direct edit. Phase 1 is therefore not
   "add the missing third access mode" — it is **introducing the access-mode
   axis itself**, and the managed worktree is its first non-trivial member.
2. **Claude compatibility is absent by policy, not partial.** `AGENTS.md` and
   `CLAUDE.md` are named in exactly two places, both of which say they are
   deliberately *not* ingested: `core/agent/context.rs:28-31` ("Another agent's
   file … is deliberately not ingested: only what a user wrote for Jan") and
   `lib/coworkPrompt.ts:57-64`. `JAN.md` is the one instructions file either
   harness reads. Phase 4 is a **reversal of a documented decision**, and needs
   to be argued as one — see §5.4.
3. **Cowork has no MCP.** Zero `mcp` hits in `lib/cowork*`, `hooks/useCowork*`
   and `routes/cowork.tsx`. MCP exists only on the CLI side
   (`core/cli/mcp.rs`). "Keep MCP on Jan's real manager" is new integration
   work for this surface, not preservation.
4. **`scripts/cowork-compat-smoke.sh` does not exist.** `scripts/` contains
   seven files, none of them a Cowork smoke harness. Phase 7 would be creating
   it.

None of this makes the requested work wrong. It changes its size and its order:
Phases 1 and 4 both start further back than the description assumes, and Phase 4
additionally needs a policy decision before any code.

### 1.4 What *is* already built, and is reusable

- **A checkpoint/rewind engine, on the wrong side of the wall.**
  `core/agent/git.rs` implements a shadow-snapshot chain: `snapshot()` writes a
  commit object without touching the user's branch, HEAD or index and without
  scanning the working tree (it stages only the paths changed this turn against
  a persistent per-thread index); `snapshot_ref()` keeps the chain reachable
  across GC; `restore(target, latest)` rolls the tree back and removes files
  added since. The TUI drives it from `core/cli/tui.rs:13167-13260`
  (double-Esc rewind picker, conversation-only vs conversation+workspace).
  Every one of these is `pub(crate)` and none is reachable from Cowork.
  **This is the single most valuable existing asset for Phases 1 and 6.**
- **Three OS sandbox backends**: bubblewrap (Linux), Seatbelt (macOS),
  AppContainer (Windows), funnelling through one choke point in
  `plugins/.../tools/proc.rs:163-197`, with `appcontainer.rs` noting it also
  blocks loopback where the Unix backends do not.
- **A path jail with canonicalisation and symlink handling**:
  `tools/sandbox.rs::escapes_project` resolves `..` and symlinks, handles the
  not-yet-existing leaf case for new-file writes, and treats the Linux `/tmp`
  bind as scratch rather than as an escape.
- **Transient, never-persisted permission grants**: `tools/gate.rs:34-103`,
  per base command, with opaque commands (`sudo`, `eval`) matched only by exact
  prior grant so a grant cannot be escalated by composition.
- **Frozen-for-the-run tool signature**: `lib/coworkTools.ts:155-172`
  (`coworkToolSignature`) already establishes the "freeze the advertised
  surface for a run, mode changes take effect next message" discipline that the
  requested "one frozen manifest" generalises. The manifest should extend this
  record, not replace it.
- **Subagents with an injection defence already reasoned through**:
  definitions come only from `<jan-data>/agent-workspace/subagents`, never from
  the attached folder, precisely so a cloned repo cannot inject a system prompt
  and a tool allowlist (`lib/coworkSubagentRegistry.ts:5-11`). Phase 4's
  project-level agent definitions collide with this head-on — see §5.4.

### 1.5 Context handling today

`lib/coworkBudget.ts` is the whole of it: 100 model steps and 200,000 tokens per
*user request* (not per session — matching where `SessionBudget` lives in Rust),
charged from provider-reported usage with `recordSpend()` folding in completion
tokens plus positive prompt *growth*, so replayed context is not charged 20×.

There is no context pack, no per-category accounting, no repository map, and no
compaction on this path. `core/agent/compaction.rs` exists but is called only
from `loop.rs`. So the "Cowork context counts are unknown" gap in the request is
real and correctly diagnosed — it is the one premise that holds exactly.

---

## 2. Ownership map

| Concern | Owner today | Owner after this work |
|---|---|---|
| Cowork loop, steps, budget | `lib/coworkRunner.ts`, `lib/coworkBudget.ts` | unchanged |
| Advertised tool surface | `lib/coworkTools.ts` | manifest-derived |
| Tool routing | `lib/coworkDispatch.ts` | manifest-derived |
| System prompt | `lib/coworkPrompt.ts` | manifest-derived |
| Session persistence | `hooks/useCoworkSessions.ts` (zustand + `backendStorage`) | + binding, access, worktree, checkpoints |
| Path confinement | `plugins/.../tools/sandbox.rs`, `jail.rs` | + worktree root as jail root |
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

Several phases independently need "one record, resolved once per run, that
prompt / readiness / dispatch / UI all read". `coworkToolSignature` already does
this for the tool surface. The manifest generalises it:

```
CoworkRunManifest {
  binding:   { sourceRepo, canonicalRoot, gitIdentity, branch, headSha, dirty }
  access:    { mode, destinationRoot, grantsRef }
  context:   { packId, categories[], measurement, omissions[] }
  compat:    { instructions[], skills[], agents[], commands[], unsupported[] }
  mcp:       { servers[], fingerprints[], consentState }
  budget:    { maxSteps, maxTokens }
  toolSignature: string
}
```

Resolved once at run start, immutable for the run's lifetime, shared by
reference with every subagent and every MCP process. Two rules make it load
bearing rather than decorative:

- **Readiness, prompt and dispatch must all be derived from it**, with a test
  that fails if any of the three is computed independently. Without that test
  the manifest becomes a fourth source of truth rather than the only one.
- **Persist it with the checkpoint** (Phase 6), so a resumed run can prove what
  the interrupted run was actually allowed to do.

---

## 5. Per-phase blueprint

Each phase states: goal, where it starts from, files, the decisions that need
making, persistence, tests, and exit criteria. Effort is in rough
implementation-days for one engineer, excluding review.

### 5.1 Phase 1 — access modes and managed worktrees

**Starts from:** nothing. There is no access-mode axis (§1.3.1).

**Two changes, not one.** (a) Introduce `CoworkAccessMode` as an explicit
session field with the modes `sandbox` (today's behaviour, the default),
`worktree`, and — only if the product wants it — `direct`. (b) Implement the
worktree lifecycle. Landing (b) without (a) means the worktree path is a special
case bolted onto a binary sandbox/no-sandbox switch.

**Backend (new module, `core/agent/worktree.rs`).** Sits beside `git.rs` and
uses its `run()` helper and fixed agent identity so worktree commits never need
user git config and never trigger signing.

Lifecycle: validate repo → capture base (HEAD sha, branch, dirty state, repo
identity) → create a Jan-owned worktree **outside** the user checkout, under
`<jan-data>/agent-workspace/worktrees/<repo-id>/<session-id>` → create a branch
with a collision-safe stable name → record in session state. Then: reuse on
restart when identity matches, detect missing/moved/corrupted/externally
deleted, expose status, refresh/recover, diff against recorded base,
apply/merge/export, and discard-with-confirmation.

Design points that need deciding before code:

- **Repo identity.** Path alone is wrong (repos move). Suggest: the first-commit
  sha where one exists, path hash as the fallback, both recorded. A mismatch on
  either refuses the stale binding rather than silently rebinding.
- **Branch naming.** Stable across restarts and collision-safe. Suggest
  `jan/cowork/<session-id-short>`, with an explicit refusal (never a silent
  suffix bump) when that ref exists and does not point at our recorded base.
- **Dirty source.** A `git worktree add` from a dirty checkout is legal; the
  worktree gets the *committed* state, so the user's uncommitted work is
  invisible to the run. That surprises people. Suggest: warn explicitly in the
  confirmation, and record the dirty file list in the manifest so the completion
  summary can say what was not included.
- **Serialisation.** One lifecycle operation per (repo, session) at a time, with
  the lock held across the whole create/reuse decision, not just the git call.

**Authority.** The worktree root becomes the jail root passed to
`executeAgentTool` — i.e. the `readOnlyFolder` argument in
`lib/coworkDispatch.ts:88-94` is replaced by a destination-aware binding. A
managed-worktree run must be structurally unable to write the source checkout:
the source path is simply never handed to the tool layer. This is the property
to mutation-test.

**UI.** `CoworkWorkspacePill.tsx` currently renders a lock icon and a read-only
contract. It grows into a destination selector (Review only / Managed worktree /
Edit this folder) showing source repo, worktree path, branch, base revision,
dirty warning, lifecycle state, and apply/export/discard/recover. The existing
truthful-downgrade behaviour (say what you actually got, not what was asked for)
must survive.

**Persistence.** New `CoworkSession` fields: `accessMode`, `worktree { path,
branch, baseSha, repoId, state }`. Migration: absent means `sandbox`, which is
exactly today's behaviour, so old sessions load unchanged. `useCoworkSessions`
already has a migration test file to extend.

**Tests.** Creation, reuse across restart, branch collision, dirty source,
missing/moved worktree, stale base, concurrent lifecycle calls, apply/export,
discard confirmation, refusal to touch the source checkout, sibling containment,
symlink escape, cancellation mid-lifecycle, crash recovery. Mutation tests:
source-checkout write, parent-root widening, stale-worktree acceptance.

**Exit criteria.** A worktree can be created, reused after restart, reviewed as
a diff, applied or exported, recovered, and discarded on confirmation; a
managed-worktree run cannot write the source checkout (proven by a mutation
test, not by inspection); the mode is visible in the UI before the run starts.

**Effort:** 8–12 days. **Risk:** medium-high — git worktree edge cases are
numerous and platform-specific (Windows path length, case sensitivity).

### 5.2 Phase 2 — context pack and inspector

**Starts from:** budget caps only (§1.5). This is the cleanest phase: no
existing design to reverse, and the diagnosis in the request is accurate.

**The pack** is assembled once per run and frozen: binding and access policy,
repository map, build manifests, git state, `JAN.md`, active skills, agent
definitions, MCP schemas, todo/handoff state, compacted summary, current turn,
capability metadata.

**Repository map.** Bounded shallow tree plus an important-file index, built on
demand, respecting ignore files and the repository boundary, cached by binding +
revision identity, invalidated on binding change or explicit refresh. It must
never recursively ingest the repository — the bound is part of the design, not a
safeguard added later.

**Measurement is where this phase earns its keep, and where it can quietly
fail.** Jan runs local models through llama.cpp and remote providers through the
AI SDK; these do not share a tokenizer. The honest design is a per-category
measurement with an explicit method tag:

- `exact` — counted with the model's own tokenizer (local llama.cpp path).
- `provider` — from the provider's reported usage, attributable to a category
  only for whole-message categories.
- `estimate:<method>` — a labelled heuristic, with the method named in the UI.

The rule from the request — never display an invented exact number — is
implementable only if the method tag travels with every number all the way to
the inspector. Suggest making the type itself carry it (`{ value, method }`),
so an unlabelled number cannot be rendered.

**Compaction.** Cowork has none. Rather than porting `compaction.rs` wholesale,
the Cowork path needs compaction that preserves the pinned set: binding,
instructions, active skills, todo state, tool results, approvals, origin ledger,
unresolved questions, and — explicitly — any user correction or refusal. A
compaction event is recorded and shown.

**Exit criteria.** Every category in the inspector shows either a measured
number or a labelled estimate; omissions and truncations are visible; a test
proves prompt, readiness, inspector and dispatch all read the same frozen pack.

**Effort:** 6–9 days. **Risk:** medium — the measurement honesty requirement is
easy to satisfy sloppily and hard to satisfy properly.

### 5.3 Phase 3 — first-turn inspect → propose → continue gate

**Starts from:** plan mode, which is close in spirit and reusable in mechanism.
`lib/coworkPrompt.ts:27-40` already implements a read-only mode that stages a
plan via `todo` and then blocks on an `ask` with the reserved question id
`plan_review`, special-cased by the ask card. `PLAN_DENIED_TOOLS` in
`coworkTools.ts` is enforced twice — withheld from the advertised set *and*
refused by name in the dispatcher, because a model can call a tool that was
never advertised. That double enforcement is the pattern to copy.

**The addition** is a persisted state machine — `inspecting`, `proposal-ready`,
`awaiting-continuation`, `executing`, `completed`, `blocked`, `cancelled` — and
a *classifier* for ambiguous first turns ("read this project", "learn it",
"continue where the other harness stopped", "probably task 1").

**The classifier is the risk in this phase**, and it deserves saying plainly: a
false negative silently reintroduces exactly the drift the phase exists to
prevent. Two mitigations, both worth taking: (a) make the *first turn of a
newly-bound repository session* default to inspect-only regardless of
classification, so the classifier only ever *widens* from a safe default; (b)
never let the classifier's decision be the only enforcement — the state machine
gates the mutation tools, the same way plan mode does.

**Resume must not auto-execute a staged plan.** This is the property most likely
to regress silently later; it needs its own test, not a shared one.

**Tests.** The original screenshot scenario, and an `obs-forwarder` / `note-py`
sibling fixture for the wrong-repository case.

**Exit criteria.** An ambiguous first turn inspects, summarises with evidence,
proposes, and stops; an explicit "implement task 2 now" follows the normal
gates; resume restores state without executing.

**Effort:** 4–6 days. **Risk:** medium, concentrated in classification.

### 5.4 Phase 4 — Claude compatibility (needs a decision first)

**This phase reverses a documented policy** (§1.3.2) and collides with a
documented injection defence (§1.4, subagent definitions). It should not start
as an implementation task.

The existing reasoning is: `JAN.md` is the one instructions file, because only
what a user wrote *for Jan* is treated as authoritative; and subagent
definitions never come from an attached folder, because a cloned repo would
otherwise inject a system prompt and a tool allowlist into the agent. Ingesting
`AGENTS.md`, `CLAUDE.md`, project skills and project agent definitions means
ingesting content from a repository the user may have merely cloned.

That is a legitimate product call to make — every comparable harness makes it —
but it is a call, and it needs to be made explicitly with the mitigation
attached. A workable shape:

- Compatibility ingestion is **off by default** and enabled per project, by an
  explicit user action, not by file presence.
- Ingested content is **inert prose**: it enters the prompt inside an
  untrusted-content envelope and can never grant a tool, change the root,
  activate a skill, consent to an MCP server, or alter access. Invariant 5 in
  §3 is the one to test hardest here, per source type.
- Project **agent definitions and skills** are the sharpest edge, because they
  carry tool allowlists and executable resources. Suggest: tools requested by a
  project-sourced agent are **intersected** with what the user already granted,
  never unioned; bundled scripts are never executed merely because a skill
  exists.
- **Hooks, plugin installers and lifecycle scripts stay disabled** and are
  reported individually as unsupported. Partial plugin support must be shown
  per-portion, never as "compatible".

Precedence, once enabled: system/security → binding and access policy → `JAN.md`
→ `AGENTS.md`/`CLAUDE.md`. Nested `CLAUDE.md` stays directory-scoped; nested
`AGENTS.md` either gets equivalent scoping or a precise unsupported-scoping
report. Nothing above the repository root, ever — `coworkPrompt.ts:66-77`
already refuses the parent walk that `context.rs` performs on the CLI side, and
that difference is deliberate.

**Exit criteria.** Every imported component is listed in readiness with source,
state, precedence and unsupported fields; a prose-cannot-grant test exists per
source type; the default-off decision is recorded with its rationale.

**Effort:** 10–14 days, **plus a product decision that blocks the start.**
**Risk:** high — this is the phase where a subtle mistake becomes a prompt
injection path into a tool-using agent with filesystem access.

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

**Starts from:** a working engine on the wrong side of the wall (§1.4). The
first task is not writing a snapshot system; it is **promoting `git.rs`** from
`pub(crate)` to a shared service both harnesses use, without regressing the TUI.

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

Acceptance scenarios, not implementation. Includes creating
`scripts/cowork-compat-smoke.sh`, which does not exist today (§1.3.4), and an
end-user manual checklist. Cheap, and it is what turns the preceding phases into
something a user can verify without writing a defensive prompt.

**Effort:** 2–3 days.

### 5.8 Phase 8 — verification and platform evidence

See §6. The classification scheme from the request —
runtime-verified / unit-tested-only / construction-only / detected-but-unsupported /
externally-blocked — should be applied per claim and recorded in the phase's
report. The rule that matters: a skipped test is never reported as support.

---

## 6. Verification: what this environment can and cannot prove

Measured at `adfd071` in this container:

| Check | Status |
|---|---|
| Dependency install | Works, but **not out of the box** — see below |
| `yarn test:web` | Runs; baseline recorded in §6.1 |
| Rust plugin tests | **Blocked** on missing system libraries |
| macOS native / WebView smoke | Impossible here (Linux container) |
| Windows fail-closed runtime | Impossible here |
| Linux bubblewrap runtime | Possible in principle; needs `bwrap` present |

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

**Rust tests are blocked here, not broken.** `cargo test --lib` in
`tauri-plugin-agent-tools` fails building `atk-sys` and `gdk-sys` — GTK/WebKit
development headers are absent. crates.io itself is reachable (the dependency
graph compiled up to those two). Installing `libgtk-3-dev` and
`libwebkit2gtk-4.1-dev` is the fix; whether that succeeded in this session is
recorded in §6.1.

**Two of the 22 verification steps in the request cannot be satisfied from any
Linux container** — macOS native/WebView smoke and Windows fail-closed runtime.
They belong in CI on those runners, and any claim about them made from here is
construction-only by definition.

### 6.1 Baseline results at `adfd071`

- **Web suite, cold (packages unbuilt):** 305 test files — 241 passed, 64
  failed; 2,770 tests — 2,727 passed, 43 failed. Failures are module-resolution,
  not assertions.
- **Web suite, after building workspace packages:** see the commit message /
  PR description accompanying this document for the re-run figures.
- **Rust plugin tests:** blocked on system libraries as described above.

---

## 7. Recommended sequence

1. **Phase 1** (access modes + worktrees) — foundational; Phases 5 and 6 both
   depend on it.
2. **Phase 2** (context pack + inspector) — independent of Phase 1, highest
   ratio of user-visible payoff to risk, and the one phase whose diagnosis in
   the request is exactly right.
3. **Phase 3** (first-turn gate) — small, and it reuses plan mode's mechanism.
4. **Phase 6** (checkpoints/rewind) — after Phase 1; mostly promotion of
   existing, already-exercised code.
5. **Phase 5** (agent teams) — after Phases 1 and 6.
6. **Phase 4** (Claude compatibility) — **last, and only after the policy
   decision in §5.4 is made**, because it is the only phase that trades away an
   existing security property, and doing it under time pressure at the end of a
   long epic is how injection paths get shipped.
7. **Phases 7–8** continuously rather than as a tail.

Rough total: 45–66 implementation-days, excluding the Phase 4 decision and
excluding review. That is the number worth reacting to before committing to the
epic as a single unit of work.
