# UI polish pass (impeccable + transitions-polish)

Scope: web-app/src (routes, shell, containers, styles). Conservative: Kravio direction, existing tokens, no layout moves.

Method. Static scan of every route/shell/container file: `impeccable detect` (mechanical), motion scan against the transitions-polish rules (`transition-all`, ad-hoc easing/duration, looping animation without `motion-safe`, reduced-motion coverage). Live DOM check (names, labels, horizontal overflow) in `?preview` at 1100px for the settings pages marked "DOM". Round 1 had no pixel screenshots (built-in pane hidden). Round 2 rendered every route with Playwright against the vite `?preview` build and looked at each: dark and light at 1280x800, dark and light at 420x850, plus a code-level DOM check per route (overflow, `transition: all`, unnamed controls).

Findings kept as-is on purpose: Inter (existing font, detector "overused-font"), slider overshoot easing in `motion-controls.css` (deliberate, sliders only), `text-shimmer` utility (existing loading idiom), violet HuggingFace avatar (brand), `border-l-2` in the rich composer quote (1-2px quote rule). Reduced motion is handled app-wide by `html.reduce-motion` and `data-perf='reduced'` (durations collapse so end events fire); not changed.

Changed:
- `transition-all` replaced by named properties + `ease-expo` (CodeWrapToggles, Capabilities, TokenCounter bar).
- `animate-pulse` on StatusDot (running), MarkdownImage loading, EngineAddon indeterminate progress now `motion-safe:` like the rest.
- Appearance > "Colored user bubble" switch had no accessible name; now labelled with its row title (existing key).

| Page | Route | Audit | Result |
|---|---|---|---|
| Chat home | `/` | visual (dark, light, 420) | clean |
| Thread | `/threads/$threadId` | visual (4 views) | clean |
| Project | `/project/$projectId` | visual (4 views) | clean |
| Cowork session + approval card | `/cowork` | visual (4 views) | changed: approval text wrapping |
| Overview | `/overview` | visual | clean |
| Library / artifacts | `/artifacts` | visual | clean |
| Studio | `/studio` | visual | clean |
| Rooms, room detail | `/rooms`, `/rooms/$roomId` | visual | clean |
| Campaigns | `/campaigns` | visual (desktop-only empty state) | clean; detail `/campaign/$id` scanned only |
| Models discover, model detail | `/hub`, `/hub/$modelId` | visual (detail: light 1280 only) | clean |
| Logs, local API logs | `/logs`, `/local-api-server/logs` | visual | changed: level filter scrolls at 420 |
| System monitor | `/system-monitor` | visual, then screenshots deleted (shows real hardware in preview) | clean; not stored |
| Extensions, translate | `/extensions`, `/translate` | visual | clean |
| Archive | `/archive` | visual | changed: filter chips scroll at 420 |
| Settings General, Appearance, Shortcuts, Chat, Assistants, Memory, Permissions | `/settings/*` | visual (4 views) | clean |
| Settings Model providers, provider detail | `/settings/providers[/$name]` | visual | changed: tab labels wrap at 420 |
| Settings MCP servers, Web search, Attachments, Integrations, Network proxy, Local API server, Remote access | `/settings/*` | visual | Integrations changed (Jev tabs wrap) |
| Settings Agent (+ agent-tools alias), Data, Schedules | `/settings/*` | visual | Agent changed (4th tab was off screen at 420); Data is blank in the web preview (Tauri-only content) |
| Settings aliases (claude-code, jev, https-proxy, interface, extensions) | `/settings/*` | visual: redirect to Integrations / Network proxy / Appearance | clean |
| Dialogs: Add MCP server, Add assistant, New room; model picker; notifications and approvals menus; command palette; settings search | overlays | visual (dark or light) | clean |
| Sidebar, header, settings section list | shell | visual on every route above | clean |
| Cowork workflow card, held-message stack, composer option menus, onboarding | - | scanned only (no preview seed renders them; composer + button not reached) | not visually audited |

Changed in round 2:
- Approval/permission command text wraps at spaces first (`overflow-wrap:anywhere`) instead of splitting inside a flag.
- `SettingsTabStrip` and the Jev tab strip use `wrap`; the settings page action area has `max-w-full` so a four-tab strip no longer runs past a 420px viewport.
- Log level filter and archive filter chips scroll inside their row at narrow widths instead of shrinking to initials.

Not changed, worth a look: settings search for "proxy" returned one unrelated result (index data, not styling); Rooms "New room" Title field has no placeholder while Objective does; System monitor preview data shows Memory above 100% with negative available RAM (seed values).
