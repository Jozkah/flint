# Flint 0.9.0

Flint is a local-first fork of [Jan](https://github.com/janhq/jan), rebuilt into an agentic desktop workspace for local and user-chosen models. This first Flint release combines the rebrand and migration path with Cowork, tool-using Discussion Rooms, an auditable agent runtime, Memory, MCP and Skills, remote access, a redesigned interface, and a fully branded Windows installer.

This changelog is release-oriented: it lists shipped features, additions and meaningful changes versus the Jan base. It intentionally does **not** list follow-up bug fixes whose only purpose was repairing a Flint feature introduced during 0.9.0 development. Bug-fix entries are kept where they apply to inherited/original Jan behavior or an upstream Jan issue.

## Highlights

- **Local-first and private.** Telemetry, automatic update checks and background model-discovery fetches were removed from the Flint build. Models, providers and data remain under the user's control, and external access only happens through features the user enables or invokes, including Hugging Face **Discover**.
- **Hugging Face Discover.** Search Hugging Face, inspect model details and README, and download the exact GGUF quantization (or MLX repository on Apple silicon) you choose, with hardware-aware recommendations, gated-model token support, resumable/cancellable downloads and size/SHA-256 verification. Nothing is contacted until you open Discover, search, or click Download.
- **Jan → Flint migration.** Existing Jan data is detected on first launch with Copy, Reuse, Move and Start fresh modes, per-category selection, conflict handling, backup/rollback and resumable migration.
- **Cowork.** A full agentic coding workspace with managed worktrees, proposals, hunk review, Code/Preview/Changes/Activity panels, checkpoints, subagents, multiple attached folders, PR state/checks and browser verification.
- **Discussion Rooms.** Multi-model rooms with per-participant models, tools, folder access, MCP, web research, reasoning controls, limits, pausing/resuming and automatic context compaction.
- **Auditable agent runtime.** Versioned event logs, replayable execution records, deadlines/cancellation, budgets, retry policy, background jobs, subagents, readiness checks, loop protection and run timelines.
- **Repository intelligence.** Stored repository indexes, caller/callee traversal, semantic search, LSP integration, impact/test analysis, project-tool detection, formatter discovery and diagnostics.
- **Git and GitHub workflows.** First-class git tooling, branching/commits, split commits, rebase/cherry-pick flows, PR creation/review, conflict status, CI check hand-off and approval boundaries for remote operations.
- **Memory, MCP and Skills.** Cross-chat scoped Memory, fingerprint-pinned MCP trust, OAuth secret handling, per-server health/logs/budgets, native Skills, plugin-scoped Skills and reviewed permission policies.
- **Redesigned Flint UI.** New shell/sidebar/header, Overview dashboard, Slate/Violet appearance system, Inter, duotone iconography, redesigned settings/components, split view, groups, phone layouts, notifications and System Monitor.
- **Remote access preview.** Pair a phone over Tailscale, LAN or loopback and use Chat, Cowork and Rooms while models, keys and files remain on the desktop.
- **SDK and CLI.** JavaScript/Python Agent SDKs, protocol v1, host tools, Flint tools over MCP, JSON-lines CLI, diagnostics and benchmark tooling.
- **Fully custom Windows installer.** The NSIS installer is now a real Flint-styled setup flow rather than a stock/passive Tauri wizard, with the actual Flint app icon, Inter, app colors, custom controls, install options, progress, completion and matching uninstall screens.

## Final 0.9.0 additions

These are the significant additions merged after the previous 0.9.0 changelog pass.

### Built-in assistants and JEV routing

- Added four specialist assistants alongside the default Flint generalist:
  - **Quartz** — research, analysis, comparisons, calculations and evidence synthesis.
  - **Coal** — software engineering, implementation, debugging, testing and code review.
  - **Blaze** — creative/product ideation, UX concepts, naming and polished copy.
  - **Redstone** — automation, integrations, systems workflows and repeatable operations.
- Added distinct Flint-style pixel icons and behavior/sampling profiles for all four specialists.
- Existing installs receive the specialists through assistant migration v4 without overwriting an existing assistant that already uses one of the built-in IDs.
- Optional JEV routing can choose Flint/Quartz/Coal/Blaze/Redstone once per new user message and suggest an advisory **Review / Ask / Auto** work style.
- JEV routing never grants permissions or changes Cowork authority. Custom/project assistants stay pinned, and invalid or unconfident routing falls back to Flint.
- Cowork can inject the selected specialist persona beneath its existing policy/project instructions, while Flint itself keeps the normal Cowork baseline.
- Automatic work profiles are re-evaluated for each new user message and can use JEV ranking with Flint's local classifier as fallback.

### Remote access and mobile parity

- The mobile app now has real paginated chat history while preserving scroll position and rendering system/tool messages.
- Phone-created Cowork sessions can select an existing recent desktop folder without widening write authority.
- Rooms can be created, updated and deleted from the phone.
- Room participants can change model and Auto/On/Off reasoning from mobile; moderator model/state, speaking mode, limits and room control actions are available remotely.
- Thread rename/pin/delete and Cowork fork/delete are real phone actions.
- Unsupported desktop-only actions are shown as computer-managed instead of pretending to be selectable mobile controls.
- Pairing exposes a QR code plus a selectable/copyable link and retains a manual fallback when clipboard storage is unavailable.

### Browser verification

- Verify in browser and the screenshot tool now support Chrome, Edge, Brave, Opera/Opera GX, Vivaldi, Arc and Chromium.
- **Choose a browser…** lets the user select a Chromium-based executable manually.
- The chosen browser is shared by the verification runner and screenshot tooling for the current Flint session.
- Windows discovery uses real install layouts, including Arc's Windows app-execution alias.

### Git approvals

- Inline approvals keep **More options** available instead of hiding it when the immediate request only exposes Allow once.
- Added **Allow all temporarily** for non-destructive remote Git/GitHub operations in the current conversation.
- Temporary Git trust stays in renderer memory, is never persisted as an Always allow grant, is not offered to temporary chats and never covers destructive Git operations.

### Search, MCP and interface additions

- Added a DuckDuckGo MCP preset using `uvx duckduckgo-mcp-server`.
- Native web-search providers can show their real favicon in Flint UI surfaces.
- Added a **New group** action to the Move to group flow.
- Compact split-pane labels use **Auto** / **Edit** while retaining full accessible labels.
- Settings rows, including the Local API Server model selector, use the constrained Flint layout correctly.

### Inference and repository targeting

- Upgraded the bundled llama.cpp engine from 0.4.1 / b10964 to **0.5.0 / b11146**, with matching packages and lockfiles.
- Active release workflows, package metadata, project links and web-search identification now target `Jozkah/flint` rather than the upstream repository where appropriate.

### Release infrastructure

- Tag pushes matching `v*` now start the tag build pipeline.
- Moving an existing release tag can rebuild the existing release: the workflow resolves the existing release upload URL and clears stale build assets before uploading replacements.
- Reusable release workflows use `$GITHUB_OUTPUT` instead of deprecated `::set-output` handling.

### Windows installer

- `tauri.windows.conf.json` permanently points NSIS builds at Flint's custom template, so local and CI builds use the same installer.
- Normal installer launches use the interactive Flint flow; silent/passive/update paths remain supported.
- Added Flint-styled welcome, installation options, existing-install maintenance, progress, completion, uninstall confirmation/progress and uninstall completion views.
- Installer typography, light/dark tokens, DPI behavior and controls match Flint's app design.
- The title bar and brand mark use the **real Flint application icon** generated from the app's canonical icon source.
- The installer exposes install location, desktop shortcut and launch-after-install choices while retaining Tauri's packaging/update engine underneath.
- NSIS UI compilation runs with `/WX`, treating every NSIS warning as a CI failure before the release-grade Windows bundle build is allowed to run.

## Core Flint capabilities

### Identity, privacy and migration

- Rebranded the product, desktop binary, visible UI, documentation, agent identity and deep links as Flint while retaining compatibility paths needed to upgrade existing Jan installations.
- Added `flint://` while preserving the legacy `jan://` deep link.
- Prefer `FLINT_*` environment variables with `JAN_*` compatibility fallbacks.
- Write/discover `FLINT.md` project guidance while continuing to read legacy `JAN.md`.
- Migration supports Copy, Reuse, Move and Start fresh; per-category import; conflict policies; recoverable backup; rollback; idempotent resume; quarantine of partial data and a migration manifest.
- Migration can be reopened from Settings → General → Migrate from Jan.

### Cowork workspace

- Code, Preview, Changes (Git), Activity and session-details panels.
- Managed worktrees and per-session branches, including parallel sessions on the same repository.
- Reviewable proposals, hunk-by-hunk application, patch-bundle export/import and checkpoints/rewind with restore previews.
- Multiple attached folders with independent access levels and Windows AppContainer grants for editable folders.
- Subagent teams, restart/replace, isolated checkouts, consensus reviewers and recorded change attribution.
- Live bash output, repository diff gutters, editable Code panel, inline blame and file-path navigation from tools/diffs/replies.
- PR state/checks, conflict and behind indicators, **Fix this check**, PR ownership per session and merge-base conflict workflows.
- Verify in browser with isolated temporary browser profiles, bounded local origins, screenshots, console output and pass/fail steps.
- Automatic context compaction and explicit `/compact` support.
- Run-phase status text for waiting, thinking, tool execution, tool-result reading and writing.

### Agent runtime and repository intelligence

- Versioned execution/event records, replay, invocation IDs and a persistent timeline.
- Token, dollar and turn ceilings; deadlines/cancellation; retry policy; process-tree reaping; loop detection and emergency stop.
- Durable background jobs and subagents, role allowlists, readiness probes and structured error taxonomy.
- Prompt-cache-aware request construction and proactive compaction before provider context overflow.
- Repository index, name lookup, callers/callees, semantic code search, LSP lifecycle, impact analysis, test coverage analysis, project-tool detection and formatter discovery.
- Native git inspection/cloning, branch/commit/rebase/cherry-pick helpers, PR/review workflows and dependency-license checks.

### Discussion Rooms

- Persistent multi-participant room engine and UI.
- Per-participant model choice, Reasoning Auto/On/Off, effort and llama.cpp Thinking Budget where supported.
- Per-participant tool access, trusted MCP servers and web research.
- Room limits, control actions, early completion and per-speaker history compaction.

### Memory, MCP, Skills and permissions

- Scoped Memory with precedence, proposal/review, provenance, export/import, project binding and idle-time consolidation.
- MCP trust by fingerprint, per-server auto-approve, OAuth tokens in the secret store, proactive refresh, scopes, documents/prompts, ping health, logs, budgets and confinement.
- User-level native Skills and plugin Skills with declared tools/versions.
- Reviewed project policy, scoped write grants, plain-language approval descriptions and destructive-operation gates.
- Optional JEV skill suggestion and attachment reranking with off/shadow/on modes, bounded time/cost and protected key storage.

### Chat, models and providers

- Per-chat model settings and reasoning controls, temporary chats, split view up to four panes, attachment aliases and a unified `@` menu.
- Native `web_search` / `web_fetch`, web-required message holding, queued/steered messages and automatic/manual compaction.
- Shared slash-command menu across Home, Cowork and Rooms.
- Transcript/tool timeline modes, live thinking timer and streamed ANSI terminal output.
- Model Doctor tool-calling probe and model-fit/readiness information.
- Provider chains/failover, custom request headers, predefined local providers, provider card management and LAN-aware networking.
- You.com native web search/fetch provider support.
- Per-model llama.cpp chat-template kwargs and backend selection improvements.

### Design and system

- New Flint shell with resizable sidebar, top header/breadcrumb and Overview dashboard.
- Slate default accent, Violet option, Inter, contrast-checked custom accent colors, first-paint theme application and Reduce motion support.
- Duotone icon set and Flint/model/provider branding.
- Redesigned buttons, dialogs, menus, sheets, switches, inputs, segmented controls, chips, Library, Models, providers, Tools & MCP, Extensions, Logs and System Monitor.
- Groups for chats, Cowork sessions and Rooms, with optional inherited folder bindings.
- Phone layouts across the desktop UI, notifications menu, global settings search and redesigned command palette.
- System Monitor includes CPU, memory, drives, network, temperatures, swap, uptime and usage bars.
- Optional finish sounds for Chat/Cowork and taskbar/Dock attention while an approval is waiting.

### Remote access, SDK and CLI

- Off-by-default remote HTTP/WebSocket server restricted to Tailscale, private LAN or loopback addresses.
- HTTPS with user certificate, Tailscale certificate or LAN self-signed certificate; paired-device tokens are stored as hashes and can be revoked immediately.
- Installable mobile web app for Chat, Cowork, Rooms, Models, Tools, System and phone-oriented Settings.
- JavaScript and Python SDKs over frozen protocol v1, host-declared tools and Flint built-ins over MCP.
- Headless JSON-lines CLI, local diagnostics bundle, benchmark harness, session export/search and `flint doctor` hardware information.

## Inherited / upstream Jan fixes included in Flint 0.9.0

These are kept because they fix behavior inherited from the Jan base rather than a Flint-only feature introduced during this release.

- Respect `JAN_DATA_FOLDER` wherever the legacy override is supposed to win.
- Fall back safely when a configured data folder no longer exists without moving user data (`janhq/jan#8855`).
- Park an unsent composer draft when starting a new session instead of making **New session** a silent no-op (`janhq/jan#8864`).
- Namespace duplicate MCP tool names from different servers and avoid mutating inline attachments (`janhq/jan#8975`).
- Make the Local API Server CORS switch actually control CORS and stop forwarding the caller's Origin/Referer upstream (`janhq/jan#8836`).
- Explain why the local model list is empty when the data folder is unusable (`janhq/jan#8374`).
- Keep the latest user message when trimming history and surface provider context-window errors through the context UI instead of raw provider HTTP errors.
- Prevent malformed or nameless interrupted tool calls from being resent into later provider requests.
- Preserve thread/message integrity across deletes and concurrent saves, including safe handling of unreadable thread metadata.
- Keep provider/model selection consistent when providers are added, removed or temporarily unreachable.
- Harden archive extraction, secret storage, proxy forwarding and Local API Server request handling inherited from the base application.

---

Flint is an independent fork of [Jan](https://github.com/janhq/jan) by [janhq](https://github.com/janhq) and preserves Jan's Apache-2.0 license, copyright notices, contributor attribution, acknowledgements and upstream provenance.
