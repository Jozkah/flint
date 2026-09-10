# janhq/jan#8778 (fixes #8777) — an MCP server's `web_search` skipped its approval

- Upstream PR: https://github.com/janhq/jan/pull/8778 (open, by Totoro-qaq)
- Upstream issue: https://github.com/janhq/jan/issues/8777
- Priority: P0 (permission bypass)
- Status in this fork: **adapted** (reimplemented; the PR does not apply)

## Applies to us

In `web-app/src/routes/threads/$threadId.tsx`:

- `isAutoAllowedTool` treated any call named `web_search` / `web_fetch` as one
  of Jan's own internal tools, which never prompt.
- The dispatcher sent any call with those names to `executeWebTool`.

Both keyed on the name alone. With built-in web search switched off, Jan does not
advertise its native web tools, so a call by that name came from an MCP server
that exposes one. That call was auto-approved — the user never saw the server's
approval prompt — and sent to Jan's native adapter instead of the server.

## Fix

`isNativeWebTool(name)` in `web-app/src/lib/webSearchTool.ts` claims the names
only while `useWebSearchConfig.webSearchEnabled` is on. The approval check and
the dispatcher both use it. With search off, the call is prompted with its
server, authorized with the backend-issued approval ticket, and runs on that
server — the same path as any other MCP tool.

The PR's changes to `toolOrigin` / a new `webToolRouting` module do not apply:
the fork's tool-origin code has diverged, and routing is decided at the two call
sites above.

## Verification

```
vitest src/lib/__tests__/webSearchTool.native.test.ts            3 passed
vitest src/routes/threads/__tests__/$threadId.test.tsx           38 passed
yarn typecheck                                                   exit 0
```

Mutation: reverting `isNativeWebTool` to the name-only check fails
`leaves the names to an MCP server while built-in web search is off` and
`treats an MCP server web_search as that server tool while built-in search is off`.

## Follow-up

Cowork (`web-app/src/lib/coworkDispatch.ts`) already refuses the native tools
when web access is off, so it cannot be bypassed the same way; whether it then
lets a same-named MCP tool run is recorded separately.
