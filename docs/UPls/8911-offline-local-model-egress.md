# janhq/jan#8911 — local model does not load without internet

- Upstream: https://github.com/janhq/jan/issues/8911
- Kind: issue, open upstream
- Priority: P0 (unwanted network traffic on a local-only path)
- Status in this fork: **egress fixed**; offline load hang not reproduced

## What the report shows

With only llama.cpp enabled and telemetry off, the reporter's startup log has
two outbound connections they did not ask for:

- `reqwest::connect ... https://api.github.com/`
- an MCP server `exa` failing to initialise against `https://mcp.exa.ai/mcp`

## In this fork

**mcp.exa.ai — reproduced by reading, fixed.** The schema-v3 MCP migration in
`src-tauri/src/core/setup.rs` rewrote the default Exa entry as the hosted
HTTP endpoint with `active: true`. The v4 cleanup removed Exa only while it was
inactive, so any install that ran v3 — including a fresh profile running v1→v4
in one launch — kept an **active remote MCP server that connects on every
start**. The reporter never enabled it; Jan's own migration did.

v1 and v3 are now superseded no-ops, and a v5 step removes the Exa entry Jan's
migrations created regardless of its `active` flag, keeping any entry with a
real key, another URL, or a stdio entry the user switched on
(`remove_default_exa`, six unit tests).

**api.github.com — not present at startup here.** The only GitHub API URL in
shipped source is the skill hub's tree listing
(`src-tauri/src/core/agent/skill_hub.rs`), reached only through the
`agent_skill_hub_list` / import commands a user triggers. The fork has no
backend-release lookup at startup (`scripts/local-only-guard.mjs` is clean).

**The load hang itself — not reproduced.** Whether a slow-failing MCP connection
delayed model load in the reporter's build has not been exercised offline on
this machine. With the Exa entry gone the reported trigger no longer exists;
an offline launch-and-load run is still owed.

## Verification

```
cargo test --lib (test-tauri) exa_migration_tests   6 passed
cargo test --lib (test-tauri)                        816 passed
yarn guard:local-only                                clean
```
