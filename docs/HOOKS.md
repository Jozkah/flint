# Hooks

Hooks are shell commands you ask Flint to run at defined points in an agent
run: a linter before every write, a policy check that refuses a command the
project does not allow, a notification after a tool runs. They are implemented
in `src-tauri/plugins/tauri-plugin-agent-tools/src/hooks.rs` and run from the
tool dispatcher in `tools/handlers.rs`.

## Where hooks live

`<project>/.jan/agent/hooks.toml`

The model cannot create or edit this file: `.jan` is refused to every
file-writing tool and to `bash`. A `hooks.toml` that is a symlink resolving
outside the project is not read. A project without the file has no hooks.

## Format

```toml
[[hook]]
event = "pre-tool"          # required: pre-tool | post-tool | post-tool-batch | run-end
command = "npm run lint"    # required: a shell command, at most 4096 characters
on_failure = "block"        # optional: block | warn | ignore (default warn)
timeout_secs = 30           # optional: 1 to 120 (default 30)
tools = ["write", "edit"]   # optional: tool names; empty or absent = every tool
```

At most 32 hooks are read. Hooks run in the order the file declares them.

A file with any mistake (invalid TOML, a missing `event` or `command`, an
unknown event or failure policy, a limit exceeded, `block` on an event that
cannot block) disables all hooks in it and reports the reason, rather than
running the subset that happened to parse.

## Events

| Event | When | Can block? |
| --- | --- | --- |
| `pre-tool` | before a tool call executes | yes |
| `post-tool` | after a tool call has produced its result | no |
| `post-tool-batch` | once per assistant turn, after all its tool calls have results, before the next model request | no |
| `run-end` | accepted by the parser; not fired by the current tool path | no |

`post-tool-batch` is observe-only and runs detached: the next model request
does not wait for it, its failure or timeout is logged and dropped (never added
to a tool result), and `block` is refused for it. A `tools` list matches when
any call in the turn used one of those tools. It fires from the Rust agent loop
(CLI agent runs), and from the desktop chat: the chat runs its tool calls one at
a time through the `execute_tool` command, and when every call of an assistant
turn has its result it reports the batch with the `fire_post_tool_batch`
command, which does the same detached, observe-only run (no await, errors
swallowed). In the chat the hooks file is the one in the thread's workspace
(the root its tools work in). Cowork and Rooms run their own tool loops and do
not report batches yet.

`session-start` is refused: nothing fires it yet.

## Failure policy

A hook fails when it exits non-zero, times out, is cancelled, or cannot start.

- `block` refuses the tool call the hook ran before, and stops the remaining
  hooks for that point. Only `pre-tool` hooks may use it; a block hook can only
  stop work, never grant any.
- `warn` lets the work proceed and reports the failure.
- `ignore` records the run and nothing else.

## What a hook is told

Only these environment variables (the `JAN_` names are kept as legacy aliases
with the same values):

- `FLINT_HOOK_EVENT` / `JAN_HOOK_EVENT`: the event name
- `FLINT_HOOK_TOOL` / `JAN_HOOK_TOOL`: the tool name, when there is one
- `FLINT_HOOK_TOOL_NAMES` / `JAN_HOOK_TOOL_NAMES`: `post-tool-batch` only, the
  turn's tool names, comma-separated, in call order
- `FLINT_HOOK_TOOL_COUNT` / `JAN_HOOK_TOOL_COUNT`: `post-tool-batch` only, how
  many calls the turn made
- `FLINT_HOOK_AGENT` / `JAN_HOOK_AGENT`: `post-tool-batch` only, `main` for the
  main agent's turn or `subagent` for a turn of a subagent it dispatched, so a
  hook can tell them apart. Set by the harness, never by a model; any other
  value is reported as `main`. Observe-only like the event itself.
- `FLINT_PROJECT_ROOT` / `JAN_PROJECT_ROOT`: the project root

Stdin is empty. The prompt, the tool's arguments and provider keys are never
passed. Captured output is capped at 4096 characters per hook and scrubbed.

## Confinement

A hook is never more privileged than the `bash` tool on the same surface. It
runs through the same shell selection, the same jail policy (project as the
workspace, network only if the run allows it, the Flint data folder masked),
and the project's `.jan` folder is hidden from a confined hook. A hook written
for a POSIX shell is refused, not rewritten, when no POSIX shell can run
confined.

A hook always starts in the project root. A confined PowerShell ignores the
directory it is started in (it opens in `C:\Windows\System32`), so a confined
hook's command is wrapped to open in the project, the way the `bash` tool's is:
a relative path in a hook means the same file under `--sandbox` as without it.
