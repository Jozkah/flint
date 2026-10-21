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

## Round 3 (skills read from disk, rendered pass on remaining surfaces)

The Skill tool could not load the design skills in this session (a different config dir), so the real skill files were read and followed: impeccable `SKILL.md`, `reference/audit.md`, `polish.md`, `craft-floor.md`, `critique.md`; `transitions-dev/SKILL.md`; `transitions-polish/SKILL.md` and `_refine-rules.md`; `transitions-ui-generation/SKILL.md`; all GSAP `SKILL.md` files (core, react, timeline, scrolltrigger, plugins, performance, utils, frameworks); make-interfaces-feel-better from `~/.claude/skills` (full) and the ecc plugin copy (short). Not followed in full: impeccable `critique`'s dual sub-agent run, snapshot and question close (per page that is not workable for ~45 pages); its combined review was applied per surface group instead.

- **transitions-ui-generation:** not used. Its own rule says generation animation is for a moment where an AI product shows output being built, not for frequently repeated UI. Cowork transcripts and workflow cards update on every event, so it does not fit; recorded here as the reason.
- **GSAP:** `gsap` is not a dependency. Existing JS-driven motion is `motion`/`framer-motion` (about 25 files: animated icons, tooltip, slider, drop rim, dropdrawer, status mark, voice pill, empty state, undo toast, shell), the Web Animations API (tooltip glide, theme transition) and CSS keyframes. There is no scroll-driven animation, no timeline-sequenced choreography and no SVG morphing, so no surface is a clear GSAP win; nothing was added, so there is no bundle cost.
- **make-interfaces-feel-better:** already satisfied app-wide: `antialiased` on the body, `text-wrap: balance` on headings, 243 `tabular-nums` uses, no `transition: all` left. Left alone: segmented press scale 0.97 (rule says 0.96), icon buttons around 28px in the composer (dense desktop).

| Surface | Viewed | Skills applied | Change |
|---|---|---|---|
| Campaign not found `/campaign/$id` | dark (desktop-only app screen; the board itself cannot render in the web preview) | impeccable clarify/harden (error state names no recovery), transitions: none needed | added a "Campaigns" button back to the list (existing key, no new strings) |
| Command palette with a query | dark | impeccable audit/polish, make-interfaces | clean |
| Sidebar row context menu | light | impeccable polish, make-interfaces | clean |
| Cowork new session / transcript, pinned progress | light 1280 | impeccable critique-level read, transitions-polish | clean (pinned and inline progress both show; left) |
| Composer Attachments, Options, Token usage, Effort popovers | dark and light 1280 | impeccable polish, transitions-polish (open/close), make-interfaces | clean |
| Model detail `/hub/$modelId` | dark 1280, dark 420, light 420 | impeccable adapt | left: variant table scrolls sideways at 420 so Fit/Size/Download are off screen; the header Download button stays visible |
| Archive "Empty archive" confirm | not reachable (button disabled with an empty archive) | - | scanned only |
| Cowork workflow card, held-message stack, onboarding wizard, permission-request dialog | not renderable in `?preview` (no seed) | - | scanned only |

## Fix pass (branch ui/fix-all)

All rows in `UI_IMPROVEMENTS.md` are now marked with a status and commit. The surfaces that could not be rendered before (workflow card, held-message stack, setup wizard, MCP question, usage attribution, rule warnings, hooks, archive, remote access) have preview seeds in `web-app/src/dev/previewSurfaces.ts` (`?workflow`, `?held`, `?elicit`, `?setup`) and were viewed. Still scanned only: the permission-request dialog beyond the approval card, and the review panel.
