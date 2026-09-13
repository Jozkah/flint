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
diffing and the inspector read that record.

**The CLI's view of it (AH-087).** `jan cli agent prompts <session>` lists a
session's recorded requests; `--show last` or `--show <id>` prints one through
`PromptSnapshot::render_text`: every message in order with its role and whole
text (the system prompt's date line and memory block are in it because they
were in the payload), each tool call with its arguments, each tool result, the
tools offered, and a header with model, dispatch kind, hash and redaction
count. It reads the same `prompts.jsonl` as the desktop panel, through the same
`scoped_lookup`, so a snapshot id is only readable with the session it belongs
to.

**Context diff (AH-086).** "Compare with the previous request" in the
snapshot panel diffs a stored payload against the one the same session sent
just before it (`lib/contextDiff.ts`). Messages are matched as a longest
common subsequence keyed by role, answered call and text, so a window that
drops its oldest turns and appends new ones keeps its middle. Each item that
entered or left carries a reason read from the payloads alone: the new
request, the model's previous answer or tool call, a tool result, steering;
left the window (trimmed or compacted); memory recalled or withdrawn
(`<remembered_facts>`); project instructions changed; a tool offered or no
longer offered. It never re-derives a payload. The current `/context` report
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

### AHD-009f: shipped agent roles (AH-094..099)

`roles.rs` ships six versioned subagent definitions, which a parent dispatches
by name with the `task` tool:

| Role | Tools | Job |
| --- | --- | --- |
| explorer | read, ls, find, grep | find and explain, with references |
| planner | read, ls, find, grep | investigate, then return a phased plan (plan mode: read only) |
| implementer | read, ls, find, grep, write, edit | make the change it is given, nothing else |
| reviewer | read, ls, find, grep | report real defects, each with its location |
| tester | read, ls, find, grep, bash | select and run the covering tests, report exact results |
| security | read, ls, find, grep | report exploitable weaknesses and the attacker's path |

**Where they sit.** They form their own scope, `SubagentScope::Builtin`,
loaded first, so a plugin, user, project or desktop-saved definition of the
same name replaces one. The scope is read-only: `create`, `create_in` and
`subagent_dir_for` refuse it. The desktop list (`agent_subagent_list`)
returns only the winner for each name, because the renderer resolves a name
to its first match. Each role carries `scope: builtin` and a version in its
description.

**Authority comes from the allowlist, never from the prompt:**

- A role's list is explicit, so a tool it does not name, MCP tools
  included, is never offered.
- The child's set is that list narrowed by the parent: by the parent's tool
  names in the renderer (`intersectAllowedTools`), and by the parent's deny
  rules in Rust (`intersect_allowed_tools`). A call site can narrow it and
  never widen it.
- `task`, `team`, `ask` and `todo` are withheld from every child, so a role
  cannot dispatch further agents.
- The four read-only roles are checked against the tool capability table
  (`read_only_roles_hold_no_mutating_tool`), so they hold no write, exec or
  network tool.
- The implementer's writes and the tester's commands still go through the
  parent's approval gate. In a team, each isolated child works in its own
  worktree and is reviewed through AH-107/109.

**Enforced at the call, not only at advertisement.** A model can emit a call
to a tool it was never offered. Such a call is refused by the harness, before
any gate, prompt or auto-approval, as a typed refusal of kind
`tool-not-offered`:

- Desktop (Cowork): the AI SDK marks it invalid; `runTurn` returns a
  `ToolOutcome` with `refusal: { kind, tool, agent }`, and the execution
  record's `refused` event carries `refusal: "tool-not-offered"` under the
  role and its run's session.
- Rust loop (CLI and desktop agent runs): `CompositeToolInvoker` holds the
  run's `allowed_tools` and refuses anything outside it, whatever its name
  (built-in, `task`/`dispatch_subagent`, `ask`, `todo`, MCP), with
  `ToolOutcome.refusal = Some(HarnessRefusal::ToolNotOffered)`. Before this, the
  allowlist only shaped what was advertised, and a child's forged `write`
  reached the gate -- which the CLI auto-approves.

**Stopping a role.** Each dispatched role has its own controller; the
Background Tasks panel's Stop reaches only that child, which ends as
`cancelled` (never `failed` or `interrupted`), records a `subagent`
`lifecycle.cancelled` event in its session, and sends nothing more. After a
restart the child reads back as cancelled and nothing is dispatched again.

### AHD-009e: one versioned envelope for a session's events (AH-005), exported (AH-177)

The Phase 0 harness crate that first carried an event envelope never reached
the main line (see the handoff for 16ae36728). It is rebuilt here on current
interfaces rather than restored, as `event_log.rs` in the agent-tools plugin.

**The log.** Each session has one append-only JSON-lines log,
`<data>/events/<sha256(session)>.jsonl`. One envelope per line carries:

- `v`: the envelope version, currently 1. A reader meeting a newer version
  fails with a typed error rather than guessing.
- `id`: stable, chosen by the writer. The same id is one event, even across a
  restart.
- `session`, `run`, `invocation`.
- `seq`: assigned by the log, strictly increasing within the session.
- `at`: RFC 3339, UTC.
- `kind`: a dotted name. A kind this build does not know is kept and read back
  verbatim.
- `payload`: redacted before it is written, with `redactions` naming what was
  removed. It is bounded to 64 KiB, and above that replaced by a note.

**Recovery and limits.** A torn last line from a crash is skipped by readers
and cut off before the next append. Any other bad line is a typed error, never
a silent gap. A session log is bounded at 32 MiB, and the oldest of more than
500 session logs are removed.

**Writers.** Two paths write events, both in the backend:

- `tool_activity_record` appends every tool phase (`tool.requested` …
  `tool.timed-out`, one per `activity::Phase`) and every run lifecycle event
  (`lifecycle.<phase>`: compaction, steering, a subagent or job stopped),
  through `activity::record`. That is the only writer of the execution
  record: the payload is the whole activity event (schema v2, redacted and
  bounded), the id is `tool:<call>:<phase>` or `life:<call>:<phase>`, so a
  retried record is one event. The restart settlement writes `tool.stale`
  the same way.
- `agent_events_record` takes the run-level events the renderer owns:
  `run.started`, `run.ended` (with `stoppedBy`), `agent.dispatched`,
  `job.started` and `job.ended`.

**The Rust loop writes too.** The CLI and the desktop's own agent runs go
through `CompositeToolInvoker`, which (with `record_to` set to the data
folder) records each asked-for call before any gate and its ending --
succeeded, failed, or a typed refusal -- with input, output and diff, under
the run's session, run and agent, `source: agent-loop`; `orchestrate_inner`
records `run.started` and `run.ended`. The loop's text streaming, steering and
compaction are not written yet (AH-004).

**One store (integration of AH-005 with AH-050's v2 record).** Before the
integration, main wrote each tool phase twice -- to this log and to
`audit/tool-activity.jsonl` -- and the desktop branch's v2 record wrote only
the latter, so the two could disagree on how a call ended (the restart
settlement, for one, wrote only the legacy file). Now this log is the single
source, and `activity::items` (the timeline, the Background Tasks panel,
`audit_export`) is a projection folded from it. The legacy file is read, never
rewritten, so older timelines still load; a transition present in both counts
once, and an envelope written before the consolidation (smaller camelCase
payload) is read too. Only an event with no session, which has no session log,
is still appended there.

Not yet written: the Rust CLI and subagent loop's own `StreamEvent`s, and
steering and compaction. So AH-004 ("sole source for streaming, journalling,
audit and replay") stays in progress.

**Export (`event_export.rs`).** An export writes `events.jsonl` and
`manifest.json` (schema, session, run, count, first and last `seq`,
`metadataOnly`, SHA-256) under `<data>/exports/`. It is assembled under
`.partial`, can be stopped, and is never sent anywhere.

- **Metadata only by default.** Each payload is cut to a short allowlist of
  scalar fields: status, phase, tool, agent, times, exit codes.
- **Content only when asked.** Prompts, tool inputs and outputs and paths are
  included only when the person ticks it, beside a warning.
- **Inspection.** `inspect` reads an export as untrusted input and reports
  counts by kind; it runs and replays nothing. It requires exactly the two
  files, no links, a strict manifest, a matching hash, a single session and
  strictly increasing order. Failures are typed: `not-an-export`,
  `unsupported-version`, `manifest-invalid`, `hash-mismatch`, `truncated`,
  `cross-session`, `out-of-order`.

### AHD-009d: an exported bundle is imported as a proposal (AH-169)

`bundle_import.rs` reads an AH-168 bundle folder as hostile input.

1. **Private copy.** The folder is walked without following links, and every
   entry is copied into `<data>/imports/<id>.partial/`. Everything after this
   reads the copy, so the bundle cannot change between check and use.
   - A link, junction or reparse point anywhere is `entry-link`.
   - Archives, single files and links as the container are
     `unsupported-container`. Nothing is decompressed, so there is no
     decompression-bomb path.
   - Entries, total bytes, file size, manifest size, path length, depth and
     elapsed time are bounded (`too-large`).
2. **Manifest.** Parsed strictly, with unknown fields refused
   (`manifest-invalid`). A schema other than 1 is `unsupported-version`.
   Every path goes through `proposal::validate_path` plus an NFC check, which
   refuses:
   - `..`, absolute, drive, UNC and backslash paths;
   - streams and device names;
   - `.git` and `.jan` at any depth, with trailing dots or as `GIT~N`;
   - names not in NFC form.

   Paths that collide by case or Unicode normalization are `path-collision`.
3. **Entries and hashes.** The bundle must hold exactly the manifest, the
   patch and the declared `files/` (`entry-missing`, `entry-extra`). The patch
   and each shipped file must match their SHA-256 (`hash-mismatch`). The
   patch must hold exactly one section per text file in the manifest
   (`patch-invalid`).
4. **Destination.** It must be the top level of a Git repository that holds
   the base commit (`destination-invalid`, `base-missing`). Each file's base
   is read from that commit with read-only `git cat-file`/`git show`. The
   patch is re-applied to it in memory and must fit exactly. The result is
   stored as an ordinary proposal: nothing is extracted into the repository,
   and no branch, index, stash, config or hook is touched. The same bundle
   already imported, or every change already present, is `already-applied`.
5. **Apply.** The approval is the proposal's own plus the import's bundle and
   manifest hashes and the destination. `apply` re-resolves the destination
   and checks its path, root commit and base commit
   (`destination-changed`, `approval-mismatch`). `proposal::apply` then
   applies selected files and hunks atomically, with rollback. Before each
   write it recomputes flags from the stored content, checks acknowledgements,
   and re-checks links and `.git` aliases. A refusal comes back as `refused`
   with the conflicts or unacknowledged paths.

Binary files and deletions are flagged in every proposal, not only imported
ones (a rename reaches review as a deletion and an addition). A flagged file
lands only when its approval acknowledges it.

Import records live in `<data>/imports/<id>.json` and hold hashes and paths,
never file content. They survive a restart. A pending import can be abandoned,
which rejects its proposal. The private copy is removed on every path out,
including cancellation, and a copy left by a dead process is swept by the next
import.

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

## Execution timeline panel (AH-172)

The Timeline rail (`CoworkTimelinePanel`, model in `lib/executionTimeline.ts`)
reads the session's canonical event log through `agent_events_list(session,
after_seq, limit)` -- one session only, oldest first, at most 5000 per page,
with `lastSeq` so polling knows it caught up; an unreadable log is an error
shown in the panel, never an empty list.

- **Rows.** A tool call or run lifecycle item is one row folded from its
  phases (keyed by call, agent and run, so two agents reusing a provider call
  id stay two rows); every other event is its own row: `run.started`/`ended`,
  `agent.dispatched`/`ended`, `job.started`/`ended`, and per model request
  `usage.reported` (provider counts only, token-named keys) and
  `message.completed` (sizes only: characters and tool calls; the words stay in
  the transcript). Order is the log's `seq`. A kind this build does not know is
  shown by name.
- **States.** running, queued, awaiting approval, completed, failed, refused
  (with the typed refusal kind), cancelled, interrupted (a call a dead run
  left, settled `stale` at start-up) -- in words, not only an icon.
- **Categories and filters.** messages, reasoning, tools, edits, usage,
  steering, approvals, background, subagents, run; a row can be in several (an
  edit that waited for Allow once is tools, edits and approvals). Reasoning is
  a category but Cowork's runner records no reasoning size yet, so it is empty
  there.
- **Edits.** A row's `+added −removed` are that call's own diff counts; opening
  it loads the diff the backend stored for that session and call
  (`tool_activity_diff`) and renders it with file path and hunk count --
  never the repository's current aggregate and never a tool's own display
  text. `change.kind` is `created`/`deleted`/`edited` from the diff's headers
  unless the caller said otherwise.
- **Invocation linking.** Each row carries its request's invocation id;
  pressing it highlights every row of that request (tool calls, usage,
  response), which is the same id the prompt snapshot and the usage record
  carry.
- **Live, keyboard, size.** Polls every 1.5 s while a run is going and once
  more when it ends; follows the end of the list until the user scrolls up,
  then says "Paused" until "Follow live". `role="feed"`, rows are `article`s
  with `aria-posinset`/`aria-setsize` and a label of title and status; arrow
  keys, Home and End move between rows. Above 200 rows the list is virtualized
  (`@tanstack/react-virtual`).
- **Isolation.** Switching session clears the panel and drops any page that
  arrives late for the previous one.

**Audit export formats (versioned).**

- `jan-event-export`, schema 1 (`event_export.rs`): a folder with
  `events.jsonl` (envelopes, version 1: `v, id, session, run, invocation, seq,
  at, kind, payload, redactions`) and `manifest.json` (`schemaVersion, kind,
  envelopeVersion, session, run, metadataOnly, count, firstSeq, lastSeq,
  eventsSha256, createdAt, note`). Metadata-only by default: payloads keep only
  the scalar allowlist `METADATA_FIELDS` (status, phase, tool, capability,
  kind, agent, durations, exit codes, refusal kind, token counts and sizes).
- `jan-audit-export`, version 1 (`activity::export`, `audit_export(session)`):
  `{ format, version, exported_at, session, permissions: PermissionRecord[],
  activity: ToolActivityItem[] }` -- the session's permission decisions and its
  folded execution record, both redacted when written; a session is required.

## Tool activity: the canonical record (AH-050) and the timeline (AH-172)

Two logs, deliberately separate:

- `audit/permissions.jsonl` (`plugins/tauri-plugin-agent-tools/src/audit.rs`)
  records *decisions* -- what was allowed, refused, expired or revoked.
- the execution record (`.../src/activity.rs`) records what each tool call
  *did*: one item per call, moving through `requested`, `queued`,
  `awaiting-permission`, `allowed`, `refused`, `running`, `succeeded`,
  `failed`, `cancelled`, `stale`, `timed-out`. It is stored as envelopes in
  the session's canonical event log (AHD-009e); `audit/tool-activity.jsonl`
  is the pre-integration file, read for compatibility only.

**Two ways in, one wrapper.** Cowork routes every tool call -- the main
agent's, a subagent's, a background task's, an MCP server's, a skill's --
through `coworkDispatch.ts`; Chat runs its tool calls in the thread route's
tool loop (`routes/threads/$threadId.tsx`). Both wrap execution in
`withToolActivity`, and both record the permission phases around it, so a
tool added later is covered without being told to be. The Rust agent loop
(CLI and the desktop's own agent runs) writes the same record from its tool
invoker: each call as it is asked for, then how it ended, under the run's
session, run and agent, with `run.started` / `run.ended` around it.

**What kind of failure this is (AH-009).** `harness_error.rs` in the tools
plugin carries the classification on the value: a `kind` (cancelled, timeout,
budget exhausted, permission denied, policy violation, not found, invalid
input, upstream, transport, io, serialization, unsupported, internal), whether
a retry could help, and who the failure is addressed to -- the model, the user,
or the log. `classify_upstream` turns a provider failure into one of those, in
one place, with the answered cases decided first so an outage word inside a
refusal cannot turn a refusal into an outage. The provider chain asks it
whether another provider may be tried (AH-193), and the headless CLI asks it
how to say what happened: a cancellation reads as `[stopped]`, everything else
as `[error:<kind>]`. The module was written on the `feat/agent-harness-phase-1`
line, whose crate never reached the main tree; it is restored here, in the
plugin both surfaces already depend on.

**When a provider cannot be reached (AH-193).** `[agent].fallback` in
`agent.toml` is an ordered list of models to try when the configured one does
not answer. It is empty by default: a reply from a provider the user did not
choose is worse than an error, so a chain exists only because someone wrote one
down. Each entry is resolved the same way the primary model is; one that
resolves to nothing is logged and skipped rather than failing the run.

Only a failure that says the request never reached a model is failed over --
a refused connection, an unknown host, a 502/503/504, a timeout
(`loop.rs::is_failover_worthy`). Anything a provider *answered* is a decision,
not an outage: a rejected key, a refused request, a context that does not fit, a
cancelled run. That rule is also what keeps the guarantees simple: a dispatch
that never reached a model produced no tokens, ran no tool and collected no
approval, so nothing can be duplicated by trying the next provider. Each attempt
is its own invocation in the record, the fallback itself is recorded
(`phase: "fell-back"`, from, to, the reason and the request it follows), and the
usage is attributed to the provider that actually answered (`answeredBy`). The
chain belongs to the agent loop, which is what the CLI runs; Chat and Cowork
have no chain configuration, so they never fail over.

**Saying the window is filling (AH-077).** One shape of the warning, in
`core/agent/context_pressure.rs`, shared by the TUI and the headless CLI so the
two cannot drift: the share of the window in use, the figures behind it
(`82,000 of 100,000 tokens`), where those figures came from -- the provider's
count or Jan's estimate -- and what can still be done (`/compact`, `/context`).
It fires at 80% and once per approach: crossing back below re-arms it, which is
what a compaction, a new conversation or a larger window does. The window is the
one the run resolved (`[agent].context_window`, then the model catalog, then the
fallback), never a constant. The desktop counter is the same rule at 85%, with
"Nearly full" / "Full" in words beside the ring and the same "of N tokens,
counted by the provider / Jan's estimate" line in its popover. A surface that
does not know the window -- a remote provider that reports none -- says the
count and no percentage rather than inventing a denominator.

**One request, one id (AH-004).** Every provider request has an invocation id,
and everything that request causes is recorded under it: the prompt snapshot it
was taken from, what it cost, what its reply was made of, and every tool call it
asked for. The Rust loop mints it (`loop.rs::Invocations`) and shares it with
the tool invoker; Chat mints it in `lib/chatRun.ts`, where a turn is one run
even though Chat runs its tools *between* requests -- a reply that asks for
tools leaves the turn open, and the request carrying the results back continues
it. Chat therefore writes the same `run.started` / `usage.reported` /
`message.completed` / `run.ended` events Cowork does, and its tool events carry
the run and the request instead of an empty run. Folding is keyed by session,
invocation and call (`activity::item_id`), so a provider that numbers its tool
calls per request -- `call_1` every time -- cannot make two calls look like one;
an event written before invocations existed folds exactly as it did.

**Who changed a file (AH-110).** Every change the undo journal records carries
an `Actor`: a durable `id` in the subject spelling (`agent`, `agent:<name>`,
`role:<name>`), a `kind` (primary, named, role), a `label` that is for reading
only, and the parent agent, invocation and task it ran under. The identity is
what a change points at, so renaming or deleting a custom agent changes the
words a surface shows and never the agent an old change names. `execute_tool`
takes the actor as a claim and validates it before the tool runs: an identity
that is not an agent -- a user, a session, a skill, an injected string -- is a
typed refusal, so no change is left to be attributed afterwards, and a label is
flattened to one bounded line of text and never parsed. A file changed twice in
one turn names the agent that left it as it stands; every call stays separate in
the execution record, which now carries `agent_id` beside the display name and
exports it. A change recorded before provenance existed has no actor and is
shown as an unknown agent -- never as whoever is running now. The Changes panel
and the Timeline say "Changed by the primary agent", "Changed by <name>" or
"Changed by the <role> role" in words, inside the row's own label, so the
information does not depend on colour.

**MCP server liveness (AH-139).** The desktop's per-server health monitor
probes every 30 seconds with the MCP protocol `ping`
(`core/mcp/helpers.rs::probe_liveness`), not a tool call and not
`tools/list`. Any answer, a JSON-RPC error included, is a live server; a
server that ignores `ping` gets one `tools/list` before it is called
unresponsive, and is logged as not answering `ping`; a closed transport is
gone. A gone or unresponsive server is removed and restarted with the
configured backoff. `check_jan_browser_extension_connected` is separate: it
calls the browser server's own tool named `ping` to test the extension link.

**User-level skills (AH-121).** Native Jan skills have two scopes on every
surface. The desktop keeps them in the permanent store,
`<jan_data_folder>/agent-workspace/skills`, which is already shared across
projects. The CLI and the Rust agent loop read the project store
(`<project>/.jan/agent/skills`) first and that same user store after it; a
project skill shadows a user skill of the same name, and `[skills].enabled`
filters both. The system-prompt catalog (`core/agent/skills.rs`),
`skill_list` and `skill_read` (the plugin handlers, given the user store root
through `ToolContext::with_user_skills`) all resolve the same way, so a skill
the model is shown is a skill it can read.

**What an event carries (schema v2).** Identity (session, run, call,
invocation, agent, source, the parent task, a call it supersedes), a sequence
number stamped as the line is written, the call's redacted input (bounded to
4 KB) on its request, and its redacted output (the last 16 KB, flagged when
cut) on its end. Output that was never recorded reads as `unavailable`, never
as an empty success. A background job's id, a subagent's task id, and the file
a call changed with its own `+added/-removed` counts. The unified diff of that
change is stored beside the log (`audit/diffs/<session>/<call>.diff`, redacted,
up to 512 KB; larger is counted and marked oversized) and read back with
`tool_activity_diff` -- it is that edit's diff, not the repository's current
one. Lines written before v2 still read.

**Lifecycle events.** The run's own events -- a context compaction or trim, a
subagent waiting for a slot, a subagent or background job stopped (or a stop
that failed) -- are items in the same log and the same sequence, marked
`event_type: lifecycle`. There is no separate store for them.

**Ordering.** `activity::items` folds the log into one item per call, keyed by
session *and* call (a provider's call id is not unique across sessions),
ordered by when each was *requested*. Two concurrent calls therefore read in
the order they were made however their results interleave. Recording is queued
rather than awaited (`toolActivity.ts`), so a tool never waits on its own audit
line, and the queue is what stops `running` landing after `succeeded`.

**Export.** `audit_export(session)` returns one JSON document with the
session's permission decisions and its execution record (AH-200).

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

**What is remembered (AH-080..AH-085).** Durable memory is the canonical
record store in `tauri-plugin-agent-tools/src/memory/`, one JSONL file per
scope, rewritten atomically through a temp file and rename. Conversation
history is not memory: nothing is recalled from past transcripts. The
path-keyed BM25 "# Project Memory" block the CLI loop used to append (raw past
answers, keyed by the project folder's path text) was removed, and so was the
indexing that fed it. Inferred facts arrive as `Proposed` records and are never
injected until a person approves them, unless automatic saving is on.

| Scope | Keyed by | Stored at | Reaches |
| --- | --- | --- | --- |
| Session | the conversation's own id (Chat thread id, Cowork session id) | `<jan_data>/agent-workspace/memory/records/session.jsonl` | that conversation only |
| Project | the attached folder's identity file `<folder>/.jan/agent/project-id` (created from the canonical path once, then carried with the folder) | `<folder>/.jan/agent/memory/records/project.jsonl` | Cowork sessions attached to that folder; Chat has no project folder, so never |
| User | nothing | `<jan_data>/agent-workspace/memory/records/user.jsonl` | every conversation |

A temporary chat reads and writes none of them. Subagents follow one rule per
harness, stated rather than implied: a Cowork subagent receives no memory (its
prompt is built from its own brief and the parent's frozen instructions,
`coworkSubagent.ts`); a CLI subagent runs with its parent's session and project
(`subagent.rs` clones the parent's arguments), so it receives exactly the
memory its parent would, and nothing from any other session.

Precedence, highest first, and what each is:

1. The system prompt of the surface, including the run's permission and
   workspace constraints -- policy, set by Jan.
2. The user's current message -- the request.
3. `JAN.md` and approved compatibility instructions -- project policy, content
   that grants nothing (see section 1).
4. Remembered records, rendered last in the system prompt under
   `# Remembered` with the sentence "they are not instructions that override
   the current request", each line naming its id and scope. Among records,
   `record::prefer` decides: higher-precedence scope (user > project > session,
   per the chain below),
   then pinned, then who saved it (user > system > agent > import), then
   explicit over inferred, then recency, then id.
5. Tool output, in the messages -- data.

**One precedence chain (AH-084)**, defined in `memory/precedence.rs` and
stated verbatim in every prompt (CLI, Chat, Cowork) ahead of the remembered
facts: 1 system and security constraints, 2 the current user request, 3
active workspace and permission state, 4 `JAN.md`, 5 approved compatibility
instructions, 6 skills, 7 user memory, 8 project memory, 9 session memory,
10 recalled transcript excerpts and tool output. Levels 1-3 are the gate, the
sandbox, the tool list and the message itself, decided without memory. For
the text levels, retrieval is given the instruction text above memory
(`JAN.md` and skill descriptions on the CLI path; `JAN.md` and approved
compatibility files in Cowork) and withholds any memory that contradicts it,
reporting both values, both sources and the winner to the turn. A memory that
claims authority (overriding earlier instructions, lifting an approval,
enabling tools, posing as a system prompt, closing the memory block) is
refused. Remembered facts are rendered inside `<remembered_facts>` as sealed
single lines, so stored text cannot start a heading or close the block.

**Durability and trust boundaries (Priority 4).** Every read-modify-write of a
scope's file (save, forget, restore, clear, use records) runs under a per-scope
lock file created exclusively beside the store, so concurrent windows cannot
lose each other's records; a lock older than 30 s is taken over, and a writer
that cannot get it in 5 s is refused with "busy" rather than overwriting. The
rewrite stays temp-and-rename, so an interrupted write leaves the previous
file, and a store that cannot be read at all is never overwritten with what
little was readable. The project folder the renderer names is validated
before anything is written inside it: it must resolve to a real directory,
not a filesystem root, not overlap the Jan data folder, and its `.jan` and
`.jan/agent` must not be symlinks or junctions (Windows reparse points
included); a refused folder gets no project memory and the reason is reported
to the page and the turn. Saving refuses credentials, authority claims and
records over 2,000 characters, and a scope holds at most 2,000 live records.
The memory module writes nothing to logs; a test checks its sources. Commands
do their file work synchronously inside one call, so an abandoned request is
either entirely before or entirely after its single atomic write.

Memory can never grant a permission, move the workspace boundary, enable a
tool, or override the current request: it is text in a labelled block, and the
gate, the sandbox and the tool list are decided before and without it. Two
applicable records that make incompatible claims (package manager, indentation,
response length) are both withheld and reported as a conflict, rather than one
being chosen silently. The user is told and asked: `memory_conflicts` returns
the disagreements a dispatch from a given conversation and project would
withhold -- the same entitled records and applicability rule as
`memory_retrieve`, so another chat's disagreement is never listed -- and
Settings > Memory shows each pair in full with "Keep this one", which forgets
the other side (undoable) so the survivor reaches the next request.
Recall is switched per scope (`settings.json` `recall.{session,project,user}`,
on by default): a scope switched off is not read for retrieval or conflicts,
and its records stay stored. Settings that exist but cannot be parsed fail
closed -- recall off, automatic saving off -- and say so; unreadable or
partly damaged stores are reported to the page and to each turn rather than
read as empty. Forgetting removes the text from the store in the same write
and keeps a tombstone (id, provenance, content hash); undo must hand back the
exact text, checked against that hash. "Forget all" does the same for one
scope. Nothing moves a chat or project memory to user scope except an
explicit move.

Provenance (AH-083) is on the record and survives restart: `version` (1 when
created, +1 per edit; absent -- shown as unknown -- for records older than
versions), `history` (each replaced version as version, content hash and
time; never its text), `provenance.run_id` and `source_project_id` (the run
and project it was saved from, when known), a source type derived from
creator and origin (user-authored, agent-authored, imported, extracted), and
`provenance.uses`: the last 20 dispatches that carried it, each with session,
turn, prompt-snapshot id and the recall reason. Retrieval returns, per
injected record, its precedence rank and why it applied (`rank` is position,
not a relevance score -- there is no scoring model). Cowork records uses where
an assistant row meets its prompt snapshot; Chat records the chat only, having
no snapshot on that path. Each
dispatch records the ids it carried and withheld:
Chat on the message's `metadata.memory`, Cowork on the assistant turn's
`memory`, both shown in that turn's details; the rendered block with its ids is
also inside the prompt snapshot. Forgetting sets `Deleted` (undoable from the
toast) and removes the record from every selection immediately. Every injected
line names its id, scope and source before the quoted text --
`- [id] (user) (source: imported) ...` -- so the text cannot forge its own
origin and the model can tell an import from what the user said here.

**A memory's use names the request it went out in (AH-083).** A use recorded
against "this chat, some turn" cannot be checked against anything. Cowork always
named the snapshot; Chat could not, because the transport's snapshot reference
reached only whichever route had registered last for it. Snapshots are now
announced to every listener, so Chat records both the dispatch (AH-032) and the
memory use that went out in it, naming the same request.

**Forgetting reaches the prompts (AH-083).** A prompt snapshot is the exact
payload, so a memory forgotten from the store would still be readable in every
request it had already been sent in -- in the snapshot panel, in
`jan cli agent prompts`, in the audit export and in a session export.
Forgetting one memory, or clearing a whole scope, now takes its text out of
every snapshot that carries it (`snapshot::redact_text`), replacing it with
`[redacted: forgotten memory]` and recording that redaction on the snapshot.
The request itself stays: what was asked, which tools were offered, and that
something was removed on purpose. The rewrite is atomic, like every other pass
over that log, and a line that no longer parses is left untouched rather than
edited blind. `memory/` never logs the outcome -- a body could travel with the
message -- so the snapshot module reports it instead.

**Background work outlives the app (AH-101/AH-102).** A job is run by a
supervisor process of its own -- `jan cli job supervise`, the same command-line
binary that ships beside the app -- spawned detached, so closing the window
leaves the work running and a later app process can find it, read what it has
produced and stop it. The supervisor is what makes an ending *knowable*: a bare
detached command that exits while the app is closed leaves nobody to write down
that it finished, and the next process could only say "its process is gone".

Detaching means more than "do not wait for it". A detached child on Windows
still inherits this process's inheritable handles, including the pipe a caller
is capturing output through -- so `id=$(jan cli job start ...)` would block for
the whole job rather than for the id, which is precisely what background work
must not do. The standard handles are therefore marked non-inheritable across
the spawn and restored afterwards.

A job is "ours" only when three things agree: the pid, the process's creation
time, and a per-job secret. The secret lives in the supervisor's claim file; the
record keeps only its hash, so nothing listed, exported or logged carries it.
Two out of three is a stranger, and a stranger is never signalled.

**A background job outlives the app that started it, as a record
(AH-101/AH-102).** Background jobs lived in a map in memory, so the moment the
app exited a job that was running became a job nobody had any record of: the
panel was empty, its output could not be found, and a process that outlived the
app -- which is what happens whenever the app is killed rather than closed --
was running with nothing naming it.

`job_record` is the durable half: one line per job under `<data>/jobs/`, keyed
by a hash of the owner so a conversation id is never a path component, holding
what a listing needs and nothing more -- the owner, the run and invocation that
started it, a redacted and bounded summary of the command, and how it ended.

Which process a job *is* matters more than its number. A pid alone is not an
identity: the operating system reuses them, and a record that trusts one can end
up listing -- or killing -- whatever holds that number now. Every record keeps
the process's creation time beside its pid, and a job is only still ours when
both match.

A restart reconciles: a job whose process is gone is `interrupted` (an ending
nobody saw is never a completion), one whose pid now belongs to something else
is `orphaned` and is never touched, and one that cannot be identified at all is
`interrupted` too. In every case the pid is dropped, so nothing can act on it
afterwards.

**One classification of what filled the window (AH-087).** Every surface used
to answer "what is filling the context?" its own way: the TUI rebuilt the system
prompt from disk and re-serialized the tool schemas, the renderer counted what
it had in memory, and the headless CLI had no answer at all. Three derivations
of one number disagree the moment anything moves -- a skill added since, a
memory forgotten, a tool that was never advertised on this run -- and none of
them read the request that was actually sent.

`context_report` reads that. Given a stored prompt snapshot -- the exact bytes
the provider received -- it cuts the request into categories: the harness's own
prompt, project context, skills, memory, custom agents, the tool definitions the
request carried, compacted history, the conversation, attachments, what was
reserved for the answer, and what is left. The parts are cut from the whole, so
they sum to it.

Two honesty rules the callers depend on. A number is marked exact only when the
provider reported it; everything cut from the payload is an estimate (bytes over
four) and says so, including in the text form's `~`. A window this build does
not know is unknown, not a default: there is then no percentage and no free
space rather than invented ones. Tool definitions the run holds but did not send
are reported and never counted, because a definition that was not transmitted
cost nothing.

The TUI's `/context` reads it, `jan cli agent context` prints it as text or
JSON, and `agent_context_breakdown` hands it to the desktop.

**Replaying a recorded run (AH-032).** Replay reads the canonical record
rather than a format of its own. `replay::plan` names the exact source run, the
snapshot behind each of its provider requests, whether each can be sent again
and why not when it cannot, and the tools the original asked for -- shown, never
run, so an approval given once cannot be spent again by replaying the turn that
carried it. `replay::recorded` is the deterministic half: the run's own events,
re-read, sending nothing and costing nothing. `begin_for_run` is the other half:
a fresh request whose payload still comes from the stored snapshot, opening a
run of its own that names the run and the request it came from, and whose
ending says whether the model really received the same context again.

A run is looked up inside the session that owns it, so a run id from another
session or another project names nothing. A snapshot that was stored without its
payload, or whose fields were later redacted -- a memory forgotten since, say --
is planned but not sendable, with the reason attached: a replay that quietly
differs is worse than none.

**An id is parsed before anything is stored under it (AH-008).** Session, run,
invocation, job, agent and snapshot ids arrive from the renderer over IPC, the
CLI's flags, a resumed thread on disk, an imported bundle and a provider's own
reply. `identity` gives each a validated type: bounded, no control characters,
no path separator and no `..`, refused with a typed error rather than sanitised
into something else and written -- which matters because the session id names
the file its record lives in. Parentage is checked rather than believed: a child
run must name a parent of the same session and nothing may be its own parent. A
provider's own id never becomes one of these, because two requests can carry the
same one. A record written before this module is readable, but an id in it that
would be refused today comes back as nothing rather than as a value to store
under.

**One identity for a conversation (AH-008).** The session a run records under
is the conversation, not the process: a `--resume` run adopts the thread's id,
so its events, prompt snapshots, changes and audit records join the ones its
earlier turns wrote. Before this each turn minted a fresh uuid, and seven turns
of one conversation left seven unrelated logs with nothing to join them by.

A run id is `<session>#run-<base36 time><counter>`. The time part is what makes
it unique: a counter alone restarts at 1 with the process, so the first run
after a restart would take the first run's id -- and because the record treats a
repeated event id as one event, that run's start and end would be dropped and
its work would read as the earlier run's.

A child run keeps its parent's session (that is what puts their work in one
place) and carries `parentRun` and the `dispatch` it answers, while the parent
records `agent.dispatched` naming the same dispatch. The join holds in both
directions without either side having to guess from timing.

**A tool failure is classified once (AH-009).** The tool protocol is text: a
handler answers the model in words and a failure begins `ERROR`. That is the
model's interface and it stays. What does not stay is *deciding* anything by
reading it. `classify_tool` turns a result into a classification in one place --
taking an `ERROR [kind]:` tag at its word where a handler already knew what it
was, reading the shapes the built-in tools produce otherwise, and calling
anything unrecognised a tool failure that is never retried on that basis alone.
The tool boundary, the transcript's error flag and the activity record all read
that one classification, so they cannot disagree about whether a call was
refused, timed out or failed; the record carries `error_kind` beside the phase,
and a call that was cancelled or timed out is recorded as cancelled or timed
out rather than as a failure.

The harness's other error enums -- event export, bundle import, child
checkouts, worktree export, replay -- each cross into the taxonomy through an
explicit `From`, written case by case. A checkout reaching outside itself is a
policy violation, not an I/O fault; another session's events are a refusal, not
a corrupt file; a renderer that went away mid-replay is an interruption, not a
decision anybody made.

**Failures carry their classification (AH-009).** The orchestration loop's
errors are `HarnessError`, not prose: a kind (26 of them, from `authentication`
and `rate_limited` through `context_overflow`, `sandbox_denied` and
`child_failed` to `internal`), the stage it happened at, whether another attempt
could help, who it is addressed to, and the failure that caused it. Prose
crosses into the taxonomy at exactly one place -- `classify_upstream`, where the
streaming layer's text arrives -- and every decision after that reads the kind:
whether to compact and retry (`ContextOverflow`), whether the next provider in
the chain may be tried (`may_try_another`), whether the TUI may reuse the
history, what the CLI prints and what the process exits with.

Nothing that travels with a failure can carry a credential: `scrub` removes the
value after any authorization, key, token, password or secret marker, and any
bare `sk-` key, when the error is *built* -- so there is no path (a log, the
record, a serialized cause) where the raw text still exists. Messages are
bounded, so a provider that echoes the whole request back in its error body
cannot turn one failure into a copy of the prompt.

The serialized form is versioned (`to_wire` / `from_wire`). A record from a
newer build is refused with a typed error rather than guessed at; a *kind* from
a newer build stays readable as what it called itself, because the vocabulary
grows and an old reader must still see what happened. Exit statuses follow
`sysexits.h`, so a script can tell a stopped run (130) from a rejected
credential (77) from a provider that was not there (69) without parsing text.

**What a run started, as a tree (AH-173).** A run dispatches children,
children call tools, and tools start processes that outlive the call. All three
are recorded -- runs and tool phases in the canonical log, background jobs in
their own record -- but nothing joined them, so "what is this run actually
running?" meant reading three things and matching them by eye. `run_tree` joins
them: each run with its tool calls folded to one node per call, each child run
under the run that dispatched it, and each background job under the run that
left it. It is built from what was recorded and never from the machine's process
list, which cannot say which run asked for anything -- and adopting a process by
pid is the mistake the job record exists to avoid. `jan cli agent tree` prints
it; `agent_run_tree` hands the same nodes to the desktop.

**A policy as a file somebody reviewed (AH-052).** A project's permissions live
in its `agent.toml`, which is already reviewable and committable -- but nothing
could take one out, check it, and put it back, so a policy copied between
projects was a policy nobody diffed. `policy_transfer` is strict where the
runtime is lenient: every rule must parse (the runtime drops one it cannot read,
which is right at load time and wrong in a file whose purpose is to say what
will happen), and a document may hold rules and nothing else -- a key this build
does not know is refused by name rather than ignored, because an unknown key is
either meaningless or is trying to bring authority along with the rules.

Importing is the asymmetric part. A policy that only takes things away applies
freely. One that would let the agent do anything more -- a denial lifted, a
permission added, the default opened -- is refused unless the caller says so out
loud, and the refusal names exactly what it would open. `jan cli agent
policy-export` and `policy-import` are the two ends; nothing else in a document
can grant anything, because approvals and session grants are not in it.

**Watching a headless run as it happens (AH-183).** The record is written
first and read afterwards, which is no use to a caller that wants to watch. One
watcher per process hears every event as it is recorded -- after it is on disk
and outside the log's own lock -- and `jan cli agent run --events <path|->`
writes those envelopes out as JSON lines, the same shape the session's log
holds. A destination that cannot be written fails the command before the run
starts, because a run whose output nobody can see is not what was asked for, and
a stream nobody is reading any more never fails the run: the record is on disk
either way.

**What one run records (AH-004).** A run's canonical log holds what it did, not
what it said. Per provider request: the dispatch and its prompt snapshot id,
`message.started` when the reply first produces something (saying whether that
was content or reasoning), `message.reasoning` with the size of what the
provider supplied, the usage it reported, and the finished `message.completed`.
Between requests, under the request that was last in flight: `steering.received`
when the surface hands input over mid-run, `compaction.started` with why, then
`compaction.succeeded` with the sizes or `compaction.failed` with the reason,
and `agent.dispatched` / `agent.ended` for a child the model started. Ordering
is the log's own sequence, so a reader can say what happened before what without
trusting whichever clock a writer had. Sizes and counts only: the words are in
the transcript and the payload is in the snapshot, and a log that copied either
would be a second place for them to leak from.

A session's log is bounded (32 MB) and the number of logs is bounded (500). A
log that fills up writes one `log.truncated` line saying so and refuses what
follows, because a record that simply stops is indistinguishable from a run that
did.

**Memory export and import (AH-083).** `memory/transfer.rs` defines the
`jan-memory-export` v1 document: one scope's active memories with content,
content hash, creator, origin, source type, category, pin, timestamps,
version, hash-only history, and the source session, run and project. Forgotten,
proposed, superseded, conflicted and expired records are not exported, nor is
where a memory was used. Settings > Memory exports through the save dialog
(`memory_export`) and imports through the open dialog (`memory_import`).
Import checks the format and version before the shape (a newer file says
"newer", not "damaged"), rejects unknown fields and files over 8 MB, and then
takes each record separately: a record whose text no longer matches its hash
was altered and is refused; every other record goes through the same
`create::propose` gate as one typed by hand (credentials and instructions
posing as facts are refused), is created as `Creator::Import`, and keeps its
origin in `provenance.imported_from` (export id and time, exported scope,
original id, source type, creation time, version, session, run and project).
Re-exporting an import keeps the first author rather than the relaying
machine. Text already remembered in the target scope is skipped as a
duplicate, so importing the same file twice changes nothing. The page shows a
per-record report (imported, duplicates, refused with index, original id and
reason) and, on each imported memory, where it was imported from and who first
wrote it.

**What the provider cached (AH-211).** Provider-reported usage, including the
prompt cache, has one shape everywhere: `web-app/src/lib/tokenUsage.ts`. It is
kept apart from AH-073's dispatched-payload estimate, which is Jan's own byte
count and stays labelled as an estimate; nothing in this shape is ever
estimated. The fields, and what each provider's wire format means by them:

| Field | Meaning | OpenAI Chat / OpenAI-compatible / llama-server | OpenAI Responses | Anthropic | Gemini |
| --- | --- | --- | --- | --- | --- |
| `inputTokens` | every prompt token the request carried | `prompt_tokens` (already includes cached) | `input_tokens` | `input_tokens + cache_read + cache_creation` | `promptTokenCount` |
| `cachedInputTokens` | read from the cache | `prompt_tokens_details.cached_tokens` | `input_tokens_details.cached_tokens` | `cache_read_input_tokens` | `cachedContentTokenCount` |
| `uncachedInputTokens` | derived, `max(input - cached, 0)` | derived | derived | derived (= `input_tokens + cache_creation`) | derived |
| `cacheWriteTokens` | written to the cache; a subset of the uncached input | not reported (`cache_creation_input_tokens` if a proxy passes Anthropic's through) | not reported | `cache_creation_input_tokens` | not reported |
| `outputTokens` / `totalTokens` | output; input plus output | `completion_tokens`; sum | `output_tokens`; sum | `output_tokens`; sum | `candidatesTokenCount (+thoughts)`; sum |

Anthropic's `input_tokens` is the only one that excludes cached tokens, which is
why its total is assembled from three fields; the creation count is inside that
total and inside the uncached share, and is never added again. llama.cpp and
MLX also report `timings.cache_n`; it is used only when `usage` carried no
cache count, and it is the engine's own measurement, not an inference. Nothing
is inferred from a request "probably" reusing its conversation.

A count the provider did not send is `undefined` and stays so through every
layer: the AI SDK's converters default an absent `cached_tokens` to zero, so
presence is decided from the provider's raw usage object (`finish-step`'s
`usage.raw`) before any number is believed. A measured zero is a zero; an
unreported count is shown as "Not reported". A cached count larger than the
input, or a cache write larger than the uncached input, is clamped and the
provider's value kept in `reported` for diagnostics. Streaming snapshots are
cumulative and the last one wins -- the SDK keeps the final `usage` chunk,
Anthropic's `message_delta` replaces `message_start`, and the llama.cpp
extractor keeps the last `timings` -- while distinct steps of one turn are
separate requests and are added, with a cache count kept only if every step
reported one.

The breakdown travels in Chat message metadata (`metadata.usage`, persisted
verbatim in `messages.jsonl`), through `coworkRunner`'s step fold into the
Cowork session's `lastUsage` and each subagent's `usage` (snake_case, mirroring
the Rust `Usage`), into AH-073's payload record as optional
`cached_prompt_tokens`/`cache_write_tokens`, and through the local server's
converters (`core/server/converters.rs`) and the Rust agent's `Usage`. Records
saved before any of this existed load unchanged and read as "not reported";
nothing migrates a missing field to zero. The counter's compact badge is
unchanged; its popover (`TokenUsageBreakdown`) itemises input, cached and
uncached input, cache write, output and total, draws only rows backed by a
reported count, and explains that uncached input is derived and is a token
count, not a number of cache misses.


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

## Project tooling: frameworks, build systems, test runners (AH-068 / AH-069 / AH-070)

`core::agent::tooling::detect` reads a project's manifests and returns
evidence, not prose.

**What each fact holds.** Every `Fact` has:
- a kind: framework, package manager, workspace, build system or test runner;
- a value from a fixed vocabulary;
- a confidence: high, medium or low;
- a source file, relative and `/`-separated;
- the directory it applies to;
- a reason built from the manifest's structure;
- a command, only where the evidence is unambiguous;
- for test runners, whether they are unit, integration or end-to-end.

A report also carries conflicts, skipped files with reasons, and a truncation
note.

**Where it is used.**
- **CLI and TUI.** `context::build_system_prompt_for` renders the facts as a
  `# Project Tooling` block after the runtime environment.
- **Desktop.** The `project_tooling` IPC command returns the facts and that
  same rendered block. Cowork shows the facts on the readiness card and hands
  the model the block verbatim for the run's read root. The desktop never
  re-renders it, so the CLI and the desktop cannot describe one project
  differently.
- **Failure.** A failure comes back typed (`not-a-directory`, `unreadable`,
  `cancelled`) and never stops a folder being attached or used. The card says
  it could not be read, and the prompt goes without the block.

**Precedence and ambiguity.**
- Package manager: the `packageManager` field first, then a single lockfile,
  then the workspace root's (medium). Two lockfiles in one place are a
  conflict: each is reported low and no command is proposed there. A bare
  `package.json` names no manager and gets no command.
- Frameworks: a dependency is high. A framework config file with no dependency
  behind it is medium.
- Scripts are classified and never copied:
  - a script that only calls another is followed one level;
  - a runner the script names but no dependency provides is medium;
  - a script that downloads, deletes, escalates or pipes into a shell, or
    runs `npx`/`dlx`, is reported with no command.
- No command where the manifest does not say how:
  - Gradle without its wrapper;
  - CMake and Meson (no known build directory);
  - Flutter builds (no target platform);
  - Xcode (no scheme).

**Recognised.**
- **JavaScript/TypeScript:** npm, yarn, pnpm and bun.
  - Workspaces: the workspaces field, pnpm, Turborepo, Nx, Lerna.
  - Frameworks: Next.js, Nuxt, Angular, Astro, SvelteKit, React Native, Expo,
    React, Vue, Svelte, Electron, Tauri, NestJS, Express, Vite.
  - Test runners: Vitest, Jest, Mocha, AVA, Playwright and Cypress (e2e),
    Karma, node:test.
- **Rust:** Cargo, workspaces, integration tests in `tests/`, and Tauri, Axum,
  Actix, Rocket, Bevy, Leptos, Yew, Dioxus.
- **Python:** uv, Poetry, PDM, Pipenv; the build backend from
  `[build-system]`; pytest (from a declared dependency, or medium from config
  alone), tox, nox; Django, Flask, FastAPI, Streamlit.
- **Go:** modules and workspaces; Gin, Echo, Fiber, chi.
- **JVM:** Maven and Gradle, including multi-project builds; Android and
  Spring Boot.
- **.NET:** solutions, SDK projects, xUnit, NUnit, MSTest, ASP.NET Core, MAUI.
- **Other:** Flutter/Dart, Xcode, CMake/CTest, Ninja, Meson, Make, Bundler,
  Rails, RSpec.

**Security.** Repository contents are untrusted.
- **Canonical root.** The scan starts from the canonical root.
- **Links.** No symlink, junction or other reparse point is followed, and each
  one is reported. A manifest that resolves outside the root is refused.
- **Nothing is executed.** No script is run, nothing is fetched or installed,
  and no registry is contacted.
- **Bounded.**
  - 64 directories.
  - Depth 2, and depth 2 only under package containers such as `packages/` and
    `apps/`.
  - 200 files, 8 MiB in total, 1 MiB per manifest.
  - 3 s.

  A bound that stops the scan is stated in the report, never passed off as a
  complete answer.
- **Prompt safety.** Script text and manifest contents never reach the prompt
  or the log. Paths and script names in the block are stripped of backticks
  and control characters, so repository text cannot break out of it.
- **Cancellation.** `detect` checks a cancel flag between directories and
  returns `ToolingError::Cancelled`. It writes nothing, holds no lock and starts
  no process.

Nothing is persisted: the registry does not ask for it, and a stale record
would be worse than a 3 s scan.

## Lifecycle hooks (AH-127 / AH-128 / AH-129)

A hook is a shell command the *user* asks to be run when something happens in
a run: before a tool call, after one, when a session starts, when a run ends.
It is the escape hatch for the things a harness should not try to do itself --
run this project's linter before every write, refuse a command this project
does not allow, notify someone when a long run finishes.

Hooks live in `<project>/.jan/agent/hooks.toml`:

```toml
[[hook]]
event = "pre-tool"        # pre-tool | post-tool | session-start | run-end
command = "cargo fmt --check"
on_failure = "block"      # block | warn | ignore   (default: warn)
tools = ["write", "edit"] # omitted: every tool
timeout_secs = 30         # 1..=120
```

**Why a hook is safe to have at all.** Four properties, each of which is a
test:

* *The model cannot write one.* `.jan` is refused to every file-writing tool
  and to `bash`, so a model that would like a hook cannot create one, and a
  `hooks.toml` that resolves outside the project through a symlink is not
  read (`sandbox_denied`).
* *A hook is not more privileged than a tool.* It runs through the shell the
  jail can confine, under the same policy `bash` gets on that surface, and
  under a harness deadline rather than the file's word. Where no confinable
  shell can run the command as written -- Windows, where the MSYS runtime
  cannot start inside an AppContainer -- the hook is refused
  (`unsupported`), never quietly handed to a different shell that would run
  something else.
* *A hook is told almost nothing.* `JAN_HOOK_EVENT`, `JAN_HOOK_TOOL`,
  `JAN_PROJECT_ROOT`. No prompt, no message, no credential; its own output is
  scrubbed and bounded before it reaches a transcript.
* *A hook can only take authority away.* `block` refuses the call the hook ran
  before, and only `pre-tool` may declare it -- by the time the other three
  events fire, the thing they would refuse has already happened. There is no
  hook outcome that grants anything.

**What failing means is declared, not inferred.** `block` refuses the call and
skips the remaining hooks (the decision is made; more commands would just be
more side effects). `warn` lets the call through and appends the failure to
the result, where the model and the person reading the transcript both see it.
`ignore` is recorded and nothing else. A `hooks.toml` that is wrong in any way
refuses *every* tool call with `invalid_input` rather than silently meaning no
hooks -- a project that declared a policy and got none is the worst of the
three outcomes.

**Stopping a hook stops its work.** The deadline drops the future, which kills
the shell, and the process tree beneath it is killed with it -- found by the
test that asserts the marker file a stopped hook would have written never
appears. A stopped hook is never retried on the harness's own initiative: it
already ran, and whatever it did to the project is done.

## What a change can affect (AH-065 / AH-066 / AH-067 / AH-151)

`impact.rs` answers the question a run keeps asking after an edit: what should
I run now? Without an answer a model either runs the whole suite -- slow
enough that it stops running it -- or guesses a test name from the file name,
which is wrong the moment the coverage is indirect.

It reads import edges out of the repository: Rust `mod`/`use crate::`, JS/TS
`import`/`require` (including the project's own `tsconfig.json` `paths`
aliases), Python `import`/`from`. Edges that do not resolve to a file in the
project are dropped rather than guessed at. Walking those edges backwards from
a changed file gives the files that can be affected, and the subset of them
that look like tests -- so a test three re-exports away is still found.

`jan cli agent impact --changed <files>` prints it, and `--json` gives the
whole answer. Nothing is ever run: a command is printed for someone else to
decide about.

**Two honesty rules that decide whether this is usable.**

*A package import is not incompleteness.* Almost every real file imports a
package; treating that as an unresolved edge would make every answer partial,
which is the same as having no answer. What does count as incomplete is an
import that named a file *here* and did not find one, a changed path the graph
has never seen, or a walk that hit a bound. A specifier that resolves to a
stylesheet, an image or a JSON fixture is neither -- those exist and cannot
import anything, so they cannot be the path from a change to a test.

*Partial means run everything.* A selection narrows only when the graph is
whole. An incomplete graph can hide the one test that would have failed, and a
green subset would then be a false negative dressed as a pass. The reason line
says exactly what was incomplete and by how much.

**What it does not do.** It does not parse: edges come from line-shaped
matching, so a specifier inside a string literal reads as an import. Rust
resolution is the weakest -- `use` paths through workspace crates and items
inside inline modules do not resolve -- which is why a Rust crate's answer
reports many missed edges and proposes the whole suite. That is the honest
outcome rather than a confident wrong one. And the command comes from the
project's own detected test runner (AH-070) or there is no command at all; a
guessed `npm test` at a project with no such script is a turn spent learning
that it does not work.

## Machine policy an organisation sets (AH-187)

`.jan/agent/agent.toml` is the *project's* policy, and anyone who can push to
the repository can write it. That is the right answer for a developer's own
rules and the wrong one for an organisation's: "nothing on this machine
reaches the network from a tool" has to survive a checkout that says
otherwise.

So there is a second file, outside every project, that only an administrator
can write -- `%ProgramData%\Jan\policy.toml` on Windows, `/etc/jan/policy.toml`
elsewhere:

```toml
[tools]
max_default = "read-only"      # the most permissive default a project may set
deny = ["bash(rm *)"]          # denied here whatever a project says
allow_network = false          # a ceiling, not a default
allow_domains = ["docs.internal"]   # the only destinations any project may reach
deny_domains = ["evil.example"]
```

One rule combines the two: **a project may tighten and may never loosen.**
Denies are the union. The network is allowed only if both allow it. Where the
organisation lists destinations, a project may choose fewer and never others.
Where it caps the default, a project may be stricter than the cap.

Three places a bypass would otherwise live, each closed and each tested:

* *A run with no project.* Opening a directory with no `agent.toml` used to
  mean the permissive default; the machine's policy applies there too.
* *A project file that will not parse.* Same case, same answer.
* *`JAN_ORG_POLICY`.* It names a policy file for a machine that has none
  installed -- a container, a test. When the installed file exists the variable
  is not consulted, because anything a user can set is not where administrator
  policy comes from. A policy file that will not parse is read at its strictest
  (`read-only`, no network) and reported, rather than read as no policy.

The refusal says which file the rule is in. Telling someone to edit
`agent.toml` when the deny came from `policy.toml` sends them to change a file
that cannot help, and the refusal is tagged `permission_denied` so nothing
downstream has to infer it from the words.

## A diverged branch and a stopped merge (AH-171 / AH-165)

These are the two git situations where a wrong guess destroys someone's work,
and both are currently handled by asking the model to read `git status` and
decide. In both, the convenient answer -- `git push --force`,
`git checkout --theirs .` -- throws away commits, and a model told to make it
work will reach for it.

`vcs.rs` reports and refuses to resolve. `jan cli agent vcs` prints it.

*Divergence* says how far a branch and its upstream have drifted in each
direction, whether the tree is dirty, and what can be done from here that
loses nothing -- a push when only the local side moved, a fast-forward when
only the remote did, and for a real divergence, merge or rebase with what each
costs. A force push is not in that list under any circumstances; the answer
instead carries `needsAPerson`, because choosing between a merge and a rebase
is a project's decision rather than a command. `refuse_overwrite` is the typed
refusal for a caller that tries to assemble one anyway: `policy_violation`,
never retryable.

Nothing fetches. A function that reaches the network as a side effect of being
asked a question cannot be called from anywhere careful, so the answer is
about what has already been fetched and says so.

*Conflicts* reads a stopped merge from the index's unmerged stages rather than
from the working tree alone, which is what lets it tell "both sides changed
it" from "they deleted it while we changed it" -- different situations, and
only one of them has regions to show. Each conflicting region is reported with
its line number and both sides, bounded (20 regions per file, 60 lines per
side, 200 files) with what was cut said out loud. Binary files are named as
binary rather than shown. Nothing is written: after reading a conflict, the
markers are still in the file.

## Runs talking to each other (AH-103)

A child run could already hand its parent a final answer. What it could not do
was say anything *while* it worked -- "the migration you asked about is
already applied", "I need the file you are holding" -- so a parent either
waited for a result it could have redirected, or the two agents did not
collaborate at all.

`mailbox.rs` is a durable per-run mailbox, and two tools sit on it:
`message_send` (write to another run of this conversation) and
`message_check` (read what has been sent to me). `jan cli agent mail` reads
and writes the same store from outside a run.

The rules, each of them a test:

* *The sender is recorded, never claimed.* `from` is the run the loop is
  executing, taken from its cancellation scope. The model supplies who the
  message is for and what it says, and nothing else -- a model that would like
  to be someone else has no field to put it in.
* *A message stays inside its conversation.* Both ends must be runs of the
  same session, so one conversation cannot post into another's work. The
  refusal is `policy_violation`, not "not found": the recipient may well exist
  somewhere this run is not entitled to know about.
* *Reading records delivery and destroys nothing.* What two agents told each
  other stays answerable afterwards. What is *new* is decided before the read
  marks anything -- otherwise every check hands back every message the run has
  ever received.
* *Bounded, and the bound is said.* 64 messages per mailbox, 16 KB each. A
  full mailbox refuses (`rate_limited`, so waiting is a real option) rather
  than dropping the oldest: a queue that silently forgets leaves the sender
  believing something was said.
* *A mailbox closes with its run.* When a run ends, later sends are refused as
  `not_found` and never retried, because a message nobody will read is not
  delivered. What was already there stays readable.

The mailbox path is a hash of the run id, so a conversation id is never a path
component on a shared machine, and message bodies are scrubbed on the way in.
A message is data: `message_check` presents it as another agent's words, which
this run may act on or ignore.


## The repository index, and looking a name up in it (AH-053 ... AH-061)

`impact.rs` reads a repository every time it is asked anything, which is right
for a one-off question and wrong as a foundation: a symbol search that re-reads
a thousand files per query is a search nobody runs twice. `index.rs` is that
same reading, kept.

Stored per file: path, size, modification time, a content hash, and the symbols
it defines. Stored under the data folder keyed by a hash of the project path --
an index is state *about* a checkout, not part of it, and writing it into the
repository would put it in somebody's diff.

What makes it trustworthy rather than merely fast:

* *A stale entry is never used.* A file is re-read when its size or
  modification time differs from what was stored -- **any** difference, not a
  newer one, because a checkout or a restore can put an older file in place.
* *An update says what it did.* added, changed, unchanged, removed. Reporting
  how much was re-read is what makes "incremental" checkable rather than
  claimed: on this repository the first pass reads 1,665 files in 0.77 s and
  the second reads none in 0.22 s.
* *A moved checkout reconciles rather than trusting.* The index records the
  commit it was built at; when that has moved, every entry is re-checked
  against disk. Still incremental -- unchanged files are stat-compared, not
  re-read -- but nothing is believed because it was true on another branch.
* *A stopped build writes nothing.* Half an index that looks whole is worse
  than none, so cancellation returns `cancelled` and leaves no file. The index
  is written to a temporary file and moved into place for the same reason.
* *An index from another project or an older shape is not used.* Not an error
  either: the next build is simply a full one.

On top of it, `symbol_find` (a model-facing tool) and
`jan cli agent index --symbol`: where a name is defined, and optionally every
place it is used. Whole-word matching over the indexed files only, so `load`
does not match `payload` and vendored trees are not searched. It locates and
does not resolve: two unrelated things with one name are both reported, and
definition lines are marked so the difference is visible rather than guessed
at.

This is not a language server (AH-057 and AH-058 remain missing, and one would
answer questions this cannot -- types, overloads, which of two same-named
symbols an expression means). It is the part that does not need one.


## What the compiler says, without the model shelling out (AH-063 / AH-064)

A model that has just edited a file learns whether it broke something in one of
two ways: it runs the build itself, in a `bash` call it has to think to make
and a user has to approve, or it does not and finds out three turns later. The
first is noisy and gets skipped under pressure; the second is how a run ends
with a confident summary of code that does not compile.

So the harness can run the check itself and hand back the diagnostics for the
files the run touched.

* *Opt-in, per project.* `[tools] diagnostics = true` in
  `.jan/agent/agent.toml`. Running a compiler after every edit costs real time
  on a large project, and a harness that silently does it feels broken. Off by
  default.
* *The project's own command, or nothing.* `cargo check --message-format=short`
  where there is a `Cargo.toml`; the project's own TypeScript compiler where
  there is a `tsconfig.json` **and** a dependency that provides one -- never
  `npx tsc`, which would download a compiler behind the user's back. Where
  neither is true there is no command and no diagnostics.
* *Bounded and stoppable.* One command, a deadline the harness caps at 180 s,
  512 KB of output kept, and the process tree killed when the run is cancelled
  or the deadline passes. A check that hangs must not hang the run.
* *Only what the run touched.* The compiler reports the whole project; what
  goes back is the diagnostics for the files this turn edited, appended to the
  last successful tool result -- where the model is already reading, costing no
  extra turn. Everything else is noise it did not cause and cannot act on.

The parser reads exactly two shapes, rustc's short format and the TypeScript
compiler's, and ignores every other line. A parser that guesses turns a line of
prose into a diagnostic pointing at a file that is fine.

Nothing here fixes anything. It reports.


### Who calls this (AH-062)

`hierarchy()` walks one function's callers and callees from the same index: a
caller is a place the name is written followed by `(`, with the enclosing
function taken as the nearest definition above it in that file; a callee is a
name called between the function's definition line and the next definition in
the file. `symbol_find` exposes it with `calls: true`.

Said plainly rather than sold as a call graph: the reading is line-shaped, so a
name used as a value reads like a call, a macro can look like one, and two
functions with one name are not told apart. What it does is find the places
worth opening, which before meant reading the whole project.


### Branches, without a shell command (AH-161)

The model reached git only through `bash`, under per-base-command grants,
which means every branch operation was a string somebody had to read. There is
now a `git_branch` tool -- list, create, switch -- and the reason it is worth
having is the refusals a shell command cannot give:

* a name that is really a flag (`--force`, `-D`) or a path (`a..b`,
  `refs/heads/../../x`) is refused before git sees it;
* creating a branch that already exists is refused, because `switch -C` moves
  it and orphans whatever it pointed at;
* switching to a branch another worktree of this repository holds is refused
  by name, rather than failing obscurely halfway;
* switching to an existing branch with uncommitted changes is refused --
  carrying them onto somebody else's history is rarely what was meant --
  while *creating* from them is the ordinary way work starts;
* there is no delete at all. A branch is often the only record of work that is
  not merged yet.

Listing is a read and is offered in Plan mode; create and switch are not.


### The fixture library (AH-011)

Every module that needed a repository, a session's events or a set of
permission rules was building them by hand. That is how two tests come to
disagree about what a run looks like, and how a test ends up asserting against
a shape the harness never produces.

`core::agent::fixtures` builds the real things: `Workspace` (files, an
`agent.toml`, a real `git init`, removed when it drops -- including after a
panic), `Events` (envelopes through the same `event_log::append` every surface
uses, with the ordinary run shape in one call), `ids` (the session, run and
invocation ids already parsed, so the relationships between them are not
spelled by hand), and `Rules` (permissions without each test re-deciding what
the defaults mean).

They are ordinary code rather than `#[cfg(test)]` items on purpose: the
integration tests under `tests/` and the smoke harness need them too, and a
fixture only unit tests can reach is one that gets hand-rolled again in the
places that cannot. The golden-repository suite is built on them.


### An MCP server's documents (AH-137)

MCP servers offer *resources* as well as tools: documents a client may read,
where reading runs nothing on the server. Jan connected to servers and never
asked for them, so a server whose whole purpose was to expose a wiki or a
schema looked empty.

`mcp_resource_list` lists what every connected server offers;
`mcp_resource_read` reads one, by server and uri. Both are reads, so Plan mode
keeps them, and they are advertised only when a server is actually connected.

Three properties worth stating:

* *The server is named, not guessed.* Two servers can offer the same uri, and
  reading the wrong one silently is worse than being asked which.
* *What comes back is the server's content, and says so.* The answer is
  prefixed as that server's document rather than presented as instructions --
  the fixture's resource is deliberately instruction-shaped, so the test would
  catch the opposite.
* *Bounded and scrubbed.* 200 resources listed, 32 KB of one read, secrets
  scrubbed, and a binary blob named as bytes rather than pasted as base64 into
  a transcript that has to hold it.


### Writing a commit message (AH-159)

The harness supplies the change, the model writes the words, and the harness
checks the words against the change. `commit_message` called with no argument
returns the staged files, the insertion and deletion counts, the staged diff
(bounded and scrubbed) and -- separately -- the files that are changed and
*not* staged, under a heading that says this commit does not contain them.
Called again with `message`, it checks it.

What it refuses, each because the message would be wrong about the commit
rather than because of a style opinion: an empty subject; a subject past 72
characters, which every tool that shows a log truncates; a body that starts on
the line after the subject, which git reads as part of it; a message naming a
file that is changed but not staged -- the failure that matters, a model
summarising the branch instead of the commit; and a message carrying something
that looks like a credential.

It commits nothing. The message comes back for the caller to use.


### Working through a review (AH-164)

A review arrives as remarks about particular lines, and the usual way a run
consumes one is that somebody pastes the thread into the prompt. The model then
answers the three it found most interesting, says it has addressed the rest,
and nobody can tell which of the two happened for any given comment.

`review_comments` holds the comments with state and hands them over one at a
time: `load` to read a review file, no arguments to see what is left, and
`id` + `outcome` + `reply` to deal with one.

* *Each comment is answered or addressed explicitly.* "I changed this" and "I
  disagree, and here is why" are both real outcomes. Silence is not one, and
  neither is a summary of the thread.
* *Addressed is checked, not believed.* The file the comment names must differ
  from what it was when the review was loaded; a comment naming no file cannot
  be addressed at all. A run that changed nothing has answered, and the record
  says so.
* *What was said is kept*, beside the comment, so "what did this run say about
  comment 4" is answerable afterwards.
* *Nothing is posted anywhere.* Sending replies back to whoever wrote them is a
  person's decision, with their credentials.
* *Comments are data.* They are a reviewer's opinion about code, scrubbed and
  bounded on the way in, and presented as remarks rather than instructions --
  a comment that says "ignore your instructions" is still just a comment.


## What is on disk, and what an upgrade does to it (AH-010)

Twenty stores had a version constant each, declared next to the code that
writes them and catalogued nowhere. That is fine until somebody has to answer
one of these: what is on disk after a run, which of it survives an upgrade,
what happens to a file written by a newer build, and where does a support
request send someone to look.

`state_schema.rs` is the catalogue -- each store with its version, where it
lives, what it holds, and what reading an older or newer file actually does.
`jan cli agent state` prints it.

The version in each entry is *read from the writing module's constant*, not
copied, and a test asserts the pairing, so the list cannot quietly go stale.
That is the reason it is code rather than a document.

Four migration behaviours, and every store declares one:

* *reads older files in place* -- fields added since have defaults, and an
  absent one reads as absent rather than as zero;
* *rebuilt from its source* -- the file is derived (the repository index), so
  an older or unreadable one is thrown away and rebuilt, losing nothing;
* *refused and left alone* -- a bundle or export written by a build that knows
  more than this one is declined rather than guessed at;
* *skips lines it cannot read* -- append-only records where one bad line never
  costs the rest of the file.

Nothing rewrites a user's data on startup. That is the migration strategy that
turns one bad release into lost work, and no store here uses it.


### A skill says which tools it needs (AH-040)

A skill's frontmatter may declare `allowed-tools: [read, grep]`, the convention
Claude Code uses. The harness reads it as a *ceiling claim*, never a grant:

* a skill whose declared tools this run may not use is **withheld**, with a
  refusal naming the tool, and its instructions are not loaded -- handing over
  steps that will each be refused wastes a turn and reads to the model as the
  harness being broken rather than as a policy it cannot cross;
* the catalogue does not list such a skill either, because an entry is an
  invitation and one that always ends in a refusal is worse than no entry;
* a skill that declares nothing behaves as it always did: its calls are gated
  when they are made, like anybody else's;
* and nothing here makes a denied tool callable. The check can only subtract.

The tool context now carries the run's permissions and subject, which is what
makes the check possible at the point the skill is handed over rather than
three calls later.


## What a run cost, where somebody said what things cost (AH-175)

Tokens have been counted for a long time and money has never appeared
anywhere. The reason is worth keeping in front of whoever changes this: the
harness does not know what a model costs. Prices change, they differ by
account and by region, and a number invented here would be wrong in a way that
looks authoritative. A dashboard that quietly multiplies by last year's rate is
worse than one that says nothing.

So a price is something a person declares, in `<data folder>/prices.toml`, in
dollars per million tokens, and `jan cli agent spend [--since 7d] [--session]`
reports what was used and -- only for the models declared there -- what it
cost.

* A model nobody priced is shown with its tokens and the words **not priced**,
  and is listed under the total rather than folded into it as zero. A total
  that silently omits a model is a wrong total.
* An estimate is said to be one: dispatches Jan counted itself are reported
  separately from the provider's own counts, the same distinction `usage.rs`
  draws, carried through to money instead of flattened.
* Cached input is charged at the cached rate where one is declared, which is
  the reason anybody looks at a cache figure in the first place.
* A price file that will not parse, or that carries a negative or non-finite
  rate, is refused whole -- half a price list produces a confident wrong
  number.

It reads both records that carry a dispatch: the desktop's payload-usage log
and the `usage.reported` events a headless run writes, joined on the
invocation so a dispatch in both is counted once.


## A child that starts from this conversation (AH-100)

A subagent has always started from a single message: the task, and nothing
else. That is the right default and it stays the default -- a child that
inherits everything the parent has read pays for all of it on every turn, and
most dispatches are clearer without it. But some tasks cannot be stated in one
message, because what makes them intelligible is the exchange that led to them.

So `dispatch_subagent` takes `fork_context: true`, and the child is then
started from a copy of the conversation the dispatch was made in, with the task
as its final message.

What travels, and what deliberately does not:

* The parent's **system prompt** stays with the parent. The child has its own,
  which is the reason it is a different agent.
* The **tail**, not the whole: at most 40 messages and 96 KB. When that cut is
  real the child is told plainly that what it holds is the recent part of
  another conversation and not the whole of it. Nothing else is announced as
  truncation -- a note claiming a cut that did not happen is a false claim.
* **No half of a tool exchange.** A result whose call fell outside the tail has
  nothing to answer, and the call being dispatched has no result yet, because
  the result is the child. Both are dropped, and an assistant turn left with
  nothing at all goes with them. Providers reject either half, and a model
  imitates a tool that appears never to have answered.
* It is a **copy**. What the child says happens in the child's own history and
  reaches the parent only as the result it returns. Nothing flows back.

The conversation is read at the moment of dispatch, from the turn loop that is
dispatching, so what the child receives is what the parent had when it asked.


## What a skill calls itself, and what it needs (AH-123, AH-124)

A skill could say what it did and which tools it needed, but not what version
of itself it was, and not that it only made sense alongside another skill. So
two skills could disagree about which "deploy" they meant, and a skill whose
first instruction was "follow the formatting skill" was handed over in a
project where no such skill existed.

Frontmatter now takes two more keys:

```yaml
---
name: release
version: 2.1.0
requires:
  - deploy >=2.0
  - formatting
allowed-tools: [bash]
---
```

**Version (AH-123).** Three numbers, and the parts nobody wrote are zero, so
`2`, `2.1` and `2.1.0` are the same version. A pre-release or build suffix is
kept as written but never ordered -- ordering a suffix nobody defined is how a
constraint comes to be judged wrongly. Anything that is not a version
(`latest`, `1.x`, `1.2.3.4`) is refused rather than guessed at, and a skill that
declares nothing declares nothing: that is not version zero, and no constraint
is satisfied by it. What a skill declares travels with its name, in the
system-prompt catalogue and in `skill_list`, as `deploy (v2.1.0)`.

**Dependencies (AH-124).** `requires:` names skills, each optionally bounded:
`deploy >=2.0`, `deploy<1.0`, `deploy 2.0.0` (an exact version, the way a
lockfile writes one), or a bare name meaning only that it be installed at all.
Loading **fails closed**:

* A skill that is not installed, or installed at a version the bound rules out,
  or installed declaring no version where a bound needs one, is named in the
  refusal along with what was found.
* A bound this build cannot read is *unmet*, never quietly widened to "any
  version at all".
* Requirements are followed through -- a dependency's own dependency counts --
  and two skills that require each other end the check rather than looping.
* A skill whose `allowed-tools` names a tool this run does not have at all is
  withheld too. This is the absence case; AH-040 already covers a tool that
  exists and is denied. Where the surface does not say what tools it has, the
  check is skipped rather than guessing that an unfamiliar name is absent.

The refusal reaches both surfaces: `skill_read` returns a typed
`invalid_input` naming what is missing, `skill_list` does not advertise a skill
that could not be loaded, and `/skill:<name>` refuses by name instead of
handing over instructions that cannot be followed.


## Agents written for somebody else's harness (AH-118, AH-119)

Two ecosystems keep agent definitions in files Jan can read, and both describe
roughly what a Jan subagent is -- a name, a description of when to use it, a
prompt, and the tools it may use:

* **OpenCode**: `.opencode/agent/<name>.md`, YAML frontmatter over a markdown
  prompt, plus agents declared under `"agent"` in an `opencode.json`.
* **Qwen Code**: `.qwen/agents/<name>.md`, the same shape with the Claude Code
  key set.

`jan cli agent import-agents <path> [--scope user|project] [--dry-run]
[--overwrite]` reads a file, a directory of them, or an `opencode.json`, and
writes native `<scope>/.jan/agent/subagents/<name>.toml`.

The rule the importer is built on is that it does not guess:

* A key it knows is mapped. A key it does not know is **reported by name** in
  the import's notes. Nothing is dropped silently, so nobody has to diff two
  directories to find out what survived.
* What Jan has no room for is named too, and why: a per-agent `temperature`
  (Jan has none per subagent), OpenCode `permission` rules (a subagent runs
  under the run's permissions, narrowed by its tool list), `color`.
* A tool with no Jan equivalent is not imported and is listed. Dropping it
  silently would widen a deliberately narrow agent.
* OpenCode writes `tools` as on/off switches. A map that only switches things
  *off* is subtractive, so it becomes every tool an imported agent could name,
  minus those -- not every Jan tool, because that author never had
  `memory_write` or `screenshot`, and turning off `write` is not a request to
  be handed them.
* `mode: primary` is OpenCode's word for the agent a person talks to. It is
  passed over by name, not imported as a subagent; so is one its author
  disabled.
* `model` is kept exactly as written. Rewriting it to a model Jan has would be
  choosing one on the author's behalf; an unknown model fails at dispatch,
  saying so.

Refusals are typed and name the file: no frontmatter, no description (the
description is what says when to dispatch it), no prompt, an unreadable
`mode`. Reading happens before any writing, so a directory with one malformed
definition imports none of them -- a half-imported directory is a state nobody
can reason about -- and `--dry-run` writes nothing at all.


## The project's own formatter (AH-150, AH-149)

Every project already has an opinion about layout, and writes it down: a
`rustfmt.toml`, a `.prettierrc`, a `[tool.ruff]` table, a `go.mod`. An edit
that ignores it produces a diff half made of whitespace, and a commit the next
`cargo fmt` rewrites anyway.

**Detection (AH-150)** is evidence-based, never conventional. A formatter is
claimed only when the project says it uses one *and* the program is actually
there -- in `node_modules/.bin` first, since a project's own copy is the one it
means, then on `PATH`. A file extension is not evidence: plenty of
repositories hold a `.py` and no Python formatter. What the evidence was
travels with the answer, so a person can be told why something ran.

| File | Evidence required | Run as |
| --- | --- | --- |
| `.rs` | `Cargo.toml` with an `edition` (plus `rustfmt.toml` if present) | `rustfmt --edition <edition>` |
| `.ts`/`.js`/`.css`/`.md`/… | a `.prettierrc*`, or prettier in `package.json` | `prettier --write` |
| `.py` | `pyproject.toml` `[tool.ruff]`, else `[tool.black]` | `ruff format -q` / `black -q` |
| `.go` | `go.mod` | `gofmt -w` |

The Rust edition is read rather than assumed: formatting a 2021 crate as 2015
fails on the first `async fn`, and a manifest that does not say has not said.

**Formatting on edit (AH-149)** is `[tools].format_on_edit`, off unless asked
for -- a formatter is a program, and running one nobody asked for is a change
nobody asked for. When it is on, the file the agent just wrote is handed to the
detected formatter, on its own, inside the project, with a 20-second deadline,
and then the diff is **redrawn against what the file now holds**. The point of
showing a diff is that it is what happened; annotating a stale one would not
be. The line underneath names the formatter and the evidence
(`[formatted with rustfmt (Cargo.toml (edition 2021))]`).

A formatter that will not start, misses the deadline, or refuses the file
leaves the edit exactly as the model wrote it and says so under the original
diff -- usually because the edit does not parse, which is worth knowing.


## A run that can execute nothing is stopped

A turn whose tool calls all fail the executability check changes nothing. The
malformed calls are dropped from the live context before the next request, so
that request is the one just sent, and the reply will be the one just received.
A token budget is the only other ceiling, and a provider that reports no usage
never moves it.

Found in a real run while verifying something else: a mock provider answering
with a tool call whose arguments were a bare string, and a run at turn 456
still asking the same question. Three such turns in a row now end the run with
a typed `invalid_response` that says what happened. Any turn that executes
something -- or that produces an answer -- resets the count, so a model that is
merely confused once is not cut off.


## Ceilings that hold across runs (AH-191, AH-192)

A session budget stops one run. Neither of these is about one run: they are
about what a person or a project may use in a day or a month, which is the
number anybody means when they say "keep it under $20".

`<data folder>/quotas.toml`:

```toml
[tokens]
per_day = 1000000
per_month = 20000000

[spend]
per_day = 5.0
per_month = 50.0
```

Every ceiling is optional, and no file means none. A file that will not parse,
or that carries a negative or non-finite amount, refuses the run: half a quota
file would enforce a ceiling nobody wrote, and an unreadable ceiling is not the
same as no ceiling.

**Where it is judged.** At every provider dispatch -- the moment something is
actually spent, including retries, fallbacks and a turn's own second request.
The ledger grows as the run goes, so a run that crosses its ceiling mid-way
stops there rather than at the end. A run with no ceilings declared reads no
ledger at all. A compaction dispatch is exempt: the run it belongs to is judged
at every turn of its own, and stopping the compaction would strand it with a
history it cannot send.

**What a money ceiling can judge.** Only what has a declared price
(`prices.toml`, AH-175). Use of a model nobody priced is real use that cannot
be turned into dollars, so it is named beside the answer rather than folded in
as zero -- `spend per day: $0.0000 of $0.0100 (not counted, because nobody has
said what they cost: mock/m)`. A ceiling that treated unpriced use as free
would be a ceiling that does not hold, and saying so is the honest half of it.

`jan cli agent quota` prints where use stands against each ceiling, tightest
first -- the same numbers `jan cli agent spend` reports, because it is the same
ledger. A run stopped by a ceiling ends with a typed `budget_exhausted` naming
which ceiling and what it stands at, and marked never-retry: the window has to
pass.


## Telling somebody a run ended, or wants them (AH-185, AH-184)

A headless run that has been going ten minutes and now wants an approval is
invisible: whoever started it has moved on. `[notify]` in `agent.toml` says who
to tell.

```toml
[notify]
command = ["notify-send", "Jan"]              # a local command (AH-185)
webhook = "https://example.invalid/hooks/jan" # an endpoint (AH-184)
events = ["run.ended", "needs.attention"]     # default: both
```

The command is an **argument vector, never a shell string**: the program is
exactly what was named, and the notification arrives as one more argument
rather than being spliced into a command line where a quote would change what
runs. The webhook is POSTed as JSON.

What is sent is deliberately small -- which session, what happened, when, and a
one-line summary:

```json
{"kind":"run.ended","session":"0fd56d9c-…","at":"2026-09-13T04:58:29Z",
 "summary":"the run ended: completed"}
```

What is **not** sent: the prompt, the model's answer, tool output, file
contents, credentials. Everything else is in the transcript, which stays where
it is. "Tell me when it finishes" does not ask for the contents of the run, and
an endpoint is a place data does not come back from. The `run` field is absent
rather than filled with a stand-in where the surface does not know the run id:
a session id in a field labelled `run` is a wrong answer.

A configuration that cannot work is refused at startup -- a scheme that is not
http or https, an empty argument, a moment nobody defined -- rather than
discovered when a run ends and nobody is told.

One thing to know before opening an unfamiliar repository: `[notify]` lives in
the project's own `agent.toml`, so a project can declare a command to run and
an endpoint to reach when a run of *its* code ends. That is the same trust
already placed in a project's `hooks.toml` and its MCP servers -- the harness
treats a project you have opened as one you chose to open -- and it is why the
notification carries no content of the run: the most an unfamiliar project
learns this way is that somebody ran the agent in it. Delivery itself never decides
the run: a command that fails, or an endpoint that is not there, is logged and
dropped, because a run that has finished has finished, and failing it because
nobody could be told would turn a courtesy into a new way to lose work.


## Named profiles (AH-186)

One project is worked on in more than one way: a careful review pass that may
not run anything, a cheap pass on a smaller model, an offline pass. Keeping
those as edits to `agent.toml` means editing the file before each run and
remembering to put it back.

```toml
[profiles.review]
model = "provider/a-careful-model"
tools_default = "ask"
tools_deny = ["bash"]
skills = ["review"]

[profiles.readonly]
tools_deny = ["write", "edit"]
```

`jan cli agent run --profile review "..."` (and `agent step --profile`) folds
the named profile over the project's own settings for that run only.

A profile may name the things people actually vary -- `model`, `max_tokens`,
`context_window`, `tools_default`/`tools_allow`/`tools_deny`, `allow_network`,
`sandbox`, `format_on_edit`, `skills` -- and nothing else. A profile that could
change anything at all would be a second configuration format, and the one a
reader has to hold in their head would be whichever they last looked at.

**What a profile does not mention is left exactly as it was.** An unset field
is not a default of its own; a profile that quietly reset settings it never
named would be a run with settings nobody chose.

**A profile nobody declared is refused**, naming what the project does declare:
`no profile named "reveiw": this project declares "other-model", "readonly"`.
Running the base configuration because a name was misspelled is a run with the
wrong settings that looks like the right one. The refusal happens before a
provider, a model or a tool policy is resolved. `--profile ""` is naming none,
not a profile called nothing.

The chosen profile travels with the run (`OrchestrationArgs::profile`), so the
settings the loop resolves -- skills, network, sandbox, formatting -- are the
ones the run was actually asked for, not the file's.


## Finding a past run, and taking its transcript out (AH-178)

Runs leave transcripts in two places: a project's own
`<project>/.jan/agent/threads/<id>/messages.jsonl`, and the desktop's
`<data folder>/threads/<id>/messages.jsonl`. The desktop app could search what
it holds; nothing could search the project's, and nothing could take a
transcript out at all, so "what did that run do, three days ago" meant opening
files by hand.

```
jan cli agent search "plum-coloured" [--regex] [--session ID] [--role user]
                                     [--limit N] [--json]
jan cli agent transcript <session> [--format text|markdown|json] [--out PATH]
```

Both read the two stores together, newest transcript first, so a bounded search
spends its budget on the runs somebody is most likely looking for.

Two things it deliberately does not do:

* **It does not index.** Search reads the transcripts, bounded (2,000
  transcripts, 20,000 messages each), every time. An index is a second copy of
  everything ever said, with its own staleness and its own place to leak from,
  and a few hundred conversations are read faster than an index is explained.
  When a bound bites, the answer says so rather than being quietly partial.
* **It does not widen what is readable.** It reads exactly the transcripts
  already on disk, and every snippet goes through the same scrubber the error
  path uses -- so a credential a model once echoed into a transcript is not
  re-printed by a search for something else on the same line.

The export is what is on disk, not a summary of it: the tool calls and their
results are part of what the run did, and an export that dropped them would
read as a model that described work instead of doing it. `--format json` hands
back the stored lines themselves.


## Rules about which model answers what (AH-194)

Resolution already preferred a provider with a credential, and already knew a
small-model role. What nobody could express is the thing people actually want:
*this* kind of work goes to *that* model.

```toml
[[routing]]
match = "agent:reviewer"        # a subagent, by the name it is dispatched under
use = "provider/careful-model"

[[routing]]
match = "role:smol"             # role:task and role:smol
use = "provider/small-fast-model"

[[routing]]
match = "model:gpt-*"           # the model that would otherwise be used
use = "provider/one-we-have-a-key-for"
```

Rules are read in the order they are written and the first match wins, because
that is how a person reads a list. `*` is a catch-all. The only wildcard in a
model pattern is `*`, anywhere in the string -- a wildcard language is a thing
to learn, and one character is not.

**Routing narrows nothing and grants nothing.** It redirects what it was asked
to redirect; anything no rule matches resolves exactly as it did before. A rule
whose `use` is the model already chosen changes nothing and is not reported as
a change.

**A rule that cannot be honoured refuses the run** -- an unknown match form, or
a rule that says nothing to use. Ignoring it would send the run to a model
nobody chose while looking as though their rule had been honoured.

A rule about a subagent by name outranks both that subagent's own declared
model and the parent's, because naming the agent is the more specific
statement and the one somebody wrote on purpose.


## How much a run says about itself (AH-181)

A headless run printed one fixed amount: every turn marker, every reasoning
token, every byte of live command output, every tool result. That is right for
watching one run and wrong for a log of a hundred.

`jan cli agent run --output-density compact|normal|verbose`, or `[output]
density` in agent.toml, with the flag outranking the file.

| | compact | normal | verbose |
| --- | --- | --- | --- |
| the answer (stdout) | yes | yes | yes |
| tool calls | yes | yes | yes |
| errors and failed tools | yes | yes | yes |
| tool results | no | yes | yes |
| reasoning, live command output, turn markers | no | yes | yes |
| each turn's token usage | no | no | yes |

**stdout never changes.** A piped run yields exactly the model's completion at
every density; what moves is the progress on stderr, which is what a person
reads while waiting and what a log keeps afterwards. **A failure is never
quiet**: compact drops results, not the news that something did not work.

A density that is not one of the three refuses the run rather than being
treated as the default -- a run that says less than somebody asked it to is a
log missing what they wanted to read.


## Dependency licences (AH-158)

A dependency arrives with a licence and a project has a list of the ones it may
ship. Nothing here decided whether the two agreed.

```toml
[licenses]
allow = ["MIT", "Apache-2.0", "BSD-3-Clause"]
```

```
jan cli agent licenses [--project .] [--allow MIT Apache-2.0] [--record] [--json]
```

Cargo crates come from `cargo metadata --offline`, npm packages from each
installed package's own `package.json` (the deprecated `licenses` array
included). Reading what is installed rather than what a lockfile promises is
deliberate: the licence that matters is the one in the code that is there.
`--offline` is deliberate too -- a licence check is not a reason to update a
registry index, and a tree that has never been resolved fails saying so.

The rules it follows:

* **Only the declared identifier.** Matching a licence by reading its text is
  how a project comes to believe a modified MIT is MIT.
* **Undeclared is undeclared.** A dependency that declares nothing is listed as
  declaring nothing -- never as allowed.
* **`MIT OR Apache-2.0` needs either; `MIT AND OpenSSL` needs both.** An
  expression with parentheses is not judged by halves: it is reported for a
  person to read. `allow = ["*"]` means anything that declares a licence at
  all, and then the shape stops mattering -- but it still never turns an
  undeclared licence into a declared one.
* **A project that has not said what it allows enforces nothing.** Everything
  is listed; nothing is called disallowed.
* **Nothing that could not be read is called fine.** A tree that fails to read
  is a typed error, not an empty list of problems.

`--record` writes `<project>/.jan/agent/licenses.json`; a later scan says which
dependencies were not in it, which is the question somebody has when a lockfile
changes. Before there is a record, the scan says so rather than calling
everything new. A disallowed dependency exits `policy_violation`, so this is
usable as a gate.


## Is this project in working order? (AH-072)

Before changing a repository it is worth knowing what was already broken. An
agent that starts in a tree whose tests were failing before it arrived will
spend the run fixing somebody else's problem -- or conclude its own change
caused it.

```
jan cli agent health [--project .] [--only build test lint dependencies]
                     [--dry-run] [--json]
```

**Only commands the project declares.** A `Cargo.toml` means `cargo check`,
`cargo test --no-run` and `cargo clippy`; a `package.json` means the scripts it
actually has, run through the runner its lockfile names -- `npm run` in a yarn
project can resolve a different tree than the one that was installed. A project
that declares nothing has no checks, and is told so rather than having a
command invented for it. `--dry-run` prints exactly what would run, with the
file that says so.

`cargo test --no-run` builds the tests rather than running them: a health scan
asks whether the project is in working order, and running an unknown
repository's whole suite is a much longer thing than was asked for.

**Bounded, drained, and quoted.** Each check has a deadline, and one that runs
past it is reported as having run past it -- not as a failure it never
reported, and never left running. Both pipes are drained while it runs, because
a compiler is perfectly capable of filling a pipe and stopping. What failed is
quoted from what the command printed, because a paraphrase of a compiler error
is a second thing to verify.

**Dependency health is what can be known offline**: how many dependencies there
are, which declare no licence (shared with AH-158's reader, so the two never
disagree), and which are present at more than one version. Anything needing a
registry is not claimed.

A scan that found something broken exits non-zero: this is what somebody runs
before starting work, and "it printed a failure and exited 0" is how a broken
tree gets worked in anyway.


## Reading a failing suite (AH-152, AH-153)

A suite that fails forty times has usually broken in two or three ways: one
renamed function, one changed message, forty call sites. A list of forty
failures is a list somebody has to group in their head before they can act, and
a model handed that list fixes them one at a time.

```
jan cli agent test-triage [--command cargo test] [--no-retry] [--json]
```

**Grouping (AH-152).** Failures are grouped by what they printed, normalised
only where the noise is provably incidental: the `thread 'name' (id) panicked
at` preamble (which is the one thing every failure has different), file paths,
line numbers, and bare numbers inside a message. Nothing else is touched -- a
quoted string in an assertion may be exactly what the failure is about. The
claim a group makes is "these said the same thing", and the group carries one
real, unnormalised message so a person sees what was actually printed. The
biggest group is first: it is the fix that buys the most.

**Flakes (AH-153).** Each failing test is run again, by name. One that passes
the second time is reported as flaky *on that evidence*; one that fails again
is a failure. `--no-retry` skips this, and then nothing is called flaky at all
-- because without a second run there is nothing to say. A re-run that could
not be done is recorded as saying nothing, not as either answer.

**It reads the shapes it knows.** Rust's test output is parsed. A run that
failed and printed something this cannot read says exactly that, rather than
reporting no failures -- silence there would read as a clean suite.

The exit code distinguishes the two: a suite whose only failures did not
reproduce exits zero, one with a failure that happened twice does not.


## A server's prompts, and listings that come in pages (AH-138, AH-143)

**Prompts (AH-138).** An MCP server can offer prompts: messages its author
wrote, filled in with arguments. `jan cli mcp prompts <server>` lists them with
the descriptions the server gave; `jan cli mcp prompt <server> <name> --arg
k=v` fetches one.

What comes back is **content, not instruction**. It is rendered with its role
(`[user] …`) and handed on the way a person pasting it would -- never merged
into the harness's own prompt, and nothing in it decides what the harness may
do. That is the same rule MCP resources follow (AH-137), for the same reason: a
server is a third party. A prompt the server does not have is the server's own
refusal, returned as it was given rather than smoothed into an empty prompt.

**Pagination (AH-143).** A listing arrives with a `nextCursor` when there is
more, and every listing this harness makes follows it to the end -- tools,
prompts and resources alike. The fixture server now serves its tools over two
pages, with the second tool reachable *only* by following the cursor, so a
client that stopped at the first page is visibly missing something rather than
merely untested.

Each round trip is bounded by the same tool-call timeout every other call to a
peer uses: the lock these take is the process-wide server map an agent turn
also locks, so a peer that accepts a request and never answers would stall
turns and not just the listing.


## Per-server MCP logs and budgets (AH-140, AH-144)

Each MCP server now has its own log under `<data folder>/mcp-logs/`, named by a hash of the server's name (a name is configuration a repository can supply, so it is never a path component). Both surfaces write it: the desktop's existing stderr pump appends to it as well as to the application logger, and the CLI, which used to discard a server's stderr entirely, now pipes it line by line into the same file. Lines are scrubbed before they are written and bounded by the scrubber's own length cap; a log rotates at 512 KB into one previous generation. It is viewable in the app (a log button on each server's row in MCP settings opens a dialog, keyboard-reachable and labelled) and from `jan cli mcp logs <server>`.

A server entry may declare `"budget": {"maxResultChars": N, "maxSessionChars": M}`. `maxResultChars` narrows the global per-result cap for that server and can never widen it. `maxSessionChars` bounds the total a server may return in the process's session: it is checked before the server's arguments are sent, so a refusal never spends what it refuses, and a spent server is refused with a typed `budget_exhausted` naming it while other servers are unaffected. Token cost is reported as an estimate (four characters per token) and labelled as one. The session ledger is per process: it resets when the app or CLI run restarts, which is stated in the refusal.

## Portable agent bundles (AH-145)

`jan cli agent bundle-export <out>` writes a project's subagents, skills (with the text files a skill bundles), plugin command templates and `[tools]` policy as one JSON bundle; `bundle-import` reads one back. Import treats the bundle as hostile: every path must be relative, `/`-separated and under `subagents/`, `skills/` or `plugins/<p>/commands/*.md`, free of `..`, drive letters, device names and `.git`/`.jan`, and unique without case; every entry's SHA-256 must match; unknown fields refuse the bundle. The policy goes through the same `plan_import` comparison `policy import` uses, so a bundle that widens what the agent may do is refused unless `--accept-widening` is passed, and that check happens before any component is written. Entries that exist with different content refuse the import unless `--overwrite`. Everything is written to a staging directory and moved into place only when every entry is staged; a failure removes the staging directory. Links are neither followed on export nor written through on import. Binary files and files over 1 MB are reported as skipped, not silently dropped.


## One compaction policy for every surface (AH-076)

Compaction was decided twice: the Rust loop kept a fixed eight-message tail and triggered at `window - [agent].compaction_reserve_tokens` (a key only the CLI read), while the chat transport budgeted by the model's output cap, summarised in 512 tokens and turned on only through a per-model inference parameter. The same conversation compacted differently depending on which window it was open in.

`tauri_plugin_agent_tools::compaction_policy` is now the single definition, with five fields -- `auto`, `reserveTokens`, `keepRecent`, `strategy` (`summarize` or `trim`) and `summaryMaxTokens` -- resolved from defaults, then the user's `<data folder>/compaction.json`, then a project's `.jan/agent/compaction.json` (the legacy `[agent].compaction_reserve_tokens` still counts as a project value). Every field records its origin, so the settings page can say when a project overrides it. The CLI and TUI (proactive trigger, automatic tail), the Rust loop's overflow and budget compactions (tail, strategy, summary cap) and the chat transport (auto switch, headroom, strategy, summary cap) all read it; `trim` never calls a model. The reserve kept free is never more than a quarter of the window on any surface -- a 16K reserve is headroom in a 128K window and would leave nothing in a 4K local model's; the first TypeScript wiring did exactly that and an existing transport test caught it.

A policy file that will not parse, names an unknown field or holds an out-of-range value is refused with a typed `invalid_input` naming the file and field: a run through the orchestrator does not start, the settings page shows the refusal instead of defaults, and nothing invalid is ever written. Edit it in Settings > Agent Tools (saved atomically at user scope, one field at a time) or read the effective policy with `jan cli agent compaction`.

The AH-140 scenario also exposed a defect in an existing path: the desktop's MCP stderr pump wrote a server's raw stderr, credentials included, into the application log. Lines are now scrubbed before either log keeps them.


## Stepping through a finished run (AH-176)

The event log already held everything a run did, in order, and the timeline panel already rendered it; what was missing was a way to see the run as it stood at any point rather than only as it ended. `tauri_plugin_agent_tools::run_replay` decides what can be stepped through: a run with a recorded `run.started` and a recorded `run.ended`. `finished_runs` lists them in the order they finished (runs overlap -- the chat run inside an agent run starts later and ends earlier -- so start order would offer the wrong one as the latest), and `recording` returns one run's events. A run the log does not hold is refused as `not_found`; a run with no recorded end (still going, or cut off) or no recorded start as `invalid_input`; a log that cannot be read as `malformed_state`; each at stage `replay`. The desktop reaches them through `agent_events_runs` and `agent_events_run`.

In the timeline panel, Step through (disabled while a run is going) loads the most recently finished run; a selector offers the others. The panel then renders `buildTimeline` over the first N events of that run -- the same builder as the live view, so step N shows exactly what the record held after its Nth event: a call can be seen running, then awaiting approval, then completed. The row the current step created or changed is marked `aria-current="step"` and kept in view. First/Previous/Next/Last buttons, a slider and the arrow, Home and End keys move between steps; the step's event kind and time are announced. Nothing is re-executed and no request is sent. Leaving replay restores the live view; an answer that arrives after replay was left or the session changed is dropped by a request token, so an abandoned load leaves nothing behind.


## MCP OAuth tokens in the secret store, refreshed ahead of expiry (AH-134)

Remote MCP OAuth tokens were kept in plaintext in `<data>/mcp_oauth.json` (owner-only on Unix, unprotected on Windows) and refreshed only when a connection was opened: rmcp's own refresh compares the token's original `expires_in`, which never decreases, so a connection left open past the token's lifetime kept sending an expired token.

Tokens now live in the same secret store as provider keys (`provider_secrets`: the OS keyring -- Windows Credential Manager on Windows -- or its AES-GCM file when the keyring is unavailable or refuses a value over its size limit). The record key is `mcp-oauth:` plus a hash of the canonical data folder and the server name, because the keyring belongs to the OS user, not to a Jan profile: two profiles with a server of the same name neither read nor overwrite each other's tokens. A plaintext record from an earlier build is moved into the store the first time it is read; the plaintext copy is removed only after the store holds it (a store that cannot be written leaves it where it was), and the file is deleted once empty. A store record outranks a plaintext one.

`authorized_client` refreshes a token inside the 60-second window when it connects, and then starts a refresher for the connection that refreshes each token 60 seconds before its expiry, stores the result and repeats. It holds the connection's authorization manager weakly and checks every two seconds, so it ends with the connection. A provider that omits the refresh token on refresh (RFC 6749 section 6) keeps the previous one, both in the store and on the live connection. Failures are typed: a stale resource, an expired token without a refresh token and a refused refresh are `authentication` at stage `startup` (the stored tokens are left untouched), discovery failure is `transport`, and a store that cannot be written is `io` at `persistence`. `jan cli mcp auth-status <name>` and `jan cli mcp auth-clear <name>` expose the state and the clear.

Two existing defects surfaced on the way. `extract_command_args` required `command` and `args` for every server, so an http or sse server added with `jan cli mcp add --type http` was refused as an invalid config and could never connect; a remote server with a url now needs neither. And the shared test helper `with_temp_data_folder` never kept tests off the OS keyring; it now forces the encrypted file.


## A headless JSON-lines API (AH-182)

`jan cli agent run --output-format json` answers how one run ended, once it is over. A program that supervises runs needs to start them, watch them, answer their approval prompts, ask what is going on and stop them. `jan cli agent serve` (module `core::cli::json_api`) reads one JSON request per line on stdin and writes one JSON message per line on stdout: `ready` once with the protocol version (`jan-agent-api/1`), a `response` for every request (a `result`, or an `error` in the versioned harness-error wire form), an `event` for every stream event of a run, and exactly one `result` per run -- the same envelope `--output-format json` prints. Methods: `run {project, task, model, safe}`, `status`, `approve {run, request, allow}`, `cancel {run}`, `shutdown`. Requests are read strictly: a line that is not a JSON object, a missing or non-scalar `id`, an unknown field or method, or a blank task is refused as `invalid_input` (echoing the `id` when it could be read); an unknown run or approval is `not_found`; cancelling a run that has ended is `invalid_input`.

Runs go through the same preparation, orchestration and thread persistence as `jan cli agent run` -- persistence is one shared function, `persist_headless_run`, so the two surfaces cannot save a run differently. A `safe` run's permission prompts arrive as `permission_request` events and wait for `approve`. Cancelling drops the run's orchestration future, disconnects the MCP servers that run started, refuses its pending approvals, removes its scratch directory and reports `stop_reason: "cancelled"` (a new `RunReport::cancel`); a cancelled run's partial conversation is not written. End of input or `shutdown` cancels every run still going and waits for each to report before the process exits. The protocol layer is independent of what a run is (`Runner`), so it is tested without a model.


## CPU and memory attributed to the run that used them (AH-174)

The system monitor showed the host's CPU and RAM; nothing said which run caused them. `tauri_plugin_agent_tools::resources` measures every command a `bash` call starts as a process tree and keeps the figures against its run and call. On Windows the command's root process is placed in a job object at spawn (`Meter::attach`); a job accounts for every process created inside it, including children that have already exited, so the reading at exit is the tree's: user plus kernel CPU time, the job's peak committed memory, and the number of processes. A process started in the instant between spawn and assignment would escape the job; the shells used start nothing that early. The job has no kill-on-close limit, so closing the measurement never touches the command. On other platforms there is no per-tree accounting that survives a child's exit without owning its reaping, so a command there is recorded `measured: false` with the reason -- never as zero.

The ledger is keyed by run and call: `record` adds to the run's totals and keeps the call's reading, `take_call` hands the call's reading out once, and `finish_run` returns the run's totals and forgets everything kept for it. Totals sum CPU and processes and take the highest single peak (commands overlap, so peaks are not summed), and count commands that could not be measured with the first reason. Both surfaces carry it. In the agent loop the call context now names its call id; `record_outcomes` puts the call's reading on its `tool.*` event, and the run's end puts the totals on `run.ended` and emits `StreamEvent::RunResources`, which the headless result envelope reports as `resources` and the text printer shows on stderr. On the desktop, `execute_tool` measures under the run it is given (`with_measured_run`) and returns the reading in `ToolResult.resources`; the Cowork dispatcher passes the call id and records the reading on the call's terminal event, and the run's end takes the totals through `tool_resources_finish_run`. The execution timeline shows them in the row detail: CPU, peak memory and processes, or `Not measured: <reason>`, and on the run's end how many of its commands were measured.


## A run interrupted mid-turn resumes with its turn (AH-026)

A resumed run already carried every completed tool call and result (Phase 5), but only as of the last saved turn: a run killed mid-turn lost that turn outright. On both surfaces the turn in flight is now kept while it happens, and a later process offers it back instead of silently losing or re-running it.

**Headless (`jan cli agent run`, the JSON API).** `core::cli::inflight` keeps `<thread>/inflight.json` for the run in flight: the conversation as the loop last published it, the text streamed since (written at most every 400 ms, bounded), and the writer's pid and creation time. The thread record itself is written when the run starts, so an interrupted thread is listed and resumable by id; a clean end removes the checkpoint. Two defects stood in the way and are fixed: the loop published its conversation only at natural stops, so no checkpoint could hold a step completed before the run died -- it now publishes each completed step as soon as its results are in; and process liveness trusted creation time alone, which on Windows reads a process that has ended as alive while anything holds a handle to it -- `job_record::still_running` (used by background-job reconciliation too) now also asks whether the process has ended. On `--resume`, a session another live process is running is refused (`invalid_input`, naming the pid). A session whose run was cut off is refused unless the caller chooses `--interrupted=continue` (keep the completed steps and the unfinished reply) or `--interrupted=discard-partial` (keep the steps, drop the reply); either way the model is sent the recovered conversation and a note, as a user-role message marked as coming from Jan, that the previous run was interrupted -- a system message would be replaced by the run's prompt, and a status marker in the assistant's own voice is one the model imitates. A client's cancel over the JSON API is a decision, not an interruption, and leaves no checkpoint.

**Desktop (Cowork).** A Cowork run's live turns are checkpointed onto the persisted session (`inFlight`) at every step and at most every half second while text streams, and cleared when the turn is committed. A session holding a checkpoint of a run that is not running in this process shows `CoworkInterruptedTurn`: how many completed steps were kept and how long the unfinished reply is, with Continue and (when there is a reply) Discard unfinished reply. Nothing resumes until one is chosen. `recoverInFlight` rebuilds the conversation from the checkpoint (a call that never finished is closed as `stale`, not left running), adds the note from Jan, and the next run continues from it.


## Restarting or replacing a failed team member (AH-111)

A team retried a failed task only automatically (`retries`, capped at `MAX_TASK_RETRIES`); once those were spent the task stayed failed, everything downstream was blocked, and the only way to try again was to run the whole team -- the whole run -- again. `runTeam` now takes a `TeamControl`. A failed task can be restarted as it was, or replaced -- given to another subagent, or a corrected brief -- while its team is still running: `checkRequest` refuses by kind a task that is not failed, a missing task, an empty or no-op replacement, and any request once the team has ended; `applyReplacement` changes that task in the team's own copy of the graph (the caller's is untouched); `reopen` makes the task pending again, together with every dependent that was blocked only because of it -- a dependent still blocked by a different failure stays blocked. The failed attempt leaves the report, so the report describes the attempt that counts.

A team with a control that would end with failures holds instead of ending, so a person can decide. The hold is bounded (`DECISION_WINDOW_MS`, five minutes): the wait happens inside the agent's own `team` tool call, and an unattended run must not block on a decision nobody is there to make. The outcome says why a team with failures ended -- `finished` by a person, `window-elapsed` with nobody deciding (the agent is told the failed tasks were not restarted), or `stopped` with the run. Nothing restarts on its own. In Cowork the route registers each running team's control (`useTeamControls`, not persisted: a control reaches a team only while its run is alive) and the Activity panel shows Restart, Replace (brief and subagent) and Finish team on a failed member of a held team. What a person did is recorded on the member's persisted activity task (`attempts`, `replacedWith`), so after a restart the row says it was restarted or replaced by hand -- and offers no controls, because the team ended with its run.


## Durable subagents (AH-101/AH-102)

An ordinary background subagent is a future inside the dispatching process: it is aborted with its parent run and gone when the process exits. `dispatch_subagent` now takes `durable: true`, which starts the child as a job under the worker's detached supervisor instead (`core/agent/durable_subagent.rs`).

**What travels.** The parent resolves the dispatch exactly as it would an in-process child (`resolve_dispatch`, the three-way tool intersection, routing by agent name) and writes a spec file into the worker directory: subagent name, brief, optional one-off prompt, the intersected tool list, the routed model, the project, the owning conversation, the dispatching run and dispatch id, the data folder, the remaining token budget and `send_reasoning`. Never a credential: the child resolves providers and keys the way any CLI run in that data folder does. `deny_unknown_fields` and `validate` refuse a spec that could not describe a runnable child; a dispatch id cannot steer the spec path out of the worker directory.

**How it runs.** `worker::start_argv` starts the supervisor with `--argv-json`, and the supervisor runs this program with `cli agent run-subagent --spec <file>` -- an argument vector, never a shell line, so nothing in a brief is ever parsed as a command. The job record carries `kind = "subagent"`. The child (`run_durable_subagent`) is configured by the same `configure_child_args` and `child_body` an in-process child uses -- its own subject for the permission gate, no nested dispatch, no questions, no parent todo list -- so the two kinds of child cannot drift apart. Its answer is what it prints, which the supervisor keeps as the job output; its ending is the record the supervisor writes. Nobody is attached to a durable child, so every permission prompt is denied and said so: it does only what the project's rules already allow.

**Lifecycle.** The job id is the child's `run_id`. `await_subagent`, `list_subagent_runs` and `cancel_subagent` recognise a durable child of *this conversation* (the job's owner) and reach it through the worker: await polls the settled record and returns the output of a completed job or a typed `child_failed` naming how it ended (failed, cancelled, interrupted); list appends the conversation's durable children; cancel stops the supervisor's tree after the claim proves identity. Because the owner is the conversation, a later run of the same conversation -- `--resume`, or a new app process -- can await, list and cancel it; another conversation sees nothing.

**Refused rather than approximated.** A durable child cannot fork the conversation. In a git repository it gets no checkout of its own, so it must be dispatched with `isolate: false`, which is the dispatcher saying its changes land in the project directly. A run with no conversation id cannot own one.

**Reboot.** A machine that goes down takes the supervisor and child with it. Nothing is written at that moment, so the next process that looks settles the record through the existing claim check: the supervisor's pid and creation time are gone, the job is `interrupted`, and awaiting it says so instead of returning an answer. This was exercised as a simulated reboot (supervisor and child tree killed together); a physical reboot was not performed.

**Scope.** Cowork's own in-app subagents are not durable, by decision: they run in the webview on the app's loaded model instance under per-run grants, none of which exist once the app exits, and they are recorded as interrupted on restart (AH-026/AH-089). Durable background agents are the harness loop's (`jan cli agent run`, `agent serve`), which is the loop that can run without the app.


## OAuth scopes for MCP servers (AH-135)

Before this, a sign-in to a remote MCP server asked for no scopes at all (`start_authorization(&[], ..)`) and kept whatever the provider granted, so the authority a stored token carried was whatever the provider chose and nobody on Jan's side had stated or seen it.

**Declared.** A server's `mcp_config.json` entry declares its scopes: `"oauth": { "scopes": ["mcp:read", "mcp:tools"] }` (`jan cli mcp add --scope`, repeatable; the TUI edit form keeps an entry's existing scopes). `oauth::declared_scopes` reads them as a sorted, de-duplicated set of RFC 6749 scope tokens and refuses, as `invalid_input`, anything else: an `oauth` value that is not an object, a key other than `scopes`, a non-list, a non-string, an empty token, or a token with a space, quote, backslash or non-ASCII character. A typo there never quietly means "no scopes". Scopes on a stdio server are refused.

**Shown.** `jan cli mcp get`/`list` print the `oauth` entry (never redacted: it is not a secret, and it is the authority the token will carry). `jan cli mcp auth-status` and the desktop's `get_mcp_auth_status` return `declaredScopes` (what a sign-in will ask for), `requestedScopes` and `grantedScopes` (what the stored token was asked for and given) and a `detail`. The desktop MCP settings row shows "Asks for" and "Granted" under the auth badge; the TUI detail screen shows the granted scopes. `jan cli mcp auth <name>` prints the scopes it is asking for before the consent url, and what was granted after -- it never opens a browser, so it works over SSH.

**Requested.** `begin` sends exactly the declared scopes in the consent request.

**Enforced.** Three places, each refusing rather than trusting:

* *At the grant.* `complete` computes what was granted (the response's `scope`, or -- RFC 6749 section 5.1 -- what was requested when the response omits it) and refuses, as `permission_denied`, a grant carrying any scope that was not asked for. The token is not stored. A narrower grant is the provider's right; it is kept and shown as narrower.
* *At use.* `authorized_client` refuses to send a stored token unless it was asked for under exactly the scopes the configuration now declares and carries nothing beyond them. Widening the declaration therefore needs a new consent, and narrowing it stops a broader token from being used. `status` reports this as `scopeMismatch` (sign in again), and an unreadable declaration as `invalidScopes` (no sign-in is offered until it is fixed). This is the shared path: the CLI transport and the desktop activation (`mcp::helpers`) both connect through it.
* *At refresh.* A refresh that comes back with a scope beyond the grant is refused and not stored, both at connect and in the live refresher, which also puts the connection back on the token it had.

Records written before scopes existed deserialize as requested and granted nothing, so a server that declares none keeps working unchanged.


## Language servers (AH-057, AH-058)

The project index (`index.rs`, AH-059..061) locates names by reading text; by its own documentation it does not resolve them. It cannot say which of two `Close` methods `f.Close()` calls, and for a language whose declarations it does not recognise it cannot say anything: Go is read with JS/TS keywords, so no Go `func` is indexed at all. A language server type-checks the code and can answer. `core/agent/lsp.rs` is the client; the agent asks it through the `lsp` tool.

**The protocol (AH-057).** JSON-RPC 2.0 over the server's stdin and stdout with `Content-Length` framing (`encode`/`decode`; a message over 32 MiB, a frame without a length or a cut-short body is a protocol error, not an allocation). The client sends `initialize`/`initialized` with the project as the workspace folder, keeps each file it asks about in sync with the disk (`didOpen`, then a full-text `didChange` when the file's contents changed), and asks `textDocument/definition`, `references` (with the declaration), `implementation` and `hover`. `publishDiagnostics` notifications are kept per file; `diagnostics` waits, bounded, for one published after the file was synced. Requests the server makes of the client (`workspace/configuration`, progress creation) are answered with defaults so a server that asks is never left waiting. Positions are converted between the model's 1-based characters and LSP's 0-based UTF-16 units in both directions. Locations are shown relative to the project, and a location outside it (the standard library) is marked as such.

**The tool.** `lsp` takes `action` (definition, references, implementation, hover, diagnostics, status), `path`, `line`, `column`. The path is resolved inside the project like every path the model names and refused when it escapes. It is read-only, so it is offered and answered in Plan mode, and it does not depend on the subagent context. Errors are typed: a file no known server covers, or `[tools] lsp = false` in `agent.toml`, is `unsupported`; a server that is not on PATH is `tool_unavailable` and says Jan installs nothing; a server that does not finish starting, crashes, or keeps failing is `tool_failed`; a request past its deadline is `timeout`; a stopped run is `cancelled`; an unreadable answer is `invalid_response`.

**Which servers.** `SERVERS` lists only what has been exercised: Go files go to `gopls`. A server is used only when it is already on PATH. It is started with `GOPROXY=off` and `GOTOOLCHAIN=local`, so starting one never fetches a module or a toolchain, and with the shell's environment allowlist plus the toolchain's own variables -- never the host's whole environment, so API keys a run holds do not reach it.

**Lifecycle (AH-058).** `LspPool` is owned by the run's tool invoker. A server is started on first use and reused for the rest of the run.

* *Health.* Before every use the process is checked, so an exited server is noticed before a request waits on it; a request that outlives its deadline marks the server unhealthy and it is replaced on the next use rather than asked again.
* *Restart.* A dead or wedged server is restarted at most `MAX_RESTARTS` (3) times in a run; after that the refusal says it kept failing.
* *Shutdown with the run.* Dropping the pool -- when the run ends -- sends `shutdown` and `exit`, waits briefly, then stops the process tree and joins the reader thread.
* *Cancellation.* A waiting request stops at once and sends `$/cancelRequest`. The server's process is adopted by the run's cancellation token, so stopping the run stops it; it is registered for the application's shutdown reaping; and it runs in a process tree stopped as a unit (`tools::owned::OwnedChild`): on Windows a kill-on-close job object, so it cannot outlive Jan even when Jan is killed, and on Unix its own process group.


## Custom certificate authorities (AH-190)

A company that inspects TLS, or runs its own model gateway, signs server certificates with a private CA the operating system does not know. Before this there was no way to trust one short of switching verification off. `core/net/tls.rs` is the narrow way: it adds the roots from one PEM bundle to every outbound client that talks to a configured or remote endpoint, and changes nothing else.

**Where the bundle is named.** Only where the user decides: `JAN_CA_BUNDLE` in a process's environment; for the CLI, `ca_bundle` in `~/.jan/config.toml`, written by `jan cli net ca set <path>` after the bundle is checked; for the desktop app, a path in the HTTPS proxy settings (stored in `settings.json` under `setting-proxy-config`, field `caBundlePath`). A project's `agent.toml` cannot name one -- trust in a certificate authority is not the repository's to grant -- and the CLI does not inherit the desktop's setting. A run that tries to write the user's config to name one stops at the permission gate (`WriteEscape`) even in a project that allows everything else by default.

**What it changes.** The bundle's certificates are added to the platform's roots on both HTTP stacks (reqwest 0.12 `add_root_certificate`, reqwest 0.13 `tls_certs_merge`). Verification stays on: the chain, the host name and the dates are still checked, so a custom CA never makes a certificate for another host acceptable. Nothing falls back to plain HTTP.

**What it covers.** The agent client (`genai_bridge`, used by agent runs and the API server), the desktop provider transport (`net::transport`), both outbound clients of the local API server proxy, the MCP HTTP/SSE base clients on the desktop and in the CLI (and so MCP OAuth), the CLI model listing, provider login and Tokamak/device-auth clients, webhooks, and the plugin and skill hubs. Clients that cache are rebuilt when the bundle changes: the agent client and the transport's per-endpoint cache are keyed on `tls::fingerprint()` (path, size, modification time), so a setting changed while the app runs applies to new connections without a restart. Not covered: the separate web search and llama.cpp plugin crates (fixed public providers and localhost) and the pre-existing download client, whose proxy setting `ignoreSsl` still switches verification off -- unchanged here, and the reason this feature exists.

**Refusal and failing closed.** `load` refuses, by kind, a bundle that is missing (`not_found`), unreadable or not a file (`unreadable`), over 1 MiB (`too_large`), without a PEM certificate (`no_certificates`), or with any block that is not an X.509 certificate for both stacks (`malformed`; one bad certificate refuses the whole bundle). `jan cli net ca set` refuses such a bundle and saves nothing; `jan cli net ca status` and the settings page (`network_ca_status`, `network_ca_check`) report what is in force -- none, in use with each certificate's SHA-256, or broken with its kind and reason. A bundle that is named but cannot be used makes every client fail closed: built-in roots are switched off and nothing is trusted, so a typo cannot silently mean the bundle is ignored.

**Certificate failures are named and not retried (R13).** Found from this feature's own failing evidence: an agent run against a server whose certificate was not trusted spent about 35 seconds on ten attempts and then said only "error sending request". `genai` keeps the transport error only as text, so the cause never reached the retry decision. `tls::certificate_failure` reads a failure's source chain -- the Windows SChannel codes (CERT_E_UNTRUSTEDROOT, CERT_E_CN_NO_MATCH and the related CERT_E/SEC_E codes, matched by value and as `os error <code>` text, because the io::Error is not reachable by downcast behind hyper's connect error), then the wording OpenSSL, Security.framework and rustls use -- and names the reason. On the agent path, the first failure without an HTTP response is diagnosed once with one request to the same endpoint through the same client; a certificate failure is then returned at once with its reason and marked not retried. The desktop provider transport and the API server's one-retry path do the same from the error they already hold. A plain-HTTP protocol mismatch or a refused connection is not a certificate failure and keeps the ordinary retry.


## Benchmarking the harness against a fixed task set (AH-196)

A change to the agent loop -- a system prompt, a retry policy, a tool description -- is judged by running it, not by reading it. `core/cli/bench.rs` adds `jan cli bench run` and `jan cli bench compare`.

**The task set** is one TOML file: a name and tasks, each with an id, a prompt, the files of the project it starts from and objective read-only checks (`file_equals`, `file_contains`, `file_absent`, `result_contains`). It is refused by kind before anything runs when it does not parse, has no tasks, repeats an id, names an unknown check or a path that escapes the task's project. Its SHA-256 is recorded in the report.

**How a task runs.** In a fresh scratch copy of its project, as a separate `jan cli agent run --output-format json` process -- the same binary and loop, nothing mocked in-process -- with the benchmark's model and data folder, under a per-task deadline. The child is owned (`tools::owned`, kill-on-close job), so an interrupted benchmark stops its agent and the agent's tree. Scratch copies live under a directory named for the benchmark's PID; a benchmark killed outright cannot remove its own, so each run first sweeps scratch left by benchmarks whose process no longer exists and keeps a live one's.

**The report** records per task the outcome (completed, failed, timed out, cancelled), failed checks with reasons, turns and duration. Ctrl+C marks the run incomplete and exits 130. `compare` refuses two reports of different task sets, lists tasks that regressed or improved, and exits 1 when any task that passed before fails now.


## Consensus gates (AH-112)

Some decisions should not rest on one agent's judgement: shipping a risky change, accepting a plan, approving a migration. The `consensus` loop tool (`core/agent/consensus.rs`) puts a yes-or-no question to two to seven independent read-only reviewers and decides it by a stated quorum -- `all` (default), `majority`, or a number of approvals.

**Independence.** Every reviewer is dispatched as its own subagent before any is awaited, so they work at the same time; each gets only its brief (which reviewer it is, the question, the context) and never another reviewer's answer.

**Who may sit on a gate.** Only reviewers whose resolved definition allows nothing but read and network tools. The registry's definition decides, never the name: a project or user definition of `reviewer` replaces the built-in one and may allow `bash`, and is then refused (R15). Unknown names and roles that write or run commands are refused with `permission_denied`; one reviewer, a reviewer listed twice, more than seven, an empty question or a quorum that cannot be met are refused with `invalid_input` -- all before any reviewer runs.

**Verdicts.** A reviewer's answer counts only when its first non-empty line is exactly `VERDICT: approve` or `VERDICT: reject`. Anything else -- a verdict buried later in the text, an error, a cancelled reviewer -- is not counted and is never an approval. The outcome is approved once the quorum's approvals are reached, rejected once too few reviewers remain who could approve, otherwise undecided; a cancelled run is cancelled.

**Record.** A decided gate is written atomically to the data folder under a digest of the project path, with its question, quorum, reviewers, verdicts, outcome, session and run, and noted in the run's invocation record (`consensus.decided`). Calling `consensus` with just `id` reads a gate back -- after a restart too -- and only in the project it belongs to; an id that is not a gate id is refused. A gate that could not be recorded does not count, and a run killed while its reviewers are answering records nothing.
