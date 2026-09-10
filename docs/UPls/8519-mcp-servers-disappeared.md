# janhq/jan#8519 — MCP servers disappeared from the list

- Upstream: https://github.com/janhq/jan/issues/8519
- Kind: issue, open upstream
- Priority: P1 (data loss: every configured MCP server)
- Status in this fork: **fixed**

## Root cause, confirmed in this fork

The reporter's `mcp_config.json` after the loss contained only `mcpSettings`
and an inactive `Jan Browser MCP`. `get_mcp_configs`
(`src-tauri/src/core/mcp/commands.rs`) produces exactly that file from any
config it cannot parse:

1. parse fails → start from `json!({})`;
2. add default `mcpSettings` and an empty `mcpServers`;
3. "migration": add `Jan Browser MCP` if missing;
4. `mutated` is true → `fs::write` it back over the original.

The user's servers are overwritten with no copy kept. A config becomes
unparseable easily enough, because every writer — `save_mcp_configs`,
`add_server_config_with_path`, and the setup migrations — used a
truncate-then-write `fs::write`.

Reproduced by `an_unreadable_config_is_kept_before_defaults_are_written`
(`src-tauri/src/core/mcp/config_durability_tests.rs`), which fails against the
old code.

## Fix

- An unreadable config is copied to `mcp_config.json.corrupt-<millis>` before
  anything is written. If that copy fails, the defaults are served for the
  session and the original is not touched.
- Every `mcp_config.json` writer uses `write_file_atomically` (staging file,
  flush, rename), so a crash can no longer produce a torn file.

## The second symptom: `key 'arguments' not found`

The same report shows every generation failing with
`json.exception.out_of_range.403 key 'arguments' not found` — llama.cpp's chat
template reading a tool call with no `arguments`.

`convertUIMessageToThreadMessage` (`web-app/src/lib/messages.ts`) stored a
call's arguments as `JSON.stringify(part.input ?? part.args)`. For a call
stopped before its input streamed, both are undefined and
`JSON.stringify(undefined)` is `undefined`, so the stored call had no
`arguments` key. Reloading produced a tool part with no input, and every later
turn replayed it into the template.

Now a missing input is `{}` when stored, and `{}` when restored — for both the
current and the legacy stored shapes, so threads saved before the fix heal on
load. Removing the load-side default fails
`gives a stored tool call without input an empty input object`.

## Verification

```
cargo test --lib (test-tauri) config_durability   2 passed
cargo test --lib (test-tauri)                      816 passed
```
