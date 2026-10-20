# UI polish pass (impeccable + transitions-polish)

Scope: web-app/src (routes, shell, containers, styles). Conservative: Kravio direction, existing tokens, no layout moves.

Method. Static scan of every route/shell/container file: `impeccable detect` (mechanical), motion scan against the transitions-polish rules (`transition-all`, ad-hoc easing/duration, looping animation without `motion-safe`, reduced-motion coverage). Live DOM check (names, labels, horizontal overflow) in `?preview` at 1100px for the settings pages marked "DOM". Pixel screenshots were not possible (the browser pane was hidden, screenshots timed out), so visual hierarchy and contrast judgment is code-level only.

Findings kept as-is on purpose: Inter (existing font, detector "overused-font"), slider overshoot easing in `motion-controls.css` (deliberate, sliders only), `text-shimmer` utility (existing loading idiom), violet HuggingFace avatar (brand), `border-l-2` in the rich composer quote (1-2px quote rule). Reduced motion is handled app-wide by `html.reduce-motion` and `data-perf='reduced'` (durations collapse so end events fire); not changed.

Changed:
- `transition-all` replaced by named properties + `ease-expo` (CodeWrapToggles, Capabilities, TokenCounter bar).
- `animate-pulse` on StatusDot (running), MarkdownImage loading, EngineAddon indeterminate progress now `motion-safe:` like the rest.
- Appearance > "Colored user bubble" switch had no accessible name; now labelled with its row title (existing key).

| Page | Route | Files | Status |
|---|---|---|---|
| Chat home | `/` | routes/index.tsx, ChatInput, composer containers | audited visually (dark 1280); narrow/light scanned only |
| Thread | `/threads/$threadId` | routes/threads | audited (static) |
| Project | `/project/$projectId` | routes/project | audited (static) |
| Cowork + transcript (workflow card, tool rows, approvals, held stack) | `/cowork` | routes/cowork.tsx, CoworkWorkflowCard, CoworkHeldInput, Cowork* | audited visually (dark 1280, narrow 420); changed (approval text wrapping); light scanned only |
| Overview | `/overview` | routes/overview.tsx | audited (static) |
| Artifacts | `/artifacts` | routes/artifacts.tsx | audited (static) |
| Studio | `/studio` | routes/studio.tsx | audited (static) |
| Rooms / room | `/rooms`, `/rooms/$roomId` | routes/rooms | audited (static) |
| Campaigns / campaign | `/campaigns`, `/campaign/$campaignId` | routes/campaign*, components/campaign/StatusDot | changed (StatusDot) |
| Models hub / model | `/hub`, `/hub/$modelId` | routes/hub | audited visually (light 1280, narrow 420); model detail scanned only |
| Logs, local API logs | `/logs`, `/local-api-server/logs` | routes/logs.tsx | audited (static) |
| System monitor | `/system-monitor` | routes/system-monitor.tsx | audited (static; preview data only) |
| Extensions, archive, translate | `/extensions` `/archive` `/translate` | routes/*.tsx | audited (static) |
| Settings Chat / Data / Integrations / Providers / General | `/settings/*` | routes/settings | Chat audited visually (light 1280); all five DOM-checked (no unnamed controls, no overflow) |
| Settings Appearance | `/settings/appearance` | appearance.tsx | changed (switch name) |
| Settings other (agent, agent-tools, assistant, attachments, claude-code, extensions, https/network proxy, interface, jev, local-api-server, mcp-servers, memory, permissions, remote-access, schedules, shortcuts, web-search) | `/settings/*` | routes/settings | audited (static) |
| Sidebar / nav shell, header | - | components/shell | audited (static); sidebar kept |
| Token counter, code toggles, capabilities | - | TokenCounter, CodeWrapToggles, Capabilities | changed (transition-all) |
| Onboarding, empty states, dialogs | - | containers | skipped: not individually reviewed live |

Possible follow-up: many `<Switch>` in settings pages (chat.tsx, agent.tsx, local-api-server.tsx, hub) have no own `aria-label`; the DOM check showed Chat/Data/Integrations OK, so the row wrapper probably names them. Verify agent, local-api-server and hub in a live pass.

## Second round (Playwright, rendered)
Screenshots are in `.playwright-mcp/` of the worktree (untracked scratch). Viewed: home dark 1280; Cowork dark 1280 and 420; settings/chat light 1280; hub light 1280 and 420. No horizontal overflow at 420 on hub or Cowork.
Changed: approval command text (tool approval subject, permission request command/arguments/preview) used `break-all`, splitting flags mid-word (`--f`/`ill`); now `overflow-wrap:anywhere`, so it wraps at spaces and only splits a token that cannot fit. Paths and server names keep `break-all`.
Left: settings row descriptions clamp to one line by design (full text in the title attribute; `wrapDescription` exists for warnings).
Everything not listed above as "visually" is still scanned only.
