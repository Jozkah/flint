# JAN Atelier: implementation and feature-preservation map

> **Superseded visual direction.** The Atelier look described here (ivory
> surfaces, Newsreader headings, 80px graphite rail) was replaced by JAN
> Graphite Studio; see `docs/GRAPHITE_IMPLEMENTATION.md`. The
> feature-preservation map and contracts below still apply.

This document tracks the production implementation of the approved JAN Atelier
design. It sits beside `docs/IMPLEMENTATION_BASELINE.md` (backend contracts a
redesign must preserve) and `docs/BEGINNER_WORKFLOWS_HANDOFF.md` (beginner
workflow behaviour).

## Design reference

- Approved reference: JAN Atelier artifact
  `https://claude.ai/code/artifact/fcb87849-b092-4145-8ab7-190a332de30e`,
  published version `1789318543-eeeb`, shown as V4 in the version picker, build
  label `r6 · 2026-09-13`. The mirror
  `https://claude.ai/code/artifact/9a92a360-fb68-41a6-a5a1-0666b64f343a`
  (version `1789318572-8fac`) serves byte-identical files apart from its title.
  No V5 existed when implementation started (2026-09-13); if one is published
  later, compare it against r6 before adopting changes.
- The artifact is a visual and interaction reference only. Its simulated data,
  timers and seeded state are not carried into the app.

## Design system

| Area | Where | Notes |
| --- | --- | --- |
| Tokens | `web-app/src/index.css` | Ivory ground `#F5F1EA`, paper `#FBF9F5`, graphite rail `#1D1E1D`; dark `#1A1917` / `#211F1C` / `#121211`. Existing shadcn variable names are kept so every component picks the palette up; new `--brand-*`, `--rail-*`, `--success`, `--warning`, `--destructive-tint`, `--sunken`, `--ink-2`, `--line-strong` tokens are exposed as Tailwind colours. |
| Typography | `web-app/src/main.tsx` | IBM Plex Sans (UI), IBM Plex Mono (code), Newsreader (display, `font-display` and the existing `font-studio`), bundled through `@fontsource`; nothing is fetched at runtime. |
| Icons | `lucide-react` | 1.5px strokes set globally; the rail uses 22px icons. |
| Accent | `web-app/src/lib/accent.ts`, `containers/AccentSettings.tsx`, `hooks/useInterfaceSettings.ts` | Presets Vermilion, Ink, Moss or any hex. Fill, hover, pressed, on-fill text, ring, accent text, rail marker, tint and soft are derived per theme with WCAG checks against the real surfaces. Semantic colours are never derived. Saved `accentColor` values from earlier versions migrate (store version 1). |
| Primitives | `web-app/src/components/ui/*` | Buttons (destructive stays outlined), dialogs as bottom sheets on phones, menus and inputs with 44px coarse-pointer targets, 16px input text below `md`. |

## Shell

| Element | Default | Component |
| --- | --- | --- |
| Global rail | 80px; items 72px; Workspace, Library, Models, Tools / Search, System, Settings | `components/shell/AppRail.tsx`, `lib/shellNavigation.ts` |
| Contextual sidebar | 256px, resizable 220-300px, 72px header | `components/left-sidebar/index.tsx`, `components/ui/sidebar.tsx`, `hooks/useLeftPanel.ts` |
| Context bar | 52px | `containers/HeaderPage.tsx` |
| Status bar | 28px | `components/shell/StatusBar.tsx` |
| Narrow navigation | Rail and sidebar in one sheet below 1024px (phones, phone landscape, portrait tablets) | `Sidebar` `mobileLeading`, `useIsNarrowShell`, `HeaderPage` menu button |
| System navigation | Monitor, app logs, local API server logs | `components/left-sidebar/NavSystem.tsx` |
| Viewport | `--app-vvh`, `html.kb-open` | `hooks/useAppViewport.ts` |

Rail destinations are existing routes: Workspace `/` (chats, projects,
Cowork), Library `/artifacts`, Models `/settings/providers` (and hardware),
Tools `/settings/mcp-servers` (agent tools, web search, extensions, Claude
Code), System `/system-monitor` (logs), Settings `/settings/general`. Search opens
the existing search dialog. The harness hooks `cowork-search`,
`cowork-settings` and `[data-sidebar="trigger"]` are kept.

## Feature-preservation map

Each row names the real state the redesigned surface must keep reading. A row
is only "restyled" when its behaviour and tests are unchanged.

| Feature | Route / surface | Real state and contracts | Status |
| --- | --- | --- | --- |
| First run, resume | `routes/index.tsx` → `SetupScreen`, `GettingStartedCard` (beginner workflows) | `hasUsableProvider`, `useSetupChecklist`, `useOnboardingGuide` | restyled |
| Chat, streaming, stop, retry, edit, attachments, errors | `routes/threads/$threadId.tsx` → `ThreadConversation`, `ChatInput`, `MessageItem` | `use-chat`, `custom-chat-transport`, `message-branching`, `useAttachments`, `stores/message-errors` | restyled; Stop is a secondary action |
| Split conversations | `SplitConversation`, `useSplitConversation`, `useConversationPane` | per pane: thread, model, draft (`usePrompt` scoped), attachments, queue, approvals, stream, Stop, scroll. Shared by design: llama.cpp OOM/backend events and model-load progress (global backend events without a thread id), prompt history | new; side by side ≥1100px with a resizable divider, pane switch below |
| Cowork runs, plans, tools, output, review, checkpoints, steering | `routes/cowork.tsx`, `Cowork*` containers | `useCoworkSessions`, `useCoworkRun`, `useCoworkCheckpoints`, event log (`events/*.jsonl`) | restyled; 360px output inspector, drawer below 1100px, Content / Output / Details below 768px |
| Projects, sessions, instructions, files, knowledge | `routes/project/$projectId.tsx`, `NavProjects`, `ProjectFiles`, `/settings/assistant` | `useThreadManagement`, VectorDB extension | restyled |
| Agents, tasks, dependencies, worktrees | `CoworkTasksPanel`, `CoworkWorkflowCard`, `useCoworkWorktrees` | subagent registry, team children | token sweep and quiet timelines; no new dependency-graph UI |
| Repository, symbols, diagnostics | `CoworkCodePanel` (backend `index.rs`, `lsp.rs`, `diagnostics.rs` have no UI yet) | agent-core tools | token sweep; symbols/diagnostics remain agent tools without a dedicated UI |
| Changes, per-hunk review, git | `CoworkDiffPanel`, `CoworkProposalReview`, `DiffView` | `agent_git_*`, `agent_proposal_*` | diffs use semantic tints and scroll inside their container; git split/rebase/PR remain agent tools |
| Models, providers, compatibility, default | `/settings/providers/*`, `ModelSupportStatus`, `DropdownModelProvider` | `useModelProvider`, `useModelLoad`, `useModelEvidence`, `lib/modelStatus.ts` | restyled; one status vocabulary from `deriveModelStatus` |
| Artifact library | `/artifacts` (rail Library) | `lib/coworkArtifacts`, `useCoworkSessions` | restyled; Go to session added |
| Skills, plugins, MCP, commands, hooks | `SkillsManagerDialog`, `PluginsManagerDialog`, `/settings/mcp-servers`, `CoworkCompatSection` | `useSkills`, MCP services, fingerprint trust; skills layered project → store → user | restyled (MCP chips from `mcpConnectionState`) |
| Permissions, grants, revocation, audit | inline approvals (`ai-elements/tool.tsx`), `CoworkChildApprovals`, `/settings/permissions` | backend gate, `useToolApproval`, `permission_audit_recent` | restyled; four grant groups, audit table |
| Context attribution, memory | `WhatJanIsUsing`, `CoworkContextBreakdown`, `/settings/memory` | `memory_*` commands, prompt snapshots | restyled; memory scope tabs |
| Runs, activity, budgets, usage, system | `CoworkTimelinePanel`, `TokenUsageBreakdown`, `/system-monitor`, `/logs` (rail System, `NavSystem`) | event log, `useHardware` | restyled; system meters and shared LogViewer |
| Settings, accessibility, search, shortcuts | `/settings/*`, `SearchDialog`, `CommandPalette`, `/settings/shortcuts` | `SETTINGS_PAGES`, `useKeybindings` | settings navigation moved into the shell sidebar |
| Accent | `/settings/interface` | `useInterfaceSettings.accent` | done |

## Verification log

### Integration branch `feat/atelier-integration`

Mock-backed unit and component tests (vitest, jsdom) prove state, persistence
and UI contracts; they are not real-app evidence. Real-app runs use the
`cowork-smoke` build of the actual Tauri app with the local model fixture (a
controlled OpenAI-compatible server), not a real model.

- Final gate, JavaScript half (at `614621023`): plugin API build, typecheck,
  lint, production web build, web tests (516 files; 6,706 passed, 3 skipped),
  core 171, extensions 320, registry validation and render consistency,
  local-only guard, `git diff --check`: all pass. Script tests: 2 registry tests
  failed on the phase-6 baseline as well (they assumed a "missing" item exists);
  fixed in `9eb9a0221`, script tests now 46/46.
- Final gate, Rust half (at `0dcd5dfd8`; later commits change web and script
  files only): desktop library tests 1,232 passed; CLI library 1,925; `jan` bin
  16; golden repositories 6; agent-tools 1,111 passed, 1 ignored (with the
  sandbox helper); LSP 10; TLS 6; semantic 9; clippy (desktop and CLI) no
  errors; `jan` and harness builds pass.
- Real app, `atelier-explore` scenario driven over the WebView2 DevTools
  protocol (`real-journeys.cjs`): shell geometry (rail 80, context bar 52,
  status bar 28), chat send and streamed reply, split conversation, accent
  preset / invalid hex refused / reset / persistence across reload, dark theme,
  Cowork Changes inspector, models, tools, permissions, memory, library and
  system pages, keyboard focus ring, and viewport emulation at 390×844,
  844×390 and 768×1024 with no horizontal overflow. Emulation is not phone
  hardware: touch, virtual keyboards and safe-area insets were not tested on a
  device.
- Real app, scenario matrix (`cowork-smoke`, one process per unit, fresh
  profile each, retries off, real-provider units excluded): 94 runs on the
  integrated build, 86 passed on the first run. The 8 failures were harness
  selectors that still expected the pre-redesign labels, Tabler icons and
  approval text, a unit grouping that skipped a prerequisite scenario, and one
  timing-sensitive scenario that also fails intermittently on the phase-6
  baseline. The harness was updated and every failed unit passed when run
  again. One product fix came out of it: the edit and delete buttons on a
  message had no accessible name.

### Design branch `feat/atelier-design`

Recorded per commit:

- `9b49766d2` tokens, fonts, accent: `tsc -b` exit 0; vitest accent, AccentSettings, useInterfaceSettings, interface route, locale keys: 53/53.
- `c6065e809` primitives: vitest `src/components/ui`: 241/241.
- `14153208d` shell: `tsc -b` exit 0; vitest routes, HeaderPage, shellNavigation, SetupScreen, locales, components: 791/791; eslint clean on changed files. Web build in a browser at 1440×900 and 390×844 (no Tauri backend): rail 80px, context bar 52px, sidebar 256px, no horizontal overflow, phone navigation sheet opens.
