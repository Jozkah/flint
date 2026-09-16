# `jan-desktop`: in-process MCP UI bridge

`src-tauri/src/core/agent/desktop_bridge.rs` exposes a small, tightly-scoped set
of Jan desktop UI capabilities to the agent as ordinary MCP tools under the
server name `jan-desktop`, replacing bespoke agent-to-UI calls with normal,
permission-gated, audited tool calls.

## Tools

| Tool | Purpose | Authorization |
| --- | --- | --- |
| `open_file` | Open a workspace file at a line/column | path must be inside the workspace |
| `get_terminal_contents` | Read recent terminal output | bounded lines; this session's terminals only |
| `show_diff` | Show a diff, return a diff id | workspace path; id bound to the session |
| `diff_accepted` | Record a diff acceptance | id must be issued to this session; consumed on use |
| `apply_settings` | Change one setting | allowlisted keys only; secret values redacted |

## Design

- **Transport-independent core.** The module holds the schemas, typed args, and
  the authorization layer. The rmcp `ServerHandler` that speaks the wire protocol
  is a thin adapter over `DesktopBridge::dispatch` and does no validation itself.
- **`DesktopUi` trait.** The real editor/terminal/diff/settings services are the
  single implementation; tests use a fake. The bridge never duplicates that
  logic.
- **`RequestContext`.** Every dispatch is bound to the window, workspace,
  conversation, and session it came from — minted by the host from the live
  window, never from anything the model can influence. A tool can only act within
  that scope.

## Security properties (enforced + tested)

- **Path containment** — `open_file`/`show_diff` refuse absolute, drive-qualified,
  and `..`-climbing paths; resolution is lexical (no symlink following), so a
  planted symlink cannot redirect the check and a not-yet-existing path still
  validates.
- **Bounded terminal reads** — `max_lines` is clamped to the server cap (1000),
  and only the requesting session's terminals are visible.
- **Diff-id integrity** — a `diff_id` must be one `show_diff` issued to *this*
  session; unknown, cross-session, or already-accepted (replayed) ids are refused.
- **Settings allowlist** — only `SETTINGS_ALLOWLIST` keys may change; a sensitive
  value never appears in a result or log (`redact_setting`).
- **Local, non-networked** — the server runs in the desktop process; it is not a
  network transport and accepts no remote clients.

## Adding a capability

1. Add a method to `DesktopUi` and implement it in the real service.
2. Add a schema in `tool_schemas()` and a `dispatch` arm that validates inputs
   and authorizes against `RequestContext` **before** calling the `DesktopUi`.
3. If it touches files, resolve through `resolve_in_workspace`. If it hands back
   an id to be redeemed later, bind it to the session in a registry like
   `issued_diffs`. If it exposes settings, gate on an allowlist and redact.
4. Add unit tests for schema validation and every authorization refusal.
