# Agent harness architecture

Scope: the coding-agent harness in this repository -- the orchestration loop, its
toolset, the permission gate, and the surfaces that drive them. It is the design
reference for the 200-item backlog in
[`AGENT_HARNESS_FEATURE_REGISTRY.md`](./AGENT_HARNESS_FEATURE_REGISTRY.md).

## 1. Where the harness lives today

| Layer | Location | Responsibility |
| --- | --- | --- |
| Orchestration | `src-tauri/src/core/agent/` | The turn loop, upstream clients, subagents, context assembly, compaction, skills, plugins |
| Toolset | `src-tauri/plugins/tauri-plugin-agent-tools/` | Built-in tools, the capability gate, path sandbox, process jail, skill and memory stores |
| MCP | `src-tauri/src/core/mcp/` | MCP client, OAuth, tool dispatch, cancellation, truncation |
| Persistence | `src-tauri/src/core/threads/` | Thread metadata, wire history, per-thread files |
| CLI surface | `src-tauri/src/core/cli/`, `src-tauri/src/bin/jan.rs` | Headless run, TUI, display journal, resume |
| Cowork harness | `web-app/src/lib/cowork*.ts` | The desktop route's own loop, budget, dispatch, prompt, team coordination, worktree binding and context accounting |
| Desktop surface | `web-app/src/` | React UI: transcript, approvals, diffs, subagent lanes, rewind |

There are two harnesses, not one: the Rust harness drives the CLI and TUI, and
the Cowork harness drives the desktop route. They share the Rust toolset, the
gate and the sandbox, but not the loop. Several backlog items are `in-progress`
precisely because a capability exists on one and not the other -- compaction
(`AH-076`) and context accounting are the clearest cases -- and an item is not
`verified` while only one surface has it.

Three properties of the existing design are load-bearing and are preserved by
every item in the backlog:

- **The toolset builds without Tauri.** `tauri-plugin-agent-tools` compiles with
  `--no-default-features` so the headless CLI and the desktop app share one
  implementation of tools, sandboxing and gating. New harness code must not drag
  the GUI stack into that graph.
- **The gate is the trust boundary.** `tools/gate.rs` is the single place a call
  is allowed, denied or escalated to a human. Surfaces render decisions; they do
  not make them.
- **No instruction file grants authority.** Project, compatibility and skill
  instructions are content, not policy: none of them may move the repository,
  grant a tool or redirect where changes go, however they are phrased. Every
  compatibility item in Phase 6 inherits this.

## 2. Decisions

Each decision states the constraint it imposes on the backlog. They are numbered
so registry entries and commit messages can cite them.

### AHD-001: the registry is the source of truth

`docs/agent-harness-features.json` is authoritative; the markdown registry is a
rendered artefact. Backlog items are never deleted, merged or renumbered -- an
item leaves only as `verified`, `platform-blocked` or `rejected-with-decision`,
and the latter two require a written `blockedReason`. Enforced by
`scripts/agent-harness/validate-registry.mjs`.

### AHD-002: one canonical event, many renderings

The harness emits one versioned event stream. Streaming to a UI, the display
journal, the audit log, replay and the headless event API are all *consumers* of
that stream, never parallel implementations of it.

Today `StreamEvent` (`core/agent/events.rs`) is a UI streaming type that is never
persisted, and `cli/journal.rs` keeps a separate rendering journal. That is the
root cause of five registry gaps at once (`AH-032` replay, `AH-049` and `AH-050`
audit logs, `AH-177` export, `AH-183` event streaming), which is why the
canonical event model is Phase 0 work rather than an observability nicety.

### AHD-003: identity before everything that has to be correlated

A run has one id. Thread, session, subagent, event, checkpoint and audit records
all carry it. Audit found three independently minted ids (`thread_id`,
`session_id`, subagent `run_id`) that nothing correlates; every later phase that
needs to join records across surfaces depends on fixing that first.

### AHD-004: errors are typed, and the type decides the policy

The orchestrator is `Result<_, String>` end to end, with error classes encoded as
prose prefixes (`"ERROR [ask_cancelled]: ..."`) that callers substring-match. A
single error enum classifies failures by kind, by retryability and by audience
(model-visible, user-visible, internal). Retry policy (`AH-024`, `AH-025`) reads
retryability off the type instead of re-deriving it per call site.

### AHD-005: permission rules match resources, not tool names

Rules are `(subject, capability, resource)` predicates, written as
`[subject/]tool[(pattern)]` in a project's `agent.toml`. All three dimensions are
live: "allow `read` under `src/**`", "deny `bash` running `git push --force`" and
"deny `agent:reviewer/bash`" are each expressible, which is why `AH-034`,
`AH-036`, `AH-037`, `AH-043` and `AH-046` were one design change rather than
five.

**The subject dimension.** `subject::Subject` names the actor a decision is made
*for*: `user`, `agent` (the top-level agent), `agent:<name>` (a subagent by the
name it was dispatched under), `role:`, `skill:`, `mcp:`, `session:`, `project:`.
An unqualified rule covers every subject, so a rule set written before subjects
existed keeps its meaning exactly. An unparseable or unrecognised subject is
`Subject::Unknown`, which matches no rule and is permitted by none: a caller that
cannot say who it is acting for does not get the benefit of the doubt.

The subject reaches the gate from three places, and all three must agree or the
model is offered a tool it is then refused:

* `resolve_decision` takes the subject as a parameter -- the execution gate.
* `ToolPermissions::is_denied` / `is_allowed` / `advertises_mcp` take it too --
  the advertising gate. Asking "is this denied for anyone" is what made a rule
  about one subagent hide the tool from every agent.
* `intersect_allowed_tools` reads the parent's rules *for the child*, by the name
  it is being dispatched under, when narrowing a subagent's toolset.

A run's subject is decided once, in `orchestrate_inner`, from
`OrchestrationArgs::agent_name`: `None` is the main agent, and `run_subagent`
sets it on the child's cloned args. A subagent cannot dispatch its own children,
so there is no chain to carry.

### AHD-005b: one redactor, and it never falls back to the original

Credentials are removed by `secrets::redact_secrets` in Rust, and every writer
goes through it: the audit log, the activity record, the prompt snapshot, memory,
and -- via the `secrets_redact` command -- tool output the renderer persists into
a thread. A transcript is a file that outlives the run and gets exported, so
anything a tool printed is in it verbatim otherwise.

Two rules hold everywhere:

* **The word-level pass runs first, the line-level pass is the fallback.** A
  credential in prose gets replaced in place, leaving the sentence that says
  where it came from; a value in an assignment shape need not look like anything
  in particular (`PASSWORD = hunter2`), so there the whole value goes.
* **Failure withholds, it does not pass through.** A caller that cannot confirm
  redaction ran stores a placeholder. A fallback to the unredacted text is a
  fallback that leaks on precisely the path least likely to be tested.

### AHD-005c: an approval is about a specific version of a file

A `write` or `edit` that needs approval is staged as a `StagedPatch`: hunks
computed against the file as it is when the question is asked, plus a stamp of
that content. The stage lives until the answer arrives, and the answer is
applied only if the file is still that content. Otherwise the call is refused
with nothing written.

Three consequences, all deliberate:

* **Hunks carry no merged context.** A unified diff joins nearby changes; here
  two unrelated edits stay two hunks, because they are two decisions.
* **One implementation of "what will this edit do".** The staged proposal and
  the write both come from `apply_edits`, so what is reviewed is what lands.
* **Refuse, do not merge.** When the base moved, the model re-reads and
  proposes again. A three-way merge would produce a file nobody reviewed.

### AHD-006: the capability model covers every dispatchable tool

`Capability::{Read, Write, Exec, Net}` classifies the 16 built-ins and drives
gating, plan-mode enforcement and concurrency. MCP tools still carry no
capability, which is what keeps `AH-013` (plan mode being trustworthy for MCP)
open.

Per-server policy (`AH-041`) no longer waits on that, because it does not need a
capability: it keys on the **server**, in `mcp_trust`. A tool name is chosen by
whoever publishes it, so it is not an identity -- two servers can both publish
`fetch`, and a call that names no server is answered by whichever one the search
reaches first. Trust is therefore recorded per server, persisted, and checked in
`call_tool` against the server the tool was actually resolved on. An "allow once"
answer is a single-use, short-lived ticket that is never written to disk, so it
cannot quietly become a standing permission.

### AHD-007: fail closed

Absent policy denies. Absent sandbox backend withholds `bash` rather than running
it unconfined. An unknown capability is not `Read`. Subagent authority is the
intersection of definition, call site and parent, and a parent deny always wins.
This already holds in `subagent.rs` and `jail.rs`; new authority paths inherit it.

### AHD-008: concurrent agents do not share a working tree

`core/agent/worktree.rs` already owns managed worktrees -- create, validate,
name, list, recover and discard, on the `jan/cowork/` branch prefix -- and a
Cowork run is bound to one. That convention is the harness's convention; nothing
else may introduce a second naming scheme, because cleanup (`AH-170`) can only
distinguish an abandoned agent worktree from a developer's own by its name.

Per-agent worktrees (`AH-107`) extend that module rather than adding a
second one. Both runners use it:

* **Cowork teams** (`web-app/src/lib/coworkTeam*.ts`): a task that sets
  `isolate` gets its own worktree and write grant before any child starts.
* **The Rust subagent runner** (`subagent.rs`, `isolation_for`): a child that
  can change files, dispatched in a git repository, works in a worktree of its
  own by default. `project_root` is re-pointed there, so its tools, write
  roots and shell all start in it. `isolate: false` is the only way for a
  writing child to share the project tree. A request for isolation that
  cannot be met (not a repository, a worktree that cannot be made) is a typed
  `SubagentError::Isolation`, and the child does not run.

Either way the child is recorded in `core/agent/team_children.rs` before it
starts and settled when it ends, with the first ending kept. The record
holds only its identity (parent session and task id); its worktree, branch
and base commit are found from Git. When it settles, a fingerprint of what it
changed is stored. The review list (`CoworkTeamReviews`) reads these records
back from disk after a restart. It proposes a child's changes through the
ordinary proposal store (`AH-146`), so there is no second apply path. Several
cases are typed refusals, never an empty or partial review:

* a worktree that is gone, is not a Jan-owned worktree, or has moved off its
  branch;
* a worktree that holds a link out of itself;
* a worktree that changed after its child finished;
* a child that failed, was cancelled or was interrupted. Its changes can be
  reviewed only after an explicit acknowledgement, and the proposal's
  subject then says so.

Conflicts between team tasks are checked before dispatch, on declared scopes:
the same file, a folder and something inside it, either end of a move, a
delete, and the lock file a manifest change regenerates beside it. Paths are
compared normalised and case-folded, and reads never conflict. An overlap is
the user's to resolve: run one task after the other (an ordering-only edge
that implies no data dependency), narrow a scope, or let them run side by
side. The last choice is recorded on both children and is never a waiver.
The apply-time check still compares each proposal's base and the folder as
it is now. This is overlap of declared paths, not semantic conflict
detection, and the UI says so.

### AHD-009: what the model saw is a record, not a re-derivation

The dispatched payload is persisted (`AH-078`). Token accounting, replay,
diffing and the inspector read that record. The current `/context` report
re-derives the prompt from present-day disk state and admits in its own docstring
that it omits parts of what was sent; a resumed thread therefore cannot be shown
the context it actually ran under.

**Replay (`AH-079`)** sends a stored snapshot's request to the model again.
The backend (`core/agent/replay.rs`) owns the record and hands out the payload.
A replay begins by naming a snapshot and its session, and gets back the stored
request or a typed refusal:

- `not-found`: no such snapshot in that session;
- `unavailable`: no payload was stored;
- `redacted`: fields were removed before storage, so the request is not what
  the model saw;
- `not-a-chat`: the stored request is not a chat request.

The renderer (`lib/contextReplay.ts`) sends the request unchanged, through the
ordinary provider transport, to the provider the turn used. Renderer-side
refusals are also typed and recorded: `provider-gone`, `provider-unsupported`
(Anthropic wire format, MLX) and `model-not-running` (a local model is never
started for a replay).

The transport snapshots the replay dispatch like any other, under agent
`replay`, which the timeline's sink ignores. `settle` compares that
snapshot's hash with the original's, so `matched` is checked on the record
rather than asserted by the caller. Tool calls in the reply are recorded by
name and never run.

Endings are `completed`, `failed` (`provider-error`, `stream-cut-off`),
`cancelled` and `refused`. The first ending is kept. A `running` record
written by an earlier process reads as `interrupted`, and one this window no
longer holds is recorded as `abandoned`. Records live in
`<data>/replays/<sha256(session)>.json` and are redacted and bounded before
they are written.

Snapshot ids carry the process's launch stamp. Before this, every launch
numbered its snapshots from `snap-1` again, so an id could name an earlier
launch's record.

### AHD-009b: some changes need a closer look than their diff (AH-154/155/156)

A proposal's files can carry flags, which `review_flags.rs` works out from the
stored before and after of each file:

- `dependency`: a manifest's dependency entries were added, changed or
  removed. `package.json`, `Cargo.toml` (every dependency table),
  `pyproject.toml`, `requirements*.txt` and `go.mod` are read and compared
  entry by entry. Other manifests are flagged whenever they change. A manifest
  that cannot be read is flagged as unreadable, never passed.
- `lockfile`: a lock file changed. The review lists lock files apart from
  source changes.
- `migration`: a file in a migrations directory, or SQL with schema or data
  statements. It is described as irreversible: reverting the file does not
  undo a migration that has run.

A selected file with a flag is applied only when the approval names it in
`acknowledged`. `plan` works the flags out again from the stored blobs rather
than trusting the record, so a record whose flags were removed on disk still
needs the acknowledgement. A refusal is the typed `Unacknowledged(paths)`, and
nothing is written, including the unflagged files in the same approval. An
acknowledgement covers only the path it names, with no case folding, and only
for files that are both selected and flagged.

This is a reading of well-known formats, not a package manager: it does not
resolve versions or fetch anything.

### AHD-009c: a worktree exports as a patch bundle (AH-168)

`agent_worktree_export` writes a managed worktree's changes since its base
commit to `<data>/exports/<stamp>-<worktree>/`. The changes are committed or
not, tracked or not, and read exactly the way a proposal reads them, so links
out of the worktree refuse the export and `.git`/`.jan` are never included.
The bundle holds three things:

- `changes.patch`: one unified diff that `git apply` reads
  (`patch_export.rs`), with new and deleted file markers and the missing-newline
  note.
- `files/<path>`: the new content of any file that is not text.
- `manifest.json`: repository, branch, base and head, and for each file its
  change, counts and review flags. It also holds SHA-256 hashes of the patch
  and of each shipped file.

The record arrives over IPC, so it must lie inside Jan's worktrees folder and
still be in the state it was recorded in. Refusals are typed: `not-managed`,
`not-ready`, `link-escape`, `no-changes`, `io`. The bundle is assembled under
a `.partial` name and renamed only when complete. A failure removes the
partial directory, and one left by a stopped process is swept by the next
export. Nothing in the worktree or the user's checkout is written. Applying a
bundle elsewhere (AH-169) is not implemented.

### AHD-010: persistence is versioned

Every on-disk structure carries a schema version and has a migration path.
`thread.json`, `messages.jsonl` and `display.jsonl` currently carry none, so no
format change is safely shippable.

### AHD-011: state lives in the harness, not in a surface

Checkpoints, resume and replay currently live in `cli/tui.rs` and `cli/mod.rs`,
so the desktop app and the server proxy have none of them. Harness capabilities
belong in `core/agent/`; surfaces drive them.

### AHD-012: exclusive file ownership per lane

Lanes own modules exclusively for the duration of a phase, work in separate
worktrees, and never edit the same file concurrently. Cross-boundary changes are
made by the owning lane and consumed by the other.

## 3. Lane and file ownership

| Lane | Owns |
| --- | --- |
| `lane-01-architecture-registry` | `docs/AGENT_HARNESS_*`, `docs/agent-harness-features.json`, `scripts/agent-harness/`, `src-tauri/harness/` |
| `lane-02-execution-runtime` | `core/agent/loop.rs`, `plan.rs`, `todo.rs`, `session.rs`, `goal.rs`, `reminder.rs` |
| `lane-03-permission-security` | `tauri-plugin-agent-tools/src/permissions.rs`, `tools/gate.rs`, `tools/cmdscan.rs`, `tools/jail.rs`, `tools/sandbox.rs`, `tools/appcontainer.rs` |
| `lane-04-repo-index-lsp` | new index and LSP modules; `tauri-plugin-agent-tools/src/project_browse.rs` |
| `lane-05-context-memory` | `core/agent/context.rs`, `compaction.rs`, `memory.rs`, `tauri-plugin-agent-tools/src/memory.rs` |
| `lane-06-agents-worktrees` | `core/agent/subagent.rs`, `git.rs`, new worktree module |
| `lane-07-mcp-skills-plugins` | `core/mcp/`, `core/agent/skills.rs`, `skill_hub.rs`, `plugins.rs`, `plugin_commands.rs` |
| `lane-08-git-pr-workflows` | new git tool and workflow modules |
| `lane-09-ux-observability` | `web-app/src/` agent surfaces, `core/cli/journal.rs`, `run_report.rs` |
| `lane-10-provider-enterprise` | `core/agent/upstream.rs`, `genai_bridge.rs`, `global_config.rs`, `core/server/provider_secrets.rs` |
| `lane-11-cross-platform-verification` | `docs/AGENT_HARNESS_VERIFICATION.md`, CI workflow files |
| `lane-12-security-regression-review` | harness test corpora; reviews every lane, owns no production module |

`core/agent/events.rs` and `src-tauri/harness/` are owned by lane 01 through
Phase 0 and handed to lane 02 in Phase 1, because every other lane consumes them.

## 4. Phase 0 foundation modules

Phase 0 adds `src-tauri/harness/` (crate `jan-agent-harness`): a dependency-light
crate holding the models every other lane builds on -- run identity, the event
model and its versioned envelope, the error taxonomy, the persisted-state schema
and the shared test fixtures. It deliberately depends on nothing from `tauri` or
the app crate so that the CLI, the desktop app and tests can all link it, and so
that `cargo test -p jan-agent-harness` stays fast enough to run on every change.

It holds no worktree module: per AHD-008 that convention already exists in
`core/agent/worktree.rs`, and a second one in a foundation crate would be the
drift this document exists to prevent.

Adoption is incremental: the crate lands with its own tests first, and each
consuming module migrates in the phase that owns it (per AHD-012), rather than
one atomic rewrite of `loop.rs`.

## 5. Relationship to the Cowork harness blueprint

[`COWORK_HARNESS_BLUEPRINT.md`](./COWORK_HARNESS_BLUEPRINT.md) is a separate,
active programme covering the Cowork desktop harness
(`web-app/src/lib/cowork*.ts`) and the Rust promotions it needs. It has its own
Phase 1-8 numbering, most of which it reports as built.

The two documents are not alternatives and their phase numbers do not
correspond. Read them as:

- The blueprint is **narrower and further along**: one surface, eight phases,
  largely delivered. It is the authority on the Cowork harness's ownership map,
  its security invariants and its verification evidence.
- This registry is **wider and earlier**: 200 items across both harnesses and
  the shared Rust core, most of them not started.

Where they overlap, the blueprint wins on fact and this registry records the
outcome. Registry items whose work the blueprint already delivered are marked
`implemented` and point at the shipped module -- notably managed worktrees,
context measurement, checkpoints and compatibility ingestion. Citing
"Phase 5" without saying which document is a defect; cite `AH-###` or a
blueprint section number.

## Background tasks: lifecycle and control (AH-101 / AH-102)

There is one task system, with three sources that feed one record:

- **Background shell commands** -- the agent-tools job registry
  (`tools/handlers.rs`). `bash {"command", "background": true}` backgrounds at
  once (a timeout given with it means "wait this long first") and returns a
  job id `bash-<process prefix>-<n>`; the prefix keeps ids from a previous app
  run from ever naming a new job. With no command, `bash` manages jobs:
  `{"action": "list"}`, `{"job_id"}` to await and collect (exactly once),
  `{"job_id", "action": "status"}` for state and recent output without
  consuming anything, `{"job_id", "action": "cancel"}` to kill the process
  tree. Every job belongs to the conversation that started it (`job_owner`,
  the thread id on the desktop); another conversation's job reads as "no such
  job" everywhere, including the Tauri `bash_jobs_list` / `bash_job_kill`
  commands. Each owner holds at most 32 jobs; the oldest finished job makes
  room, and with all 32 running a new one is refused and stopped. Commands and
  peeked output are redacted with `audit::redact`.
- **Subagents in the Rust loop** -- `BackgroundSubagents` (`subagent.rs`).
  Each child's life is one atomic phase (queued, running, finished,
  cancelled) moved only by compare-and-swap, so a cancel and the child's own
  progress cannot both win. `list_subagent_runs` lists the run's children;
  `cancel_subagent` takes a queued child out of the queue before it starts or
  aborts a running one, settles its checkout and announces its end once.
  Parent teardown cancels every child (`AbortOnDrop`); a clean parent exit
  waits for them (`join_all`).
- **Cowork subagents and commands** -- recorded by `coworkActivityRecorder`
  into `coworkActivity`, the model the Background Tasks panel, the workflow
  card and the chip all read. A child is stopped through its own
  `AbortController`, a command through `bash_job_kill` scoped to the session.
  A failed stop is kept on the row (`cancelError`), not only toasted.

Nothing survives an app exit: graceful shutdown reaps every process tree the
plugin started, and subagent futures end with the process. On the next start
`settleOnLoad` marks anything left in flight `interrupted` with the reason
"Interrupted by application exit" and drops its job id, so the record can
never show it running. There is no durable worker, which is why AH-101's
persistence criterion is open.

## Tool activity: the canonical record (AH-050) and the timeline (AH-172)

Two logs, deliberately separate:

- `audit/permissions.jsonl` (`plugins/tauri-plugin-agent-tools/src/audit.rs`)
  records *decisions* -- what was allowed, refused, expired or revoked.
- `audit/tool-activity.jsonl` (`.../src/activity.rs`) records what each tool
  call *did*: one item per call, moving through `requested`,
  `awaiting-permission`, `allowed`, `refused`, `running`, `succeeded`,
  `failed`, `cancelled`, `stale`, `timed-out`.

**One way in.** `web-app/src/lib/coworkDispatch.ts` routes every tool call in
the app -- the main agent's, a subagent's, a background task's, an MCP
server's, a skill's -- and `withToolActivity` wraps that one function. A tool
added later is covered without being told to be, and there is no second path
that could execute something the record does not show.

**Ordering.** `activity::items` folds the log into one item per call, ordered
by when each was *requested*. Two concurrent calls therefore read in the order
they were made however their results interleave. Recording is queued rather
than awaited (`toolActivity.ts`), so a tool never waits on its own audit line,
and the queue is what stops `running` landing after `succeeded`.

**Restart.** `settle_unfinished` runs in `.setup()` before the window opens:
a call left `running` by a killed process becomes `stale`, since nothing
survives that could finish it. It is idempotent.

**Rendering.** `coworkActivityTimeline.ts` reconciles the record against the
session transcript. The record wins on what became of a call; the transcript
keeps what the record deliberately does not carry (arguments, output, diff).
Nothing is ever removed, and a call the transcript lost is restored from the
record. `keepToolActivity` on `MessageItem` stops Cowork folding finished tool
calls into "Worked for Ns" the way a chat thread does -- there the reasoning is
scaffolding behind an answer; here the tool calls are the work.

**Hiding.** "Hide completed tool activity" (default off) may hide only
`succeeded`. A refusal, failure, cancellation, stale or running call always
stays on screen, with a compact count and a temporary reveal. It is a display
filter: the turns stay in the session, in exports and in search.

**Redaction.** Applied on the way in, in `tool_activity_record`, because the
file outlives the window. The record carries a short redacted detail, never a
tool's whole output.


## Context: what fits, what it cost, and what the model can hold

Three separate questions, deliberately answered by three separate things.

**What the model can hold (AH-195).** `web-app/src/lib/modelCapabilities.ts`
resolves one `ModelCapabilities` from sources the app already has, in order of
how much they are worth trusting: the user's own setting, the provider's
metadata for that model, the local runtime's report for the loaded model, the
provider default, then bundled offline metadata. Nothing here reaches the
network. It recognizes `ctx_len`, `ctx_size`, `n_ctx`, `context_length`,
`max_context_length`, `max_model_len` and `context_window`, and reads Jan's own
nested `settings.<key>.controller_props.value` shape as well as a `/models`
entry's flat one -- reading only `ctx_len`, as the app used to, left every
OpenAI-compatible endpoint permanently "not known". `n_ctx_train` is kept apart
from `n_ctx`: llama.cpp's `--fit` routinely runs a 32k model in an 8k window,
and the smaller number is the real limit. An unknown window stays unknown; a
guessed one would silently truncate.

**What fits (AH-088).** `planTurn` in `coworkBudget.ts` reserves room for the
reply -- 15% of the window, floored at 512 and capped at 8192 -- and classifies
the turn as `fits`, `tight`, `over` or `unknown` *before* dispatch. `over`
raises `ContextOverflowError` inside the run's own try block, so the turn is
torn down like any other ending: the user's message is committed and the run is
closed. `unknown` is never a refusal -- it is a limit Jan could not discover,
not one that was exceeded.

**What it cost (AH-073).** Jan's own measurement is bytes over four and is
labelled an estimate. The exact number comes from the server that tokenized the
payload, and `usage.rs` records it against the invocation *and* the snapshot of
the payload it counted, because a run makes many model calls and a count shown
beside the wrong one looks authoritative while being wrong. A provider count
replaces an estimate for the same invocation; an estimate never replaces a
count. Lookups are scoped like snapshot lookups: name an invocation, a run or a
session, or be refused.


## Run guards: budgets, deadlines, retries and loops

All four live around one loop (`web-app/src/lib/coworkRunner.ts`), because they
all answer the same question -- may this run take another step -- and answering
it in four places is how they disagree.

**Steps (AH-018).** A step is one model turn. The cap is checked *before* the
step that would exceed it, and the spend is written to the session's
`runBudget` as it goes, so a run killed mid-flight comes back having spent what
it spent.

**Wall clock (AH-019).** `runDeadline.ts` holds an absolute deadline, which is
what makes it survive a restart unchanged. It counts waiting -- a run stuck ten
minutes on a permission prompt nobody will answer has spent ten minutes.
`restoreDeadline` treats a remainder larger than the budget as a clock that
moved, not a run that gained time.

**One operation (AH-021).** `operationSignal` chains a timeout to the run's own
signal, so a stream that goes quiet and a user's Stop cancel by the same path.
A timeout is reported as a timeout and an abort as an abort. `terminalReason`
collapses simultaneous limits to one, because a run that reports itself as both
timed out and over budget describes something that did not happen.

**Retries (AH-024/AH-025).** `runRetry.ts` classifies before it decides.
Transient and rate-limited are eligible; auth, invalid input, refusals,
cancellation and deterministic tool failures are not -- retrying those re-sends
the same rejection, or works around a person who said no. Backoff is
exponential with full jitter and honours `Retry-After` in both spellings; waits
are cancellable, and a wait cut short is never mistaken for a completed one.
Each attempt is a fresh dispatch, so it gets its own invocation, snapshot and
accounting.

**Loops (AH-029/AH-030).** `runLoopGuard.ts` takes the run's whole call history
and looks for the shapes a stuck model produces: the same call, the same call
spelled differently, the same failure, edits that undo each other, delegation
that keeps delegating. It is counted from what happened rather than asked of
the model, because a model in a loop is the one most likely to insist it is
about to finish. Five identical calls, not three: re-reading a file after
editing it is ordinary work, and a guard that stops ordinary work gets
turned off.


## Forking a session (AH-201)

`useCoworkSessions.forkSession(id, throughTurn)` copies a conversation up to a
turn and gives it a new session. The messages are rebuilt from the kept turns
rather than sliced out of the parent's array: the two do not correspond one to
one, and a message array cut at the wrong index sends the model half a turn.

The rule that matters is what a fork does *not* carry. No folder, no access
mode, no edit consent, no write grant, no run budget. Inheriting any of them
would make forking a way to multiply authority that was granted once, and would
put two sessions on one checkout without either knowing. A fork asks for its
own.

An unknown session, or a divergence point outside the conversation, is refused
and returns null -- not clamped to the nearest turn, because a fork silently
taken somewhere else is not the fork that was asked for.
