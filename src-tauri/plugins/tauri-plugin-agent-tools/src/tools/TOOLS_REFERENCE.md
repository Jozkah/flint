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
| Chrome / Playwright MCP | `browser` | One tool with an `action`; see below. |

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

## The `browser` tool

An interactive browser for testing a web app on this machine, in one tool with
an `action` (open, snapshot, click, type, press, select, scroll, wait, back,
reload, screenshot, console, evaluate, close) so a small model keeps one entry
in its tool list. It is deliberately narrower than Playwright MCP:

- **Local pages only.** A separate, throwaway Chromium-based browser (fresh
  profile, dead proxy) that can load only the loopback origins the run opened;
  everything else is blocked and reported, and the session stays alive. Outside
  sites are `web_fetch`'s job. No browser is downloaded.
- **`snapshot` is how the model sees.** A compact outline (about 6k characters
  at most) of what is visible, each control with a ref (`e12`); refs die with a
  navigation and a stale one is refused with an instruction to snapshot again.
  `screenshot` is a picture for models that can see images.
- **Gated per call**, like `git`: looking runs; acting is asked like a write;
  `open` (the model picks which local service the browser reaches) and
  `evaluate` (script in the page) are asked every time. Plan mode withholds
  the whole tool. MCP peers are never offered it.
- **Page content is untrusted.** Snapshots, console text and evaluate results
  come back inside an `<untrusted_web_content>` block.
- **Not offered:** file uploads, downloads (refused and reported), multiple
  tabs (a popup is closed and reported), network interception, cookies and
  storage access other than through `evaluate`.

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
