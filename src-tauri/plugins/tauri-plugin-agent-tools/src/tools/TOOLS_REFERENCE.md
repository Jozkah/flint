# Built-in tool descriptions: reference and intentional differences

The built-in tool schemas in `schema.rs` were rewritten as *behavior-steering*
model instructions: each description says when to use the tool, when not to, the
validation rules a call must satisfy, the defaults for omitted fields, and the
safety boundary the tool enforces. This mirrors the intent of the Claude Code
2.1.89 reference tool set, adapted to Jan's actual runtime.

Jan does **not** rename tools or change wire formats. Names stay snake_case
(`read`, `edit`, `bash`, …) and existing request payloads keep working. The one
additive schema change is `edit.edits[].replace_all` (optional, default `false`).

## Mapping to the Claude Code reference tools

| Reference tool | Jan equivalent | Notes |
| --- | --- | --- |
| Bash | `bash` | Present. See timeout difference below. |
| FileEdit | `edit` | Batch `edits[]` with `old_string`/`new_string`; `replace_all` added. |
| Read / LS / Grep / Glob | `read` / `ls` / `grep` / `find` | Present, sandbox-checked. |
| WebFetch / WebSearch | `web_fetch` / `web_search` | Present, provider-neutral. |
| (Jan-specific) | `memory_*`, `skill_*`, `screenshot` | No Claude Code counterpart. |

## Intentional differences

- **`bash` timeout is in seconds, not milliseconds, and never kills.** The
  reference `Bash` caps `timeout` at 600000 ms and terminates on expiry. Jan's
  `timeout` is **seconds** (default 30) and, on expiry, *backgrounds* the command
  and returns a `job_id` to poll — it does not terminate the process. Changing to
  a millisecond kill-on-expiry contract would break the backgrounding runtime, so
  the seconds/backgrounding semantics are kept and documented in the description.
- **`edit` is a batch of exact replacements**, not a single
  `old_string`/`new_string`/`replace_all` triple. `replace_all` is exposed
  per-replacement (default `false`), which matches the reference default while
  fitting Jan's array shape.

## Deferred: reference tools with no Jan runtime

These reference tools are **not** added, because Jan has no runtime behind them
and adding stubs would be a broad tool-framework rewrite (out of scope):

`Agent`, `TaskOutput`, `TaskStop`, `Config`, `EnterWorktree`, `ExitWorktree`,
`AskUserQuestion`, `ExitPlanMode`, `NotebookEdit`, `ListMcpResources`,
`ReadMcpResource`, `TodoWrite`.

When Jan grows the supporting runtime (subagent orchestration, background-task
lookup, worktree management, plan mode, notebook editing, MCP resource access,
todo tracking), add each as a `BUILTIN_TOOLS` entry plus a `schema.rs` schema and
a `handlers.rs` dispatch arm, following the same behavior-steering description
style used here.
