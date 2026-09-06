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

Rules are `(subject, capability, resource)` predicates. The current model globs
tool names only, so "allow `read` under `src/**`" and "deny `bash` running
`git push --force`" are inexpressible -- which is why `AH-034`, `AH-036`,
`AH-037`, `AH-043` and `AH-046` are all one design change rather than five.

### AHD-006: the capability model covers every dispatchable tool

`Capability::{Read, Write, Exec, Net}` classifies the 16 built-ins and drives
gating, plan-mode enforcement and concurrency. MCP tools carry no capability and
are gated by name alone. Extending the model to MCP is a precondition for
per-server policy (`AH-041`) and for plan mode being trustworthy (`AH-013`).

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

The remaining gap is scope, not machinery. Worktrees are bound per *session*;
the Rust subagent runner still fans out up to ten concurrent children against
one `project_root`, with no per-agent tree, no merge step and no per-file
provenance. Every orchestration item that increases concurrency
(`AH-101`..`AH-112`) is gated behind extending the existing module to per-agent
worktrees (`AH-107`), not behind building a new one.

### AHD-009: what the model saw is a record, not a re-derivation

The dispatched payload is persisted (`AH-078`). Token accounting, replay,
diffing and the inspector read that record. The current `/context` report
re-derives the prompt from present-day disk state and admits in its own docstring
that it omits parts of what was sent; a resumed thread therefore cannot be shown
the context it actually ran under.

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

### AHD-013: a repository tool states what it cannot know

The repository-intelligence tools answer from the declaration index and from
files at the project root. None of them runs a compiler, a type checker or a
coverage run, so each one has a boundary it cannot see past, and each says so in
the same words in its tool description and in every rendered result:

- `symbol_search` and `code_search` match text, not meaning. There is no
  embedding model, vector store or conceptual similarity anywhere in the path, so
  a differently-named equivalent will not be found.
- `impact` maps tests by filename convention and dependents by the import graph,
  not by coverage. Passing the tests it names does not prove a change safe.
- the project block names the file each claim came from, and an unrecognised
  project produces nothing rather than a plausible default.

The rule this encodes: a tool that guesses silently is worse than one that
returns nothing, because the model cannot tell a guess from a fact and will act
on it. Absence of a caveat is read as a guarantee, so the caveat travels with
every result rather than living in a doc the model never sees.

Reference search and go-to-definition are deliberately absent for the same
reason. They are resolution questions, and a regex cannot resolve a name to its
binding: it cannot tell a shadowed local from the import it shadows, or a method
on one type from the same method name on another. Approximating them would
produce answers indistinguishable in shape from correct ones. They wait for a
real LSP client (`AH-060`-`AH-064`).

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

## 5. Phase 3 repository-intelligence modules

Phase 3 adds four modules under `core/agent/`, all read-only, all advertised to
the model including in plan mode:

| Module | Tool | Answers |
| --- | --- | --- |
| `index.rs` | -- | a declaration index: every symbol's file and line, its doc comment, and each file's imports |
| `index.rs` | `symbol_search` | where is `X` declared |
| `search.rs` | `code_search` | where does the text `X` appear, as a name, a word inside one, a path or a doc comment |
| `impact.rs` | `impact` | what should I run after changing these files, and who imports them |
| `project_kind.rs` | -- | what kind of project is this (injected into the runtime block every run, not a tool) |

The index is the shared substrate. It is built once per run, keyed on
`(size, mtime)` per file so a refresh re-reads only what changed, bounded at
20,000 files and 1 MiB per file, and it honours `.gitignore` (via `ignore` with
`.require_git(false)`, so a worktree without a `.git` directory still filters).
It carries `INDEX_SCHEMA_VERSION`; an index written by an older version is
discarded and rebuilt rather than read, per AHD-010. Version 3 added the
doc-comment field that `code_search`'s metadata matching reads.

`code_search` classifies every hit as exact, token, fuzzy or metadata, and that
class alone decides the reported confidence -- 100, 75, 45, 30. The number is a
restatement of the evidence, not an independent judgement about relevance, which
is why it is fixed per class rather than computed. Ranking is total and
deterministic (match type, symbol name length, path, line) over a `BTreeMap`, so
the same query returns the same order and a capped scan always stops in the same
place. Query length, result count and scan cost are all bounded, and a refusal
names its reason. An empty index, a scan that stopped early and a genuine miss
are three distinct outcomes and never collapse into one message: "no results"
from an index that was never built is a lie about the repository.

## 6. Relationship to the Cowork harness blueprint

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
