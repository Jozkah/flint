# JAN Atelier: implementation and feature-preservation map

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
| Phone navigation | Rail and sidebar in one sheet below 768px | `Sidebar` `mobileLeading`, `HeaderPage` menu button |
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
| First run, resume | `routes/index.tsx` → `SetupScreen`, `GettingStartedCard` (beginner workflows) | `hasUsableProvider`, `useSetupChecklist`, `useOnboardingGuide` | shell only |
| Chat, streaming, stop, retry, edit, attachments, errors | `routes/threads/$threadId.tsx`, `ChatInput`, `MessageItem` | `use-chat`, `custom-chat-transport`, `message-branching`, `useAttachments`, `stores/message-errors` | pending |
| Split conversations | new | independent session, model, project, draft, tools, permissions, stream and scroll per pane | pending (new UI; no existing implementation) |
| Cowork runs, plans, tools, output, review, checkpoints, steering | `routes/cowork.tsx`, `Cowork*` containers | `useCoworkSessions`, `useCoworkRun`, `useCoworkCheckpoints`, event log (`events/*.jsonl`) | pending |
| Projects, sessions, instructions, files, knowledge | `routes/project/$projectId.tsx`, `NavProjects`, `ProjectFiles`, `/settings/assistant` | `useThreadManagement`, VectorDB extension | pending |
| Agents, tasks, dependencies, worktrees | `CoworkTasksPanel`, `CoworkWorkflowCard`, `useCoworkWorktrees` | subagent registry, team children | pending |
| Repository, symbols, diagnostics | `CoworkCodePanel` (backend `index.rs`, `lsp.rs`, `diagnostics.rs` have no UI yet) | agent-core tools | pending |
| Changes, per-hunk review, git | `CoworkDiffPanel`, `CoworkProposalReview`, `DiffView` | `agent_git_*`, `agent_proposal_*` | pending |
| Models, providers, compatibility, default | `/settings/providers/*`, `ModelSupportStatus`, `DropdownModelProvider` | `useModelProvider`, `useModelLoad`, `useModelEvidence` | pending |
| Artifact library | `/artifacts` | `lib/coworkArtifacts`, `useCoworkSessions` | pending |
| Skills, plugins, MCP, commands, hooks | `SkillsManagerDialog`, `PluginsManagerDialog`, `/settings/mcp-servers`, `CoworkCompatSection` | `useSkills`, MCP services, fingerprint trust | pending |
| Permissions, grants, revocation, audit | inline approvals (`ai-elements/tool.tsx`), `/settings/permissions` | backend gate, `useToolApproval`, `permission_audit_recent` | pending |
| Context attribution, memory | `WhatJanIsUsing`, `CoworkContextBreakdown`, `/settings/memory` | `memory_*` commands, prompt snapshots | pending |
| Runs, activity, budgets, usage, system | `CoworkTimelinePanel`, `TokenUsageBreakdown`, `/system-monitor`, `/logs` | event log, `useHardware` | pending |
| Settings, accessibility, search, shortcuts | `/settings/*`, `SearchDialog`, `CommandPalette`, `/settings/shortcuts` | `SETTINGS_PAGES`, `useKeybindings` | settings navigation moved into the shell sidebar |
| Accent | `/settings/interface` | `useInterfaceSettings.accent` | done |

## Verification log

Recorded per commit on `feat/atelier-design`:

- `9b49766d2` tokens, fonts, accent: `tsc -b` exit 0; vitest accent, AccentSettings, useInterfaceSettings, interface route, locale keys: 53/53.
- `c6065e809` primitives: vitest `src/components/ui`: 241/241.
- `14153208d` shell: `tsc -b` exit 0; vitest routes, HeaderPage, shellNavigation, SetupScreen, locales, components: 791/791; eslint clean on changed files. Web build in a browser at 1440×900 and 390×844 (no Tauri backend): rail 80px, context bar 52px, sidebar 256px, no horizontal overflow, phone navigation sheet opens.
