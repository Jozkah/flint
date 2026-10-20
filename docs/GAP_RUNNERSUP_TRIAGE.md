# Gap analysis runners-up: triage

Source: `docs/CLAUDE_CODE_GAP_ANALYSIS.md` (branch `claude/awesome-dhawan-872d9f`), "Runners-up". MCP items (`${VAR}`, `list_changed`, long-result spill) belong to the web-mcp session and are not triaged here.

| Item | Size | Value (local desktop app) | Security risk | Decision | Reason |
|---|---|---|---|---|---|
| Skill `paths` | S | medium | low | **build** | Skill offered/readable only when the project has a file matching its globs. "In play" is approximated by "the project contains a match" (bounded walk); there is no per-session touched-files tracker. |
| Skill `context: fork` | S | medium | low | **build** | `skill_read` tells the model to run it through `dispatch_subagent`; the subagent loads the body with `skill_read inline:true`. Reuses the subagent machinery unchanged. |
| Keep-awake during runs | S | high (long local runs) | none | **build** | Windows only: `windows-sys` already a dependency, only the `Win32_System_Power` feature added. Other platforms would need new deps (IOKit, D-Bus), so they are a no-op. Setting default on. |
| Session recap | M | medium | low | **build** | Reuses `summarizeConversation` (tool-less, local engine only, skipped while the engine is busy or no local model). Shown on returning to a session that changed while away. Nothing sent to a remote provider. |
| Opt-in OpenTelemetry export | M | low | medium | **skip** | Needs the `opentelemetry` crate family plus an OTLP exporter: heavy new dependencies and a telemetry surface. Revisit only as a feature-gated build. |
| Domain-filtered network for sandboxed shell | L | medium | high | **skip** | Security-sensitive; the repo/safety sessions are editing sandbox allow/deny lists now. Follow after their merge; deny must win. |
| PR auto-fix watcher / merge-when-ready | L | low | high | **skip** | Needs a CI polling loop and GitHub write actions (merge). New infrastructure. |
| Integrated terminal | L | medium | medium | **skip** | Needs a PTY layer plus a terminal emulator UI; new infrastructure. |
| Computer-use safety tiers | M | low | high | **skip** | Touches the permission model (safety group's files). |
| mTLS client certificates | M | low | medium | **skip** | Lives in the HTTP client/web layer (web-mcp group's files); certificate storage needs a design. |
| Custom status line | S | low | low | **skip** | TUI only (cli group's files). |
| acceptEdits mode | S | medium | medium | **skip** | Permission modes (safety group's files). |
| Rules on tool parameters | M | medium | medium | **skip** | Permission rules/gate (safety group's files). |
| Comment on approve | S | low | low | **skip** | Approval flow is gate code; leave to safety group. |
| Deep-link `project` parameter | S | low | high | **skip** | A link from outside the app would pick the workspace folder; needs a trust prompt design first. |
| Plugin `.lsp.json`; `flint plugin validate` | M/S | low | low | **skip** | `plugins.rs`/CLI (repo and cli groups' files). |

## Not exercised live

All four built items are verified by unit tests and typecheck only: no Flint-Desktop launch. Keep-awake needs a Windows run to see the power request (`powercfg /requests`). Recap needs a loaded local model.
