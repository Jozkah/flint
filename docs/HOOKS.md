# Hook events

`src-tauri/src/core/agent/hooks.rs` runs configurable commands on agent
lifecycle events.

## Configuration

```jsonc
{
  "<event>": [
    {
      "matcher": "<glob over the event subject>",   // absent or "*" = all
      "hooks": [
        { "type": "command", "command": "<shell command>" }
      ]
    }
  ]
}
```

Validated at load (`HookRegistry::compile`): an unknown event key, a hook whose
`type` is not `command`, an empty command, or an invalid-glob matcher is an error
naming what to fix.

## Events

| Event | Subject matched | Blocking? |
| --- | --- | --- |
| `PreToolUse` | tool name | yes |
| `PostToolUse` | tool name | no |
| `PostToolUseFailure` | tool name | no |
| `Stop` | — | no |
| `StopFailure` | — | no |
| `PreCompact` | — | yes |
| `PostCompact` | — | no |
| `PermissionRequest` | operation | yes |
| `PermissionDenied` | operation | no |
| `CwdChanged` | — | no |
| `FileChanged` | path | no |

**Blocking** hooks guard an action that has not happened yet; a non-zero exit or
a timeout blocks it. **Non-blocking** (post/observation) hooks never fail the
caller — their outcomes are recorded, not enforced.

## Payload

Each hook receives JSON on stdin: common metadata (`event`, `sessionId`,
`conversationId`, `timestampMs`, `cwd`, `workspaceId`, `correlationId`,
`chainDepth`) plus a `data` object with event-specific fields (failure category
and safe message; compaction trigger/token counts/result; permission
operation/decision/reason; old/new cwd; changed path/kind/source). Values whose
key names a secret (token, secret, password, api key, authorization) are redacted
before the payload leaves Jan.

## Safety

- **Recursion** — every payload carries a `chainDepth`; a hook-caused event uses
  `HookPayload::child`, which deepens the chain. `fire` refuses once the bound is
  reached, so hooks cannot loop unboundedly.
- **Ordering** — groups fire in configuration order, each group's hooks in order,
  within one correlation chain.
- **Bounds** — each hook has a wall-clock timeout (killed on expiry) and a capped
  captured output.
- **Privilege** — hooks run under the same sandbox/permission context as the
  session; they gain nothing the run does not have.
- **No UI coupling** — the module runs processes and builds payloads; it does not
  touch UI components.
